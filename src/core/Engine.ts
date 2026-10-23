import crypto from 'node:crypto';
import {
  resolveSymbolStrategyConfig,
  strategyConfig,
  type StrategyConfig,
} from '../config/strategyConfig.js';
import { QuantRepository, repository as defaultRepo } from '../db/repository.js';
import {
  isReduceOnlyRejectedError,
  isStopOrderImmediateTriggerError,
  type IExecutionBroker,
} from '../exchange/IExecutionBroker.js';
import { PaperBroker } from '../exchange/PaperBroker.js';
import { MathEngine } from '../indicators/MathEngine.js';
import type {
  Candle,
  EquitySnapshotRecord,
  ExecutionMode,
  ExitReason,
  OrderExecutionResult,
  Signal,
  TradeRecord,
} from '../types/index.js';
import { formatPrice } from '../utils/formatPrice.js';
import { logger } from '../utils/logger.js';
import { RegimeDetector } from './RegimeDetector.js';
import { RiskManager } from './RiskManager.js';
import { MeanReversionStrategy } from './strategies/MeanReversion.js';
import { TrendBreakoutStrategy } from './strategies/TrendBreakout.js';

export { formatPrice };

export interface EngineDependencies {
  mode: ExecutionMode;
  broker: IExecutionBroker;
  repo?: QuantRepository;
  config?: StrategyConfig;
  regimeDetector?: RegimeDetector;
  riskManager?: RiskManager;
  trendStrategy?: TrendBreakoutStrategy;
  meanReversionStrategy?: MeanReversionStrategy;
}

export class Engine {
  private readonly mode: ExecutionMode;
  private readonly broker: IExecutionBroker;
  private readonly repo: QuantRepository;
  private readonly config: StrategyConfig;
  private readonly regimeDetector: RegimeDetector;
  private readonly riskManager: RiskManager;
  private readonly trendStrategy: TrendBreakoutStrategy;
  private readonly meanReversionStrategy: MeanReversionStrategy;
  private peakEquityUsdt: number;
  private maxDrawdownPct = 0;

  // Tracks partial realized PnL by UTC day timestamp for accurate Daily Kill Switch accounting
  private readonly dailyRealizedPnlByDayUtc = new Map<number, number>();
  // Prevents opening a new trade on the exact same 15m candle where a trade was just opened or closed
  private readonly lastCandleTsBySymbol = new Map<string, number>();
  // Enforces a 2-candle (30m) cooldown per symbol after a Stop Loss exit to prevent whipsaw chaining
  private readonly slCooldownUntilBySymbol = new Map<string, number>();

  constructor(deps: EngineDependencies) {
    this.mode = deps.mode;
    this.broker = deps.broker;
    this.repo = deps.repo ?? defaultRepo;
    this.config = deps.config ?? strategyConfig;
    this.regimeDetector = deps.regimeDetector ?? new RegimeDetector(undefined, this.config);
    this.riskManager = deps.riskManager ?? new RiskManager(this.config);
    this.trendStrategy = deps.trendStrategy ?? new TrendBreakoutStrategy(undefined, this.config);
    this.meanReversionStrategy =
      deps.meanReversionStrategy ?? new MeanReversionStrategy(undefined, this.config);
    this.peakEquityUsdt = 0;

    this.hydrateDailyRealizedPnlFromDb();
  }

  private hydrateDailyRealizedPnlFromDb(): void {
    const allTrades = this.repo.getAllTrades(this.mode);
    for (const t of allTrades) {
      const refTs = t.closed_at ?? t.opened_at;
      const dayStartUtcMs = Math.floor(refTs / 86_400_000) * 86_400_000;
      const prev = this.dailyRealizedPnlByDayUtc.get(dayStartUtcMs) ?? 0;
      this.dailyRealizedPnlByDayUtc.set(dayStartUtcMs, prev + t.realized_pnl);
    }
  }

  public getRiskManager(): RiskManager {
    return this.riskManager;
  }

