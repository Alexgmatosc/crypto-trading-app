import crypto from 'node:crypto';
import { strategyConfig, type StrategyConfig } from '../config/strategyConfig.js';
import { QuantRepository, repository as defaultRepo } from '../db/repository.js';
import type { IExecutionBroker } from '../exchange/IExecutionBroker.js';
import { PaperBroker } from '../exchange/PaperBroker.js';
import { MathEngine } from '../indicators/MathEngine.js';
import type {
  Candle,
  EquitySnapshotRecord,
  ExecutionMode,
  ExitReason,
  Signal,
  TradeRecord,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { RegimeDetector } from './RegimeDetector.js';
import { RiskManager } from './RiskManager.js';
import { MeanReversionStrategy } from './strategies/MeanReversion.js';
import { TrendBreakoutStrategy } from './strategies/TrendBreakout.js';

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
  }

  public getRiskManager(): RiskManager {
    return this.riskManager;
  }

  public getMaxDrawdownPct(): number {
    return this.maxDrawdownPct;
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

    const latestAtr =
      MathEngine.getLatestATR(candles, this.config.trendStrategy.atrPeriod) ??
      Math.abs(latestCandle.high - latestCandle.low);
    const latestBb = MathEngine.getLatestBollingerBands(
      candles,
      this.config.meanReversionStrategy.bbPeriod,
      this.config.meanReversionStrategy.bbStdDev
    );

    // 1. Manage existing open positions for this symbol
    const openSymbolTrades = this.repo.getOpenTrades(this.mode, symbol);
    for (const openTrade of openSymbolTrades) {
      await this.evaluateAndExecuteTradeManagement({
        trade: openTrade,
        currentPrice: latestCandle.close,
        currentAtr: latestAtr,
        timestamp: latestCandle.timestamp,
        candleHigh: latestCandle.high,
        candleLow: latestCandle.low,
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
    const regimeState = this.regimeDetector.detect(candles);
    if (regimeState.regime === 'NO_TRADE') {
      return;
    }

    // 4. Verify RiskManager position limits and Kill Switch lock before evaluating entry signals
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
      await this.openPositionFromSignal(signal);
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
      const currentAtr =
        MathEngine.getLatestATR(symbolCandles, this.config.trendStrategy.atrPeriod) ??
        this.riskManager.getOneR(trade) / 1.5;
      const latestBb = MathEngine.getLatestBollingerBands(
        symbolCandles,
        this.config.meanReversionStrategy.bbPeriod,
        this.config.meanReversionStrategy.bbStdDev
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
      this.repo.updateTradeStopLoss(trade.id, decision.newSl);
      logger.debug(
        {
          tradeId: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          oldSl: trade.current_sl,
          newSl: decision.newSl,
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
    });

    if (sizing.sizeCoins <= 0) {
      return null;
    }

    const orderSide = signal.side === 'LONG' ? 'BUY' : 'SELL';
    const exec = await this.broker.executeMarketOrder({
      symbol: signal.symbol,
      orderSide,
      positionSide: signal.side,
      sizeCoins: sizing.sizeCoins,
      referencePrice: signal.entryPrice,
      timestamp: signal.timestamp,
      reduceOnly: false,
    });

    if (this.broker instanceof PaperBroker) {
      this.broker.adjustBalance(-exec.feeUsd);
    }

    // Anchor initial SL to actual filled entry price preserving exact SL_Distance
    const actualInitialSl =
      signal.side === 'LONG'
        ? exec.filledPrice - sizing.slDistance
        : exec.filledPrice + sizing.slDistance;

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

    logger.info(
      {
        tradeId: tradeRecord.id,
        mode: this.mode,
        symbol: tradeRecord.symbol,
        strategy: tradeRecord.strategy,
        regime: tradeRecord.regime_at_entry,
        side: tradeRecord.side,
        entryPrice: Number(tradeRecord.entry_price.toFixed(2)),
        size: Number(tradeRecord.initial_size.toFixed(6)),
        initialSl: Number(tradeRecord.initial_sl.toFixed(2)),
        riskUsd: Number(sizing.riskUsd.toFixed(2)),
      },
      'Opened new position'
    );

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
    const exec = await this.broker.executeMarketOrder({
      symbol: trade.symbol,
      orderSide: closeOrderSide,
      positionSide: trade.side,
      sizeCoins: closeSize,
      referencePrice,
      timestamp,
      reduceOnly: true,
    });

    const grossPnl =
      (trade.side === 'LONG'
        ? exec.filledPrice - trade.entry_price
        : trade.entry_price - exec.filledPrice) * exec.filledSize;

    const netPnlDelta = grossPnl - exec.feeUsd;
    const remainingSize = Math.max(0, trade.remaining_size - exec.filledSize);

    if (this.broker instanceof PaperBroker) {
      this.broker.adjustBalance(netPnlDelta);
    }

    this.repo.updateTradePartialClose({
      id: trade.id,
      remainingSize,
      currentSl: newBreakEvenSl,
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
        fillPrice: Number(exec.filledPrice.toFixed(2)),
        netPnlDelta: Number(netPnlDelta.toFixed(2)),
        newBreakEvenSl: Number(newBreakEvenSl.toFixed(2)),
      },
      'Executed 1.5R 50% Scale-Out and moved SL to Break-Even + Costs'
    );
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

    const closeOrderSide = trade.side === 'LONG' ? 'SELL' : 'BUY';
    const exec = await this.broker.executeMarketOrder({
      symbol: trade.symbol,
      orderSide: closeOrderSide,
      positionSide: trade.side,
      sizeCoins: trade.remaining_size,
      referencePrice,
      timestamp,
      reduceOnly: true,
    });

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

    logger.info(
      {
        tradeId: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        side: trade.side,
        exitReason,
        entryPrice: Number(trade.entry_price.toFixed(2)),
        exitPrice: Number(exec.filledPrice.toFixed(2)),
        totalRealizedPnl: Number((updated?.realized_pnl ?? netPnlDelta).toFixed(2)),
      },
      'Closed position completely'
    );
  }

  /**
   * Evaluates the Daily Kill Switch (-4.0% daily loss limit) and liquidates all open positions if breached.
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
    const dailyRealizedPnl = this.dailyRealizedPnlByDayUtc.get(dayStartUtcMs) ?? 0;

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
