import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const RegimeConfigSchema = z.object({
  adxPeriod: z.number().int().positive(),
  trendingThreshold: z.number().positive(),
  rangingThreshold: z.number().positive(),
  minBbWidth: z.number().positive().default(0.0065),
});

export const TrendStrategyConfigSchema = z.object({
  emaBaseline: z.number().int().positive(),
  donchianLookback: z.number().int().positive(),
  volumeMultiplier: z.number().positive(),
  atrPeriod: z.number().int().positive(),
  slAtrMultiplier: z.number().positive(),
  breakoutBufferAtr: z.number().min(0).max(2).default(0),
  requireAtrExpansion: z.boolean().default(false),
  atrExpansionPeriod: z.number().int().positive().default(20),
  minBodyRatio: z.number().min(0).max(1).default(0.4),
});

export const MeanReversionStrategyConfigSchema = z.object({
  bbPeriod: z.number().int().positive(),
  bbStdDev: z.number().positive(),
  rsiPeriod: z.number().int().positive(),
  rsiOversold: z.number().gt(0).lt(50),
  rsiOverbought: z.number().gt(50).lt(100),
  slAtrMultiplier: z.number().positive(),
});

export const TradeManagementConfigSchema = z.object({
  partialTakeProfitR: z.number().positive(),
  partialClosePct: z.number().gt(0).lt(1),
  trailingActivationR: z.number().positive(),
  trailingAtrMultiplier: z.number().positive(),
});

export const SymbolOverrideSchema = z.object({
  // Flat per-symbol override keys
  adxPeriod: z.number().int().positive().optional(),
  trendingThreshold: z.number().positive().optional(),
  rangingThreshold: z.number().positive().optional(),
  minBbWidth: z.number().positive().optional(),
  emaBaseline: z.number().int().positive().optional(),
  donchianLookback: z.number().int().positive().optional(),
  volumeMultiplier: z.number().positive().optional(),
  atrPeriod: z.number().int().positive().optional(),
  slAtrMultiplier: z.number().positive().optional(),
  breakoutBufferAtr: z.number().min(0).max(2).optional(),
  requireAtrExpansion: z.boolean().optional(),
  atrExpansionPeriod: z.number().int().positive().optional(),
  minBodyRatio: z.number().min(0).max(1).optional(),
  bbPeriod: z.number().int().positive().optional(),
  bbStdDev: z.number().positive().optional(),
  rsiPeriod: z.number().int().positive().optional(),
  rsiOversold: z.number().gt(0).lt(50).optional(),
  rsiOverbought: z.number().gt(50).lt(100).optional(),
  meanReversionSlAtrMultiplier: z.number().positive().optional(),
  partialTakeProfitR: z.number().positive().optional(),
  partialClosePct: z.number().gt(0).lt(1).optional(),
  trailingActivationR: z.number().positive().optional(),
  trailingAtrMultiplier: z.number().positive().optional(),
  // Optional nested section overrides
  regime: RegimeConfigSchema.partial().optional(),
  trendStrategy: TrendStrategyConfigSchema.partial().optional(),
  meanReversionStrategy: MeanReversionStrategyConfigSchema.partial().optional(),
  tradeManagement: TradeManagementConfigSchema.partial().optional(),
});

export type SymbolOverrideConfig = z.infer<typeof SymbolOverrideSchema>;