  public getMaxDrawdownPct(): number {
    return this.maxDrawdownPct;
  }

  /**
   * Ensures all currently open trades in SQLite have an active exchange-side STOP_MARKET order.
   * Called on daemon startup to protect any legacy or restarted positions.
   */
  public async ensureOpenTradesProtected(): Promise<void> {
    const openTrades = this.repo.getOpenTrades(this.mode);
    for (const trade of openTrades) {
      if (trade.stop_order_id || trade.remaining_size <= 0) {
        continue;
      }
      try {
        const slRes = await this.broker.placeStopLossOrder({
          symbol: trade.symbol,
          positionSide: trade.side,
          sizeCoins: trade.remaining_size,
          stopPrice: trade.current_sl,
        });
        this.repo.updateTradeStopOrderId(trade.id, slRes.stopOrderId);
      } catch (err) {
        if (isStopOrderImmediateTriggerError(err)) {
          logger.warn(
            {
              tradeId: trade.id,
              symbol: trade.symbol,
              currentSl: formatPrice(trade.current_sl),
            },
            'Startup protection: Stop-Loss already crossed (-2021) — forcing immediate market close'
          );
          await this.closeFullPosition(
            trade,
            trade.current_sl,
            trade.tp1_hit === 1 ? 'TRAILING_STOP' : 'STOP_LOSS',
            Date.now()
          );
        } else {
          logger.error(
            {
              tradeId: trade.id,
              symbol: trade.symbol,
              error: (err as Error).message,
            },
            'Failed to place startup STOP_MARKET order for existing open trade'
          );
        }
      }
    }
  }

