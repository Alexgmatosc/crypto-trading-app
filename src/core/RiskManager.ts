import { strategyConfig, type StrategyConfig } from '../config/strategyConfig.js';
import type {
  ExitReason,
  OrderSide,
  PositionSizingResult,
  StrategyName,
  TradeRecord,
} from '../types/index.js';

export interface TradeManagementEvaluation {
  shouldFullExit: boolean;
  exitReason?: ExitReason;
  exitExecutionPrice?: number;
  shouldPartialClose: boolean;
  partialCloseSize?: number;
  partialClosePrice?: number;
  shouldUpdateSl: boolean;
  newSl?: number;
}

export interface KillSwitchState {
  triggered: boolean;
  isLocked: boolean;
  lockedUntilMs: number | null;
  dayStartUtcMs: number;
  dayOpeningBalance: number;
  dailyLossPct: number;
}

export class RiskManager {
  private readonly config: StrategyConfig;
  private killSwitchLockedUntilMs: number | null = null;
  private currentDayStartUtcMs: number | null = null;
  private currentDayOpeningBalance: number = 0;

  constructor(customConfig: StrategyConfig = strategyConfig) {
    this.config = customConfig;
    this.currentDayOpeningBalance = customConfig.initialBalance;
  }

  /**
   * 1. Dynamic Position Sizing (Volatility Parity):
   * - Risk_USD = Available_Balance * 0.015 (1.5% max risk if SL hits)
   * - SL_Distance = slAtrMultiplier * ATR(14) (1.5 * ATR in trend, 1.2 * ATR in range)
   * - LONG: Initial_SL = Entry_Price - SL_Distance
   * - SHORT: Initial_SL = Entry_Price + SL_Distance
   * - Position_Size_Coins = Risk_USD / SL_Distance
   * - Margin Cap: Notional (Position_Size_Coins * Entry_Price) <= Available_Balance * leverage * 0.95
   */
  public calculatePositionSize(params: {
    availableBalance: number;
    entryPrice: number;
    atr: number;
    side: OrderSide;
    strategy: StrategyName;
  }): PositionSizingResult {
    const { availableBalance, entryPrice, atr, side, strategy } = params;

    if (availableBalance <= 0 || entryPrice <= 0 || atr <= 0) {
      throw new Error(
        `Invalid sizing parameters: balance=${availableBalance}, entryPrice=${entryPrice}, atr=${atr}`
      );
    }

    const slAtrMultiplier =
      strategy === 'TREND_BREAKOUT'
        ? this.config.trendStrategy.slAtrMultiplier
        : this.config.meanReversionStrategy.slAtrMultiplier;

    const slDistance = slAtrMultiplier * atr;
    const initialSl =
      side === 'LONG' ? entryPrice - slDistance : entryPrice + slDistance;

    if (initialSl <= 0) {
      throw new Error(`Computed initial Stop Loss is non-positive: ${initialSl}`);
    }

    const targetRiskUsd = availableBalance * this.config.riskPerTrade;
    let sizeCoins = targetRiskUsd / slDistance;
    let notionalUsd = sizeCoins * entryPrice;

    const maxNotionalUsd = availableBalance * this.config.leverage * 0.95;
    if (notionalUsd > maxNotionalUsd) {
      notionalUsd = maxNotionalUsd;
      sizeCoins = notionalUsd / entryPrice;
    }

    const actualRiskUsd = sizeCoins * slDistance;
    const oneR = Math.abs(entryPrice - initialSl);

    return {
      sizeCoins,
      notionalUsd,
      riskUsd: actualRiskUsd,
      initialSl,
      slDistance,
      oneR,
    };
  }

  /**
   * Break-Even + Costs Stop Loss calculation after 1.5R partial take profit:
   * - LONG: Entry_Price * 1.0015
   * - SHORT: Entry_Price * 0.9985
   */
  public calculateBreakEvenStop(entryPrice: number, side: OrderSide): number {
    return side === 'LONG' ? entryPrice * 1.0015 : entryPrice * 0.9985;
  }

  /**
   * Computes One_R = abs(Entry_Price - Initial_SL).
   */
  public getOneR(trade: Pick<TradeRecord, 'entry_price' | 'initial_sl'>): number {
    return Math.abs(trade.entry_price - trade.initial_sl);
  }

