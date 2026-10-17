import ccxt, { type Exchange } from 'ccxt';
import { env } from '../config/env.js';
import { QuantRepository, repository as defaultRepo } from '../db/repository.js';
import type { Candle } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class MarketDataFeed {
  private exchange: Exchange;
  private readonly repo: QuantRepository;
  private readonly exchangeId: string;

  constructor(exchangeId: string = env.EXCHANGE_ID, customRepo: QuantRepository = defaultRepo) {
    this.exchangeId = exchangeId.toLowerCase();
    this.repo = customRepo;
    this.exchange = this.createPublicExchange(this.exchangeId);
  }

  private createPublicExchange(id: string): Exchange {
    const ExchangeClass = (ccxt as unknown as Record<string, new (config?: object) => Exchange>)[
      id
    ];
    if (!ExchangeClass) {
      throw new Error(`Unsupported CCXT exchange ID: ${id}`);
    }

    // Always connect to public Mainnet (no sandboxMode, no API keys) for clean liquidity & real OHLCV
    return new ExchangeClass({
      enableRateLimit: true,
      timeout: 30000,
      options: {
        defaultType: id.includes('usdm') || id === 'bybit' ? 'swap' : 'spot',
      },
    });
  }

  /**
   * Converts a timeframe string (e.g. '15m') to milliseconds.
   */
  public static timeframeToMs(timeframe: string): number {
    const unit = timeframe.slice(-1);
    const value = Number.parseInt(timeframe.slice(0, -1), 10);
    if (Number.isNaN(value) || value <= 0) {
      throw new Error(`Invalid timeframe: ${timeframe}`);
    }
    switch (unit) {
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Unsupported timeframe unit: ${unit}`);
    }
  }

  /**
   * Downloads historical OHLCV candles from Mainnet with pagination and local SQLite caching.
   * Automatically includes warmup candles prior to `startTimeMs` if requested.
   */
  public async fetchHistoricalCandles(params: {
    symbol: string;
    timeframe: string;
    startTimeMs: number;
    endTimeMs: number;
    warmupCandles?: number;
  }): Promise<Candle[]> {
    const { symbol, timeframe, startTimeMs, endTimeMs, warmupCandles = 220 } = params;
    const tfMs = MarketDataFeed.timeframeToMs(timeframe);
    const effectiveStartMs = Math.floor((startTimeMs - warmupCandles * tfMs) / tfMs) * tfMs;
    const effectiveEndMs = Math.floor(endTimeMs / tfMs) * tfMs;

    // 1. Check SQLite cache coverage
    const cached = this.repo.getCachedCandles(symbol, timeframe, effectiveStartMs, effectiveEndMs);
    const expectedCount = Math.floor((effectiveEndMs - effectiveStartMs) / tfMs);

    if (
      cached.length >= expectedCount * 0.98 &&
      cached.length > 0 &&
      cached[0].timestamp <= effectiveStartMs + tfMs * 2 &&
      cached[cached.length - 1].timestamp >= effectiveEndMs - tfMs * 2
    ) {
      logger.info(
        {
          symbol,
          timeframe,
          candlesCount: cached.length,
          from: new Date(cached[0].timestamp).toISOString(),
          to: new Date(cached[cached.length - 1].timestamp).toISOString(),
        },
        'Loaded historical OHLCV candles from local SQLite cache'
      );
      return cached;
    }

    // 2. Paginated download from public Mainnet feed
    logger.info(
      {
        exchange: this.exchange.id,
        symbol,
        timeframe,
        from: new Date(effectiveStartMs).toISOString(),
        to: new Date(effectiveEndMs).toISOString(),
      },
      'Downloading historical OHLCV candles from Mainnet via CCXT...'
    );

    const downloaded: Candle[] = [];
    let cursorMs = effectiveStartMs;
    const batchLimit = 1000;

    while (cursorMs <= effectiveEndMs) {
      const ohlcvBatch = await this.fetchOhlcvWithFallback(
        symbol,
        timeframe,
        cursorMs,
        batchLimit
      );

      if (!ohlcvBatch || ohlcvBatch.length === 0) {
        break;
      }

      const parsedBatch: Candle[] = [];
      for (const row of ohlcvBatch) {
        const ts = Number(row[0]);
        if (ts > effectiveEndMs) continue;
        parsedBatch.push({
          timestamp: ts,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
        });
      }

      if (parsedBatch.length > 0) {
        this.repo.saveCandlesBatch(symbol, timeframe, parsedBatch);
        downloaded.push(...parsedBatch);
      }

      const lastFetchedTs = Number(ohlcvBatch[ohlcvBatch.length - 1][0]);
      if (lastFetchedTs <= cursorMs || lastFetchedTs >= effectiveEndMs) {
        break;
      }

      cursorMs = lastFetchedTs + tfMs;

      if (ohlcvBatch.length < batchLimit && lastFetchedTs >= effectiveEndMs - tfMs * 2) {
        break;
      }
    }

    const finalCandles = this.repo.getCachedCandles(
      symbol,
      timeframe,
      effectiveStartMs,
      effectiveEndMs
    );

    logger.info(
      {
        symbol,
        timeframe,
        totalCandles: finalCandles.length,
      },
      'Historical OHLCV synchronization completed and persisted to SQLite'
    );

    return finalCandles;
  }

  /**
   * Fetches the most recent closed candles for live / paper daemon execution.
   */
  public async fetchRecentCandles(
    symbol: string,
    timeframe: string,
    limit = 260
  ): Promise<Candle[]> {
    const raw = await this.fetchOhlcvWithFallback(symbol, timeframe, undefined, limit + 1);
    if (!raw || raw.length === 0) {
      return [];
    }

    const tfMs = MarketDataFeed.timeframeToMs(timeframe);
    const nowMs = Date.now();

    const candles: Candle[] = raw.map((row) => ({
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));

    // Drop the last candle if it is still forming (unclosed)
    if (candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      if (nowMs < lastCandle.timestamp + tfMs) {
        candles.pop();
      }
    }

    if (candles.length > 0) {
      this.repo.saveCandlesBatch(symbol, timeframe, candles);
    }

    return candles;
  }

  /**
   * Fetches the latest real-time Mainnet mark/last price for tick-level SL monitoring.
   */
  public async fetchCurrentPrice(symbol: string): Promise<number> {
    try {
      const ticker = await this.exchange.fetchTicker(symbol);
      const price = ticker.last ?? ticker.close ?? ticker.bid ?? ticker.ask;
      if (typeof price === 'number' && price > 0) {
        return price;
      }
    } catch (err) {
      logger.warn({ err, symbol, exchange: this.exchange.id }, 'Primary ticker fetch failed, trying OHLCV fallback');
    }

    const latest = await this.fetchOhlcvWithFallback(symbol, '1m', undefined, 2);
    if (latest.length > 0) {
      return Number(latest[latest.length - 1][4]);
    }
    throw new Error(`Unable to fetch current price for ${symbol}`);
  }

  private async fetchOhlcvWithFallback(
    symbol: string,
    timeframe: string,
    since?: number,
    limit = 1000
  ): Promise<number[][]> {
    const fallbackExchanges = [this.exchangeId, 'binance', 'bybit', 'okx'].filter(
      (v, i, arr) => arr.indexOf(v) === i
    );

    let lastError: unknown;
    for (const exId of fallbackExchanges) {
      try {
        if (this.exchange.id !== exId) {
          this.exchange = this.createPublicExchange(exId);
        }
        const data = await this.exchange.fetchOHLCV(symbol, timeframe, since, limit);
        return data as number[][];
      } catch (err) {
        lastError = err;
        logger.warn(
          { exchange: exId, symbol, timeframe, error: (err as Error).message },
          'OHLCV fetch attempt failed, rotating public Mainnet endpoint if available'
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to fetch OHLCV for ${symbol}`);
  }
}
