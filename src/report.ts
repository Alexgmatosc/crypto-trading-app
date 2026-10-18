import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { strategyConfig } from './config/strategyConfig.js';
import { QuantRepository, repository as defaultRepo } from './db/repository.js';
import type {
  BacktestReport,
  ExecutionMode,
  StrategyName,
  StrategyPerformanceBreakdown,
  TradeRecord,
} from './types/index.js';
import { formatPrice } from './utils/formatPrice.js';

function computeStrategyBreakdown(
  strategy: StrategyName,
  closedTrades: TradeRecord[]
): StrategyPerformanceBreakdown {
  const filtered = closedTrades.filter((t) => t.strategy === strategy);
  const totalTrades = filtered.length;
  const winningTrades = filtered.filter((t) => t.realized_pnl > 0).length;
  const losingTrades = filtered.filter((t) => t.realized_pnl <= 0).length;
  const winRatePct = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let netProfitUsd = 0;
  let feesPaidUsd = 0;

  for (const t of filtered) {
    netProfitUsd += t.realized_pnl;
    feesPaidUsd += t.fees_paid;
    if (t.realized_pnl > 0) {
      grossProfitUsd += t.realized_pnl;
    } else {
      grossLossUsd += Math.abs(t.realized_pnl);
    }
  }

  const profitFactor =
    grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? Infinity : 0;
  const expectancyUsd = totalTrades > 0 ? netProfitUsd / totalTrades : 0;

  return {
    strategy,
    totalTrades,
    winningTrades,
    losingTrades,
    winRatePct,
    grossProfitUsd,
    grossLossUsd,
    netProfitUsd,
    profitFactor,
    expectancyUsd,
    feesPaidUsd,
  };
}

export function generateModeReport(
  mode: ExecutionMode,
  repo: QuantRepository = defaultRepo,
  initialBalance: number = strategyConfig.initialBalance
): BacktestReport {
  const allTrades = repo.getAllTrades(mode);
  const closedTrades = allTrades.filter((t) => t.status === 'CLOSED');
  const snapshots = repo.getEquitySnapshots(mode);

  const totalTrades = closedTrades.length;
  const winningTrades = closedTrades.filter((t) => t.realized_pnl > 0).length;
  const losingTrades = closedTrades.filter((t) => t.realized_pnl <= 0).length;
  const winRatePct = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let netRealizedPnl = 0;
  let totalFeesPaidUsd = 0;

  for (const t of allTrades) {
    totalFeesPaidUsd += t.fees_paid;
  }

  for (const t of closedTrades) {
    netRealizedPnl += t.realized_pnl;
    if (t.realized_pnl > 0) {
      grossProfitUsd += t.realized_pnl;
    } else {
      grossLossUsd += Math.abs(t.realized_pnl);
    }
  }

  const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined;
  const effectiveInitialBalance =
    snapshots.length > 0 ? snapshots[0].balance_usdt : initialBalance;
  const finalBalance = latestSnapshot
    ? latestSnapshot.balance_usdt
    : effectiveInitialBalance + netRealizedPnl;
  const finalEquity = latestSnapshot ? latestSnapshot.equity_usdt : finalBalance;

  const netProfitUsd = finalEquity - effectiveInitialBalance;
  const totalReturnPct = effectiveInitialBalance > 0 ? (netProfitUsd / effectiveInitialBalance) * 100 : 0;

  const profitFactor =
    grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? Infinity : 0;
  const expectancyUsd = totalTrades > 0 ? netRealizedPnl / totalTrades : 0;

  let maxDrawdownPct = 0;
  for (const snap of snapshots) {
    if (snap.drawdown_pct > maxDrawdownPct) {
      maxDrawdownPct = snap.drawdown_pct;
    }
  }

  const startTimestamp =
    snapshots.length > 0
      ? snapshots[0].timestamp
      : allTrades.length > 0
        ? allTrades[0].opened_at
        : Date.now();
  const endTimestamp =
    snapshots.length > 0
      ? snapshots[snapshots.length - 1].timestamp
      : allTrades.length > 0
        ? (allTrades[allTrades.length - 1].closed_at ?? allTrades[allTrades.length - 1].opened_at)
        : Date.now();

  const symbolsSet = new Set<string>(allTrades.map((t) => t.symbol));
  const symbols = symbolsSet.size > 0 ? Array.from(symbolsSet) : strategyConfig.symbols;

  return {
    mode,
    symbols,
    timeframe: strategyConfig.timeframe,
    startTimestamp,
    endTimestamp,
    initialBalance,
    finalBalance,
    finalEquity,
    totalReturnPct,
    netProfitUsd,
    totalTrades,
    winningTrades,
    losingTrades,
    winRatePct,
    profitFactor,
    expectancyUsd,
    maxDrawdownPct,
    totalFeesPaidUsd,
    strategyBreakdown: {
      TREND_BREAKOUT: computeStrategyBreakdown('TREND_BREAKOUT', closedTrades),
      MEAN_REVERSION: computeStrategyBreakdown('MEAN_REVERSION', closedTrades),
    },
  };
}

