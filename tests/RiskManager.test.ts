import { describe, expect, it } from 'vitest';
import { strategyConfig } from '../src/config/strategyConfig.js';
import { RiskManager } from '../src/core/RiskManager.js';
import { MeanReversionStrategy } from '../src/core/strategies/MeanReversion.js';
import { TrendBreakoutStrategy } from '../src/core/strategies/TrendBreakout.js';
import type { Candle, TradeRecord } from '../src/types/index.js';

function createBaseTrade(overrides?: Partial<TradeRecord>): TradeRecord {
  return {
    id: 'test-trade-1',
    mode: 'BACKTEST',
    symbol: 'BTC/USDT',
    strategy: 'TREND_BREAKOUT',
    regime_at_entry: 'TRENDING',
    side: 'LONG',
    entry_price: 50000,
    exit_price: null,
    initial_size: 0.2,
    remaining_size: 0.2,
    initial_sl: 49250, // One_R = 750
    current_sl: 49250,
    tp1_hit: 0,
    realized_pnl: 0,
    fees_paid: 0,
    status: 'OPEN',
    exit_reason: null,
    opened_at: 1_700_000_000_000,
    closed_at: null,
    ...overrides,
  };
}

describe('RiskManager', () => {
  it('sizes LONG and SHORT positions so a Stop Loss never drains more than 1.5% (+ fees) of balance', () => {
    const rm = new RiskManager();
    const balance = 10000;
    const entryPrice = 60000;
    const atr = 800; // 1.5 * 800 = 1200 SL distance (2% price move -> not margin capped)

    // LONG Trend Breakout
    const longSizing = rm.calculatePositionSize({
      availableBalance: balance,
      entryPrice,
      atr,
      side: 'LONG',
      strategy: 'TREND_BREAKOUT',
    });

    expect(longSizing.slDistance).toBeCloseTo(1200, 6);
    expect(longSizing.initialSl).toBeCloseTo(58800, 6);
    expect(longSizing.riskUsd).toBeCloseTo(150, 6); // 1.5% of 10,000 = $150
    expect(longSizing.sizeCoins).toBeCloseTo(150 / 1200, 6);

    // Verify gross loss at SL is <= 1.5% of balance
    const grossLossLong = (entryPrice - longSizing.initialSl) * longSizing.sizeCoins;
    expect(grossLossLong).toBeLessThanOrEqual(balance * 0.015 + 1e-6);

    // SHORT Mean Reversion (1.2 * ATR)
    const shortSizing = rm.calculatePositionSize({
      availableBalance: balance,
      entryPrice,
      atr,
      side: 'SHORT',
      strategy: 'MEAN_REVERSION',
    });

    expect(shortSizing.slDistance).toBeCloseTo(960, 6);
    expect(shortSizing.initialSl).toBeCloseTo(60960, 6);
    expect(shortSizing.riskUsd).toBeCloseTo(150, 6);

    const grossLossShort = (shortSizing.initialSl - entryPrice) * shortSizing.sizeCoins;
    expect(grossLossShort).toBeLessThanOrEqual(balance * 0.015 + 1e-6);
  });

  it('enforces the 95% leverage margin cap when ATR is very tight', () => {
    const rm = new RiskManager();
    const balance = 10000;
    const entryPrice = 50000;
    const tinyAtr = 100; // SL distance = 150 (0.3% move), uncapped notional would be $50,000 > $9,500

    const sizing = rm.calculatePositionSize({
      availableBalance: balance,
      entryPrice,
      atr: tinyAtr,
      side: 'LONG',
      strategy: 'TREND_BREAKOUT',
    });

    const maxAllowedNotional = balance * strategyConfig.leverage * 0.95;
    expect(sizing.notionalUsd).toBeCloseTo(maxAllowedNotional, 6);
    expect(sizing.sizeCoins).toBeCloseTo(maxAllowedNotional / entryPrice, 6);
    expect(sizing.riskUsd).toBeLessThan(balance * 0.015);
  });

  it('triggers 50% Scale-Out at 1.5R and moves SL to Break-Even + Costs making the trade risk-free (LONG & SHORT)', () => {
    const rm = new RiskManager();

    // LONG Trade: Entry = 50,000, Initial SL = 49,000 -> One_R = 1,000, 1.5R = 51,500
    const longTrade = createBaseTrade({
      side: 'LONG',
      entry_price: 50000,
      initial_sl: 49000,
      current_sl: 49000,
      initial_size: 0.15,
      remaining_size: 0.15,
    });

    const evalLong = rm.evaluatePosition({
      trade: longTrade,
      currentPrice: 51500,
      currentAtr: 600,
    });

    expect(evalLong.shouldFullExit).toBe(false);
    expect(evalLong.shouldPartialClose).toBe(true);
    expect(evalLong.partialCloseSize).toBeCloseTo(0.075, 6); // 50% of 0.15
    expect(evalLong.shouldUpdateSl).toBe(true);
    expect(evalLong.newSl).toBeCloseTo(50000 * 1.0015, 6); // 50,075 Break-Even + Costs

    // Verify that if price reverses to the new Break-Even SL (50,075), total trade PnL is strictly positive even after taker fees + slippage
    const feeRate = strategyConfig.fees.taker + strategyConfig.fees.slippage; // 0.0009
    const entryFee = 50000 * 0.15 * feeRate;
    const partialExitGross = (51500 - 50000) * 0.075;
    const partialExitFee = 51500 * 0.075 * feeRate;
    const beExitGross = (evalLong.newSl! - 50000) * 0.075;
    const beExitFee = evalLong.newSl! * 0.075 * feeRate;
    const totalNetPnlLong =
      partialExitGross + beExitGross - (entryFee + partialExitFee + beExitFee);

    expect(totalNetPnlLong).toBeGreaterThan(0);

    // SHORT Trade: Entry = 50,000, Initial SL = 51,000 -> One_R = 1,000, 1.5R = 48,500
    const shortTrade = createBaseTrade({
      side: 'SHORT',
      entry_price: 50000,
      initial_sl: 51000,
      current_sl: 51000,
      initial_size: 0.15,
      remaining_size: 0.15,
    });

    const evalShort = rm.evaluatePosition({
      trade: shortTrade,
      currentPrice: 48500,
      currentAtr: 600,
    });

    expect(evalShort.shouldPartialClose).toBe(true);
    expect(evalShort.partialCloseSize).toBeCloseTo(0.075, 6);
    expect(evalShort.shouldUpdateSl).toBe(true);
    expect(evalShort.newSl).toBeCloseTo(50000 * 0.9985, 6); // 49,925 Break-Even + Costs
  });

  it('activates dynamic trailing stop at >= 2.0R on remaining 50% position (LONG & SHORT)', () => {
    const rm = new RiskManager();

    // LONG after TP1 hit: Entry = 50,000, One_R = 1,000 -> 2.0R = 52,000
    const longAfterTp1 = createBaseTrade({
      side: 'LONG',
      entry_price: 50000,
      initial_sl: 49000,
      current_sl: 50075, // Break-even
      initial_size: 0.15,
      remaining_size: 0.075,
      tp1_hit: 1,
    });

    const evalTrailLong = rm.evaluatePosition({
      trade: longAfterTp1,
      currentPrice: 52500, // 2.5R
      currentAtr: 500, // 1.5 * 500 = 750 -> New SL = 52,500 - 750 = 51,750
    });

    expect(evalTrailLong.shouldUpdateSl).toBe(true);
    expect(evalTrailLong.newSl).toBeCloseTo(51750, 6);

    // SHORT after TP1 hit: Entry = 50,000, One_R = 1,000 -> 2.0R = 48,000
    const shortAfterTp1 = createBaseTrade({
      side: 'SHORT',
      entry_price: 50000,
      initial_sl: 51000,
      current_sl: 49925,
      initial_size: 0.15,
      remaining_size: 0.075,
      tp1_hit: 1,
    });

    const evalTrailShort = rm.evaluatePosition({
      trade: shortAfterTp1,
      currentPrice: 47500, // 2.5R
      currentAtr: 500, // 1.5 * 500 = 750 -> New SL = 47,500 + 750 = 48,250
    });

    expect(evalTrailShort.shouldUpdateSl).toBe(true);
    expect(evalTrailShort.newSl).toBeCloseTo(48250, 6);
  });

  it('triggers Daily Kill Switch at -4.0% daily drawdown and locks new entries for 24 hours', () => {
    const rm = new RiskManager();
    const t0 = Date.UTC(2026, 5, 1, 10, 0, 0);

    // -2.5% loss -> not triggered
    const state1 = rm.evaluateDailyKillSwitch({
      currentTimestamp: t0,
      currentBalance: 9850,
      dailyRealizedPnl: -150,
      unrealizedPnl: -100,
      explicitDayOpeningBalance: 10000,
    });
    expect(state1.triggered).toBe(false);
    expect(state1.isLocked).toBe(false);

    // -4.1% loss -> triggered!
    const state2 = rm.evaluateDailyKillSwitch({
      currentTimestamp: t0 + 15 * 60 * 1000,
      currentBalance: 9700,
      dailyRealizedPnl: -300,
      unrealizedPnl: -110,
      explicitDayOpeningBalance: 10000,
    });
    expect(state2.triggered).toBe(true);
    expect(state2.isLocked).toBe(true);
    expect(rm.isEntryLocked(t0 + 12 * 3600 * 1000)).toBe(true);
    expect(rm.isEntryLocked(t0 + 25 * 3600 * 1000)).toBe(false);
  });

  it('generates bidirectional signals in TrendBreakoutStrategy and MeanReversionStrategy', () => {
    const trendStrategy = new TrendBreakoutStrategy();
    const mrStrategy = new MeanReversionStrategy();

    // 1. TrendBreakout LONG
    const uptrendCandles: Candle[] = Array.from({ length: 210 }, (_, i) => {
      const base = 40000 + i * 50;
      if (i === 209) {
        return {
          timestamp: 1_700_000_000_000 + i * 900_000,
          open: base,
          high: base + 600,
          low: base - 20,
          close: base + 550,
          volume: 2500, // > 1.2 * 1000
        };
      }
      return {
        timestamp: 1_700_000_000_000 + i * 900_000,
        open: base - 20,
        high: base + 80,
        low: base - 80,
        close: base,
        volume: 1000,
      };
    });

    const longTrendSignal = trendStrategy.evaluate('BTC/USDT', uptrendCandles, {
      regime: 'TRENDING',
      adx: 32,
      bbWidth: 0.03,
      bbUpper: 51000,
      bbMiddle: 50000,
      bbLower: 49000,
      reason: 'Trending',
    });

    expect(longTrendSignal).not.toBeNull();
    expect(longTrendSignal!.side).toBe('LONG');
    expect(longTrendSignal!.strategy).toBe('TREND_BREAKOUT');

    // 2. MeanReversion LONG (oversold bounce back inside lower Bollinger Band)
    const mrCandles: Candle[] = Array.from({ length: 40 }, (_, i) => {
      let close = 50000;
      if (i >= 25 && i <= 37) {
        close = 50000 - (i - 24) * 180; // steady drop to push RSI < 30
      } else if (i === 38) {
        close = 47200; // previous candle closes below BB_Lower
      } else if (i === 39) {
        close = 47950; // current candle bounces back inside BB_Lower while RSI still oversold
      }
      return {
        timestamp: 1_700_000_000_000 + i * 900_000,
        open: close,
        high: close + 100,
        low: close - 100,
        close,
        volume: 1000,
      };
    });

    const mrSignal = mrStrategy.evaluate('BTC/USDT', mrCandles, {
      regime: 'RANGING',
      adx: 16,
      bbWidth: 0.025,
      bbUpper: 50500,
      bbMiddle: 49000,
      bbLower: 47500,
      reason: 'Ranging',
    });

    expect(mrSignal).not.toBeNull();
    expect(mrSignal!.side).toBe('LONG');
    expect(mrSignal!.strategy).toBe('MEAN_REVERSION');
  });
});
