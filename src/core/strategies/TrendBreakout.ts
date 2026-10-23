import {
  resolveSymbolStrategyConfig,
  strategyConfig,
  type StrategyConfig,
} from '../../config/strategyConfig.js';
import { MathEngine } from '../../indicators/MathEngine.js';
import type { Candle, RegimeState, Signal, StrategyName } from '../../types/index.js';
import type { IStrategy } from './IStrategy.js';

export interface TrendBreakoutConfig {
  emaBaseline: number;
  donchianLookback: number;
  volumeMultiplier: number;
  atrPeriod: number;
  slAtrMultiplier: number;
  breakoutBufferAtr: number;
  requireAtrExpansion: boolean;
  atrExpansionPeriod: number;
  minBodyRatio: number;
}

export class TrendBreakoutStrategy implements IStrategy {
  public readonly name: StrategyName = 'TREND_BREAKOUT';
  private readonly config: TrendBreakoutConfig;
  private readonly fullConfig: StrategyConfig;
  private readonly customConfig?: Partial<TrendBreakoutConfig>;

  constructor(
    customConfig?: Partial<TrendBreakoutConfig>,
    fullConfig: StrategyConfig = strategyConfig
  ) {
    this.fullConfig = fullConfig;
    this.customConfig = customConfig;
    this.config = this.buildConfig(fullConfig, customConfig);
  }

  private buildConfig(
    resolvedFull: StrategyConfig,
    customConfig?: Partial<TrendBreakoutConfig>
  ): TrendBreakoutConfig {
    return {
      emaBaseline: customConfig?.emaBaseline ?? resolvedFull.trendStrategy.emaBaseline,
      donchianLookback:
        customConfig?.donchianLookback ?? resolvedFull.trendStrategy.donchianLookback,
      volumeMultiplier:
        customConfig?.volumeMultiplier ?? resolvedFull.trendStrategy.volumeMultiplier,
      atrPeriod: customConfig?.atrPeriod ?? resolvedFull.trendStrategy.atrPeriod,
      slAtrMultiplier: customConfig?.slAtrMultiplier ?? resolvedFull.trendStrategy.slAtrMultiplier,
      breakoutBufferAtr:
        customConfig?.breakoutBufferAtr ?? resolvedFull.trendStrategy.breakoutBufferAtr ?? 0,
      requireAtrExpansion:
        customConfig?.requireAtrExpansion ?? resolvedFull.trendStrategy.requireAtrExpansion ?? false,
      atrExpansionPeriod:
        customConfig?.atrExpansionPeriod ?? resolvedFull.trendStrategy.atrExpansionPeriod ?? 20,
      minBodyRatio:
        customConfig?.minBodyRatio ?? resolvedFull.trendStrategy.minBodyRatio ?? 0.4,
    };
  }

  private getConfigForSymbol(symbol?: string): TrendBreakoutConfig {
    if (!symbol || !this.fullConfig.symbolOverrides?.[symbol]) {
      return this.config;
    }
    const symFull = resolveSymbolStrategyConfig(this.fullConfig, symbol);
    return this.buildConfig(symFull, this.customConfig);
  }

