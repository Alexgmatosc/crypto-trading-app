import http from 'node:http';
import { strategyConfig } from '../config/strategyConfig.js';
import type { QuantRepository } from '../db/repository.js';
import type { IExecutionBroker } from '../exchange/IExecutionBroker.js';
import { generateModeReport } from '../report.js';
import type { ExecutionMode, TradeRecord } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface DashboardOptions {
  port?: number;
  mode: ExecutionMode;
  broker: IExecutionBroker;
  repo: QuantRepository;
  getMarkPrices: () => Record<string, number>;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly port: number;
  private readonly mode: ExecutionMode;
  private readonly broker: IExecutionBroker;
  private readonly repo: QuantRepository;
  private readonly getMarkPrices: () => Record<string, number>;

  constructor(options: DashboardOptions) {
    this.port = options.port ?? Number(process.env.PORT || 3000);
    this.mode = options.mode;
    this.broker = options.broker;
    this.repo = options.repo;
    this.getMarkPrices = options.getMarkPrices;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url || '/', `http://localhost:${this.port}`);

          if (url.pathname === '/api/status') {
            this.handleApiStatus(res);
            return;
          }

          if (url.pathname === '/' || url.pathname === '/index.html') {
            this.handleHtml(res);
            return;
          }

          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } catch (err) {
          logger.error({ err }, 'Error serving dashboard request');
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });

      this.server.listen(this.port, () => {
        logger.info(
          { port: this.port, url: `http://localhost:${this.port}` },
          'Web Dashboard running'
        );
        resolve();
      });

      this.server.on('error', (err) => {
        logger.error({ err }, 'Dashboard server error');
        reject(err);
      });
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleApiStatus(res: http.ServerResponse): void {
    const markPrices = this.getMarkPrices();
    const balance = this.broker.getBalanceSync();
    const openTrades = this.repo.getOpenTrades(this.mode);
    const closedTrades = this.repo.getClosedTrades(this.mode);
    const snapshots = this.repo.getEquitySnapshots(this.mode);
    const report = generateModeReport(this.mode, this.repo, balance > 0 ? balance : 5000);

    let unrealizedPnl = 0;
    const enrichedOpenTrades = openTrades.map((t: TradeRecord) => {
      const mark = markPrices[t.symbol] ?? t.entry_price;
      const priceDiff = t.side === 'LONG' ? mark - t.entry_price : t.entry_price - mark;
      const latentPnl = priceDiff * t.remaining_size;
      unrealizedPnl += latentPnl;

      return {
        ...t,
        currentPrice: mark,
        unrealizedPnl: latentPnl,
      };
    });

    const equity = balance + unrealizedPnl;

    // Per-symbol breakdown
    const configuredSymbols = strategyConfig.symbols;
    const allSymbols = Array.from(
      new Set([
        ...configuredSymbols,
        ...closedTrades.map((t) => t.symbol),
        ...openTrades.map((t) => t.symbol),
      ])
    );

    const symbolBreakdown = allSymbols.map((symbol) => {
      const symClosed = closedTrades.filter((t) => t.symbol === symbol);
      const totalTrades = symClosed.length;
      const winningTrades = symClosed.filter((t) => t.realized_pnl > 0).length;
      const losingTrades = symClosed.filter((t) => t.realized_pnl <= 0).length;
      const winRatePct = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

      let grossProfit = 0;
      let grossLoss = 0;
      let netRealizedPnl = 0;
      for (const t of symClosed) {
        netRealizedPnl += t.realized_pnl;
        if (t.realized_pnl > 0) grossProfit += t.realized_pnl;
        else grossLoss += Math.abs(t.realized_pnl);
      }

      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;
      const symOpen = enrichedOpenTrades.filter((t) => t.symbol === symbol);
      const currentPrice = markPrices[symbol] ?? (symOpen[0]?.currentPrice ?? 0);

      return {
        symbol,
        currentPrice,
        totalTrades,
        winningTrades,
        losingTrades,
        winRatePct,
        netRealizedPnl,
        profitFactor: Number.isFinite(profitFactor) ? profitFactor : (grossProfit > 0 ? 99.9 : 0),
        openCount: symOpen.length,
      };
    });

    const payload = {
      mode: this.mode,
      balance,
      equity,
      unrealizedPnl,
      netProfit: report.netProfitUsd,
      totalReturnPct: report.totalReturnPct,
      winRatePct: report.winRatePct,
      totalTrades: report.totalTrades,
      winningTrades: report.winningTrades,
      losingTrades: report.losingTrades,
      profitFactor: Number.isFinite(report.profitFactor) ? report.profitFactor : 0,
      maxDrawdownPct: report.maxDrawdownPct,
      openTrades: enrichedOpenTrades,
      closedTrades: closedTrades.slice(-20).reverse(),
      strategyBreakdown: report.strategyBreakdown,
      symbolBreakdown,
      snapshots: snapshots.slice(-60).map((s) => ({
        timestamp: s.timestamp,
        equity: s.equity_usdt,
        balance: s.balance_usdt,
        drawdown: s.drawdown_pct,
      })),
      timestamp: Date.now(),
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
  }

  private handleHtml(res: http.ServerResponse): void {
    const html = `<!DOCTYPE html>
<html lang="es" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crypto Quant Engine - Dashboard en Vivo</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: '#10b981',
            darkbg: '#0f172a',
            cardbg: '#1e293b'
          }
        }
      }
    }
  </script>
  <style>
    @keyframes pulse-fast { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .live-pulse { animation: pulse-fast 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
  </style>
</head>
<body class="bg-darkbg text-slate-100 font-sans min-h-screen p-4 md:p-8">
  <div class="max-w-7xl mx-auto space-y-6">

    <!-- Header -->
    <header class="flex flex-col md:flex-row justify-between items-start md:items-center bg-cardbg p-6 rounded-2xl border border-slate-700/60 shadow-xl gap-4">
      <div>
        <div class="flex items-center gap-3">
          <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            <span class="w-2 h-2 rounded-full bg-emerald-400 mr-2 live-pulse"></span> EN VIVO ACTIVO
          </span>
          <span id="badge-mode" class="px-2.5 py-0.5 rounded text-xs font-mono uppercase bg-blue-500/20 text-blue-400 border border-blue-500/30">TESTNET_LIVE</span>
        </div>
        <h1 class="text-2xl md:text-3xl font-extrabold tracking-tight mt-2 text-white">Adaptive Multi-Regime Quant Engine</h1>
        <p class="text-xs md:text-sm text-slate-400 mt-0.5">Operando Futuros Perpetuos con Gestión de Riesgo 1.5R y Trailing Stop</p>
      </div>

      <div class="text-right flex md:flex-col items-center md:items-end justify-between w-full md:w-auto">
        <span class="text-xs text-slate-400">Última actualización:</span>
        <span id="last-update" class="text-sm font-mono text-emerald-400 font-semibold">Cargando...</span>
      </div>
    </header>

    <!-- Top Metric Cards (Resumen General) -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="bg-cardbg p-5 rounded-xl border border-slate-700/60 shadow">
        <div class="text-xs font-medium text-slate-400 uppercase tracking-wider">Saldo Total (Balance)</div>
        <div id="stat-balance" class="text-2xl md:text-3xl font-bold mt-2 font-mono text-white">$0.00</div>
        <div class="text-xs text-slate-400 mt-1">Capital libre en exchange</div>
      </div>

      <div class="bg-cardbg p-5 rounded-xl border border-slate-700/60 shadow">
        <div class="text-xs font-medium text-slate-400 uppercase tracking-wider">Equity (Saldo + PnL)</div>
        <div id="stat-equity" class="text-2xl md:text-3xl font-bold mt-2 font-mono text-emerald-400">$0.00</div>
        <div id="stat-unrealized" class="text-xs text-slate-400 mt-1">Latente: $0.00</div>
      </div>

      <div class="bg-cardbg p-5 rounded-xl border border-slate-700/60 shadow">
        <div class="text-xs font-medium text-slate-400 uppercase tracking-wider">Beneficio Neto General</div>
        <div id="stat-pnl" class="text-2xl md:text-3xl font-bold mt-2 font-mono text-white">$0.00</div>
        <div id="stat-return" class="text-xs font-semibold mt-1">0.00%</div>
      </div>

      <div class="bg-cardbg p-5 rounded-xl border border-slate-700/60 shadow">
        <div class="text-xs font-medium text-slate-400 uppercase tracking-wider">Tasa de Acierto Global</div>
        <div id="stat-winrate" class="text-2xl md:text-3xl font-bold mt-2 font-mono text-purple-400">0.0%</div>
        <div id="stat-trades-count" class="text-xs text-slate-400 mt-1">0 Ganadores / 0 Perdedores</div>
      </div>
    </div>

    <!-- Desglose por Moneda -->
    <div class="bg-cardbg p-6 rounded-2xl border border-slate-700/60 shadow-xl">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-lg font-bold text-white">Desglose de Rendimiento por Moneda</h2>
          <p class="text-xs text-slate-400">Estadísticas individuales, precio de Binance en tiempo real y estado de cada activo</p>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="border-b border-slate-700 text-xs text-slate-400 uppercase">
              <th class="py-3 px-4">Moneda</th>
              <th class="py-3 px-4">Precio en Vivo</th>
              <th class="py-3 px-4">Operaciones</th>
              <th class="py-3 px-4">Win Rate (%)</th>
              <th class="py-3 px-4">Profit Factor</th>
              <th class="py-3 px-4">Estado</th>
              <th class="py-3 px-4 text-right">Beneficio Neto</th>
            </tr>
          </thead>
          <tbody id="table-symbols-breakdown" class="divide-y divide-slate-800 font-mono text-xs md:text-sm">
            <tr>
              <td colspan="7" class="text-center py-6 text-slate-500 font-sans">Cargando datos de monedas...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Equity Curve Chart -->
    <div class="bg-cardbg p-6 rounded-2xl border border-slate-700/60 shadow-xl">
      <div class="flex justify-between items-center mb-4">
        <div>
          <h2 class="text-lg font-bold text-white">Curva de Rendimiento General (Equity Curve)</h2>
          <p class="text-xs text-slate-400">Evolución del balance y capital en el tiempo</p>
        </div>
      </div>
      <div class="h-64 w-full">
        <canvas id="equityChart"></canvas>
      </div>
    </div>

    <!-- Open Positions -->
    <div class="bg-cardbg p-6 rounded-2xl border border-slate-700/60 shadow-xl">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <h2 class="text-lg font-bold text-white">Posiciones Abiertas en Tiempo Real</h2>
          <span id="badge-open-count" class="px-2 py-0.5 rounded-full text-xs font-bold bg-blue-500/20 text-blue-400">0</span>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="border-b border-slate-700 text-xs text-slate-400 uppercase">
              <th class="py-3 px-4">Símbolo</th>
              <th class="py-3 px-4">Estrategia</th>
              <th class="py-3 px-4">Lado</th>
              <th class="py-3 px-4">Entrada</th>
              <th class="py-3 px-4">Precio Actual</th>
              <th class="py-3 px-4">Stop Loss</th>
              <th class="py-3 px-4">TP1 (1.5R)</th>
              <th class="py-3 px-4 text-right">PnL Latente</th>
            </tr>
          </thead>
          <tbody id="table-open-positions" class="divide-y divide-slate-800 font-mono text-xs md:text-sm">
            <tr>
              <td colspan="8" class="text-center py-6 text-slate-500 font-sans">No hay posiciones abiertas actualmente. El bot está vigilando las velas de 15m.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Closed Trades History -->
    <div class="bg-cardbg p-6 rounded-2xl border border-slate-700/60 shadow-xl">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold text-white">Historial Reciente de Operaciones</h2>
        <span class="text-xs text-slate-400">Mostrando últimas operaciones cerradas</span>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="border-b border-slate-700 text-xs text-slate-400 uppercase">
              <th class="py-3 px-4">Símbolo</th>
              <th class="py-3 px-4">Estrategia</th>
              <th class="py-3 px-4">Lado</th>
              <th class="py-3 px-4">Entrada</th>
              <th class="py-3 px-4">Salida</th>
              <th class="py-3 px-4">Motivo de Salida</th>
              <th class="py-3 px-4">Cierre</th>
              <th class="py-3 px-4 text-right">Beneficio Neto</th>
            </tr>
          </thead>
          <tbody id="table-closed-trades" class="divide-y divide-slate-800 font-mono text-xs md:text-sm">
            <tr>
              <td colspan="8" class="text-center py-6 text-slate-500 font-sans">Aún no hay operaciones cerradas en esta sesión.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <script>
    let equityChartInstance = null;

    function formatPrice(val) {
      if (!val || val <= 0) return '-';
      if (val < 1) return '$' + val.toFixed(4);
      if (val < 10) return '$' + val.toFixed(3);
      return '$' + val.toFixed(2);
    }

    function initChart() {
      const ctx = document.getElementById('equityChart').getContext('2d');
      equityChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Equity (USDT)',
            data: [],
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8' } },
            y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8' } }
          }
        }
      });
    }

    async function updateDashboard() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById('badge-mode').innerText = data.mode;
        document.getElementById('last-update').innerText = new Date(data.timestamp).toLocaleTimeString();

        document.getElementById('stat-balance').innerText = '$' + data.balance.toFixed(2);
        document.getElementById('stat-equity').innerText = '$' + data.equity.toFixed(2);
        document.getElementById('stat-unrealized').innerText = 'Latente: ' + (data.unrealizedPnl >= 0 ? '+' : '') + '$' + data.unrealizedPnl.toFixed(2);

        const pnlEl = document.getElementById('stat-pnl');
        const retEl = document.getElementById('stat-return');
        pnlEl.innerText = (data.netProfit >= 0 ? '+' : '') + '$' + data.netProfit.toFixed(2);
        pnlEl.className = 'text-2xl md:text-3xl font-bold mt-2 font-mono ' + (data.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400');

        retEl.innerText = (data.totalReturnPct >= 0 ? '+' : '') + data.totalReturnPct.toFixed(2) + '%';
        retEl.className = 'text-xs font-semibold mt-1 ' + (data.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400');

        document.getElementById('stat-winrate').innerText = data.winRatePct.toFixed(1) + '%';
        document.getElementById('stat-trades-count').innerText = data.winningTrades + 'W / ' + data.losingTrades + 'L (Total: ' + data.totalTrades + ')';

        // Per-Symbol breakdown table
        const symTbody = document.getElementById('table-symbols-breakdown');
        if (data.symbolBreakdown && data.symbolBreakdown.length > 0) {
          symTbody.innerHTML = data.symbolBreakdown.map(s => {
            const pnlClass = s.netRealizedPnl >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
            const pfDisplay = s.profitFactor >= 99 ? 'INF' : s.profitFactor.toFixed(2);
            const statusBadge = s.openCount > 0
              ? '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5 live-pulse"></span> Abierta (' + s.openCount + ')</span>'
              : '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-400 border border-slate-700">Vigilando</span>';

            return '<tr class="hover:bg-slate-800/40 transition">' +
              '<td class="py-3 px-4 font-bold text-white flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-blue-400"></span>' + s.symbol + '</td>' +
              '<td class="py-3 px-4 font-semibold text-white">' + formatPrice(s.currentPrice) + '</td>' +
              '<td class="py-3 px-4 text-slate-300">' + s.totalTrades + ' (' + s.winningTrades + 'W / ' + s.losingTrades + 'L)</td>' +
              '<td class="py-3 px-4 text-purple-400 font-semibold">' + s.winRatePct.toFixed(1) + '%</td>' +
              '<td class="py-3 px-4 text-slate-300">' + pfDisplay + '</td>' +
              '<td class="py-3 px-4 font-sans">' + statusBadge + '</td>' +
              '<td class="py-3 px-4 text-right ' + pnlClass + '">' + (s.netRealizedPnl >= 0 ? '+' : '') + '$' + s.netRealizedPnl.toFixed(2) + '</td>' +
            '</tr>';
          }).join('');
        }

        // Open positions table
        document.getElementById('badge-open-count').innerText = data.openTrades.length;
        const openTbody = document.getElementById('table-open-positions');
        if (data.openTrades.length === 0) {
          openTbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-slate-500 font-sans">No hay posiciones abiertas actualmente. El bot está vigilando las velas de 15m.</td></tr>';
        } else {
          openTbody.innerHTML = data.openTrades.map(t => {
            const sideClass = t.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30';
            const pnlClass = t.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
            const tp1Badge = t.tp1_hit === 1 ? '<span class="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-400">BE Activo</span>' : '<span class="text-slate-400">Pendiente</span>';
            return '<tr class="hover:bg-slate-800/40 transition">' +
              '<td class="py-3 px-4 font-bold text-white">' + t.symbol + '</td>' +
              '<td class="py-3 px-4 text-slate-300 font-sans">' + t.strategy + '</td>' +
              '<td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-xs font-bold ' + sideClass + '">' + t.side + '</span></td>' +
              '<td class="py-3 px-4">' + formatPrice(t.entry_price) + '</td>' +
              '<td class="py-3 px-4 font-semibold text-white">' + formatPrice(t.currentPrice) + '</td>' +
              '<td class="py-3 px-4 text-amber-400">' + formatPrice(t.current_sl) + '</td>' +
              '<td class="py-3 px-4">' + tp1Badge + '</td>' +
              '<td class="py-3 px-4 text-right font-bold ' + pnlClass + '">' + (t.unrealizedPnl >= 0 ? '+' : '') + '$' + t.unrealizedPnl.toFixed(2) + '</td>' +
            '</tr>';
          }).join('');
        }

        // Closed trades table
        const closedTbody = document.getElementById('table-closed-trades');
        if (data.closedTrades.length === 0) {
          closedTbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-slate-500 font-sans">Aún no hay operaciones cerradas.</td></tr>';
        } else {
          closedTbody.innerHTML = data.closedTrades.map(t => {
            const sideClass = t.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400';
            const pnlClass = t.realized_pnl >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold';
            const closedDate = t.closed_at ? new Date(t.closed_at).toLocaleTimeString() : '-';
            return '<tr class="hover:bg-slate-800/40 transition">' +
              '<td class="py-3 px-4 font-bold text-white">' + t.symbol + '</td>' +
              '<td class="py-3 px-4 text-slate-300 font-sans">' + t.strategy + '</td>' +
              '<td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-xs ' + sideClass + '">' + t.side + '</span></td>' +
              '<td class="py-3 px-4">' + formatPrice(t.entry_price) + '</td>' +
              '<td class="py-3 px-4">' + formatPrice(t.exit_price) + '</td>' +
              '<td class="py-3 px-4 text-slate-300 font-sans text-xs">' + (t.exit_reason || '-') + '</td>' +
              '<td class="py-3 px-4 text-xs text-slate-400 font-sans">' + closedDate + '</td>' +
              '<td class="py-3 px-4 text-right ' + pnlClass + '">' + (t.realized_pnl >= 0 ? '+' : '') + '$' + t.realized_pnl.toFixed(2) + '</td>' +
            '</tr>';
          }).join('');
        }

        // Update chart
        if (equityChartInstance && data.snapshots && data.snapshots.length > 0) {
          equityChartInstance.data.labels = data.snapshots.map(s => new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          equityChartInstance.data.datasets[0].data = data.snapshots.map(s => s.equity);
          equityChartInstance.update();
        }

      } catch (err) {
        console.error('Error fetching status:', err);
      }
    }

    window.addEventListener('DOMContentLoaded', () => {
      initChart();
      updateDashboard();
      setInterval(updateDashboard, 5000);
    });
  </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}
