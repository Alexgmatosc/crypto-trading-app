import { describe, expect, it, vi } from 'vitest';
import { strategyConfig } from '../src/config/strategyConfig.js';
import { Engine } from '../src/core/Engine.js';
import { QuantRepository } from '../src/db/repository.js';
import type {
  ExecuteMarketOrderParams,
  IExecutionBroker,
  PlaceStopLossOrderParams,
  ReplaceStopLossOrderParams,
  StopLossOrderResult,
} from '../src/exchange/IExecutionBroker.js';
import type { Candle, OrderExecutionResult } from '../src/types/index.js';

function createTrendingBreakoutCandles(): Candle[] {
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

  // Final breakout candle: strong volume, closes near top of range above Donchian(30)
  const prevClose = candles[candles.length - 1].close;
  const breakoutClose = prevClose + 4.5;
  candles.push({
    timestamp: startTs + 250 * 900_000,
    open: prevClose,
    high: breakoutClose + 0.2,
    low: prevClose - 0.2,
    close: breakoutClose,
    volume: 3500,
  });

  return candles;
}

describe('Engine Native Exchange Stop-Loss Lifecycle (Area 5)', () => {
  it('places native STOP_MARKET on entry, replaces on 1.5R scale-out & 2.0R trailing, and cancels on exit', async () => {
    const repo = new QuantRepository(':memory:');
    let slCounter = 0;

    const placeStopSpy = vi.fn(
      async (params: PlaceStopLossOrderParams): Promise<StopLossOrderResult> => ({
        stopOrderId: `algo-sl-${++slCounter}`,
        stopPrice: params.stopPrice,
        sizeCoins: params.sizeCoins,
      })
    );
    const cancelStopSpy = vi.fn(async (_symbol: string, _stopOrderId?: string | null) => {});
    const replaceStopSpy = vi.fn(
      async (params: ReplaceStopLossOrderParams): Promise<StopLossOrderResult> => {
        if (params.previousStopOrderId) {
          await cancelStopSpy(params.symbol, params.previousStopOrderId);
        }
        return placeStopSpy(params);
      }
    );

    const mockBroker: IExecutionBroker = {
      initialize: async () => {},
      getBalance: async () => 5000,
      getBalanceSync: () => 5000,
      executeMarketOrder: async (params: ExecuteMarketOrderParams): Promise<OrderExecutionResult> => ({
        filledPrice: params.referencePrice,
        filledSize: params.sizeCoins,
        notionalUsd: params.referencePrice * params.sizeCoins,
        feeUsd: params.referencePrice * params.sizeCoins * 0.0005,
        timestamp: params.timestamp,
        orderId: `ord-${++slCounter}`,
      }),
      placeStopLossOrder: placeStopSpy,
      cancelStopLossOrder: cancelStopSpy,
      replaceStopLossOrder: replaceStopSpy,
    };

    const engine = new Engine({
      mode: 'TESTNET_LIVE',
      broker: mockBroker,
      repo,
      config: strategyConfig,
    });

    const candles = createTrendingBreakoutCandles();
    const markPrices: Record<string, number> = {};

    // 1. Trigger entry
    await engine.processCandleClose({
      symbol: 'DOGE/USDT',
      candles,
      markPrices,
    });

    const openTrades = repo.getOpenTrades('TESTNET_LIVE', 'DOGE/USDT');
    expect(openTrades).toHaveLength(1);
    const trade = openTrades[0];
    expect(placeStopSpy).toHaveBeenCalledTimes(1);
    expect(trade.stop_order_id).toBe('algo-sl-2');

    const oneR = Math.abs(trade.entry_price - trade.initial_sl);

    // 2. Simulate price reaching 1.6R -> triggers 50% scale-out and replaces SL to Break-Even
    const tp1Price = trade.entry_price + 1.6 * oneR;
    await engine.checkOpenPositionsOnTick({
      markPrices: { 'DOGE/USDT': tp1Price },
      candlesBySymbol: { 'DOGE/USDT': candles },
      timestamp: trade.opened_at + 10_000,
    });

    const afterScaleOut = repo.getTradeById(trade.id)!;
    expect(afterScaleOut.tp1_hit).toBe(1);
    expect(replaceStopSpy).toHaveBeenCalledTimes(1);
    expect(cancelStopSpy).toHaveBeenCalledWith('DOGE/USDT', 'algo-sl-2');
    expect(afterScaleOut.stop_order_id).toBe('algo-sl-4');
    expect(afterScaleOut.current_sl).toBeGreaterThan(afterScaleOut.entry_price);

    // 3. Simulate price reaching 3.5R -> triggers Trailing Stop update and replaces SL on exchange
    const trailPrice = trade.entry_price + 3.5 * oneR;
    await engine.checkOpenPositionsOnTick({
      markPrices: { 'DOGE/USDT': trailPrice },
      candlesBySymbol: { 'DOGE/USDT': candles },
      timestamp: trade.opened_at + 20_000,
    });

    const afterTrailing = repo.getTradeById(trade.id)!;
    expect(replaceStopSpy).toHaveBeenCalledTimes(2);
    expect(cancelStopSpy).toHaveBeenCalledWith('DOGE/USDT', 'algo-sl-4');
    expect(afterTrailing.stop_order_id).toBe('algo-sl-5');
    expect(afterTrailing.current_sl).toBeGreaterThan(afterScaleOut.current_sl);

    // 4. Simulate full exit -> cancels active STOP_MARKET order and clears stop_order_id
    await engine.closeFullPosition(
      afterTrailing,
      afterTrailing.current_sl,
      'TRAILING_STOP',
      trade.opened_at + 30_000
    );

    const closedTrade = repo.getTradeById(trade.id)!;
    expect(closedTrade.status).toBe('CLOSED');
    expect(closedTrade.stop_order_id).toBeNull();
    expect(cancelStopSpy).toHaveBeenCalledWith('DOGE/USDT', 'algo-sl-5');
  });

  it('forces immediate market close if Binance returns -2021 (Order would immediately trigger) on SL placement', async () => {
    const repo = new QuantRepository(':memory:');
    const executeMarketSpy = vi.fn(
      async (params: ExecuteMarketOrderParams): Promise<OrderExecutionResult> => ({
        filledPrice: params.referencePrice,
        filledSize: params.sizeCoins,
        notionalUsd: params.referencePrice * params.sizeCoins,
        feeUsd: params.referencePrice * params.sizeCoins * 0.0005,
        timestamp: params.timestamp,
        orderId: `ord-${Date.now()}`,
      })
    );

    const mockBroker: IExecutionBroker = {
      initialize: async () => {},
      getBalance: async () => 5000,
      getBalanceSync: () => 5000,
      executeMarketOrder: executeMarketSpy,
      placeStopLossOrder: async () => {
        throw new Error('binanceusdm {"code":-2021,"msg":"Order would immediately trigger."}');
      },
      cancelStopLossOrder: async () => {},
      replaceStopLossOrder: async () => {
        throw new Error('binanceusdm {"code":-2021,"msg":"Order would immediately trigger."}');
      },
    };

    const engine = new Engine({
      mode: 'TESTNET_LIVE',
      broker: mockBroker,
      repo,
      config: strategyConfig,
    });

    const candles = createTrendingBreakoutCandles();
    await engine.processCandleClose({
      symbol: 'DOGE/USDT',
      candles,
      markPrices: {},
    });

    const allTrades = repo.getAllTrades('TESTNET_LIVE');
    expect(allTrades).toHaveLength(1);
    expect(allTrades[0].status).toBe('CLOSED');
    expect(allTrades[0].exit_reason).toBe('STOP_LOSS');
    // 1st call = entry BUY, 2nd call = immediate emergency close SELL (reduceOnly: true)
    expect(executeMarketSpy).toHaveBeenCalledTimes(2);
    expect(executeMarketSpy.mock.calls[1][0].reduceOnly).toBe(true);
  });
});