  /**
   * Evaluates an open trade against current market price (and optional intrabar high/low & BB_Middle)
   * for:
   * 1. Stop Loss / Trailing Stop hit
   * 2. Mean Reversion target (BB_Middle)
   * 3. Scale-Out 50% at 1.5R + move SL to Break-Even + Costs
   * 4. Dynamic Trailing Stop at >= 2.0R (1.5 * ATR_Actual)
   */
  public evaluatePosition(params: {
    trade: TradeRecord;
    currentPrice: number;
    currentAtr: number;
    candleHigh?: number;
    candleLow?: number;
    bbMiddle?: number;
  }): TradeManagementEvaluation {
    const { trade, currentPrice, currentAtr, candleHigh, candleLow, bbMiddle } = params;

    const checkHigh = candleHigh !== undefined ? Math.max(candleHigh, currentPrice) : currentPrice;
    const checkLow = candleLow !== undefined ? Math.min(candleLow, currentPrice) : currentPrice;

    const isLong = trade.side === 'LONG';
    const isTrailingOrBeActive =
      trade.tp1_hit === 1 ||
      (isLong ? trade.current_sl > trade.initial_sl : trade.current_sl < trade.initial_sl);

    // 1. Check Stop Loss / Trailing Stop hit first (conservative risk priority)
    if (isLong && checkLow <= trade.current_sl) {
      return {
        shouldFullExit: true,
        exitReason: isTrailingOrBeActive ? 'TRAILING_STOP' : 'STOP_LOSS',
        exitExecutionPrice: trade.current_sl,
        shouldPartialClose: false,
        shouldUpdateSl: false,
      };
    }

    if (!isLong && checkHigh >= trade.current_sl) {
      return {
        shouldFullExit: true,
        exitReason: isTrailingOrBeActive ? 'TRAILING_STOP' : 'STOP_LOSS',
        exitExecutionPrice: trade.current_sl,
        shouldPartialClose: false,
        shouldUpdateSl: false,
      };
    }

    // 2. Check Mean Reversion specific exit target (BB_Middle)
    if (trade.strategy === 'MEAN_REVERSION' && bbMiddle !== undefined && bbMiddle > 0) {
      if (isLong && checkHigh >= bbMiddle) {
        return {
          shouldFullExit: true,
          exitReason: 'MEAN_TARGET',
          exitExecutionPrice: currentPrice >= bbMiddle ? currentPrice : bbMiddle,
          shouldPartialClose: false,
          shouldUpdateSl: false,
        };
      }
      if (!isLong && checkLow <= bbMiddle) {
        return {
          shouldFullExit: true,
          exitReason: 'MEAN_TARGET',
          exitExecutionPrice: currentPrice <= bbMiddle ? currentPrice : bbMiddle,
          shouldPartialClose: false,
          shouldUpdateSl: false,
        };
      }
    }

    const oneR = this.getOneR(trade);
    if (oneR <= 0) {
      return {
        shouldFullExit: false,
        shouldPartialClose: false,
        shouldUpdateSl: false,
      };
    }

    const {
      partialTakeProfitR,
      partialClosePct,
      trailingActivationR,
      trailingAtrMultiplier,
    } = this.config.tradeManagement;

    let shouldPartialClose = false;
    let partialCloseSize: number | undefined;
    let partialClosePrice: number | undefined;
    let effectiveCurrentSl = trade.current_sl;
    let shouldUpdateSl = false;

    // 3. Scale-Out 50% at 1.5R + Move SL to Break-Even + Costs
    if (trade.tp1_hit === 0) {
      const tp1TargetPrice = isLong
        ? trade.entry_price + partialTakeProfitR * oneR
        : trade.entry_price - partialTakeProfitR * oneR;

      const reachedTp1 = isLong ? checkHigh >= tp1TargetPrice : checkLow <= tp1TargetPrice;

      if (reachedTp1) {
        shouldPartialClose = true;
        partialCloseSize = trade.initial_size * partialClosePct;
        partialClosePrice = isLong
          ? Math.max(currentPrice, tp1TargetPrice)
          : Math.min(currentPrice, tp1TargetPrice);

        const beSl = this.calculateBreakEvenStop(trade.entry_price, trade.side);
        effectiveCurrentSl = isLong
          ? Math.max(effectiveCurrentSl, beSl)
          : Math.min(effectiveCurrentSl, beSl);
        shouldUpdateSl = true;
      }
    }

    // 4. Dynamic Trailing Stop on remaining 50% at >= 2.0R
    const trailingActivationPrice = isLong
      ? trade.entry_price + trailingActivationR * oneR
      : trade.entry_price - trailingActivationR * oneR;

    const favorablePrice = isLong ? checkHigh : checkLow;
    const reachedTrailingR = isLong
      ? favorablePrice >= trailingActivationPrice
      : favorablePrice <= trailingActivationPrice;

    if (reachedTrailingR && currentAtr > 0) {
      const candidateTrailingSl = isLong
        ? currentPrice - trailingAtrMultiplier * currentAtr
        : currentPrice + trailingAtrMultiplier * currentAtr;

      if (isLong && candidateTrailingSl > effectiveCurrentSl) {
        effectiveCurrentSl = candidateTrailingSl;
        shouldUpdateSl = true;
      } else if (!isLong && candidateTrailingSl < effectiveCurrentSl) {
        effectiveCurrentSl = candidateTrailingSl;
        shouldUpdateSl = true;
      }
    }

    return {
      shouldFullExit: false,
      shouldPartialClose,
      partialCloseSize,
      partialClosePrice,
      shouldUpdateSl,
      newSl: shouldUpdateSl ? effectiveCurrentSl : undefined,
    };
  }

