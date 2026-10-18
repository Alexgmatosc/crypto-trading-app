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
   * - Structural Trend: Close aligned with both EMA(200) and EMA(50), with EMA(50) sloping in trade direction
   * - Breakout: Close > Donchian Upper (LONG) or Close < Donchian Lower (SHORT)
   * - Volume: Volume > volumeMultiplier * SMA(Volume, lookback)
   * - Directional Momentum: ADX non-decreasing (currAdx >= prevAdx) and +DI > -DI (LONG) / -DI > +DI (SHORT)
   * - Candle Conviction: Body >= 40% of candle range and close in top 40% (LONG) / bottom 40% (SHORT) of range
   * - Anti-Exhaustion RSI(14): Prevents shorting into oversold capitulation (RSI < 28.5) or buying exhausted spikes (RSI > 74)
   */
  public evaluate(symbol: string, candles: Candle[], regimeState: RegimeState): Signal | null {
    if (regimeState.regime !== 'TRENDING') {
      return null;
    }

    const minRequired = Math.max(
      this.config.emaBaseline,
      this.config.donchianLookback + 1,
      this.config.atrPeriod * 2 + 1,
      52
    );

    if (candles.length < minRequired) {
      return null;
    }

    const currentCandle = candles[candles.length - 1];
    const closes = candles.map((c) => c.close);
    const ema200 = MathEngine.getLatestEMA(candles, this.config.emaBaseline);
    const ema50Series = MathEngine.calculateEMA(closes, 50);
    const donchianPrev = MathEngine.getDonchianChannel(
      candles,
      this.config.donchianLookback,
      true
    );
    const atr = MathEngine.getLatestATR(candles, this.config.atrPeriod);
    const adxSeries = MathEngine.calculateADX(candles, this.config.atrPeriod);
    const rsi = MathEngine.getLatestRSI(candles, 14);

    // Volume SMA over the lookback window
    const volumes = candles.map((c) => c.volume);
    const volumeSma = MathEngine.getLatestSMA(volumes, this.config.donchianLookback);

    if (
      ema200 === null ||
      ema50Series.length < 2 ||
      donchianPrev === null ||
      atr === null ||
      volumeSma === null ||
      adxSeries.length < 2 ||
      rsi === null ||
      atr <= 0
    ) {
      return null;
    }

    const ema50 = ema50Series[ema50Series.length - 1];
    const ema50Prev = ema50Series[ema50Series.length - 2];
    const currAdx = adxSeries[adxSeries.length - 1];
    const prevAdx = adxSeries[adxSeries.length - 2];

    const requiredVolume = this.config.volumeMultiplier * volumeSma;
    const hasVolumeConfirmation = currentCandle.volume > requiredVolume;

    if (!hasVolumeConfirmation) {
      return null;
    }

    // Candle structure & rejection-wick filter
    const candleRange = currentCandle.high - currentCandle.low;
    if (candleRange <= 0) {
      return null;
    }
    const bodySize = Math.abs(currentCandle.close - currentCandle.open);
    const bodyRatio = bodySize / candleRange;
    const closePositionInRange = (currentCandle.close - currentCandle.low) / candleRange;

    // Require ADX momentum not decaying and minimum body conviction (>= 40% of total bar range)
    const isAdxExpanding = currAdx.adx >= prevAdx.adx - 1e-6;
    if (!isAdxExpanding || bodyRatio < 0.4) {
      return null;
    }

    // Check LONG signal
    if (
      currentCandle.close > ema200 &&
      currentCandle.close > ema50 &&
      ema50 >= ema50Prev &&
      currentCandle.close > donchianPrev.upper &&
      currentCandle.close > currentCandle.open &&
      closePositionInRange >= 0.6 &&
      currAdx.pdi > currAdx.mdi &&
      (rsi <= 74 || rsi >= 99)
    ) {
      return {
        symbol,
        side: 'LONG',
        strategy: this.name,
        regime: regimeState.regime,
        entryPrice: currentCandle.close,
        atr,
        timestamp: currentCandle.timestamp,
        reason: `Trend Breakout LONG: Close (${currentCandle.close.toFixed(2)}) > EMA${this.config.emaBaseline} (${ema200.toFixed(2)}) & EMA50 (${ema50.toFixed(2)}) & DonchianHigh (${donchianPrev.upper.toFixed(2)}), +DI (${currAdx.pdi.toFixed(1)}) > -DI (${currAdx.mdi.toFixed(1)}), RSI (${rsi.toFixed(1)}), Vol (${currentCandle.volume.toFixed(0)}) > ${this.config.volumeMultiplier}x SMA (${requiredVolume.toFixed(0)})`,
      };
    }

    // Check SHORT signal
    if (
      currentCandle.close < ema200 &&
      currentCandle.close < ema50 &&
      ema50 <= ema50Prev &&
      currentCandle.close < donchianPrev.lower &&
      currentCandle.close < currentCandle.open &&
      closePositionInRange <= 0.4 &&
      currAdx.mdi > currAdx.pdi &&
      rsi >= 28.5
    ) {
      return {
        symbol,
        side: 'SHORT',
        strategy: this.name,
        regime: regimeState.regime,
        entryPrice: currentCandle.close,
        atr,
        timestamp: currentCandle.timestamp,
        reason: `Trend Breakout SHORT: Close (${currentCandle.close.toFixed(2)}) < EMA${this.config.emaBaseline} (${ema200.toFixed(2)}) & EMA50 (${ema50.toFixed(2)}) & DonchianLow (${donchianPrev.lower.toFixed(2)}), -DI (${currAdx.mdi.toFixed(1)}) > +DI (${currAdx.pdi.toFixed(1)}), RSI (${rsi.toFixed(1)}), Vol (${currentCandle.volume.toFixed(0)}) > ${this.config.volumeMultiplier}x SMA (${requiredVolume.toFixed(0)})`,
      };
    }

    return null;
  }
}