  /**
   * Evaluates TrendBreakout entry rules (exclusively when regime === 'TRENDING'):
   * - Structural Trend: Close aligned with both EMA(200) and EMA(50), with EMA(50) sloping in trade direction
   * - Breakout + Anti-Trap Buffer: Close > Donchian Upper + (breakoutBufferAtr * ATR) (LONG)
   *   or Close < Donchian Lower - (breakoutBufferAtr * ATR) (SHORT)
   * - Optional Volatility Expansion Filter: ATR_14 >= SMA(ATR_14, atrExpansionPeriod)
   * - Volume: Volume > volumeMultiplier * SMA(Volume, lookback)
   * - Directional Momentum: ADX non-decreasing (currAdx >= prevAdx) and +DI > -DI (LONG) / -DI > +DI (SHORT)
   * - Candle Conviction: Body >= minBodyRatio of candle range and close in top 40% (LONG) / bottom 40% (SHORT) of range
   * - Anti-Exhaustion RSI(14): Prevents shorting into oversold capitulation (RSI < 28.5) or buying exhausted spikes (RSI > 74)
   */
  public evaluate(symbol: string, candles: Candle[], regimeState: RegimeState): Signal | null {
    if (regimeState.regime !== 'TRENDING') {
      return null;
    }

    const cfg = this.getConfigForSymbol(symbol);
    const minRequired = Math.max(
      cfg.emaBaseline,
      cfg.donchianLookback + 1,
      cfg.atrPeriod * 2 + 1,
      cfg.requireAtrExpansion ? cfg.atrPeriod + cfg.atrExpansionPeriod + 1 : 0,
      52
    );

    if (candles.length < minRequired) {
      return null;
    }

    const currentCandle = candles[candles.length - 1];
    const closes = candles.map((c) => c.close);
    const ema200 = MathEngine.getLatestEMA(candles, cfg.emaBaseline);
    const ema50Series = MathEngine.calculateEMA(closes, 50);
    const donchianPrev = MathEngine.getDonchianChannel(
      candles,
      cfg.donchianLookback,
      true
    );
    const atr = MathEngine.getLatestATR(candles, cfg.atrPeriod);
    const adxSeries = MathEngine.calculateADX(candles, cfg.atrPeriod);
    const rsi = MathEngine.getLatestRSI(candles, 14);

    // Volume SMA over the lookback window
    const volumes = candles.map((c) => c.volume);
    const volumeSma = MathEngine.getLatestSMA(volumes, cfg.donchianLookback);

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

    // Optional ATR Volatility Expansion Filter (Anti-Trap Area 2):
    // Requires current ATR to be >= SMA(ATR, atrExpansionPeriod)
    if (cfg.requireAtrExpansion) {
      const atrSeries = MathEngine.calculateATR(candles, cfg.atrPeriod);
      const atrSma = MathEngine.getLatestSMA(atrSeries, cfg.atrExpansionPeriod);
      if (atrSma !== null && atr < atrSma) {
        return null;
      }
    }

    const ema50 = ema50Series[ema50Series.length - 1];
    const ema50Prev = ema50Series[ema50Series.length - 2];
    const currAdx = adxSeries[adxSeries.length - 1];
    const prevAdx = adxSeries[adxSeries.length - 2];

    const requiredVolume = cfg.volumeMultiplier * volumeSma;
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

    // Require ADX momentum not decaying and minimum body conviction (>= minBodyRatio of total bar range)
    const isAdxExpanding = currAdx.adx >= prevAdx.adx - 1e-6;
    if (!isAdxExpanding || bodyRatio < cfg.minBodyRatio) {
      return null;
    }

    // Anti-Trap Breakout Buffer: require price to clear Donchian boundary by breakoutBufferAtr * ATR
    const breakoutBuffer = cfg.breakoutBufferAtr * atr;
    const upperBreakoutThreshold = donchianPrev.upper + breakoutBuffer;
    const lowerBreakoutThreshold = donchianPrev.lower - breakoutBuffer;

    // Check LONG signal
    if (
      currentCandle.close > ema200 &&
      currentCandle.close > ema50 &&
      ema50 >= ema50Prev &&
      currentCandle.close > upperBreakoutThreshold &&
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
        reason: `Trend Breakout LONG: Close (${currentCandle.close.toFixed(2)}) > EMA${cfg.emaBaseline} (${ema200.toFixed(2)}) & EMA50 (${ema50.toFixed(2)}) & DonchianHigh+${cfg.breakoutBufferAtr}ATR (${upperBreakoutThreshold.toFixed(2)}), +DI (${currAdx.pdi.toFixed(1)}) > -DI (${currAdx.mdi.toFixed(1)}), RSI (${rsi.toFixed(1)}), Vol (${currentCandle.volume.toFixed(0)}) > ${cfg.volumeMultiplier}x SMA (${requiredVolume.toFixed(0)})`,
      };
    }

    // Check SHORT signal
    if (
      currentCandle.close < ema200 &&
      currentCandle.close < ema50 &&
      ema50 <= ema50Prev &&
      currentCandle.close < lowerBreakoutThreshold &&
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
        reason: `Trend Breakout SHORT: Close (${currentCandle.close.toFixed(2)}) < EMA${cfg.emaBaseline} (${ema200.toFixed(2)}) & EMA50 (${ema50.toFixed(2)}) & DonchianLow-${cfg.breakoutBufferAtr}ATR (${lowerBreakoutThreshold.toFixed(2)}), -DI (${currAdx.mdi.toFixed(1)}) > +DI (${currAdx.pdi.toFixed(1)}), RSI (${rsi.toFixed(1)}), Vol (${currentCandle.volume.toFixed(0)}) > ${cfg.volumeMultiplier}x SMA (${requiredVolume.toFixed(0)})`,
      };
    }

    return null;
  }
}