  /**
   * Processes the close of a 15m candle for a specific symbol:
   * 1. Evaluates open positions for SL, TP1 (1.5R), Trailing Stop (2.0R), or Mean Target (BB_Middle).
   * 2. Evaluates Daily Kill Switch (-4.0% daily drawdown circuit breaker).
   * 3. Detects market regime (TRENDING | RANGING | NO_TRADE).
   * 4. Dispatches active strategy and opens a new LONG or SHORT position if a signal fires.
   */
  public async processCandleClose(params: {
    symbol: string;
    candles: Candle[];
    markPrices: Record<string, number>;
  }): Promise<void> {
    const { symbol, candles, markPrices } = params;
    if (candles.length === 0) return;

    const latestCandle = candles[candles.length - 1];
    markPrices[symbol] = latestCandle.close;

    const symConfig = resolveSymbolStrategyConfig(this.config, symbol);
    const latestAtr =
      MathEngine.getLatestATR(candles, symConfig.trendStrategy.atrPeriod) ??
      Math.abs(latestCandle.high - latestCandle.low);
    const latestBb = MathEngine.getLatestBollingerBands(
      candles,
      symConfig.meanReversionStrategy.bbPeriod,
      symConfig.meanReversionStrategy.bbStdDev
    );

    // 1. Manage existing open positions for this symbol
    // Guard: Only apply intra-candle high/low extremes if the candle opened AT or AFTER the trade was opened.
    // In TESTNET_LIVE/PAPER_LOCAL, a candle's open timestamp is 15m before its close; if a trade was opened
    // near the end of that window, earlier intra-candle highs/lows happened before the position existed.
    const openSymbolTrades = this.repo.getOpenTrades(this.mode, symbol);
    for (const openTrade of openSymbolTrades) {
      const isFullCandleAfterEntry = latestCandle.timestamp >= openTrade.opened_at;
      await this.evaluateAndExecuteTradeManagement({
        trade: openTrade,
        currentPrice: latestCandle.close,
        currentAtr: latestAtr,
        timestamp: latestCandle.timestamp,
        candleHigh: isFullCandleAfterEntry ? latestCandle.high : undefined,
        candleLow: isFullCandleAfterEntry ? latestCandle.low : undefined,
        bbMiddle: latestBb?.middle,
      });
    }

    // 2. Evaluate Daily Kill Switch (-4.0% circuit breaker)
    const killSwitchTriggered = await this.checkAndEnforceKillSwitch(
      latestCandle.timestamp,
      markPrices
    );
    if (killSwitchTriggered) {
      return;
    }

    // 3. Detect Market Regime
    const regimeState = this.regimeDetector.detect(candles, symbol);
    logger.info(
      {
        symbol,
        close: formatPrice(latestCandle.close),
        regime: regimeState.regime,
        adx: Number(regimeState.adx.toFixed(2)),
        bbWidthPct: Number((regimeState.bbWidth * 100).toFixed(2)),
        reason: regimeState.reason,
      },
      '15m candle close evaluated'
    );
    if (regimeState.regime === 'NO_TRADE') {
      return;
    }

    // 4. Verify same-candle re-entry guard, Stop-Loss cooldown, and RiskManager position limits
    if (this.lastCandleTsBySymbol.get(symbol) === latestCandle.timestamp) {
      return;
    }
    const slCooldownUntil = this.slCooldownUntilBySymbol.get(symbol) ?? 0;
    if (latestCandle.timestamp < slCooldownUntil) {
      logger.debug(
        {
          symbol,
          candleTimestamp: latestCandle.timestamp,
          cooldownUntil: slCooldownUntil,
        },
        'Skipping entry evaluation — symbol in post-StopLoss cooldown'
      );
      return;
    }

    const allOpenTrades = this.repo.getOpenTrades(this.mode);
    const hasOpenInSymbol = allOpenTrades.some((t) => t.symbol === symbol);
    const entryPermission = this.riskManager.canOpenNewPosition({
      currentTimestamp: latestCandle.timestamp,
      openPositionsCount: allOpenTrades.length,
      hasOpenPositionInSymbol: hasOpenInSymbol,
    });

    if (!entryPermission.allowed) {
      return;
    }

    // 5. Evaluate regime-specific strategy
    const signal: Signal | null =
      regimeState.regime === 'TRENDING'
        ? this.trendStrategy.evaluate(symbol, candles, regimeState)
        : this.meanReversionStrategy.evaluate(symbol, candles, regimeState);

    if (signal) {
      const opened = await this.openPositionFromSignal(signal);
      if (opened) {
        this.lastCandleTsBySymbol.set(symbol, latestCandle.timestamp);
      }
    }
  }

  /**
   * Tick-level check (every 10 seconds in PAPER_LOCAL / TESTNET_LIVE) to monitor Stop Loss,
   * Scale-Out, Trailing Stop, and Kill Switch between 15m candle closes.
   */
  public async checkOpenPositionsOnTick(params: {
    markPrices: Record<string, number>;
    candlesBySymbol: Record<string, Candle[]>;
    timestamp: number;
  }): Promise<void> {
    const { markPrices, candlesBySymbol, timestamp } = params;
    const openTrades = this.repo.getOpenTrades(this.mode);
    if (openTrades.length === 0) return;

    for (const trade of openTrades) {
      const currentPrice = markPrices[trade.symbol];
      if (!currentPrice || currentPrice <= 0) continue;

      const symbolCandles = candlesBySymbol[trade.symbol] ?? [];
      const symConfig = resolveSymbolStrategyConfig(this.config, trade.symbol);
      const currentAtr =
        MathEngine.getLatestATR(symbolCandles, symConfig.trendStrategy.atrPeriod) ??
        this.riskManager.getOneR(trade) / symConfig.trendStrategy.slAtrMultiplier;
      const latestBb = MathEngine.getLatestBollingerBands(
        symbolCandles,
        symConfig.meanReversionStrategy.bbPeriod,
        symConfig.meanReversionStrategy.bbStdDev
      );

      await this.evaluateAndExecuteTradeManagement({
        trade,
        currentPrice,
        currentAtr,
        timestamp,
        bbMiddle: latestBb?.middle,
      });
    }

    await this.checkAndEnforceKillSwitch(timestamp, markPrices);
  }

