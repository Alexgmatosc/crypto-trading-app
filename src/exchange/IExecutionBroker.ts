import type { OrderExecutionResult, OrderSide } from '../types/index.js';

export interface ExecuteMarketOrderParams {
  symbol: string;
  orderSide: 'BUY' | 'SELL';
  positionSide: OrderSide;
  sizeCoins: number;
  referencePrice: number;
  timestamp: number;
  reduceOnly?: boolean;
}

export interface PlaceStopLossOrderParams {
  symbol: string;
  positionSide: OrderSide;
  sizeCoins: number;
  stopPrice: number;
}

export interface ReplaceStopLossOrderParams extends PlaceStopLossOrderParams {
  previousStopOrderId?: string | null;
}

export interface StopLossOrderResult {
  stopOrderId: string;
  stopPrice: number;
  sizeCoins: number;
}

export function isStopOrderImmediateTriggerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('-2021') ||
    msg.includes('-4117') ||
    msg.toLowerCase().includes('immediately trigger') ||
    msg.includes('STOP_ORDER_TRIGGERING')
  );
}

export function isReduceOnlyRejectedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('-2022') || msg.toLowerCase().includes('reduceonly order is rejected');
}

export interface IExecutionBroker {
  initialize(): Promise<void>;
  getBalance(): Promise<number>;
  getBalanceSync(): number;
  executeMarketOrder(params: ExecuteMarketOrderParams): Promise<OrderExecutionResult>;
  placeStopLossOrder(params: PlaceStopLossOrderParams): Promise<StopLossOrderResult>;
  cancelStopLossOrder(symbol: string, stopOrderId?: string | null): Promise<void>;
  replaceStopLossOrder(params: ReplaceStopLossOrderParams): Promise<StopLossOrderResult>;
}
