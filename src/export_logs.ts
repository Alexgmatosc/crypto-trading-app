import fs from 'node:fs';
import path from 'node:path';
import { repository } from './db/repository.js';
import type { ExecutionMode } from './types/index.js';

export function exportHistoricalLogs(mode: ExecutionMode = 'TESTNET_LIVE'): void {
  const logsDir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const allTrades = repository.getAllTrades(mode);
  const snapshots = repository.getEquitySnapshots(mode);

  // 1. Export JSON files for automated processing by LLMs / Gemini
  const tradesFile = path.join(logsDir, 'trades_history.json');
  fs.writeFileSync(tradesFile, JSON.stringify(allTrades, null, 2), 'utf-8');

  const snapshotsFile = path.join(logsDir, 'snapshots_history.json');
  fs.writeFileSync(snapshotsFile, JSON.stringify(snapshots, null, 2), 'utf-8');

  // 2. Export Markdown Summary
  const summaryFile = path.join(logsDir, 'LATEST_STATUS.md');
  const latestSnap = snapshots[snapshots.length - 1];
  const closedTrades = allTrades.filter((t) => t.status === 'CLOSED');
  const winning = closedTrades.filter((t) => t.realized_pnl > 0).length;
  const losing = closedTrades.filter((t) => t.realized_pnl <= 0).length;
  const netRealizedPnl = closedTrades.reduce((acc, t) => acc + t.realized_pnl, 0);

  const md = `# Estado del Sistema Cuantitativo [${mode}]
Generado: ${new Date().toISOString()}

- **Balance Actual**: $${(latestSnap?.balance_usdt ?? 5000).toFixed(2)} USDT
- **Equity Actual**: $${(latestSnap?.equity_usdt ?? 5000).toFixed(2)} USDT
- **Drawdown Máximo Registrado**: ${(latestSnap?.drawdown_pct ?? 0).toFixed(2)}%
- **Operaciones Cerradas**: ${closedTrades.length} (${winning}W / ${losing}L)
- **PnL Neto Realizado**: $${netRealizedPnl.toFixed(2)} USDT
- **Posiciones Abiertas**: ${allTrades.filter((t) => t.status === 'OPEN').length}

> Consulta [AUDIT_LOG.md](../AUDIT_LOG.md) para el desglose paso a paso de cada operación y la bitácora de incidentes.
`;

  fs.writeFileSync(summaryFile, md, 'utf-8');
}

const isMain =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('export_logs.ts');

if (isMain) {
  exportHistoricalLogs('TESTNET_LIVE');
  console.log('Historical logs exported successfully into logs/');
}
