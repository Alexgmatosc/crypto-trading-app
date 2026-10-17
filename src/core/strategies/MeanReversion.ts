import { strategyConfig, type StrategyConfig } from '../../config/strategyConfig.js';
import { MathEngine } from '../../indicators/MathEngine.js';
import type {
  Candle,
  ExitReason,
  RegimeState,
  Signal,
  StrategyName,
  TradeRecord,
} from '../../types/index.js';
import type { IStrategy } from './IStrategy.js';

export interface MeanReversionConfig {
  bbPeriod: number;
  bbStdDev: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  atrPeriod: number;
  slAtrMultiplier: number;
}

export class MeanReversionStrategy implements IStrategy {
  public readonly name: StrategyName = 'MEAN_REVERSION';
  private readonly config: MeanReversionConfig;

  constructor(
    customConfig?: Partial<MeanReversionConfig>,
    fullConfig: StrategyConfig = strategyConfig
  ) {
    // SPEC Section 5.B.2 specifies RSI(14) < 32 for oversold bounce and RSI(14) > 68 for overbought rejection
    this.config = {
      bbPeriod: customConfig?.bbPeriod ?? fullConfig.meanReversionStrategy.bbPeriod,
      bbStdDev: customConfig?.bbStdDev ?? fullConfig.meanReversionStrategy.bbStdDev,
      rsiPeriod: customConfig?.rsiPeriod ?? fullConfig.meanReversionStrategy.rsiPeriod,
      rsiOversold:
        customConfig?.rsiOversold ??
        Math.max(fullConfig.meanReversionStrategy.rsiOversold, 32),
      rsiOverbought:
        customConfig?.rsiOverbought ??
        Math.min(fullConfig.meanReversionStrategy.rsiOverbought, 68),
      atrPeriod: customConfig?.atrPeriod ?? fullConfig.trendStrategy.atrPeriod,
      slAtrMultiplier:
        customConfig?.slAtrMultiplier ?? fullConfig.meanReversionStrategy.slAtrMultiplier,
    };
  }

  /**
   * Evaluates MeanReversion entry rules (exclusively when regime === 'RANGING'):
   * - LONG (Support Bounce):
   *   1. Previous candle closed below or touched BB_Lower(20, 2.0) AND current candle closes inside (Close > BB_Lower).
   *   2. RSI(14) < 32 (Oversold confirmed).
   * - SHORT (Resistance Rejection):
   *   1. Previous candle touched or exceeded BB_Upper(20, 2.0) AND current candle closes inside (Close < BB_Upper).
   *   2. RSI(14) > 68 (Overbought confirmed).
   */
  public evaluate(symbol: string, candles: Candle[], regimeState: RegimeState): Signal | null {
    if (regimeState.regime !== 'RANGING') {
      return null;
    }

    const minRequired = Math.max(
      this.config.bbPeriod + 2,
      this.config.rsiPeriod + 2,
      this.config.atrPeriod + 1
    );

    if (candles.length < minRequired) {
      return null;
    }

    const closes = candles.map((c) => c.close);
    const bbSeries = MathEngine.calculateBollingerBands(
      closes,
      this.config.bbPeriod,
      this.config.bbStdDev
    );
    const rsiSeries = MathEngine.calculateRSI(closes, this.config.rsiPeriod);
    const atr = MathEngine.getLatestATR(candles, this.config.atrPeriod);

    if (bbSeries.length < 2 || rsiSeries.length < 2 || atr === null || atr <= 0) {
      return null;
    }

    const prevCandle = candles[candles.length - 2];
    const currCandle = candles[candles.length - 1];

    const prevBb = bbSeries[bbSeries.length - 2];
    const currBb = bbSeries[bbSeries.length - 1];

    const prevRsi = rsiSeries[rsiSeries.length - 2];
    const currRsi = rsiSeries[rsiSeries.length - 1];

    // LONG Signal:
    // 1. Previous candle closed below or touched BB_Lower and current candle closes inside (Close > BB_Lower)
    // 2. RSI(14) < 32 (check current RSI or previous-to-current bounce oversold confirmation)
    const prevTouchedOrClosedBelowLower =
      prevCandle.close <= prevBb.lower || prevCandle.low <= prevBb.lower;
    const currClosedInsideLower = currCandle.close > currBb.lower;
    const isOversold = currRsi < this.config.rsiOversold || prevRsi < this.config.rsiOversold;

    if (prevTouchedOrClosedBelowLower && currClosedInsideLower && isOversold && currRsi < 50) {
      return {
        symbol,
        side: 'LONG',
        strategy: this.name,
        regime: regimeState.regime,
        entryPrice: currCandle.close,
        atr,
        timestamp: currCandle.timestamp,
        bbMiddle: currBb.middle,
        reason: `Mean Reversion LONG: Prev touched/below BB_Lower (${prevBb.lower.toFixed(2)}), Curr closed inside (${currCandle.close.toFixed(2)} > ${currBb.lower.toFixed(2)}), RSI (${Math.min(currRsi, prevRsi).toFixed(2)}) < ${this.config.rsiOversold}`,
      };
    }

    // SHORT Signal:
    // 1. Previous candle touched or exceeded BB_Upper and current candle closes inside (Close < BB_Upper)
    // 2. RSI(14) > 68
    const prevTouchedOrExceededUpper =
      prevCandle.close >= prevBb.upper || prevCandle.high >= prevBb.upper;
    const currClosedInsideUpper = currCandle.close < currBb.upper;
    const isOverbought =
      currRsi > this.config.rsiOverbought || prevRsi > this.config.rsiOverbought;

    if (prevTouchedOrExceededUpper && currClosedInsideUpper && isOverbought && currRsi > 50) {
      return {
        symbol,
        side: 'SHORT',
        strategy: this.name,
        regime: regimeState.regime,
        entryPrice: currCandle.close,
        atr,
        timestamp: currCandle.timestamp,
        bbMiddle: currBb.middle,
        reason: `Mean Reversion SHORT: Prev touched/above BB_Upper (${prevBb.upper.toFixed(2)}), Curr closed inside (${currCandle.close.toFixed(2)} < ${currBb.upper.toFixed(2)}), RSI (${Math.max(currRsi, prevRsi).toFixed(2)}) > ${this.config.rsiOverbought}`,
      };
    }

    return null;
  }

  /**
   * Specific Mean Reversion target: if price touches the central mean (BB_Middle),
   * close the entire position with exit_reason = 'MEAN_TARGET'.
   */
  public checkStrategyExit(
    trade: TradeRecord,
    candles: Candle[],
    currentPrice: number
  ): ExitReason | null {
    if (trade.strategy !== 'MEAN_REVERSION') {
      return null;
    }

    const latestBb = MathEngine.getLatestBollingerBands(
      candles,
      this.config.bbPeriod,
      this.config.bbStdDev
    );

    if (!latestBb) {
      return null;
    }

    const latestCandle = candles[candles.length - 1];

    if (trade.side === 'LONG') {
      if (currentPrice >= latestBb.middle || (latestCandle && latestCandle.high >= latestBb.middle)) {
        return 'MEAN_TARGET';
      }
    } else {
      if (currentPrice <= latestBb.middle || (latestCandle && latestCandle.low <= latestBb.middle)) {
        return 'MEAN_TARGET';
      }
    }

    return null;
  }
}
