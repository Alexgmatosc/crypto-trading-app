import type {
  Candle,
  ExitReason,
  RegimeState,
  Signal,
  StrategyName,
  TradeRecord,
} from '../../types/index.js';

export interface IStrategy {
  readonly name: StrategyName;

  /**
   * Evaluates closed 15m candles and current regime state to generate an entry signal (LONG/SHORT) or null.
   */
  evaluate(symbol: string, candles: Candle[], regimeState: RegimeState): Signal | null;

  /**
   * Evaluates strategy-specific exit conditions (e.g. MEAN_TARGET at BB_Middle for MeanReversion).
   */
  checkStrategyExit?(
    trade: TradeRecord,
    candles: Candle[],
    currentPrice: number
  ): ExitReason | null;
}
