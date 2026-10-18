import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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
  regime: z.object({
    adxPeriod: z.number().int().positive(),
    trendingThreshold: z.number().positive(),
    rangingThreshold: z.number().positive(),
    minBbWidth: z.number().positive().default(0.0065),
  }),
  trendStrategy: z.object({
    emaBaseline: z.number().int().positive(),
    donchianLookback: z.number().int().positive(),
    volumeMultiplier: z.number().positive(),
    atrPeriod: z.number().int().positive(),
    slAtrMultiplier: z.number().positive(),
  }),
  meanReversionStrategy: z.object({
    bbPeriod: z.number().int().positive(),
    bbStdDev: z.number().positive(),
    rsiPeriod: z.number().int().positive(),
    rsiOversold: z.number().gt(0).lt(50),
    rsiOverbought: z.number().gt(50).lt(100),
    slAtrMultiplier: z.number().positive(),
  }),
  tradeManagement: z.object({
    partialTakeProfitR: z.number().positive(),
    partialClosePct: z.number().gt(0).lt(1),
    trailingActivationR: z.number().positive(),
    trailingAtrMultiplier: z.number().positive(),
  }),
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

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
