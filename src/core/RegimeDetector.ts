import { strategyConfig, type StrategyConfig } from '../config/strategyConfig.js';
import { MathEngine } from '../indicators/MathEngine.js';
import type { Candle, RegimeState } from '../types/index.js';

export interface RegimeDetectorConfig {
  adxPeriod: number;
  trendingThreshold: number;
  rangingThreshold: number;
  bbPeriod: number;
  bbStdDev: number;
  minBbWidth: number;
}

export class RegimeDetector {
  private readonly config: RegimeDetectorConfig;

  constructor(customConfig?: Partial<RegimeDetectorConfig>, fullConfig: StrategyConfig = strategyConfig) {
    this.config = {
      adxPeriod: customConfig?.adxPeriod ?? fullConfig.regime.adxPeriod,
      trendingThreshold: customConfig?.trendingThreshold ?? fullConfig.regime.trendingThreshold,
      rangingThreshold: customConfig?.rangingThreshold ?? fullConfig.regime.rangingThreshold,
      bbPeriod: customConfig?.bbPeriod ?? fullConfig.meanReversionStrategy.bbPeriod,
      bbStdDev: customConfig?.bbStdDev ?? fullConfig.meanReversionStrategy.bbStdDev,
      minBbWidth: customConfig?.minBbWidth ?? fullConfig.regime.minBbWidth ?? 0.0065,
    };
  }

  /**
   * Classifies the market regime at the close of a 15m candle:
   * - TRENDING: ADX(14) > trendingThreshold (23)
   * - RANGING: ADX(14) < rangingThreshold (20) AND BB_Width > minBbWidth (0.0065)
   * - NO_TRADE: rangingThreshold <= ADX(14) <= trendingThreshold OR BB_Width <= minBbWidth (or insufficient data)
   */
  public detect(candles: Candle[]): RegimeState {
    const minRequiredCandles = Math.max(this.config.adxPeriod * 2, this.config.bbPeriod);
    if (candles.length < minRequiredCandles) {
      return {
        regime: 'NO_TRADE',
        adx: 0,
        bbWidth: 0,
        bbUpper: 0,
        bbMiddle: 0,
        bbLower: 0,
        reason: `Insufficient candles (${candles.length}/${minRequiredCandles})`,
      };
    }

    const latestAdx = MathEngine.getLatestADX(candles, this.config.adxPeriod);
    const latestBb = MathEngine.getLatestBollingerBands(
      candles,
      this.config.bbPeriod,
      this.config.bbStdDev
    );

    if (!latestAdx || !latestBb) {
      return {
        regime: 'NO_TRADE',
        adx: 0,
        bbWidth: 0,
        bbUpper: 0,
        bbMiddle: 0,
        bbLower: 0,
        reason: 'Unable to compute ADX or Bollinger Bands',
      };
    }

    const adx = latestAdx.adx;
    const bbWidth = latestBb.width;

    // 1. TRENDING: ADX > 25
    if (adx > this.config.trendingThreshold) {
      return {
        regime: 'TRENDING',
        adx,
        bbWidth,
        bbUpper: latestBb.upper,
        bbMiddle: latestBb.middle,
        bbLower: latestBb.lower,
        reason: `ADX (${adx.toFixed(2)}) > ${this.config.trendingThreshold} -> Strong directional trend`,
      };
    }

    // 2. RANGING: ADX < 20 and BB_Width > 0.015
    if (adx < this.config.rangingThreshold && bbWidth > this.config.minBbWidth) {
      return {
        regime: 'RANGING',
        adx,
        bbWidth,
        bbUpper: latestBb.upper,
        bbMiddle: latestBb.middle,
        bbLower: latestBb.lower,
        reason: `ADX (${adx.toFixed(2)}) < ${this.config.rangingThreshold} and BB_Width (${(bbWidth * 100).toFixed(2)}%) > ${(this.config.minBbWidth * 100).toFixed(2)}% -> Tradeable range`,
      };
    }

    // 3. NO_TRADE (Dead zone / Chop): 20 <= ADX <= 25 or ultra-narrow BB channel (BB_Width <= 0.015)
    const deadZoneReason =
      adx >= this.config.rangingThreshold && adx <= this.config.trendingThreshold
        ? `ADX (${adx.toFixed(2)}) in dead zone [${this.config.rangingThreshold}, ${this.config.trendingThreshold}]`
        : `BB_Width (${(bbWidth * 100).toFixed(2)}%) <= ${(this.config.minBbWidth * 100).toFixed(2)}% (channel too narrow to cover fees)`;

    return {
      regime: 'NO_TRADE',
      adx,
      bbWidth,
      bbUpper: latestBb.upper,
      bbMiddle: latestBb.middle,
      bbLower: latestBb.lower,
      reason: deadZoneReason,
    };
  }
}