  /**
   * Computes unrealized PnL for an open trade at a given mark price.
   */
  public static calculateUnrealizedPnl(trade: TradeRecord, markPrice: number): number {
    const priceDiff =
      trade.side === 'LONG' ? markPrice - trade.entry_price : trade.entry_price - markPrice;
    return priceDiff * trade.remaining_size;
  }

  /**
   * 4. Daily Kill Switch (Circuit Breaker):
   * Tracks 00:00 UTC opening balance. If (daily realized losses + negative unrealized PnL)
   * reaches or exceeds -4.0% of the day's opening balance, triggers immediate liquidation of
   * all positions and blocks new entries for 24 hours.
   */
  public evaluateDailyKillSwitch(params: {
    currentTimestamp: number;
    currentBalance: number;
    dailyRealizedPnl: number;
    unrealizedPnl: number;
    explicitDayOpeningBalance?: number;
  }): KillSwitchState {
    const {
      currentTimestamp,
      currentBalance,
      dailyRealizedPnl,
      unrealizedPnl,
      explicitDayOpeningBalance,
    } = params;

    const dayStartUtcMs = Math.floor(currentTimestamp / 86_400_000) * 86_400_000;

    if (this.currentDayStartUtcMs !== dayStartUtcMs) {
      this.currentDayStartUtcMs = dayStartUtcMs;
      // Opening balance at 00:00 UTC is the balance before today's realized PnL
      this.currentDayOpeningBalance =
        explicitDayOpeningBalance ?? currentBalance - dailyRealizedPnl;
    } else if (explicitDayOpeningBalance !== undefined) {
      this.currentDayOpeningBalance = explicitDayOpeningBalance;
    }

    const dayOpeningBalance =
      this.currentDayOpeningBalance > 0 ? this.currentDayOpeningBalance : this.config.initialBalance;

    // Clear expired lock if 24h have elapsed
    if (this.killSwitchLockedUntilMs !== null && currentTimestamp >= this.killSwitchLockedUntilMs) {
      this.killSwitchLockedUntilMs = null;
    }

    // Sum of daily realized PnL + negative latent PnL (or total daily equity change)
    const effectiveDailyPnl = dailyRealizedPnl + Math.min(0, unrealizedPnl);
    const dailyLossPct = effectiveDailyPnl < 0 ? Math.abs(effectiveDailyPnl) / dayOpeningBalance : 0;

    // Check if -4.0% threshold is breached
    if (dailyLossPct >= this.config.maxDailyDrawdown - 1e-9) {
      const lockDurationMs = 24 * 60 * 60 * 1000;
      if (this.killSwitchLockedUntilMs === null || currentTimestamp + lockDurationMs > this.killSwitchLockedUntilMs) {
        this.killSwitchLockedUntilMs = currentTimestamp + lockDurationMs;
      }

      return {
        triggered: true,
        isLocked: true,
        lockedUntilMs: this.killSwitchLockedUntilMs,
        dayStartUtcMs,
        dayOpeningBalance,
        dailyLossPct,
      };
    }

    return {
      triggered: false,
      isLocked: this.isEntryLocked(currentTimestamp),
      lockedUntilMs: this.killSwitchLockedUntilMs,
      dayStartUtcMs,
      dayOpeningBalance,
      dailyLossPct,
    };
  }

  public isEntryLocked(currentTimestamp: number): boolean {
    if (this.killSwitchLockedUntilMs === null) return false;
    if (currentTimestamp >= this.killSwitchLockedUntilMs) {
      this.killSwitchLockedUntilMs = null;
      return false;
    }
    return true;
  }

  public canOpenNewPosition(params: {
    currentTimestamp: number;
    openPositionsCount: number;
    hasOpenPositionInSymbol: boolean;
  }): { allowed: boolean; reason?: string } {
    if (this.isEntryLocked(params.currentTimestamp)) {
      return {
        allowed: false,
        reason: `Daily Kill Switch active until ${new Date(this.killSwitchLockedUntilMs!).toISOString()}`,
      };
    }

    if (params.hasOpenPositionInSymbol) {
      return {
        allowed: false,
        reason: 'Position already open for symbol',
      };
    }

    if (params.openPositionsCount >= this.config.maxConcurrentPositions) {
      return {
        allowed: false,
        reason: `Max concurrent positions (${this.config.maxConcurrentPositions}) reached`,
      };
    }

    return { allowed: true };
  }

  public resetKillSwitch(): void {
    this.killSwitchLockedUntilMs = null;
    this.currentDayStartUtcMs = null;
  }
}
