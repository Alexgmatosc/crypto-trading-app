import crypto from 'node:crypto';
import ccxt, { type Exchange } from 'ccxt';
import { env, type EnvConfig } from '../config/env.js';
import { strategyConfig, type StrategyConfig } from '../config/strategyConfig.js';
import type { OrderExecutionResult } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type {
  ExecuteMarketOrderParams,
  IExecutionBroker,
  PlaceStopLossOrderParams,
  ReplaceStopLossOrderParams,
  StopLossOrderResult,
} from './IExecutionBroker.js';

export class TestnetBroker implements IExecutionBroker {
  private readonly exchange: Exchange;
  private readonly config: StrategyConfig;
  private cachedBalanceUsdt: number;
  private initialized = false;

  constructor(
    envConfig: EnvConfig = env,
    customStrategyConfig: StrategyConfig = strategyConfig
  ) {
    this.config = customStrategyConfig;
    this.cachedBalanceUsdt = customStrategyConfig.initialBalance;

    const exchangeId = envConfig.EXCHANGE_ID.toLowerCase();
    const ExchangeClass = (ccxt as unknown as Record<string, new (config?: object) => Exchange>)[
      exchangeId
    ];

    if (!ExchangeClass) {
      throw new Error(`Unsupported CCXT exchange ID for TestnetBroker: ${exchangeId}`);
    }

    if (
      !envConfig.TESTNET_API_KEY ||
      !envConfig.TESTNET_API_SECRET ||
      envConfig.TESTNET_API_KEY.includes('your_testnet_key')
    ) {
      throw new Error(
        'TESTNET_LIVE mode requires valid TESTNET_API_KEY and TESTNET_API_SECRET in environment variables.'
      );
    }

    this.exchange = new ExchangeClass({
      apiKey: envConfig.TESTNET_API_KEY,
      secret: envConfig.TESTNET_API_SECRET,
      enableRateLimit: true,
      timeout: 30000,
      options: {
        defaultType: 'swap',
        disableFuturesSandboxWarning: true,
      },
    });

    // Enable Exchange Sandbox / Testnet Mode as mandated by SPEC
    this.exchange.setSandboxMode(true);
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info({ exchange: this.exchange.id }, 'Initializing TestnetBroker (Sandbox Mode = true)...');
    await this.exchange.loadMarkets();

    for (const symbol of this.config.symbols) {
      try {
        if (typeof this.exchange.setLeverage === 'function') {
          await this.exchange.setLeverage(this.config.leverage, symbol);
        }
      } catch (err) {
        logger.warn(
          { symbol, leverage: this.config.leverage, error: (err as Error).message },
          'Could not set leverage on testnet symbol (may already be configured)'
        );
      }
    }

    await this.getBalance();
    this.initialized = true;
    logger.info(
      { exchange: this.exchange.id, balanceUsdt: this.cachedBalanceUsdt },
      'TestnetBroker initialized successfully'
    );
  }

  public async getBalance(): Promise<number> {
    const balance = await this.exchange.fetchBalance();
    const rawWallet = balance.info?.totalWalletBalance
      ? Number(balance.info.totalWalletBalance)
      : undefined;
    const usdtTotal =
      (rawWallet && !Number.isNaN(rawWallet) ? rawWallet : undefined) ??
      balance.USDT?.free ??
      balance.USDT?.total ??
      this.cachedBalanceUsdt;
    if (typeof usdtTotal === 'number' && !Number.isNaN(usdtTotal)) {
      this.cachedBalanceUsdt = usdtTotal;
    }
    return this.cachedBalanceUsdt;
  }

  public getBalanceSync(): number {
    return this.cachedBalanceUsdt;
  }

  public async executeMarketOrder(params: ExecuteMarketOrderParams): Promise<OrderExecutionResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const { symbol, orderSide, sizeCoins, referencePrice, timestamp, reduceOnly } = params;

    // Format quantity precision according to exchange market rules
    const formattedAmountStr = this.exchange.amountToPrecision(symbol, sizeCoins);
    const formattedAmount = Number.parseFloat(formattedAmountStr ?? String(sizeCoins));

    if (formattedAmount <= 0 || Number.isNaN(formattedAmount)) {
      throw new Error(
        `Order amount (${sizeCoins}) rounded to zero for ${symbol} after amountToPrecision`
      );
    }

    const ccxtSide = orderSide === 'BUY' ? 'buy' : 'sell';
    const orderParams: Record<string, unknown> = {};
    if (reduceOnly) {
      orderParams.reduceOnly = true;
    }

    const order = await this.exchange.createOrder(
      symbol,
      'market',
      ccxtSide,
      formattedAmount,
      undefined,
      orderParams
    );

    const rawFilled =
      typeof order.filled === 'number' && order.filled > 0
        ? order.filled
        : Number((order.info as Record<string, unknown> | undefined)?.executedQty || 0);

    if (rawFilled <= 0 || order.status === 'EXPIRED' || order.status === 'CANCELED') {
      throw new Error(
        `Order ${order.id} not filled on exchange (status: ${order.status}, filled: ${rawFilled})`
      );
    }

