import pino from 'pino';
import { env } from '../config/env.js';

const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export const logger = pino({
  level: isTestEnv ? 'silent' : env.LOG_LEVEL,
  transport: isTestEnv
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
});

export function formatPrice(price: number): number {
  return Math.abs(price) < 1 ? Number(price.toFixed(5)) : Number(price.toFixed(2));
}

export function formatPriceStr(price: number): string {
  return Math.abs(price) < 1 ? price.toFixed(5) : price.toFixed(2);
}
