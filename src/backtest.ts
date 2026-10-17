import { fileURLToPath } from 'node:url';
import { strategyConfig } from './config/strategyConfig.js';
import { Engine } from './core/Engine.js';
import { repository } from './db/repository.js';
import { MarketDataFeed } from './exchange/MarketDataFeed.js';
import { PaperBroker } from './exchange/PaperBroker.js';
import { generateModeReport, printReportToConsole } from './report.js';
import type { BacktestReport, Candle } from './types/index.js';
import { logger } from './utils/logger.js';

export interface BacktestOptions {
  days?: number;
  symbols?: string[];
  timeframe?: string;
}

function parseCliArgs(argv: string[]): BacktestOptions {
  const options: BacktestOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--days=')) {
      options.days = Number.parseInt(arg.split('=')[1], 10);
    } else if (arg === '--days' && argv[i + 1]) {
      options.days = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith('--symbols=')) {
      options.symbols = arg
        .split('=')[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--symbols' && argv[i + 1]) {
      options.symbols = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--symbol=')) {
      options.symbols = [arg.split('=')[1].trim()];
    } else if (arg === '--symbol' && argv[i + 1]) {
      options.symbols = [argv[++i].trim()];
    }
  }

  return options;
}

export async function runBacktest(options?: BacktestOptions): Promise<BacktestReport> {
  const days = options?.days && options.days > 0 ? options.days : 30;
  const symbols =
    options?.symbols && options.symbols.length > 0
      ? options.symbols[0] === 'all'
        ? strategyConfig.symbols
        : options.symbols
      : ['BTC/USDT'];
  const timeframe = options?.timeframe ?? strategyConfig.timeframe;

  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - days * 24 * 60 * 60 * 1000;
  const warmupCandles = 220;

  logger.info(
    {
      mode: 'BACKTEST',
      symbols,
      timeframe,
      days,
      initialBalance: strategyConfig.initialBalance,
    },
    'Starting historical backtest simulation...'
  );

  // Reset previous BACKTEST run data in SQLite
  repository.clearModeData('BACKTEST');

  const feed = new MarketDataFeed();
  const broker = new PaperBroker(strategyConfig.initialBalance, strategyConfig);
  await broker.initialize();

  const engine = new Engine({
    mode: 'BACKTEST',
    broker,
    repo: repository,
    config: strategyConfig,
  });

  // Load historical candles (with warmup buffer) for each symbol
  const candlesBySymbol = new Map<string, Candle[]>();
  const indexBySymbolAndTs = new Map<string, Map<number, number>>();
  const timelineTimestamps = new Set<number>();

  for (const symbol of symbols) {
    const candles = await feed.fetchHistoricalCandles({
      symbol,
      timeframe,
      startTimeMs,
      endTimeMs,
      warmupCandles,
    });

    candlesBySymbol.set(symbol, candles);
    const tsMap = new Map<number, number>();
    candles.forEach((c, idx) => {
      tsMap.set(c.timestamp, idx);
      if (c.timestamp >= startTimeMs) {
        timelineTimestamps.add(c.timestamp);
      }
    });
    indexBySymbolAndTs.set(symbol, tsMap);
  }

  const sortedTimeline = Array.from(timelineTimestamps).sort((a, b) => a - b);
  const markPrices: Record<string, number> = {};
  const maxLookbackWindow = 250;

  const simStartWallMs = performance.now();

  for (let step = 0; step < sortedTimeline.length; step++) {
    const ts = sortedTimeline[step];

    for (const symbol of symbols) {
      const tsMap = indexBySymbolAndTs.get(symbol);
      const allCandles = candlesBySymbol.get(symbol);
      if (!tsMap || !allCandles) continue;

      const candleIdx = tsMap.get(ts);
      if (candleIdx === undefined) continue;

      const windowStart = Math.max(0, candleIdx - maxLookbackWindow + 1);
      const windowSlice = allCandles.slice(windowStart, candleIdx + 1);

      await engine.processCandleClose({
        symbol,
        candles: windowSlice,
        markPrices,
      });
    }

    // Record equity snapshot periodically (every 4 hours = 16 candles of 15m) and on first/last step
    if (step === 0 || step === sortedTimeline.length - 1 || step % 16 === 0) {
      engine.recordEquitySnapshot(ts, markPrices);
    }
  }

  const elapsedMs = performance.now() - simStartWallMs;
  const report = generateModeReport('BACKTEST', repository, strategyConfig.initialBalance);
  const openTrades = repository.getOpenTrades('BACKTEST');
  const closedTrades = repository.getClosedTrades('BACKTEST');

  logger.info(
    {
      simulatedCandles: sortedTimeline.length,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      totalTrades: report.totalTrades,
      netProfitUsd: Number(report.netProfitUsd.toFixed(2)),
      totalReturnPct: Number(report.totalReturnPct.toFixed(2)),
      maxDrawdownPct: Number(report.maxDrawdownPct.toFixed(2)),
    },
    'Backtest simulation completed'
  );

  printReportToConsole(report, openTrades, closedTrades);
  return report;
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  runBacktest(cliOptions).catch((err) => {
    logger.error({ err }, 'Backtest failed with fatal error');
    process.exit(1);
  });
}