    const rawAvgPrice = Number(
      order.average ?? (order.info as Record<string, unknown> | undefined)?.avgPrice ?? 0
    );
    const filledPrice =
      rawAvgPrice > 0
        ? rawAvgPrice
        : typeof order.price === 'number' && order.price > 0
          ? order.price
          : referencePrice;

    const filledSize = rawFilled;

    const notionalUsd = filledPrice * filledSize;
    const feeUsd =
      typeof order.fee?.cost === 'number'
        ? order.fee.cost
        : notionalUsd * this.config.fees.taker;

    return {
      filledPrice,
      filledSize,
      notionalUsd,
      feeUsd,
      timestamp: order.timestamp ?? timestamp,
      orderId: String(order.id ?? `testnet-${crypto.randomUUID()}`),
    };
  }

  /**
   * Places a native exchange-side STOP_MARKET order with reduceOnly=true on Binance USD-M Futures.
   * For a LONG position, places a 'sell' STOP_MARKET order.
   * For a SHORT position, places a 'buy' STOP_MARKET order.
   */
  public async placeStopLossOrder(params: PlaceStopLossOrderParams): Promise<StopLossOrderResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const { symbol, positionSide, sizeCoins, stopPrice } = params;

    const formattedAmountStr = this.exchange.amountToPrecision(symbol, sizeCoins);
    const formattedAmount = Number.parseFloat(formattedAmountStr ?? String(sizeCoins));
    if (formattedAmount <= 0 || Number.isNaN(formattedAmount)) {
      throw new Error(
        `Stop-Loss order amount (${sizeCoins}) rounded to zero for ${symbol} after amountToPrecision`
      );
    }

    const formattedStopPriceStr = this.exchange.priceToPrecision(symbol, stopPrice);
    const formattedStopPrice = Number.parseFloat(formattedStopPriceStr ?? String(stopPrice));
    if (formattedStopPrice <= 0 || Number.isNaN(formattedStopPrice)) {
      throw new Error(
        `Stop-Loss trigger price (${stopPrice}) invalid for ${symbol} after priceToPrecision`
      );
    }

    const ccxtSide = positionSide === 'LONG' ? 'sell' : 'buy';

    const order = await this.exchange.createOrder(
      symbol,
      'STOP_MARKET',
      ccxtSide,
      formattedAmount,
      undefined,
      {
        stopPrice: formattedStopPrice,
        reduceOnly: true,
      }
    );

    const stopOrderId = String(
      order.id ??
        (order.info as Record<string, unknown> | undefined)?.algoId ??
        (order.info as Record<string, unknown> | undefined)?.orderId ??
        `testnet-sl-${crypto.randomUUID()}`
    );

    logger.info(
      {
        symbol,
        positionSide,
        stopOrderSide: ccxtSide,
        sizeCoins: formattedAmount,
        stopPrice: formattedStopPrice,
        stopOrderId,
      },
      'Placed native STOP_MARKET (reduceOnly) order on exchange'
    );

    return {
      stopOrderId,
      stopPrice: formattedStopPrice,
      sizeCoins: formattedAmount,
    };
  }

  /**
   * Cancels an active native STOP_MARKET conditional order on Binance USD-M Futures.
   * Gracefully handles cases where the order was already triggered, filled, or canceled.
   */
  public async cancelStopLossOrder(symbol: string, stopOrderId?: string | null): Promise<void> {
    if (!stopOrderId) return;

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      await this.exchange.cancelOrder(stopOrderId, symbol, { trigger: true });
      logger.info({ symbol, stopOrderId }, 'Canceled native STOP_MARKET order on exchange');
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      // Fallback for standard order endpoint if exchange didn't classify as trigger/algo order
      try {
        await this.exchange.cancelOrder(stopOrderId, symbol);
        logger.info(
          { symbol, stopOrderId },
          'Canceled native STOP_MARKET order via standard endpoint'
        );
        return;
      } catch {
        // Ignore fallback failure and log original warning
      }

      logger.debug(
        { symbol, stopOrderId, error: errMsg },
        'Stop-Loss order cancellation skipped (likely already triggered or canceled on exchange)'
      );
    }
  }

  /**
   * Atomically cancels the previous STOP_MARKET order (if any) and places a new one
   * with updated stopPrice and/or remaining position size.
   */
  public async replaceStopLossOrder(
    params: ReplaceStopLossOrderParams
  ): Promise<StopLossOrderResult> {
    if (params.previousStopOrderId) {
      await this.cancelStopLossOrder(params.symbol, params.previousStopOrderId);
    }
    return this.placeStopLossOrder(params);
  }

  /**
   * Queries open conditional/trigger orders and standard open stop orders for a symbol.
   */
  public async fetchOpenStopOrders(symbol: string) {
    if (!this.initialized) {
      await this.initialize();
    }

    const [stdOrders, triggerOrders] = await Promise.all([
      this.exchange.fetchOpenOrders(symbol).catch(() => []),
      this.exchange.fetchOpenOrders(symbol, undefined, undefined, { trigger: true }).catch(() => []),
    ]);

    return [...stdOrders, ...triggerOrders];
  }

  public getExchange(): Exchange {
    return this.exchange;
  }
}
