import { strategyConfig, type StrategyConfig } from '../../config/strategyConfig.js';
import { MathEngine } from '../../indicators/MathEngine.js';
import type { Candle, RegimeState, Signal, StrategyName } from '../../types/index.js';
import type { IStrategy } from './IStrategy.js';

export interface TrendBreakoutConfig {
  emaBaseline: number;
  donchianLookback: number;
  volumeMultiplier: number;
  atrPeriod: number;
  slAtrMultiplier: number;
}

export class TrendBreakoutStrategy implements IStrategy {
  public readonly name: StrategyName = 'TREND_BREAKOUT';
  private readonly config: TrendBreakoutConfig;

  constructor(
    customConfig?: Partial<TrendBreakoutConfig>,
    fullConfig: StrategyConfig = strategyConfig
  ) {
    this.config = {
      emaBaseline: customConfig?.emaBaseline ?? fullConfig.trendStrategy.emaBaseline,
      donchianLookback:
        customConfig?.donchianLookback ?? fullConfig.trendStrategy.donchianLookback,
      volumeMultiplier:
        customConfig?.volumeMultiplier ?? fullConfig.trendStrategy.volumeMultiplier,
      atrPeriod: customConfig?.atrPeriod ?? fullConfig.trendStrategy.atrPeriod,
      slAtrMultiplier: customConfig?.slAtrMultiplier ?? fullConfig.trendStrategy.slAtrMultiplier,
    };
  }

  /**
   * Evaluates TrendBreakout entry rules (exclusively when regime === 'TRENDING'):
   * - LONG:
   *   1. Close > EMA(200)
   *   2. Close > Max(High of 20 previous candles)
   *   3. Volume > 1.2 * SMA(Volume, 20)
   * - SHORT:
   *   1. Close < EMA(200)
   *   2. Close < Min(Low of 20 previous candles)
   *   3. Volume > 1.2 * SMA(Volume, 20)
   */
  public evaluate(symbol: string, candles: Candle[], regimeState: RegimeState): Signal | null {
    if (regimeState.regime !== 'TRENDING') {
      return null;
    }

    const minRequired = Math.max(
      this.config.emaBaseline,
      this.config.donchianLookback + 1,
      this.config.atrPeriod + 1
    );

    if (candles.length < minRequired) {
      return null;
    }

    const currentCandle = candles[candles.length - 1];
    const ema200 = MathEngine.getLatestEMA(candles, this.config.emaBaseline);
    const donchianPrev = MathEngine.getDonchianChannel(
      candles,
      this.config.donchianLookback,
      true
    );
    const atr = MathEngine.getLatestATR(candles, this.config.atrPeriod);

    // Volume SMA(20) over the 20 previous candles (or last 20 candles)
    const volumes = candles.map((c) => c.volume);
    const volumeSma = MathEngine.getLatestSMA(volumes, this.config.donchianLookback);

    if (ema200 === null || donchianPrev === null || atr === null || volumeSma === null || atr <= 0) {
      return null;
    }

    const requiredVolume = this.config.volumeMultiplier * volumeSma;
    const hasVolumeConfirmation = currentCandle.volume > requiredVolume;

    if (!hasVolumeConfirmation) {
      return null;
    }

    // Check LONG signal
    if (currentCandle.close > ema200 && currentCandle.close > donchianPrev.upper) {
      return {
        symbol,
        side: 'LONG',
        strategy: this.name,
        regime: regimeState.regime,
        entryPrice: currentCandle.close,
        atr,
        timestamp: currentCandle.timestamp,
        reason: `Trend Breakout LONG: Close (${currentCandle.close.toFixed(2)}) > EMA${this.config.emaBaseline} (${ema200.toFixed(2)}) & DonchianHigh (${donchianPrev.upper.toFixed(2)}), Vol (${currentCandle.volume.toFixed(0)}) > ${this.config.volumeMultiplier}x SMA (${requiredVolume.toFixed(0)})`,
      };
    }

    // Check SHORT signal
    if (currentCandle.close < ema200 && currentCandle.close < donchianPrev.lower) {
      return {
        symbol,
        side: 'SHORT',
        strategy: this.name,
        regime: regimeState.regime,
        entryPrice: currentCandle.close,
        atr,
        timestamp: currentCandle.timestamp,
        reason: `Trend Breakout SHORT: Close (${currentCandle.close.toFixed(2)}) < EMA${this.config.emaBaseline} (${ema200.toFixed(2)}) & DonchianLow (${donchianPrev.lower.toFixed(2)}), Vol (${currentCandle.volume.toFixed(0)}) > ${this.config.volumeMultiplier}x SMA (${requiredVolume.toFixed(0)})`,
      };
    }

    return null;
  }
}
