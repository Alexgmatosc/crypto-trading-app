export type ExecutionMode = 'BACKTEST' | 'PAPER_LOCAL' | 'TESTNET_LIVE';

export type StrategyName = 'TREND_BREAKOUT' | 'MEAN_REVERSION';

export type MarketRegime = 'TRENDING' | 'RANGING' | 'NO_TRADE';

export type OrderSide = 'LONG' | 'SHORT';

export type TradeStatus = 'OPEN' | 'CLOSED';

export type ExitReason = 'STOP_LOSS' | 'TRAILING_STOP' | 'MEAN_TARGET' | 'KILL_SWITCH';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BollingerBandsPoint {
  upper: number;
  middle: number;
  lower: number;
  pb: number;
  width: number;
}

export interface ADXPoint {
  adx: number;
  pdi: number;
  mdi: number;
}

export interface DonchianChannelPoint {
  upper: number;
  lower: number;
  middle: number;
}

export interface RegimeState {
  regime: MarketRegime;
  adx: number;
  bbWidth: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  reason: string;
}

export interface Signal {
  symbol: string;
  side: OrderSide;
  strategy: StrategyName;
  regime: MarketRegime;
  entryPrice: number;
  atr: number;
  timestamp: number;
  reason: string;
  bbMiddle?: number;
}

export interface PositionSizingResult {
  sizeCoins: number;
  notionalUsd: number;
  riskUsd: number;
  initialSl: number;
  slDistance: number;
  oneR: number;
}

export interface TradeRecord {
  id: string;
  mode: ExecutionMode;
  symbol: string;
  strategy: StrategyName;
  regime_at_entry: MarketRegime;
  side: OrderSide;
  entry_price: number;
  exit_price: number | null;
  initial_size: number;
  remaining_size: number;
  initial_sl: number;
  current_sl: number;
  stop_order_id?: string | null;
  tp1_hit: number; // 0 or 1 in SQLite
  realized_pnl: number;
  fees_paid: number;
  status: TradeStatus;
  exit_reason: ExitReason | null;
  opened_at: number;
  closed_at: number | null;
}

export interface EquitySnapshotRecord {
  id?: number;
  timestamp: number;
  mode: ExecutionMode;
  balance_usdt: number;
  equity_usdt: number;
  drawdown_pct: number;
}

export interface OrderExecutionResult {
  filledPrice: number;
  filledSize: number;
  notionalUsd: number;
  feeUsd: number;
  timestamp: number;
  orderId: string;
}

export interface TradeUpdateDecision {
  action: 'NONE' | 'PARTIAL_TP_AND_BE' | 'UPDATE_TRAILING_SL' | 'FULL_EXIT';
  exitReason?: ExitReason;
  closeSize?: number;
  newSl?: number;
  triggerPrice?: number;
}

export interface StrategyPerformanceBreakdown {
  strategy: StrategyName;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  netProfitUsd: number;
  profitFactor: number;
  expectancyUsd: number;
  feesPaidUsd: number;
}

export interface BacktestReport {
  mode: ExecutionMode;
  symbols: string[];
  timeframe: string;
  startTimestamp: number;
  endTimestamp: number;
  initialBalance: number;
  finalBalance: number;
  finalEquity: number;
  totalReturnPct: number;
  netProfitUsd: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  profitFactor: number;
  expectancyUsd: number;
  maxDrawdownPct: number;
  totalFeesPaidUsd: number;
  strategyBreakdown: Record<StrategyName, StrategyPerformanceBreakdown>;
}
