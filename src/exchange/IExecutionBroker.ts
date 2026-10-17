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

export interface IExecutionBroker {
  initialize(): Promise<void>;
  getBalance(): Promise<number>;
  getBalanceSync(): number;
  executeMarketOrder(params: ExecuteMarketOrderParams): Promise<OrderExecutionResult>;
}