  /**
   * Evaluates and executes full exits, 50% scale-outs at 1.5R, and 2.0R trailing stops.
   */
  private async evaluateAndExecuteTradeManagement(params: {
    trade: TradeRecord;
    currentPrice: number;
    currentAtr: number;
    timestamp: number;
    candleHigh?: number;
    candleLow?: number;
    bbMiddle?: number;
  }): Promise<void> {
    const { trade, currentPrice, currentAtr, timestamp, candleHigh, candleLow, bbMiddle } = params;

    const decision = this.riskManager.evaluatePosition({
      trade,
      currentPrice,
      currentAtr,
      candleHigh,
      candleLow,
      bbMiddle,
    });

    if (decision.shouldFullExit && decision.exitReason) {
      const refExitPrice = decision.exitExecutionPrice ?? currentPrice;
      await this.closeFullPosition(trade, refExitPrice, decision.exitReason, timestamp);
      return;
    }

    if (
      decision.shouldPartialClose &&
      decision.partialCloseSize &&
      decision.partialClosePrice &&
      decision.newSl
    ) {
      await this.executePartialScaleOut(
        trade,
        decision.partialCloseSize,
        decision.partialClosePrice,
        decision.newSl,
        timestamp
      );
      return;
    }

    if (decision.shouldUpdateSl && decision.newSl !== undefined) {
      let updatedStopOrderId: string | null | undefined;
      try {
        const slRes = await this.broker.replaceStopLossOrder({
          symbol: trade.symbol,
          positionSide: trade.side,
          sizeCoins: trade.remaining_size,
          stopPrice: decision.newSl,
          previousStopOrderId: trade.stop_order_id,
        });
        updatedStopOrderId = slRes.stopOrderId;
      } catch (err) {
        if (isStopOrderImmediateTriggerError(err)) {
          logger.warn(
            {
              tradeId: trade.id,
              symbol: trade.symbol,
              side: trade.side,
              newSl: formatPrice(decision.newSl),
              error: (err as Error).message,
            },
            'Trailing Stop price already crossed (-2021) — forcing immediate market close'
          );
          await this.closeFullPosition(trade, decision.newSl, 'TRAILING_STOP', timestamp);
          return;
        }
        logger.error(
          {
            tradeId: trade.id,
            symbol: trade.symbol,
            side: trade.side,
            newSl: formatPrice(decision.newSl),
            error: (err as Error).message,
          },
          'Failed to replace native STOP_MARKET order on trailing stop update'
        );
      }

      this.repo.updateTradeStopLoss(trade.id, decision.newSl, updatedStopOrderId);
      logger.debug(
        {
          tradeId: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          oldSl: formatPrice(trade.current_sl),
          newSl: formatPrice(decision.newSl),
          stopOrderId: updatedStopOrderId ?? trade.stop_order_id,
        },
        'Updated dynamic Trailing Stop Loss'
      );
    }
  }

