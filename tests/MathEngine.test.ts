import { describe, expect, it } from 'vitest';
import { MathEngine } from '../src/indicators/MathEngine.js';
import type { Candle } from '../src/types/index.js';

function generateSyntheticCandles(
  count: number,
  generator: (index: number) => { open: number; high: number; low: number; close: number; volume?: number }
): Candle[] {
  const baseTimestamp = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => {
    const c = generator(i);
    return {
      timestamp: baseTimestamp + i * 15 * 60 * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 100,
    };
  });
}

describe('MathEngine', () => {
  it('calculates EMA and SMA accurately on numeric series and candles', () => {
    const values = [10, 20, 30, 40, 50];
    const smaSeries = MathEngine.calculateSMA(values, 3);
    expect(smaSeries).toEqual([20, 30, 40]);
    expect(MathEngine.getLatestSMA(values, 3)).toBe(40);

    const candles = generateSyntheticCandles(30, (i) => {
      const price = 50000 + i * 100;
      return { open: price - 20, high: price + 50, low: price - 50, close: price };
    });

    const latestEma = MathEngine.getLatestEMA(candles, 10);
    expect(latestEma).not.toBeNull();
    expect(latestEma!).toBeGreaterThan(51500);
    expect(latestEma!).toBeLessThan(candles[candles.length - 1].close);
  });

  it('returns empty or null when input length is smaller than indicator period', () => {
    const shortCandles = generateSyntheticCandles(5, () => ({
      open: 100,
      high: 105,
      low: 95,
      close: 100,
    }));

    expect(MathEngine.getLatestEMA(shortCandles, 20)).toBeNull();
    expect(MathEngine.getLatestATR(shortCandles, 14)).toBeNull();
    expect(MathEngine.getLatestADX(shortCandles, 14)).toBeNull();
    expect(MathEngine.getLatestRSI(shortCandles, 14)).toBeNull();
    expect(MathEngine.getLatestBollingerBands(shortCandles, 20, 2)).toBeNull();
    expect(MathEngine.getDonchianChannel(shortCandles, 20)).toBeNull();
  });

  it('calculates ATR accurately for constant range candles', () => {
    // Each candle has high - low = 200, and previous close equals current open (no gap)
    const candles = generateSyntheticCandles(30, () => ({
      open: 60000,
      high: 60100,
      low: 59900,
      close: 60000,
    }));

    const atr = MathEngine.getLatestATR(candles, 14);
    expect(atr).not.toBeNull();
    expect(atr!).toBeCloseTo(200, 2);
  });

  it('calculates RSI properly in overbought and oversold conditions', () => {
    const uptrendCandles = generateSyntheticCandles(30, (i) => {
      const close = 40000 + i * 250;
      return { open: close - 200, high: close + 50, low: close - 220, close };
    });

    const downtrendCandles = generateSyntheticCandles(30, (i) => {
      const close = 40000 - i * 250;
      return { open: close + 200, high: close + 220, low: close - 50, close };
    });

    const rsiUp = MathEngine.getLatestRSI(uptrendCandles, 14);
    const rsiDown = MathEngine.getLatestRSI(downtrendCandles, 14);

    expect(rsiUp).not.toBeNull();
    expect(rsiUp!).toBeGreaterThan(75);

    expect(rsiDown).not.toBeNull();
    expect(rsiDown!).toBeLessThan(25);
  });

  it('calculates Bollinger Bands and exact normalized BB_Width = (Upper - Lower) / Middle', () => {
    const candles = generateSyntheticCandles(40, (i) => {
      const wave = Math.sin(i * 0.6) * 800;
      const close = 50000 + wave;
      return { open: close - 50, high: close + 150, low: close - 150, close };
    });

    const bb = MathEngine.getLatestBollingerBands(candles, 20, 2.0);
    expect(bb).not.toBeNull();
    expect(bb!.upper).toBeGreaterThan(bb!.middle);
    expect(bb!.middle).toBeGreaterThan(bb!.lower);

    const expectedWidth = (bb!.upper - bb!.lower) / bb!.middle;
    expect(bb!.width).toBeCloseTo(expectedWidth, 8);
    expect(bb!.width).toBeGreaterThan(0.015);
  });

  it('calculates ADX showing high values in strong trend and low values in sideways oscillation', () => {
    const strongTrend = generateSyntheticCandles(60, (i) => {
      const base = 30000 + i * 350;
      return { open: base, high: base + 400, low: base - 40, close: base + 320 };
    });

    const sidewaysRange = generateSyntheticCandles(60, (i) => {
      const offset = (i % 2 === 0 ? 1 : -1) * 300;
      const base = 30000 + offset;
      return { open: base, high: base + 250, low: base - 250, close: base };
    });

    const adxTrend = MathEngine.getLatestADX(strongTrend, 14);
    const adxRange = MathEngine.getLatestADX(sidewaysRange, 14);

    expect(adxTrend).not.toBeNull();
    expect(adxRange).not.toBeNull();
    expect(adxTrend!.adx).toBeGreaterThan(25);
    expect(adxRange!.adx).toBeLessThan(20);
  });

  it('calculates Donchian Channel excluding current candle for breakout verification', () => {
    const candles = generateSyntheticCandles(25, (i) => {
      if (i === 24) {
        // Breakout candle on index 24
        return { open: 1100, high: 1250, low: 1090, close: 1220 };
      }
      return { open: 1000, high: 1100, low: 900, close: 1050 };
    });

    const donchianPrev = MathEngine.getDonchianChannel(candles, 20, true);
    expect(donchianPrev).not.toBeNull();
    expect(donchianPrev!.upper).toBe(1100);
    expect(donchianPrev!.lower).toBe(900);
    expect(candles[candles.length - 1].close).toBeGreaterThan(donchianPrev!.upper);
  });
});
