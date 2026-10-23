import { describe, expect, it } from 'vitest';
import {
  resolveSymbolStrategyConfig,
  strategyConfig,
  type StrategyConfig,
} from '../src/config/strategyConfig.js';
import { RegimeDetector } from '../src/core/RegimeDetector.js';
import { RiskManager } from '../src/core/RiskManager.js';
import { TrendBreakoutStrategy } from '../src/core/strategies/TrendBreakout.js';
import type { Candle, RegimeState } from '../src/types/index.js';

function buildBreakoutCandles(breakoutDeltaAboveHigh: number, finalAtrScale = 1.0): Candle[] {
  const candles: Candle[] = [];
  const startTs = 1_700_000_000_000;
  let price = 100;

  for (let i = 0; i < 250; i++) {
    price += 0.35 + (i % 3 === 0 ? 0.15 : -0.05);
    candles.push({
      timestamp: startTs + i * 900_000,
      open: price - 0.3,
      high: price + 0.4,
      low: price - 0.5,
      close: price,
      volume: 1000,
    });
  }

  // Compute max high of last 30 candles
  const last30 = candles.slice(-30);
  const donchianUpper = Math.max(...last30.map((c) => c.high));
  const breakoutClose = donchianUpper + breakoutDeltaAboveHigh;
  const barRange = Math.max(0.8 * finalAtrScale, breakoutDeltaAboveHigh + 0.4);

  candles.push({
    timestamp: startTs + 250 * 900_000,
    open: breakoutClose - barRange * 0.75,
    high: breakoutClose + barRange * 0.1,
    low: breakoutClose - barRange * 0.9,
    close: breakoutClose,
    volume: 3200,
  });

  return candles;
}

describe('Per-Symbol Overrides & Anti-Trap Filter (Areas 1 & 2)', () => {
  it('resolves per-symbol overrides while preserving base config defaults for other symbols', () => {
    const customConfig: StrategyConfig = {
      ...strategyConfig,
      symbolOverrides: {
        'BTC/USDT': {
          donchianLookback: 45,
          volumeMultiplier: 1.65,
          slAtrMultiplier: 2.0,
          trendingThreshold: 25,
          breakoutBufferAtr: 0.1,
          requireAtrExpansion: true,
        },
        'DOGE/USDT': {
          donchianLookback: 20,
          volumeMultiplier: 1.25,
          slAtrMultiplier: 2.4,
          trendingThreshold: 22,
        },
      },
    };

    const btcResolved = resolveSymbolStrategyConfig(customConfig, 'BTC/USDT');
    expect(btcResolved.trendStrategy.donchianLookback).toBe(45);
    expect(btcResolved.trendStrategy.volumeMultiplier).toBe(1.65);
    expect(btcResolved.trendStrategy.slAtrMultiplier).toBe(2.0);
    expect(btcResolved.regime.trendingThreshold).toBe(25);
    expect(btcResolved.trendStrategy.breakoutBufferAtr).toBe(0.1);
    expect(btcResolved.trendStrategy.requireAtrExpansion).toBe(true);

    const dogeResolved = resolveSymbolStrategyConfig(customConfig, 'DOGE/USDT');
    expect(dogeResolved.trendStrategy.donchianLookback).toBe(20);
    expect(dogeResolved.trendStrategy.volumeMultiplier).toBe(1.25);
    expect(dogeResolved.trendStrategy.slAtrMultiplier).toBe(2.4);
    expect(dogeResolved.regime.trendingThreshold).toBe(22);

    const ethResolved = resolveSymbolStrategyConfig(customConfig, 'ETH/USDT');
    expect(ethResolved.trendStrategy.donchianLookback).toBe(
      strategyConfig.trendStrategy.donchianLookback
    );
  });

  it('filters out shallow 1-tick false breakouts when breakoutBufferAtr > 0', () => {
    const shallowCandles = buildBreakoutCandles(0.01); // barely 0.01 above Donchian upper
    const trendingRegime: RegimeState = {
      regime: 'TRENDING',
      adx: 30,
      bbWidth: 0.025,
      bbUpper: 195,
      bbMiddle: 185,
      bbLower: 175,
      reason: 'Trending test',
    };

    const configWithBuffer: StrategyConfig = {
      ...strategyConfig,
      symbolOverrides: {
        'SOL/USDT': {
          breakoutBufferAtr: 0.15, // requires clearing Donchian by 0.15 * ATR
        },
        'DOGE/USDT': {
          breakoutBufferAtr: 0, // no buffer required
        },
      },
    };

    const strategy = new TrendBreakoutStrategy(undefined, configWithBuffer);

    // DOGE (0 buffer) triggers on the 0.01 breakout
    const dogeSignal = strategy.evaluate('DOGE/USDT', shallowCandles, trendingRegime);
    expect(dogeSignal).not.toBeNull();

    // SOL (0.15 ATR buffer) rejects the shallow 0.01 breakout trap
    const solShallowSignal = strategy.evaluate('SOL/USDT', shallowCandles, trendingRegime);
    expect(solShallowSignal).toBeNull();

    // SOL accepts a decisive breakout (+1.5 above Donchian upper)
    const decisiveCandles = buildBreakoutCandles(1.5);
    const solDecisiveSignal = strategy.evaluate('SOL/USDT', decisiveCandles, trendingRegime);
    expect(solDecisiveSignal).not.toBeNull();
  });

  it('applies per-symbol slAtrMultiplier in RiskManager and trendingThreshold in RegimeDetector', () => {
    const customConfig: StrategyConfig = {
      ...strategyConfig,
      symbolOverrides: {
        'BTC/USDT': {
          slAtrMultiplier: 1.8,
          trendingThreshold: 28,
        },
        'DOGE/USDT': {
          slAtrMultiplier: 2.5,
          trendingThreshold: 21,
        },
      },
    };

    const rm = new RiskManager(customConfig);
    const btcSize = rm.calculatePositionSize({
      availableBalance: 5000,
      entryPrice: 80000,
      atr: 400,
      side: 'LONG',
      strategy: 'TREND_BREAKOUT',
      symbol: 'BTC/USDT',
    });
    const dogeSize = rm.calculatePositionSize({
      availableBalance: 5000,
      entryPrice: 0.08,
      atr: 0.001,
      side: 'LONG',
      strategy: 'TREND_BREAKOUT',
      symbol: 'DOGE/USDT',
    });

    expect(btcSize.slDistance).toBeCloseTo(1.8 * 400, 5);
    expect(dogeSize.slDistance).toBeCloseTo(2.5 * 0.001, 6);

    const detector = new RegimeDetector(undefined, customConfig);
    const candles = buildBreakoutCandles(0.5);
    const dogeRegime = detector.detect(candles, 'DOGE/USDT');
    expect(dogeRegime.regime).toBe('TRENDING');
  });
});
