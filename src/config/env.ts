import dotenv from 'dotenv';
import { z } from 'zod';
import type { ExecutionMode } from '../types/index.js';

dotenv.config();

const EnvSchema = z.object({
  EXECUTION_MODE: z.enum(['BACKTEST', 'PAPER_LOCAL', 'TESTNET_LIVE']).default('PAPER_LOCAL'),
  EXCHANGE_ID: z.string().min(1).default('binanceusdm'),
  TESTNET_API_KEY: z.string().optional().default(''),
  TESTNET_API_SECRET: z.string().optional().default(''),
  DB_PATH: z.string().min(1).default('./data/quant_bot.sqlite'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function loadEnvConfig(overrides?: Partial<Record<keyof EnvConfig, string>>): EnvConfig {
  const merged = {
    EXECUTION_MODE: overrides?.EXECUTION_MODE ?? process.env.EXECUTION_MODE,
    EXCHANGE_ID: overrides?.EXCHANGE_ID ?? process.env.EXCHANGE_ID,
    TESTNET_API_KEY: overrides?.TESTNET_API_KEY ?? process.env.TESTNET_API_KEY,
    TESTNET_API_SECRET: overrides?.TESTNET_API_SECRET ?? process.env.TESTNET_API_SECRET,
    DB_PATH: overrides?.DB_PATH ?? process.env.DB_PATH,
    LOG_LEVEL: overrides?.LOG_LEVEL ?? process.env.LOG_LEVEL,
  };

  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${formatted}`);
  }

  return parsed.data;
}

export const env: EnvConfig = loadEnvConfig();

export function getExecutionMode(override?: ExecutionMode): ExecutionMode {
  return override ?? env.EXECUTION_MODE;
}