export const StrategyConfigSchema = z.object({
  symbols: z.array(z.string().min(3)).min(1),
  timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']).default('15m'),
  initialBalance: z.number().positive(),
  leverage: z.number().min(1).max(50),
  riskPerTrade: z.number().gt(0).lte(0.1),
  maxConcurrentPositions: z.number().int().positive(),
  maxDailyDrawdown: z.number().gt(0).lt(1),
  fees: z.object({
    maker: z.number().min(0).lt(0.05),
    taker: z.number().min(0).lt(0.05),
    slippage: z.number().min(0).lt(0.05),
  }),
  regime: RegimeConfigSchema,
  trendStrategy: TrendStrategyConfigSchema,
  meanReversionStrategy: MeanReversionStrategyConfigSchema,
  tradeManagement: TradeManagementConfigSchema,
  symbolOverrides: z.record(z.string(), SymbolOverrideSchema).optional(),
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

/**
 * Resolves the effective StrategyConfig for a specific symbol by merging base config
 * with any flat or nested overrides defined in `config.symbolOverrides[symbol]`.
 */
export function resolveSymbolStrategyConfig(
  baseConfig: StrategyConfig,
  symbol?: string
): StrategyConfig {
  if (!symbol || !baseConfig.symbolOverrides?.[symbol]) {
    return baseConfig;
  }

  const ov = baseConfig.symbolOverrides[symbol];

  return {
    ...baseConfig,
    regime: {
      ...baseConfig.regime,
      ...(ov.regime ?? {}),
      ...(ov.adxPeriod !== undefined ? { adxPeriod: ov.adxPeriod } : {}),
      ...(ov.trendingThreshold !== undefined ? { trendingThreshold: ov.trendingThreshold } : {}),
      ...(ov.rangingThreshold !== undefined ? { rangingThreshold: ov.rangingThreshold } : {}),
      ...(ov.minBbWidth !== undefined ? { minBbWidth: ov.minBbWidth } : {}),
    },
    trendStrategy: {
      ...baseConfig.trendStrategy,
      ...(ov.trendStrategy ?? {}),
      ...(ov.emaBaseline !== undefined ? { emaBaseline: ov.emaBaseline } : {}),
      ...(ov.donchianLookback !== undefined ? { donchianLookback: ov.donchianLookback } : {}),
      ...(ov.volumeMultiplier !== undefined ? { volumeMultiplier: ov.volumeMultiplier } : {}),
      ...(ov.atrPeriod !== undefined ? { atrPeriod: ov.atrPeriod } : {}),
      ...(ov.slAtrMultiplier !== undefined ? { slAtrMultiplier: ov.slAtrMultiplier } : {}),
      ...(ov.breakoutBufferAtr !== undefined ? { breakoutBufferAtr: ov.breakoutBufferAtr } : {}),
      ...(ov.requireAtrExpansion !== undefined
        ? { requireAtrExpansion: ov.requireAtrExpansion }
        : {}),
      ...(ov.atrExpansionPeriod !== undefined ? { atrExpansionPeriod: ov.atrExpansionPeriod } : {}),
      ...(ov.minBodyRatio !== undefined ? { minBodyRatio: ov.minBodyRatio } : {}),
    },
    meanReversionStrategy: {
      ...baseConfig.meanReversionStrategy,
      ...(ov.meanReversionStrategy ?? {}),
      ...(ov.bbPeriod !== undefined ? { bbPeriod: ov.bbPeriod } : {}),
      ...(ov.bbStdDev !== undefined ? { bbStdDev: ov.bbStdDev } : {}),
      ...(ov.rsiPeriod !== undefined ? { rsiPeriod: ov.rsiPeriod } : {}),
      ...(ov.rsiOversold !== undefined ? { rsiOversold: ov.rsiOversold } : {}),
      ...(ov.rsiOverbought !== undefined ? { rsiOverbought: ov.rsiOverbought } : {}),
      ...(ov.meanReversionSlAtrMultiplier !== undefined
        ? { slAtrMultiplier: ov.meanReversionSlAtrMultiplier }
        : {}),
    },
    tradeManagement: {
      ...baseConfig.tradeManagement,
      ...(ov.tradeManagement ?? {}),
      ...(ov.partialTakeProfitR !== undefined ? { partialTakeProfitR: ov.partialTakeProfitR } : {}),
      ...(ov.partialClosePct !== undefined ? { partialClosePct: ov.partialClosePct } : {}),
      ...(ov.trailingActivationR !== undefined
        ? { trailingActivationR: ov.trailingActivationR }
        : {}),
      ...(ov.trailingAtrMultiplier !== undefined
        ? { trailingAtrMultiplier: ov.trailingAtrMultiplier }
        : {}),
    },
  };
}

export function loadStrategyConfig(configPath?: string): StrategyConfig {
  const resolvedPath = configPath ?? path.resolve(process.cwd(), 'config.json');
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found at ${resolvedPath}`);
  }

  const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
  const parsedJson: unknown = JSON.parse(rawContent);

  const result = StrategyConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid strategy configuration in ${resolvedPath}: ${errors}`);
  }

  return result.data;
}

export const strategyConfig: StrategyConfig = loadStrategyConfig();