  /**
   * Opens a new LONG or SHORT position sized by RiskManager Volatility Parity.
   */
  private async openPositionFromSignal(signal: Signal): Promise<TradeRecord | null> {
    const availableBalance = await this.broker.getBalance();
    if (availableBalance <= 0) {
      logger.warn({ availableBalance }, 'Insufficient balance to open new position');
      return null;
    }

    const sizing = this.riskManager.calculatePositionSize({
      availableBalance,
      entryPrice: signal.entryPrice,
      atr: signal.atr,
      side: signal.side,
      strategy: signal.strategy,
      symbol: signal.symbol,
    });

    if (sizing.sizeCoins <= 0) {
      return null;
    }

    const orderSide = signal.side === 'LONG' ? 'BUY' : 'SELL';
    let exec: OrderExecutionResult;
    try {
      exec = await this.broker.executeMarketOrder({
        symbol: signal.symbol,
        orderSide,
        positionSide: signal.side,
        sizeCoins: sizing.sizeCoins,
        referencePrice: signal.entryPrice,
        timestamp: signal.timestamp,
        reduceOnly: false,
      });
    } catch (err) {
      logger.warn(
        {
          symbol: signal.symbol,
          side: signal.side,
          error: (err as Error).message,
        },
        'Broker order execution failed (e.g. margin or exchange restriction) — trade skipped safely'
      );
      return null;
    }

    if (this.broker instanceof PaperBroker) {
      this.broker.adjustBalance(-exec.feeUsd);
    }

    // Anchor initial SL directly to exec.filledPrice by exact sizing.slDistance so that
    // getOneR(trade) = |entry_price - initial_sl| is never distorted.
    const actualInitialSl =
      signal.side === 'LONG'
        ? exec.filledPrice - sizing.slDistance
        : exec.filledPrice + sizing.slDistance;

    let stopOrderId: string | null = null;
    let immediateSlTriggered = false;
    try {
      const slRes = await this.broker.placeStopLossOrder({
        symbol: signal.symbol,
        positionSide: signal.side,
        sizeCoins: exec.filledSize,
        stopPrice: actualInitialSl,
      });
      stopOrderId = slRes.stopOrderId;
    } catch (err) {
      if (isStopOrderImmediateTriggerError(err)) {
        logger.warn(
          {
            symbol: signal.symbol,
            side: signal.side,
            initialSl: formatPrice(actualInitialSl),
            error: (err as Error).message,
          },
          'Stop-Loss trigger price already crossed on entry (-2021) — forcing immediate market close'
        );
        immediateSlTriggered = true;
      } else {
        logger.error(
          {
            symbol: signal.symbol,
            side: signal.side,
            initialSl: formatPrice(actualInitialSl),
            error: (err as Error).message,
          },
          'Failed to place native STOP_MARKET order on exchange — local 10s SL monitor remains active'
        );
      }
    }

    const tradeRecord: TradeRecord = {
      id: crypto.randomUUID(),
      mode: this.mode,
      symbol: signal.symbol,
      strategy: signal.strategy,
      regime_at_entry: signal.regime,
      side: signal.side,
      entry_price: exec.filledPrice,
      exit_price: null,
      initial_size: exec.filledSize,
      remaining_size: exec.filledSize,
      initial_sl: actualInitialSl,
      current_sl: actualInitialSl,
      stop_order_id: stopOrderId,
      tp1_hit: 0,
      realized_pnl: -exec.feeUsd,
      fees_paid: exec.feeUsd,
      status: 'OPEN',
      exit_reason: null,
      opened_at: exec.timestamp,
      closed_at: null,
    };

    this.repo.insertTrade(tradeRecord);
    this.addDailyRealizedPnl(exec.timestamp, -exec.feeUsd);
    this.lastCandleTsBySymbol.set(signal.symbol, signal.timestamp);

    logger.info(
      {
        tradeId: tradeRecord.id,
        mode: this.mode,
        symbol: tradeRecord.symbol,
        strategy: tradeRecord.strategy,
        regime: tradeRecord.regime_at_entry,
        side: tradeRecord.side,
        entryPrice: formatPrice(tradeRecord.entry_price),
        size: Number(tradeRecord.initial_size.toFixed(6)),
        initialSl: formatPrice(tradeRecord.initial_sl),
        stopOrderId: tradeRecord.stop_order_id,
        riskUsd: Number(sizing.riskUsd.toFixed(2)),
      },
      'Opened new position'
    );

    if (immediateSlTriggered) {
      await this.closeFullPosition(tradeRecord, actualInitialSl, 'STOP_LOSS', Date.now());
      return this.repo.getTradeById(tradeRecord.id) ?? tradeRecord;
    }

    return tradeRecord;
  }

