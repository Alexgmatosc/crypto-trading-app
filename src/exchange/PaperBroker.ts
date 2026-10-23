import crypto from 'node:crypto';
import { strategyConfig, type StrategyConfig } from '../config/strategyConfig.js';
import type { OrderExecutionResult } from '../types/index.js';
import type {
  ExecuteMarketOrderParams,
  IExecutionBroker,
  PlaceStopLossOrderParams,
  ReplaceStopLossOrderParams,
  StopLossOrderResult,
} from './IExecutionBroker.js';

export class PaperBroker implements IExecutionBroker {
  private balanceUsdt: number;
  private readonly config: StrategyConfig;

  constructor(initialBalance?: number, customConfig: StrategyConfig = strategyConfig) {
    this.config = customConfig;
    this.balanceUsdt = initialBalance ?? customConfig.initialBalance;
  }

  public async initialize(): Promise<void> {
    // Local simulator requires no network initialization
  }

  public async getBalance(): Promise<number> {
    return this.balanceUsdt;
  }

  public getBalanceSync(): number {
    return this.balanceUsdt;
  }

  public adjustBalance(deltaUsdt: number): void {
    this.balanceUsdt += deltaUsdt;
  }

  /**
   * Simulates a market order fill applying adverse slippage (0.04%) against the trader
   * and charging taker fee (0.05%) on the executed notional.
   */
  public async executeMarketOrder(params: ExecuteMarketOrderParams): Promise<OrderExecutionResult> {
    const { orderSide, sizeCoins, referencePrice, timestamp } = params;

    if (sizeCoins <= 0 || referencePrice <= 0) {
      throw new Error(
        `Invalid paper order parameters: sizeCoins=${sizeCoins}, referencePrice=${referencePrice}`
      );
    }

    const slippage = this.config.fees.slippage;
    const takerFee = this.config.fees.taker;

    // Adverse slippage: BUY fills higher, SELL fills lower
    const filledPrice =
      orderSide === 'BUY'
        ? referencePrice * (1 + slippage)
        : referencePrice * (1 - slippage);

    const notionalUsd = filledPrice * sizeCoins;
    const feeUsd = notionalUsd * takerFee;

    return {
      filledPrice,
      filledSize: sizeCoins,
      notionalUsd,
      feeUsd,
      timestamp,
      orderId: `paper-${crypto.randomUUID()}`,
    };
  }

  public async placeStopLossOrder(params: PlaceStopLossOrderParams): Promise<StopLossOrderResult> {
    return {
      stopOrderId: `paper-sl-${crypto.randomUUID()}`,
      stopPrice: params.stopPrice,
      sizeCoins: params.sizeCoins,
    };
  }

  public async cancelStopLossOrder(_symbol: string, _stopOrderId?: string | null): Promise<void> {
    // Local paper simulator requires no remote order cancellation
  }

  public async replaceStopLossOrder(
    params: ReplaceStopLossOrderParams
  ): Promise<StopLossOrderResult> {
    await this.cancelStopLossOrder(params.symbol, params.previousStopOrderId);
    return this.placeStopLossOrder(params);
  }
}
