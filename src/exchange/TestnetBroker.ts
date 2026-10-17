import crypto from 'node:crypto';
import ccxt, { type Exchange } from 'ccxt';
import { env, type EnvConfig } from '../config/env.js';
import { strategyConfig, type StrategyConfig } from '../config/strategyConfig.js';
import type { OrderExecutionResult } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { ExecuteMarketOrderParams, IExecutionBroker } from './IExecutionBroker.js';

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
    const usdtFree = balance.USDT?.free ?? balance.USDT?.total ?? this.cachedBalanceUsdt;
    if (typeof usdtFree === 'number' && !Number.isNaN(usdtFree)) {
      this.cachedBalanceUsdt = usdtFree;
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

    const filledPrice =
      typeof order.average === 'number' && order.average > 0
        ? order.average
        : typeof order.price === 'number' && order.price > 0
          ? order.price
          : referencePrice;

    const filledSize =
      typeof order.filled === 'number' && order.filled > 0 ? order.filled : formattedAmount;

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
}