  /**
   * Executes 50% partial close at 1.5R and moves SL to Break-Even + Costs.
   */
  private async executePartialScaleOut(
    trade: TradeRecord,
    closeSize: number,
    referencePrice: number,
    newBreakEvenSl: number,
    timestamp: number
  ): Promise<void> {
    const closeOrderSide = trade.side === 'LONG' ? 'SELL' : 'BUY';
    let exec: OrderExecutionResult;
    try {
      exec = await this.broker.executeMarketOrder({
        symbol: trade.symbol,
        orderSide: closeOrderSide,
        positionSide: trade.side,
        sizeCoins: closeSize,
        referencePrice,
        timestamp,
        reduceOnly: true,
      });
    } catch (err) {
      logger.error(
        {
          tradeId: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          closeSize,
          error: (err as Error).message,
        },
        'Failed to execute partial scale-out order on broker — will retry on next evaluation'
      );
      return;
    }

    const grossPnl =
      (trade.side === 'LONG'
        ? exec.filledPrice - trade.entry_price
        : trade.entry_price - exec.filledPrice) * exec.filledSize;

    const netPnlDelta = grossPnl - exec.feeUsd;
    const remainingSize = Math.max(0, trade.remaining_size - exec.filledSize);

    if (this.broker instanceof PaperBroker) {
      this.broker.adjustBalance(netPnlDelta);
    }

    let updatedStopOrderId: string | null = trade.stop_order_id ?? null;
    let immediateSlTriggered = false;
    if (remainingSize > 0) {
      try {
        const slRes = await this.broker.replaceStopLossOrder({
          symbol: trade.symbol,
          positionSide: trade.side,
          sizeCoins: remainingSize,
          stopPrice: newBreakEvenSl,
          previousStopOrderId: trade.stop_order_id,
        });
        updatedStopOrderId = slRes.stopOrderId;
      } catch (err) {
        if (isStopOrderImmediateTriggerError(err)) {
          logger.warn(
            {
              tradeId: trade.id,
              symbol: trade.symbol,
              side: trade.side,
              newBreakEvenSl: formatPrice(newBreakEvenSl),
              error: (err as Error).message,
            },
            'Break-Even SL already crossed during scale-out (-2021) — forcing immediate market close of remaining size'
          );
          immediateSlTriggered = true;
        } else {
          logger.error(
            {
              tradeId: trade.id,
              symbol: trade.symbol,
              side: trade.side,
              newBreakEvenSl: formatPrice(newBreakEvenSl),
              error: (err as Error).message,
            },
            'Failed to replace native STOP_MARKET order after scale-out'
          );
        }
      }
    }

    const updatedTrade = this.repo.updateTradePartialClose({
      id: trade.id,
      remainingSize,
      currentSl: newBreakEvenSl,
      stopOrderId: updatedStopOrderId,
      realizedPnlDelta: netPnlDelta,
      feesPaidDelta: exec.feeUsd,
    });

    this.addDailyRealizedPnl(timestamp, netPnlDelta);

    logger.info(
      {
        tradeId: trade.id,
        symbol: trade.symbol,
        side: trade.side,
        closedSize: Number(exec.filledSize.toFixed(6)),
        remainingSize: Number(remainingSize.toFixed(6)),
        fillPrice: formatPrice(exec.filledPrice),
        netPnlDelta: Number(netPnlDelta.toFixed(2)),
        newBreakEvenSl: formatPrice(newBreakEvenSl),
        stopOrderId: updatedStopOrderId,
      },
      'Executed 1.5R 50% Scale-Out and moved SL to Break-Even + Costs'
    );

    if (immediateSlTriggered && updatedTrade) {
      await this.closeFullPosition(updatedTrade, newBreakEvenSl, 'TRAILING_STOP', timestamp);
    }
  }

