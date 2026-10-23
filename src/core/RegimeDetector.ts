import {
  resolveSymbolStrategyConfig,
  strategyConfig,
  type StrategyConfig,
} from '../config/strategyConfig.js';
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
  private readonly fullConfig: StrategyConfig;
  private readonly customConfig?: Partial<RegimeDetectorConfig>;

  constructor(customConfig?: Partial<RegimeDetectorConfig>, fullConfig: StrategyConfig = strategyConfig) {
    this.fullConfig = fullConfig;
    this.customConfig = customConfig;
    this.config = this.buildConfig(fullConfig, customConfig);
  }

  private buildConfig(
    resolvedFullConfig: StrategyConfig,
    customConfig?: Partial<RegimeDetectorConfig>
  ): RegimeDetectorConfig {
    return {
      adxPeriod: customConfig?.adxPeriod ?? resolvedFullConfig.regime.adxPeriod,
      trendingThreshold:
        customConfig?.trendingThreshold ?? resolvedFullConfig.regime.trendingThreshold,
      rangingThreshold:
        customConfig?.rangingThreshold ?? resolvedFullConfig.regime.rangingThreshold,
      bbPeriod: customConfig?.bbPeriod ?? resolvedFullConfig.meanReversionStrategy.bbPeriod,
      bbStdDev: customConfig?.bbStdDev ?? resolvedFullConfig.meanReversionStrategy.bbStdDev,
      minBbWidth: customConfig?.minBbWidth ?? resolvedFullConfig.regime.minBbWidth ?? 0.0065,
    };
  }

  private getConfigForSymbol(symbol?: string): RegimeDetectorConfig {
    if (!symbol || !this.fullConfig.symbolOverrides?.[symbol]) {
      return this.config;
    }
    const symFull = resolveSymbolStrategyConfig(this.fullConfig, symbol);
    return this.buildConfig(symFull, this.customConfig);
  }

  /**
   * Classifies the market regime at the close of a 15m candle:
   * - TRENDING: ADX(14) > trendingThreshold (23)
   * - RANGING: ADX(14) < rangingThreshold (20) AND BB_Width > minBbWidth (0.0065)
   * - NO_TRADE: rangingThreshold <= ADX(14) <= trendingThreshold OR BB_Width <= minBbWidth (or insufficient data)
   */
  public detect(candles: Candle[], symbol?: string): RegimeState {
    const cfg = this.getConfigForSymbol(symbol);
    const minRequiredCandles = Math.max(cfg.adxPeriod * 2, cfg.bbPeriod);
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

    const latestAdx = MathEngine.getLatestADX(candles, cfg.adxPeriod);
    const latestBb = MathEngine.getLatestBollingerBands(
      candles,
      cfg.bbPeriod,
      cfg.bbStdDev
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

    // 1. TRENDING: ADX > trendingThreshold
    if (adx > cfg.trendingThreshold) {
      return {
        regime: 'TRENDING',
        adx,
        bbWidth,
        bbUpper: latestBb.upper,
        bbMiddle: latestBb.middle,
        bbLower: latestBb.lower,
        reason: `ADX (${adx.toFixed(2)}) > ${cfg.trendingThreshold} -> Strong directional trend`,
      };
    }

    // 2. RANGING: ADX < rangingThreshold and BB_Width > minBbWidth
    if (adx < cfg.rangingThreshold && bbWidth > cfg.minBbWidth) {
      return {
        regime: 'RANGING',
        adx,
        bbWidth,
        bbUpper: latestBb.upper,
        bbMiddle: latestBb.middle,
        bbLower: latestBb.lower,
        reason: `ADX (${adx.toFixed(2)}) < ${cfg.rangingThreshold} and BB_Width (${(bbWidth * 100).toFixed(2)}%) > ${(cfg.minBbWidth * 100).toFixed(2)}% -> Tradeable range`,
      };
    }

    // 3. NO_TRADE (Dead zone / Chop): rangingThreshold <= ADX <= trendingThreshold or ultra-narrow BB channel
    const deadZoneReason =
      adx >= cfg.rangingThreshold && adx <= cfg.trendingThreshold
        ? `ADX (${adx.toFixed(2)}) in dead zone [${cfg.rangingThreshold}, ${cfg.trendingThreshold}]`
        : `BB_Width (${(bbWidth * 100).toFixed(2)}%) <= ${(cfg.minBbWidth * 100).toFixed(2)}% (channel too narrow to cover fees)`;

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
