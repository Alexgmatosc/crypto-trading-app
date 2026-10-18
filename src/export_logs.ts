import fs from 'node:fs';
import path from 'node:path';
import { repository } from './db/repository.js';
import type { ExecutionMode } from './types/index.js';
import { formatPrice } from './utils/formatPrice.js';

export { formatPrice };

export function exportHistoricalLogs(mode: ExecutionMode = 'TESTNET_LIVE'): void {
  const rootDir = process.cwd();
  const logsDir = path.resolve(rootDir, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const allTrades = repository.getAllTrades(mode);
  const snapshots = repository.getEquitySnapshots(mode);

  // 1. Export JSON files
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

- **Balance Actual en Binance Testnet**: $${(latestSnap?.balance_usdt ?? 5000).toFixed(2)} USDT
- **Equity Actual**: $${(latestSnap?.equity_usdt ?? 5000).toFixed(2)} USDT
- **Drawdown Máximo Registrado**: ${(latestSnap?.drawdown_pct ?? 0).toFixed(2)}%
- **Operaciones Cerradas**: ${closedTrades.length} (${winning}W / ${losing}L)
- **PnL Neto Realizado**: $${netRealizedPnl.toFixed(2)} USDT
- **Posiciones Abiertas**: ${allTrades.filter((t) => t.status === 'OPEN').length}

> Consulta [LOGS_TEXTO_COMPLETO.txt](../LOGS_TEXTO_COMPLETO.txt) para ver los logs crudos completos en texto plano.
`;
  fs.writeFileSync(summaryFile, md, 'utf-8');

  // 3. Export Plain Text Trades Audit Table (logs/TRADES_AUDIT.txt)
  let textTable = `================================================================================\n`;
  textTable += `  HISTORIAL DETALLADO DE OPERACIONES (AUDIT TRAIL EN TEXTO PLANO)\n`;
  textTable += `  Modo: ${mode} | Generado: ${new Date().toISOString()}\n`;
  textTable += `================================================================================\n\n`;
  textTable += `ID         | Par        | Lado  | Estrategia      | Entrada  | Salida   | PnL (USDT) | Comision | Motivo Salida | Apertura | Cierre\n`;
  textTable += `-----------+------------+-------+-----------------+----------+----------+------------+----------+---------------+----------+---------\n`;

  for (const t of allTrades) {
    const idShort = t.id.slice(0, 8);
    const sym = t.symbol.padEnd(10);
    const side = t.side.padEnd(5);
    const strat = t.strategy.slice(0, 15).padEnd(15);
    const entry = ('$' + formatPrice(Number(t.entry_price))).padEnd(8);
    const exit = (t.exit_price ? '$' + formatPrice(Number(t.exit_price)) : '—').padEnd(8);
    const pnl = ((t.realized_pnl >= 0 ? '+' : '') + Number(t.realized_pnl || 0).toFixed(2)).padEnd(10);
    const fee = ('$' + Number(t.fees_paid || 0).toFixed(2)).padEnd(8);
    const reason = (t.exit_reason || t.status).padEnd(13);
    const openTs = new Date(t.opened_at).toLocaleTimeString('es-ES');
    const closeTs = t.closed_at ? new Date(t.closed_at).toLocaleTimeString('es-ES') : '—';
    textTable += `${idShort} | ${sym} | ${side} | ${strat} | ${entry} | ${exit} | ${pnl} | ${fee} | ${reason} | ${openTs} | ${closeTs}\n`;
  }
  fs.writeFileSync(path.join(logsDir, 'TRADES_AUDIT.txt'), textTable, 'utf-8');

  // 4. Export Raw Server Execution Logs (logs/SERVER_EXECUTION_LOGS.txt and LOGS_TEXTO_COMPLETO.txt)
  const pm2OutLog = '/home/alexgmatosc/.pm2/logs/quant-bot-out.log';
  const pm2ErrLog = '/home/alexgmatosc/.pm2/logs/quant-bot-error.log';

  let rawLogs = '';
  if (fs.existsSync(pm2OutLog)) {
    rawLogs = fs.readFileSync(pm2OutLog, 'utf-8');
  }

  let rawErrors = '';
  if (fs.existsSync(pm2ErrLog)) {
    rawErrors = fs.readFileSync(pm2ErrLog, 'utf-8');
  }

  fs.writeFileSync(path.join(logsDir, 'SERVER_EXECUTION_LOGS.txt'), rawLogs, 'utf-8');

  // Combined monolithic text file in root for easy copy-pasting to Gemini
  let monolithic = `================================================================================\n`;
  monolithic += `REGISTRO COMPLETO EN TEXTO PLANO — CRYPTO QUANT ENGINE (BINANCE TESTNET)\n`;
  monolithic += `Pensado para análisis con Gemini / Modelos LLM\n`;
  monolithic += `Generado: ${new Date().toISOString()}\n`;
  monolithic += `================================================================================\n\n`;

  monolithic += `--- 1. RESUMEN DE SALDO Y CAPITAL ---\n`;
  monolithic += `Saldo Inicial de Prueba: $5,000.00 USDT\n`;
  monolithic += `Saldo Actual en Binance Testnet: $${(latestSnap?.balance_usdt ?? 5000).toFixed(2)} USDT (Efectivo libre)\n`;
  monolithic += `Diferencia Neta Total: $${netRealizedPnl.toFixed(2)} USDT (${((netRealizedPnl / 5000) * 100).toFixed(2)}%)\n`;
  monolithic += `Posiciones Abiertas Actualmente: ${allTrades.filter((t) => t.status === 'OPEN').length}\n\n`;

  monolithic += `--- 2. TABLA DE TODAS LAS OPERACIONES EJECUTADAS ---\n\n`;
  monolithic += textTable + '\n\n';

  monolithic += `--- 3. ÚLTIMOS LOGS CRUDOS DEL SERVIDOR (CONSOLE OUTPUT) ---\n\n`;
  // Take last 400 lines of console logs
  const logLines = rawLogs.split('\n');
  const recentLines = logLines.slice(-400).join('\n');
  monolithic += recentLines + '\n\n';

  if (rawErrors.trim().length > 0) {
    monolithic += `--- 4. ERRORES REGISTRADOS EN STDERR ---\n\n`;
    monolithic += rawErrors.split('\n').slice(-100).join('\n') + '\n';
  }

  fs.writeFileSync(path.join(rootDir, 'LOGS_TEXTO_COMPLETO.txt'), monolithic, 'utf-8');
}

const isMain =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('export_logs.ts');

if (isMain) {
  exportHistoricalLogs('TESTNET_LIVE');
  console.log('Plain text logs exported successfully into LOGS_TEXTO_COMPLETO.txt and logs/');
}