  /**
   * Closes the remaining size of an open position completely.
   */
  public async closeFullPosition(
    trade: TradeRecord,
    referencePrice: number,
    exitReason: ExitReason,
    timestamp: number
  ): Promise<void> {
    if (trade.remaining_size <= 0 || trade.status === 'CLOSED') {
      return;
    }

    // Cancel any active native STOP_MARKET order on the exchange so it never remains orphaned
    if (trade.stop_order_id) {
      await this.broker.cancelStopLossOrder(trade.symbol, trade.stop_order_id);
    }

    const closeOrderSide = trade.side === 'LONG' ? 'SELL' : 'BUY';
    let exec: OrderExecutionResult;
    try {
      exec = await this.broker.executeMarketOrder({
        symbol: trade.symbol,
        orderSide: closeOrderSide,
        positionSide: trade.side,
        sizeCoins: trade.remaining_size,
        referencePrice,
        timestamp,
        reduceOnly: true,
      });
    } catch (err) {
      if (isReduceOnlyRejectedError(err)) {
        // The native STOP_MARKET order on Binance already executed and closed the position on the exchange
        const filledPrice = referencePrice;
        const filledSize = trade.remaining_size;
        const notionalUsd = filledPrice * filledSize;
        const feeUsd = notionalUsd * this.config.fees.taker;
        exec = {
          filledPrice,
          filledSize,
          notionalUsd,
          feeUsd,
          timestamp,
          orderId: trade.stop_order_id ?? `reconciled-sl-${trade.id}`,
        };
        logger.info(
          {
            tradeId: trade.id,
            symbol: trade.symbol,
            side: trade.side,
            exitReason,
            reconciledExitPrice: formatPrice(filledPrice),
          },
          'Position already closed on exchange by native STOP_MARKET (-2022) — reconciling trade as CLOSED'
        );
      } else {
        logger.error(
          {
            tradeId: trade.id,
            symbol: trade.symbol,
            side: trade.side,
            exitReason,
            remainingSize: trade.remaining_size,
            error: (err as Error).message,
          },
          'Failed to execute full position close order on broker — keeping trade OPEN for safe retry'
        );
        return;
      }
    }

    const grossPnl =
      (trade.side === 'LONG'
        ? exec.filledPrice - trade.entry_price
        : trade.entry_price - exec.filledPrice) * exec.filledSize;

    const netPnlDelta = grossPnl - exec.feeUsd;

    if (this.broker instanceof PaperBroker) {
      this.broker.adjustBalance(netPnlDelta);
    }

    const updated = this.repo.closeTrade({
      id: trade.id,
      exitPrice: exec.filledPrice,
      realizedPnlDelta: netPnlDelta,
      feesPaidDelta: exec.feeUsd,
      exitReason,
      closedAt: timestamp,
    });

    this.addDailyRealizedPnl(timestamp, netPnlDelta);
    this.lastCandleTsBySymbol.set(trade.symbol, timestamp);

    if (exitReason === 'STOP_LOSS') {
      // Block new entries in this symbol for 2 candles of 15m (30 minutes)
      this.slCooldownUntilBySymbol.set(trade.symbol, timestamp + 30 * 60 * 1000);
    }

    logger.info(
      {
        tradeId: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        side: trade.side,
        exitReason,
        entryPrice: formatPrice(trade.entry_price),
        exitPrice: formatPrice(exec.filledPrice),
        totalRealizedPnl: Number((updated?.realized_pnl ?? netPnlDelta).toFixed(2)),
      },
      'Closed position completely'
    );
  }

