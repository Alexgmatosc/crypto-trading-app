import { describe, expect, it } from 'vitest';
import { RegimeDetector } from '../src/core/RegimeDetector.js';
import type { Candle } from '../src/types/index.js';

function createCandles(
  count: number,
  fn: (i: number) => { open: number; high: number; low: number; close: number; volume?: number }
): Candle[] {
  const start = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => {
    const bar = fn(i);
    return {
      timestamp: start + i * 15 * 60 * 1000,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume ?? 1000,
    };
  });
}

describe('RegimeDetector', () => {
  const detector = new RegimeDetector();

  it('returns NO_TRADE when historical candle count is insufficient', () => {
    const tooFewCandles = createCandles(15, () => ({
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50000,
    }));

    const result = detector.detect(tooFewCandles);
    expect(result.regime).toBe('NO_TRADE');
    expect(result.reason).toContain('Insufficient candles');
  });

  it('classifies strong directional market as TRENDING (ADX > 23)', () => {
    const trendingCandles = createCandles(60, (i) => {
      const price = 40000 + i * 400;
      return {
        open: price,
        high: price + 450,
        low: price - 50,
        close: price + 380,
      };
    });

    const result = detector.detect(trendingCandles);
    expect(result.regime).toBe('TRENDING');
    expect(result.adx).toBeGreaterThan(23);
  });

  it('classifies sideways oscillation as RANGING (ADX < 20 and BB_Width > 0.0065)', () => {
    const rangingCandles = createCandles(60, (i) => {
      // Alternating oscillation with ~2.5% bandwidth around 50,000
      const phase = i % 4;
      const offset = phase === 0 ? -600 : phase === 1 ? 600 : phase === 2 ? 600 : -600;
      const close = 50000 + offset;
      return {
        open: 50000,
        high: 50800,
        low: 49200,
        close,
      };
    });

    const result = detector.detect(rangingCandles);
    expect(result.adx).toBeLessThan(20);
    expect(result.bbWidth).toBeGreaterThan(0.0065);
    expect(result.regime).toBe('RANGING');
  });

  it('classifies ultra-tight sideways market as NO_TRADE when BB_Width <= 0.0065', () => {
    const tightChopCandles = createCandles(60, (i) => {
      const offset = (i % 2 === 0 ? 1 : -1) * 20; // tiny 0.04% oscillation around 50,000
      const close = 50000 + offset;
      return {
        open: 50000,
        high: 50040,
        low: 49960,
        close,
      };
    });

    const result = detector.detect(tightChopCandles);
    expect(result.adx).toBeLessThan(20);
    expect(result.bbWidth).toBeLessThanOrEqual(0.0065);
    expect(result.regime).toBe('NO_TRADE');
  });

  it('classifies market as NO_TRADE when ADX falls in the dead zone [20, 25]', () => {
    // Use custom thresholds encompassing the measured ADX to deterministically verify the dead-zone branch
    const rangingCandles = createCandles(60, (i) => {
      const offset = Math.sin(i * 0.5) * 600;
      const close = 50000 + offset;
      return {
        open: close - 50,
        high: close + 200,
        low: close - 200,
        close,
      };
    });

    const probe = detector.detect(rangingCandles);
    const deadZoneDetector = new RegimeDetector({
      rangingThreshold: probe.adx - 1,
      trendingThreshold: probe.adx + 1,
    });

    const deadZoneResult = deadZoneDetector.detect(rangingCandles);
    expect(deadZoneResult.regime).toBe('NO_TRADE');
    expect(deadZoneResult.reason).toContain('dead zone');
  });
});
