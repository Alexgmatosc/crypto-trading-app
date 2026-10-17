import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { strategyConfig } from './config/strategyConfig.js';
import { Engine } from './core/Engine.js';
import { repository } from './db/repository.js';
import type { IExecutionBroker } from './exchange/IExecutionBroker.js';
import { MarketDataFeed } from './exchange/MarketDataFeed.js';
import { PaperBroker } from './exchange/PaperBroker.js';
import { TestnetBroker } from './exchange/TestnetBroker.js';
import type { Candle, ExecutionMode } from './types/index.js';
import { DashboardServer } from './ui/dashboard.js';
import { logger } from './utils/logger.js';

export class QuantDaemon {
  private readonly mode: ExecutionMode;
  private readonly feed: MarketDataFeed;
  private readonly broker: IExecutionBroker;
  private readonly engine: Engine;
  private readonly dashboardServer: DashboardServer;
  private readonly candlesBySymbol: Record<string, Candle[]> = {};
  private readonly markPrices: Record<string, number> = {};
  private readonly lastProcessedCandleTs: Record<string, number> = {};

  private tickTimer: NodeJS.Timeout | null = null;
  private candleTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessingTick = false;
  private isProcessingCandle = false;

  constructor(customMode?: ExecutionMode) {
    this.mode = customMode ?? (env.EXECUTION_MODE === 'BACKTEST' ? 'PAPER_LOCAL' : env.EXECUTION_MODE);
    this.feed = new MarketDataFeed(env.EXCHANGE_ID, repository);

    if (this.mode === 'TESTNET_LIVE') {
      this.broker = new TestnetBroker(env, strategyConfig);
    } else {
      const latestSnapshot = repository.getLatestEquitySnapshot(this.mode);
      const startingBalance = latestSnapshot?.balance_usdt ?? strategyConfig.initialBalance;
      this.broker = new PaperBroker(startingBalance, strategyConfig);
    }

    this.engine = new Engine({
      mode: this.mode,
      broker: this.broker,
      repo: repository,
      config: strategyConfig,
    });

    this.dashboardServer = new DashboardServer({
      mode: this.mode,
      broker: this.broker,
      repo: repository,
      getMarkPrices: () => this.markPrices,
    });
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.dashboardServer.start();

    logger.info(
      {
        mode: this.mode,
        exchange: env.EXCHANGE_ID,
        symbols: strategyConfig.symbols,
        timeframe: strategyConfig.timeframe,
      },
      'Starting Adaptive Multi-Regime Crypto Quant Engine Daemon...'
    );

    await this.broker.initialize();

    // Warm-up historical candles from Mainnet and evaluate latest closed candle state
    for (const symbol of strategyConfig.symbols) {
      const recentCandles = await this.feed.fetchRecentCandles(
        symbol,
        strategyConfig.timeframe,
        260
      );
      this.candlesBySymbol[symbol] = recentCandles;

      if (recentCandles.length > 0) {
        const lastCandle = recentCandles[recentCandles.length - 1];
        this.markPrices[symbol] = lastCandle.close;
        this.lastProcessedCandleTs[symbol] = lastCandle.timestamp;

        await this.engine.processCandleClose({
          symbol,
          candles: recentCandles,
          markPrices: this.markPrices,
        });
      }
    }

    this.engine.recordEquitySnapshot(Date.now(), this.markPrices);

    // 1. Start 10-second Stop Loss & Risk Management monitor
    this.tickTimer = setInterval(() => {
      void this.onTickCheck();
    }, 10_000);

    // 2. Schedule synchronized 15m candle close execution
    this.scheduleNextCandleClose();

    logger.info(
      {
        balanceUsdt: this.broker.getBalanceSync(),
        openPositions: repository.getOpenTrades(this.mode).length,
      },
      'Daemon active: synchronized with 15m candle closes and 10s SL monitoring'
    );
  }

  private scheduleNextCandleClose(): void {
    if (!this.isRunning) return;

    const tfMs = MarketDataFeed.timeframeToMs(strategyConfig.timeframe);
    const now = Date.now();
    // Add 2500ms buffer past the 15m boundary so Mainnet OHLCV candle is finalized
    const msUntilNextClose = tfMs - (now % tfMs) + 2500;

    this.candleTimer = setTimeout(async () => {
      await this.onCandleCloseCycle();
      this.scheduleNextCandleClose();
    }, msUntilNextClose);
  }

  private async onCandleCloseCycle(): Promise<void> {
    if (!this.isRunning || this.isProcessingCandle) return;
    this.isProcessingCandle = true;

    try {
      for (const symbol of strategyConfig.symbols) {
        const candles = await this.feed.fetchRecentCandles(
          symbol,
          strategyConfig.timeframe,
          260
        );
        if (candles.length === 0) continue;

        this.candlesBySymbol[symbol] = candles;
        const latestCandle = candles[candles.length - 1];
        const prevTs = this.lastProcessedCandleTs[symbol] ?? 0;

        if (latestCandle.timestamp > prevTs) {
          this.lastProcessedCandleTs[symbol] = latestCandle.timestamp;
          await this.engine.processCandleClose({
            symbol,
            candles,
            markPrices: this.markPrices,
          });
        }
      }

      this.engine.recordEquitySnapshot(Date.now(), this.markPrices);
    } catch (err) {
      logger.error({ err }, 'Error during 15m candle close cycle');
    } finally {
      this.isProcessingCandle = false;
    }
  }

  private async onTickCheck(): Promise<void> {
    if (!this.isRunning || this.isProcessingTick) return;
    this.isProcessingTick = true;

    try {
      const openTrades = repository.getOpenTrades(this.mode);
      if (openTrades.length === 0) return;

      const activeSymbols = Array.from(new Set(openTrades.map((t) => t.symbol)));
      for (const symbol of activeSymbols) {
        const price = await this.feed.fetchCurrentPrice(symbol);
        this.markPrices[symbol] = price;
      }

      await this.engine.checkOpenPositionsOnTick({
        markPrices: this.markPrices,
        candlesBySymbol: this.candlesBySymbol,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error({ err }, 'Error during 10s Stop Loss tick check');
    } finally {
      this.isProcessingTick = false;
    }
  }

  public stop(): void {
    this.isRunning = false;
    this.dashboardServer.stop();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.candleTimer) {
      clearTimeout(this.candleTimer);
      this.candleTimer = null;
    }
    logger.info('QuantDaemon stopped cleanly');
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const daemon = new QuantDaemon();

  const handleShutdown = (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, stopping daemon...');
    daemon.stop();
    repository.close();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  daemon.start().catch((err) => {
    logger.error({ err }, 'Fatal error starting QuantDaemon');
    process.exit(1);
  });
}