  /**
   * Evaluates the Daily Kill Switch (-4.0% daily loss limit) and liquidates all open positions if breached.
   * Queries SQLite trades closed today as a persistent floor so process restarts never reset daily losses.
   */
  private async checkAndEnforceKillSwitch(
    timestamp: number,
    markPrices: Record<string, number>
  ): Promise<boolean> {
    const currentBalance = this.broker.getBalanceSync();
    const openTrades = this.repo.getOpenTrades(this.mode);

    let unrealizedPnl = 0;
    for (const t of openTrades) {
      const mark = markPrices[t.symbol] ?? t.entry_price;
      unrealizedPnl += RiskManager.calculateUnrealizedPnl(t, mark);
    }

    const dayStartUtcMs = Math.floor(timestamp / 86_400_000) * 86_400_000;
    const dayEndUtcMs = dayStartUtcMs + 86_400_000;

    let dbDailyRealizedPnl = 0;
    const closedTrades = this.repo.getClosedTrades(this.mode);
    for (const t of closedTrades) {
      const closedTs = t.closed_at ?? t.opened_at;
      if (closedTs >= dayStartUtcMs && closedTs < dayEndUtcMs) {
        dbDailyRealizedPnl += t.realized_pnl;
      }
    }
    for (const t of openTrades) {
      if (t.opened_at >= dayStartUtcMs && t.opened_at < dayEndUtcMs) {
        dbDailyRealizedPnl += t.realized_pnl;
      }
    }

    const memDailyRealizedPnl = this.dailyRealizedPnlByDayUtc.get(dayStartUtcMs);
    const dailyRealizedPnl = memDailyRealizedPnl !== undefined
      ? Math.min(memDailyRealizedPnl, dbDailyRealizedPnl)
      : dbDailyRealizedPnl;

    const ksState = this.riskManager.evaluateDailyKillSwitch({
      currentTimestamp: timestamp,
      currentBalance,
      dailyRealizedPnl,
      unrealizedPnl,
    });

    if (ksState.triggered && openTrades.length > 0) {
      logger.warn(
        {
          timestamp: new Date(timestamp).toISOString(),
          dailyLossPct: Number((ksState.dailyLossPct * 100).toFixed(2)),
          lockedUntil: ksState.lockedUntilMs
            ? new Date(ksState.lockedUntilMs).toISOString()
            : null,
        },
        'DAILY KILL SWITCH TRIGGERED (-4.0% daily drawdown breached). Liquidating all open positions and locking for 24h!'
      );

      for (const openTrade of openTrades) {
        const refPrice = markPrices[openTrade.symbol] ?? openTrade.entry_price;
        await this.closeFullPosition(openTrade, refPrice, 'KILL_SWITCH', timestamp);
      }

      return true;
    }

    return ksState.isLocked;
  }

  /**
   * Computes current balance, equity (balance + unrealized PnL), and drawdown,
   * and persists an equity snapshot to SQLite.
   */
  public recordEquitySnapshot(
    timestamp: number,
    markPrices: Record<string, number>
  ): EquitySnapshotRecord {
    const balanceUsdt = this.broker.getBalanceSync();
    const openTrades = this.repo.getOpenTrades(this.mode);

    let unrealizedPnl = 0;
    for (const t of openTrades) {
      const mark = markPrices[t.symbol] ?? t.entry_price;
      unrealizedPnl += RiskManager.calculateUnrealizedPnl(t, mark);
    }

    const equityUsdt = balanceUsdt + unrealizedPnl;
    if (this.peakEquityUsdt <= 0 || equityUsdt > this.peakEquityUsdt) {
      this.peakEquityUsdt = equityUsdt;
    }

    const drawdownPct =
      this.peakEquityUsdt > 0
        ? ((this.peakEquityUsdt - equityUsdt) / this.peakEquityUsdt) * 100
        : 0;

    if (drawdownPct > this.maxDrawdownPct) {
      this.maxDrawdownPct = drawdownPct;
    }

    const snapshot: EquitySnapshotRecord = {
      timestamp,
      mode: this.mode,
      balance_usdt: balanceUsdt,
      equity_usdt: equityUsdt,
      drawdown_pct: drawdownPct,
    };

    this.repo.insertEquitySnapshot(snapshot);
    return snapshot;
  }

  private addDailyRealizedPnl(timestamp: number, pnlDelta: number): void {
    const dayStartUtcMs = Math.floor(timestamp / 86_400_000) * 86_400_000;
    const prev = this.dailyRealizedPnlByDayUtc.get(dayStartUtcMs) ?? 0;
    this.dailyRealizedPnlByDayUtc.set(dayStartUtcMs, prev + pnlDelta);
  }
}