export { formatPrice };

export function printReportToConsole(
  report: BacktestReport,
  openTrades: TradeRecord[],
  closedTrades: TradeRecord[]
): void {
  const formatUsd = (val: number) => `${val >= 0 ? '+' : ''}$${val.toFixed(2)}`;
  const formatPct = (val: number) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
  const formatPf = (pf: number) => (Number.isFinite(pf) ? pf.toFixed(2) : 'INF');
  const formatAssetPrice = (price: number) => `$${formatPrice(price)}`;

  console.log('\n================================================================================');
  console.log(`  ADAPTIVE MULTI-REGIME CRYPTO QUANT ENGINE - PERFORMANCE REPORT [${report.mode}]`);
  console.log('================================================================================');
  console.log(`  Symbols          : ${report.symbols.join(', ')} (${report.timeframe})`);
  console.log(
    `  Period           : ${new Date(report.startTimestamp).toISOString()} -> ${new Date(report.endTimestamp).toISOString()}`
  );
  console.log('--------------------------------------------------------------------------------');

  console.table([
    {
      Metric: 'Initial Balance',
      Value: `$${report.initialBalance.toFixed(2)}`,
    },
    {
      Metric: 'Current / Final Balance',
      Value: `$${report.finalBalance.toFixed(2)}`,
    },
    {
      Metric: 'Current / Final Equity',
      Value: `$${report.finalEquity.toFixed(2)}`,
    },
    {
      Metric: 'Net Profit ($)',
      Value: formatUsd(report.netProfitUsd),
    },
    {
      Metric: 'Total Return (%)',
      Value: formatPct(report.totalReturnPct),
    },
    {
      Metric: 'Max Drawdown (%)',
      Value: `-${report.maxDrawdownPct.toFixed(2)}%`,
    },
    {
      Metric: 'Total Closed Trades',
      Value: `${report.totalTrades} (${report.winningTrades}W / ${report.losingTrades}L)`,
    },
    {
      Metric: 'Win Rate (%)',
      Value: `${report.winRatePct.toFixed(2)}%`,
    },
    {
      Metric: 'Profit Factor',
      Value: formatPf(report.profitFactor),
    },
    {
      Metric: 'Mathematical Expectancy / Trade',
      Value: formatUsd(report.expectancyUsd),
    },
    {
      Metric: 'Total Fees Paid ($)',
      Value: `$${report.totalFeesPaidUsd.toFixed(2)}`,
    },
  ]);

  console.log('\n--- Strategy Breakdown (TREND_BREAKOUT vs MEAN_REVERSION) ---');
  const tb = report.strategyBreakdown.TREND_BREAKOUT;
  const mr = report.strategyBreakdown.MEAN_REVERSION;
  console.table([
    {
      Strategy: tb.strategy,
      Trades: tb.totalTrades,
      'Win / Loss': `${tb.winningTrades}W / ${tb.losingTrades}L`,
      'Win Rate (%)': `${tb.winRatePct.toFixed(2)}%`,
      'Gross Profit ($)': `$${tb.grossProfitUsd.toFixed(2)}`,
      'Gross Loss ($)': `-$${tb.grossLossUsd.toFixed(2)}`,
      'Net PnL ($)': formatUsd(tb.netProfitUsd),
      'Profit Factor': formatPf(tb.profitFactor),
      'Expectancy ($)': formatUsd(tb.expectancyUsd),
    },
    {
      Strategy: mr.strategy,
      Trades: mr.totalTrades,
      'Win / Loss': `${mr.winningTrades}W / ${mr.losingTrades}L`,
      'Win Rate (%)': `${mr.winRatePct.toFixed(2)}%`,
      'Gross Profit ($)': `$${mr.grossProfitUsd.toFixed(2)}`,
      'Gross Loss ($)': `-$${mr.grossLossUsd.toFixed(2)}`,
      'Net PnL ($)': formatUsd(mr.netProfitUsd),
      'Profit Factor': formatPf(mr.profitFactor),
      'Expectancy ($)': formatUsd(mr.expectancyUsd),
    },
  ]);

  console.log(`\n--- Open Positions (${openTrades.length}) ---`);
  if (openTrades.length === 0) {
    console.log('  No open positions currently active.');
  } else {
    console.table(
      openTrades.map((t) => ({
        ID: t.id.slice(0, 8),
        Symbol: t.symbol,
        Strategy: t.strategy,
        Regime: t.regime_at_entry,
        Side: t.side,
        Entry: formatAssetPrice(t.entry_price),
        'Rem. Size': Number(t.remaining_size.toFixed(5)),
        'Current SL': formatAssetPrice(t.current_sl),
        'TP1 (1.5R)': t.tp1_hit === 1 ? 'HIT (BE Active)' : 'PENDING',
        'Realized PnL': formatUsd(t.realized_pnl),
        'Opened At': new Date(t.opened_at).toISOString(),
      }))
    );
  }

  if (closedTrades.length > 0) {
    const recentClosed = closedTrades.slice(-10);
    console.log(`\n--- Recent Closed Trades (Showing last ${recentClosed.length} of ${closedTrades.length}) ---`);
    console.table(
      recentClosed.map((t) => ({
        ID: t.id.slice(0, 8),
        Symbol: t.symbol,
        Strategy: t.strategy,
        Side: t.side,
        Entry: formatAssetPrice(t.entry_price),
        Exit: t.exit_price ? formatAssetPrice(t.exit_price) : 'N/A',
        'TP1 Hit': t.tp1_hit === 1 ? 'YES' : 'NO',
        'Exit Reason': t.exit_reason ?? 'N/A',
        'Net PnL ($)': formatUsd(t.realized_pnl),
        'Closed At': t.closed_at ? new Date(t.closed_at).toISOString() : 'N/A',
      }))
    );
  }
  console.log('================================================================================\n');
}

function runReportCli(): void {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith('--mode='))?.split('=')[1] as
    | ExecutionMode
    | undefined;

  const modesToCheck: ExecutionMode[] = modeArg
    ? [modeArg]
    : ['BACKTEST', 'PAPER_LOCAL', 'TESTNET_LIVE'];

  let printedAny = false;
  for (const mode of modesToCheck) {
    const allTrades = defaultRepo.getAllTrades(mode);
    const snapshots = defaultRepo.getEquitySnapshots(mode);
    if (allTrades.length > 0 || snapshots.length > 0 || mode === modeArg) {
      const report = generateModeReport(mode, defaultRepo);
      const openTrades = defaultRepo.getOpenTrades(mode);
      const closedTrades = defaultRepo.getClosedTrades(mode);
      printReportToConsole(report, openTrades, closedTrades);
      printedAny = true;
    }
  }

  if (!printedAny) {
    const fallbackMode = env.EXECUTION_MODE;
    const report = generateModeReport(fallbackMode, defaultRepo);
    printReportToConsole(report, [], []);
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  runReportCli();
}
