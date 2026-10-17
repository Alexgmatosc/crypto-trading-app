import http from 'node:http';
import { strategyConfig } from '../config/strategyConfig.js';
import { RegimeDetector } from '../core/RegimeDetector.js';
import type { QuantRepository } from '../db/repository.js';
import type { IExecutionBroker } from '../exchange/IExecutionBroker.js';
import { MathEngine } from '../indicators/MathEngine.js';
import { generateModeReport } from '../report.js';
import type { Candle, ExecutionMode, TradeRecord } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface DashboardOptions {
  port?: number;
  mode: ExecutionMode;
  broker: IExecutionBroker;
  repo: QuantRepository;
  getMarkPrices: () => Record<string, number>;
  getCandlesBySymbol?: () => Record<string, Candle[]>;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private readonly port: number;
  private readonly mode: ExecutionMode;
  private readonly broker: IExecutionBroker;
  private readonly repo: QuantRepository;
  private readonly getMarkPrices: () => Record<string, number>;
  private readonly getCandlesBySymbol?: () => Record<string, Candle[]>;
  private readonly regimeDetector: RegimeDetector;

  constructor(options: DashboardOptions) {
    this.port = options.port ?? Number(process.env.PORT || 3000);
    this.mode = options.mode;
    this.broker = options.broker;
    this.repo = options.repo;
    this.getMarkPrices = options.getMarkPrices;
    this.getCandlesBySymbol = options.getCandlesBySymbol;
    this.regimeDetector = new RegimeDetector(undefined, strategyConfig);
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
    const memoryCandles = this.getCandlesBySymbol ? this.getCandlesBySymbol() : {};
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

    // Per-symbol breakdown with live quantitative telemetry
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
      const openUnrealizedPnl = symOpen.reduce((acc, t) => acc + (t.unrealizedPnl ?? 0), 0);

      // Obtain candles from memory or fallback to SQLite cache
      let candles = memoryCandles[symbol];
      if (!candles || candles.length === 0) {
        candles = this.repo.getCachedCandles(symbol, strategyConfig.timeframe, 0, Date.now()).slice(-260);
      }

      const lastCandleClose = candles && candles.length > 0 ? candles[candles.length - 1].close : 0;
      const currentPrice = markPrices[symbol] ?? (symOpen[0]?.currentPrice || lastCandleClose);

      let regime = 'WARMING_UP';
      let adx: number | null = null;
      let rsi: number | null = null;
      let bbWidthPct: number | null = null;
      let ema200: number | null = null;

      if (candles && candles.length >= 210) {
        try {
          const state = this.regimeDetector.detect(candles);
          adx = state.adx;
          bbWidthPct = state.bbWidth * 100;
          rsi = MathEngine.getLatestRSI(candles, strategyConfig.meanReversionStrategy.rsiPeriod);
          ema200 = MathEngine.getLatestEMA(candles, strategyConfig.trendStrategy.emaBaseline);

          if (state.regime === 'TRENDING') {
            regime = ema200 && currentPrice >= ema200 ? 'TRENDING_BULL' : 'TRENDING_BEAR';
          } else if (state.regime === 'RANGING') {
            regime = 'RANGING';
          } else {
            regime = 'VOLATILE_CHOP';
          }
        } catch {
          // Ignore indicator warmup errors
        }
      }

      return {
        symbol,
        currentPrice,
        regime,
        adx,
        rsi,
        bbWidthPct,
        ema200,
        totalTrades,
        winningTrades,
        losingTrades,
        winRatePct,
        netRealizedPnl,
        openUnrealizedPnl,
        profitFactor: Number.isFinite(profitFactor) ? profitFactor : grossProfit > 0 ? 99.9 : 0,
        openCount: symOpen.length,
      };
    });

    const payload = {
      mode: this.mode,
      timeframe: strategyConfig.timeframe,
      maxConcurrentPositions: strategyConfig.maxConcurrentPositions,
      riskPerTradePct: strategyConfig.riskPerTrade * 100,
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
      closedTrades: closedTrades.slice(-30).reverse(),
      strategyBreakdown: report.strategyBreakdown,
      symbolBreakdown,
      snapshots: snapshots.slice(-80).map((s) => ({
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
  <title>QuantEngine — Institutional Execution Desk</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --background: 0 0% 100%;
      --foreground: 240 10% 3.9%;
      --card: 0 0% 100%;
      --card-foreground: 240 10% 3.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 240 10% 3.9%;
      --primary: 240 5.9% 10%;
      --primary-foreground: 0 0% 98%;
      --secondary: 240 4.8% 95.9%;
      --secondary-foreground: 240 5.9% 10%;
      --muted: 240 4.8% 95.9%;
      --muted-foreground: 240 3.8% 46.1%;
      --accent: 240 4.8% 95.9%;
      --accent-foreground: 240 5.9% 10%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 0 0% 98%;
      --border: 240 5.9% 90%;
      --input: 240 5.9% 90%;
      --ring: 240 5.9% 10%;
      --radius: 0.5rem;
    }

    .dark {
      --background: 240 10% 3.9%;
      --foreground: 0 0% 98%;
      --card: 240 10% 3.9%;
      --card-foreground: 0 0% 98%;
      --popover: 240 10% 3.9%;
      --popover-foreground: 0 0% 98%;
      --primary: 0 0% 98%;
      --primary-foreground: 240 5.9% 10%;
      --secondary: 240 3.7% 15.9%;
      --secondary-foreground: 0 0% 98%;
      --muted: 240 3.7% 15.9%;
      --muted-foreground: 240 5% 64.9%;
      --accent: 240 3.7% 15.9%;
      --accent-foreground: 0 0% 98%;
      --destructive: 0 62.8% 30.6%;
      --destructive-foreground: 0 0% 98%;
      --border: 240 3.7% 15.9%;
      --input: 240 3.7% 15.9%;
      --ring: 240 4.9% 83.9%;
    }

    * {
      border-color: hsl(var(--border));
    }

    body {
      background-color: hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-feature-settings: "cv02", "cv03", "cv04", "cv11";
      -webkit-font-smoothing: antialiased;
    }

    .font-mono-num {
      font-family: 'JetBrains Mono', monospace;
      font-variant-numeric: tabular-nums;
    }
  </style>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          },
          colors: {
            border: 'hsl(var(--border))',
            input: 'hsl(var(--input))',
            ring: 'hsl(var(--ring))',
            background: 'hsl(var(--background))',
            foreground: 'hsl(var(--foreground))',
            primary: {
              DEFAULT: 'hsl(var(--primary))',
              foreground: 'hsl(var(--primary-foreground))',
            },
            secondary: {
              DEFAULT: 'hsl(var(--secondary))',
              foreground: 'hsl(var(--secondary-foreground))',
            },
            destructive: {
              DEFAULT: 'hsl(var(--destructive))',
              foreground: 'hsl(var(--destructive-foreground))',
            },
            muted: {
              DEFAULT: 'hsl(var(--muted))',
              foreground: 'hsl(var(--muted-foreground))',
            },
            accent: {
              DEFAULT: 'hsl(var(--accent))',
              foreground: 'hsl(var(--accent-foreground))',
            },
            popover: {
              DEFAULT: 'hsl(var(--popover))',
              foreground: 'hsl(var(--popover-foreground))',
            },
            card: {
              DEFAULT: 'hsl(var(--card))',
              foreground: 'hsl(var(--card-foreground))',
            },
          },
          borderRadius: {
            lg: 'var(--radius)',
            md: 'calc(var(--radius) - 2px)',
            sm: 'calc(var(--radius) - 4px)',
          },
        },
      },
    };
  </script>
</head>
<body class="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
  <div class="flex min-h-screen flex-col">
    <!-- Top Institutional Bar (shadcn Header + Separator) -->
    <header class="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div class="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div class="flex items-center gap-3">
          <div class="flex size-7 items-center justify-center rounded-md border border-border bg-secondary text-xs font-semibold tracking-tight text-foreground font-mono">
            QE
          </div>
          <div class="flex items-center gap-2 text-sm">
            <span class="font-semibold tracking-tight text-foreground">QuantEngine</span>
            <span class="text-muted-foreground">/</span>
            <span class="text-muted-foreground font-medium">Multi-Regime Futures Desk</span>
          </div>
          <span id="mode-badge" class="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-0.5 text-xs font-mono font-medium text-secondary-foreground">
            CARGANDO
          </span>
        </div>

        <div class="flex items-center gap-3">
          <div class="hidden sm:flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground">
            <span id="live-dot" class="size-2 rounded-full bg-emerald-500"></span>
            <span>Timeframe <strong id="tf-label" class="font-mono text-foreground">15m</strong></span>
            <span class="text-border">|</span>
            <span id="last-update" class="font-mono">--:--:--</span>
          </div>
          <button
            onclick="fetchStatus()"
            class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <svg class="size-3.5 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
            Sincronizar
          </button>
        </div>
      </div>
    </header>

    <!-- Main Container -->
    <main class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <!-- Page Heading & Tabs Control -->
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-col gap-1">
          <h1 class="text-2xl font-semibold tracking-tight text-foreground">Resumen de Cartera y Ejecución</h1>
          <p class="text-sm text-muted-foreground">
            Monitoreo algorítmico en tiempo real sobre contratos perpetuos USD-M (BTC, ETH, SOL, DOGE).
          </p>
        </div>

        <!-- shadcn TabsList -->
        <div class="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground self-start sm:self-auto" role="tablist">
          <button
            id="tab-btn-overview"
            onclick="switchTab('overview')"
            class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium ring-offset-background transition-all bg-background text-foreground shadow-sm"
          >
            Vista General
          </button>
          <button
            id="tab-btn-assets"
            onclick="switchTab('assets')"
            class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium ring-offset-background transition-all hover:text-foreground"
          >
            Activos y Telemetría
          </button>
          <button
            id="tab-btn-ledger"
            onclick="switchTab('ledger')"
            class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium ring-offset-background transition-all hover:text-foreground"
          >
            Libro de Órdenes
          </button>
        </div>
      </div>

      <!-- KPI Grid (shadcn Card anatomy: Card > CardHeader + CardContent) -->
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <!-- Card 1: Equity -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div class="flex flex-row items-center justify-between p-5 pb-2">
            <h3 class="text-xs font-medium text-muted-foreground">Patrimonio Neto (Equity)</h3>
            <svg class="size-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
          </div>
          <div class="p-5 pt-0 flex flex-col gap-1">
            <div id="equity-val" class="text-2xl font-semibold tracking-tight font-mono-num">$0.00</div>
            <div class="flex items-center justify-between text-xs text-muted-foreground pt-1">
              <span>Balance: <strong id="balance-val" class="font-mono-num text-foreground font-medium">$0.00</strong></span>
              <span>Flotante: <strong id="unrealized-val" class="font-mono-num font-medium">$0.00</strong></span>
            </div>
          </div>
        </div>

        <!-- Card 2: Realized PnL -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div class="flex flex-row items-center justify-between p-5 pb-2">
            <h3 class="text-xs font-medium text-muted-foreground">Beneficio Neto Realizado</h3>
            <svg class="size-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
          </div>
          <div class="p-5 pt-0 flex flex-col gap-1">
            <div id="net-profit-val" class="text-2xl font-semibold tracking-tight font-mono-num">$0.00</div>
            <div class="flex items-center justify-between text-xs text-muted-foreground pt-1">
              <span>Retorno: <strong id="return-pct-val" class="font-mono-num font-medium">0.00%</strong></span>
              <span>Profit Factor: <strong id="pf-val" class="font-mono-num text-foreground font-medium">0.00</strong></span>
            </div>
          </div>
        </div>

        <!-- Card 3: Win Rate -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div class="flex flex-row items-center justify-between p-5 pb-2">
            <h3 class="text-xs font-medium text-muted-foreground">Tasa de Acierto (Win Rate)</h3>
            <svg class="size-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20v-6M6 20V10M18 20V4"/></svg>
          </div>
          <div class="p-5 pt-0 flex flex-col gap-2">
            <div class="flex items-baseline justify-between">
              <div id="winrate-val" class="text-2xl font-semibold tracking-tight font-mono-num">0.0%</div>
              <span id="trades-count-val" class="text-xs font-mono-num text-muted-foreground">0 cerradas (0W / 0L)</span>
            </div>
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div id="winrate-bar" class="h-full bg-primary transition-all duration-300" style="width: 0%"></div>
            </div>
          </div>
        </div>

        <!-- Card 4: Drawdown & Risk -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div class="flex flex-row items-center justify-between p-5 pb-2">
            <h3 class="text-xs font-medium text-muted-foreground">Riesgo y Exposición</h3>
            <svg class="size-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div class="p-5 pt-0 flex flex-col gap-1">
            <div class="flex items-baseline justify-between">
              <div id="dd-val" class="text-2xl font-semibold tracking-tight font-mono-num">0.00%</div>
              <span class="text-xs text-muted-foreground">Max Drawdown</span>
            </div>
            <div class="flex items-center justify-between text-xs text-muted-foreground pt-1">
              <span>Slots activos: <strong id="slots-val" class="font-mono-num text-foreground font-medium">0 / 3</strong></span>
              <span>Riesgo/Trade: <strong id="risk-pct-val" class="font-mono-num text-foreground font-medium">1.5%</strong></span>
            </div>
          </div>
        </div>
      </section>

      <!-- SECTION: Per-Asset Breakdown & Live Quantitative Telemetry -->
      <section id="section-assets" class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
        <div class="flex flex-col gap-1.5 p-6 pb-4 sm:flex-row sm:items-center sm:justify-between border-b border-border">
          <div class="flex flex-col gap-0.5">
            <div class="flex items-center gap-2">
              <h2 class="text-base font-semibold tracking-tight">Desglose por Moneda y Telemetría de Régimen</h2>
              <span class="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-0.5 text-xs font-mono text-muted-foreground">4 pares activos</span>
            </div>
            <p class="text-xs text-muted-foreground">
              Estado cuantitativo en vivo (ADX, RSI, anchura Bollinger, EMA 200) y rendimiento individual acumulado por par.
            </p>
          </div>
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Haz clic en una moneda para filtrar el libro de órdenes</span>
          </div>
        </div>

        <div class="relative w-full overflow-x-auto">
          <table class="w-full caption-bottom text-sm">
            <thead class="border-b border-border bg-muted/30">
              <tr class="text-left text-xs font-medium text-muted-foreground">
                <th class="h-10 px-4 align-middle font-medium">Activo</th>
                <th class="h-10 px-4 align-middle font-medium">Precio Mark</th>
                <th class="h-10 px-4 align-middle font-medium">Régimen Detectado</th>
                <th class="h-10 px-4 align-middle font-medium">Telemetría (ADX / RSI / BBW)</th>
                <th class="h-10 px-4 align-middle font-medium">Posición</th>
                <th class="h-10 px-4 align-middle font-medium">Trades (W/L)</th>
                <th class="h-10 px-4 align-middle font-medium">Win Rate</th>
                <th class="h-10 px-4 align-middle font-medium">Profit Factor</th>
                <th class="h-10 px-4 align-middle font-medium text-right">PnL Realizado</th>
              </tr>
            </thead>
            <tbody id="symbol-breakdown-tbody" class="divide-y divide-border text-sm">
              <tr>
                <td colspan="9" class="p-6 text-center text-xs text-muted-foreground">Cargando telemetría por activo...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- SECTION: Chart & Strategy Breakdown Grid -->
      <section id="section-chart-strategies" class="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <!-- Equity Curve Card (7 cols) -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm lg:col-span-7 flex flex-col">
          <div class="flex flex-col gap-1 p-6 pb-4 border-b border-border">
            <div class="flex items-center justify-between">
              <h2 class="text-base font-semibold tracking-tight">Curva de Patrimonio (Equity Curve)</h2>
              <span class="text-xs font-mono text-muted-foreground">USDT</span>
            </div>
            <p class="text-xs text-muted-foreground">Evolución histórica del capital neto incluyendo posiciones cerradas y valoración mark-to-market.</p>
          </div>
          <div class="p-6 flex-1 flex items-center justify-center">
            <div class="h-64 w-full">
              <canvas id="equityChart"></canvas>
            </div>
          </div>
        </div>

        <!-- Strategy Attribution Card (5 cols) -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm lg:col-span-5 flex flex-col">
          <div class="flex flex-col gap-1 p-6 pb-4 border-b border-border">
            <h2 class="text-base font-semibold tracking-tight">Atribución por Motor de Estrategia</h2>
            <p class="text-xs text-muted-foreground">Comparativa entre el motor tendencial Donchian y el motor de reversión a la media.</p>
          </div>
          <div id="strategy-breakdown" class="flex flex-1 flex-col gap-3 p-6">
            <div class="text-xs text-muted-foreground">Sin datos de estrategias aún.</div>
          </div>
        </div>
      </section>

      <!-- SECTION: Open Positions & Trade History Ledger -->
      <section id="section-ledger" class="flex flex-col gap-6">
        <!-- Open Positions Card -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div class="flex flex-col gap-1.5 p-6 pb-4 sm:flex-row sm:items-center sm:justify-between border-b border-border">
            <div class="flex flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <h2 class="text-base font-semibold tracking-tight">Posiciones Abiertas en Mercado</h2>
                <span id="open-count-badge" class="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-0.5 text-xs font-mono font-medium text-foreground">0</span>
              </div>
              <p class="text-xs text-muted-foreground">Contratos perpetuos activos con gestión dinámica de Stop-Loss, Take-Profit parcial (TP1) y Chandelier Exit.</p>
            </div>
          </div>

          <div class="relative w-full overflow-x-auto">
            <table class="w-full caption-bottom text-sm">
              <thead class="border-b border-border bg-muted/30">
                <tr class="text-left text-xs font-medium text-muted-foreground">
                  <th class="h-10 px-4 align-middle font-medium">Par</th>
                  <th class="h-10 px-4 align-middle font-medium">Dirección</th>
                  <th class="h-10 px-4 align-middle font-medium">Estrategia / Régimen</th>
                  <th class="h-10 px-4 align-middle font-medium">Entrada</th>
                  <th class="h-10 px-4 align-middle font-medium">Precio Mark</th>
                  <th class="h-10 px-4 align-middle font-medium">Tamaño</th>
                  <th class="h-10 px-4 align-middle font-medium">Stop Loss</th>
                  <th class="h-10 px-4 align-middle font-medium">Take Profit 1</th>
                  <th class="h-10 px-4 align-middle font-medium text-right">PnL Flotante</th>
                </tr>
              </thead>
              <tbody id="open-trades-tbody" class="divide-y divide-border text-sm">
                <tr>
                  <td colspan="9" class="p-8 text-center text-xs text-muted-foreground">No hay posiciones abiertas en este momento.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Closed Trades History Card -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div class="flex flex-col gap-3 p-6 pb-4 sm:flex-row sm:items-center sm:justify-between border-b border-border">
            <div class="flex flex-col gap-0.5">
              <h2 class="text-base font-semibold tracking-tight">Libro de Operaciones Cerradas</h2>
              <p class="text-xs text-muted-foreground">Registro auditable de ejecuciones completadas (neto de comisiones y slippage).</p>
            </div>
            <!-- Symbol Filter Pills -->
            <div id="symbol-filter-bar" class="flex flex-wrap items-center gap-1.5">
              <button onclick="setSymbolFilter('ALL')" class="inline-flex h-7 items-center rounded-md border border-border bg-primary px-2.5 text-xs font-medium text-primary-foreground">Todas</button>
            </div>
          </div>

          <div class="relative w-full overflow-x-auto">
            <table class="w-full caption-bottom text-sm">
              <thead class="border-b border-border bg-muted/30">
                <tr class="text-left text-xs font-medium text-muted-foreground">
                  <th class="h-10 px-4 align-middle font-medium">Fecha Cierre</th>
                  <th class="h-10 px-4 align-middle font-medium">Par</th>
                  <th class="h-10 px-4 align-middle font-medium">Lado</th>
                  <th class="h-10 px-4 align-middle font-medium">Estrategia</th>
                  <th class="h-10 px-4 align-middle font-medium">Entrada</th>
                  <th class="h-10 px-4 align-middle font-medium">Salida</th>
                  <th class="h-10 px-4 align-middle font-medium">Comisiones</th>
                  <th class="h-10 px-4 align-middle font-medium text-right">PnL Realizado</th>
                </tr>
              </thead>
              <tbody id="closed-trades-tbody" class="divide-y divide-border text-sm">
                <tr>
                  <td colspan="8" class="p-8 text-center text-xs text-muted-foreground">Aún no se han cerrado operaciones.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>

    <!-- Footer -->
    <footer class="border-t border-border py-4">
      <div class="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 text-xs text-muted-foreground sm:flex-row sm:px-6 lg:px-8">
        <span>Adaptive Multi-Regime Crypto Quant Engine — Arquitectura Determinista en TypeScript</span>
        <span class="font-mono">SQLite WAL • CCXT Binance USD-M Futures</span>
      </div>
    </footer>
  </div>

  <script>
    let chartInstance = null;
    let currentTab = 'overview';
    let selectedSymbolFilter = 'ALL';
    let latestData = null;

    function switchTab(tab) {
      currentTab = tab;
      const tabs = ['overview', 'assets', 'ledger'];
      tabs.forEach((t) => {
        const btn = document.getElementById('tab-btn-' + t);
        if (!btn) return;
        if (t === tab) {
          btn.className = 'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium ring-offset-background transition-all bg-background text-foreground shadow-sm';
        } else {
          btn.className = 'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium ring-offset-background transition-all hover:text-foreground text-muted-foreground';
        }
      });

      const secAssets = document.getElementById('section-assets');
      const secChart = document.getElementById('section-chart-strategies');
      const secLedger = document.getElementById('section-ledger');

      if (tab === 'overview') {
        secAssets.classList.remove('hidden');
        secChart.classList.remove('hidden');
        secLedger.classList.remove('hidden');
      } else if (tab === 'assets') {
        secAssets.classList.remove('hidden');
        secChart.classList.remove('hidden');
        secLedger.classList.add('hidden');
      } else if (tab === 'ledger') {
        secAssets.classList.add('hidden');
        secChart.classList.add('hidden');
        secLedger.classList.remove('hidden');
      }
    }

    function setSymbolFilter(symbol) {
      selectedSymbolFilter = symbol;
      if (latestData) {
        renderSymbolFilterBar(latestData);
        renderClosedTrades(latestData);
        renderSymbolBreakdown(latestData);
      }
    }

    function fmtUsd(val) {
      const num = Number(val || 0);
      const sign = num > 0 ? '+' : num < 0 ? '-' : '';
      return (num < 0 ? '-' : '') + '$' + Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtSignedUsd(val) {
      const num = Number(val || 0);
      const sign = num > 0 ? '+' : num < 0 ? '-' : '';
      return sign + '$' + Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtPrice(val) {
      const num = Number(val || 0);
      if (num === 0) return '—';
      const decimals = num < 1 ? 4 : num < 10 ? 3 : 2;
      return '$' + num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }

    function pnlTextClass(val) {
      const num = Number(val || 0);
      if (num > 0) return 'text-emerald-400';
      if (num < 0) return 'text-rose-400';
      return 'text-muted-foreground';
    }

    function renderRegimeBadge(regime) {
      const map = {
        TRENDING_BULL: {
          label: 'TREND BULL',
          cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
          dot: 'bg-emerald-400',
        },
        TRENDING_BEAR: {
          label: 'TREND BEAR',
          cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
          dot: 'bg-rose-400',
        },
        RANGING: {
          label: 'RANGING (MEAN REV)',
          cls: 'border-border bg-secondary text-secondary-foreground',
          dot: 'bg-zinc-400',
        },
        VOLATILE_CHOP: {
          label: 'VOLATILE CHOP (NO-TRADE)',
          cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
          dot: 'bg-amber-400',
        },
      };
      const item = map[regime] || {
        label: regime || 'SINCRONIZANDO',
        cls: 'border-border bg-muted text-muted-foreground',
        dot: 'bg-zinc-500',
      };
      return \`<span class="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-mono font-medium \${item.cls}">
        <span class="size-1.5 rounded-full \${item.dot}"></span>
        \${item.label}
      </span>\`;
    }

    function renderSymbolBreakdown(data) {
      const tbody = document.getElementById('symbol-breakdown-tbody');
      if (!data.symbolBreakdown || data.symbolBreakdown.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="p-6 text-center text-xs text-muted-foreground">Sin activos configurados.</td></tr>';
        return;
      }

      tbody.innerHTML = data.symbolBreakdown.map((s) => {
        const isSelected = selectedSymbolFilter === s.symbol;
        const rowBg = isSelected ? 'bg-accent/60' : 'hover:bg-muted/40';
        const baseCoin = s.symbol.split('/')[0];
        const adxStr = s.adx !== null && s.adx !== undefined ? s.adx.toFixed(1) : '—';
        const rsiStr = s.rsi !== null && s.rsi !== undefined ? s.rsi.toFixed(1) : '—';
        const bbwStr = s.bbWidthPct !== null && s.bbWidthPct !== undefined ? s.bbWidthPct.toFixed(2) + '%' : '—';

        const posBadge = s.openCount > 0
          ? \`<span class="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-mono text-emerald-400">\${s.openCount} activa (\${fmtSignedUsd(s.openUnrealizedPnl)})</span>\`
          : \`<span class="inline-flex items-center rounded-md border border-border bg-transparent px-2 py-0.5 text-xs font-mono text-muted-foreground">En espera</span>\`;

        return \`
          <tr onclick="setSymbolFilter('\${isSelected ? 'ALL' : s.symbol}')" class="cursor-pointer transition-colors \${rowBg}">
            <td class="p-4 align-middle">
              <div class="flex items-center gap-2.5">
                <div class="flex size-7 items-center justify-center rounded-md border border-border bg-secondary text-[11px] font-mono font-semibold text-foreground">
                  \${baseCoin.slice(0, 4)}
                </div>
                <div class="flex flex-col">
                  <span class="font-medium text-foreground">\${s.symbol}</span>
                  <span class="text-[11px] text-muted-foreground">Perpetuo USD-M</span>
                </div>
              </div>
            </td>
            <td class="p-4 align-middle font-mono-num text-sm font-medium text-foreground">
              \${fmtPrice(s.currentPrice)}
            </td>
            <td class="p-4 align-middle">
              \${renderRegimeBadge(s.regime)}
            </td>
            <td class="p-4 align-middle">
              <div class="flex items-center gap-2 font-mono-num text-xs">
                <span class="rounded border border-border bg-background px-1.5 py-0.5 text-muted-foreground">ADX <strong class="text-foreground">\${adxStr}</strong></span>
                <span class="rounded border border-border bg-background px-1.5 py-0.5 text-muted-foreground">RSI <strong class="text-foreground">\${rsiStr}</strong></span>
                <span class="rounded border border-border bg-background px-1.5 py-0.5 text-muted-foreground">BBW <strong class="text-foreground">\${bbwStr}</strong></span>
              </div>
            </td>
            <td class="p-4 align-middle">
              \${posBadge}
            </td>
            <td class="p-4 align-middle font-mono-num text-xs text-muted-foreground">
              <span class="text-foreground font-medium">\${s.totalTrades}</span> (\${s.winningTrades}W / \${s.losingTrades}L)
            </td>
            <td class="p-4 align-middle">
              <div class="flex items-center gap-2">
                <div class="h-1.5 w-14 overflow-hidden rounded-full bg-secondary">
                  <div class="h-full bg-primary" style="width: \${Math.min(100, Math.max(0, s.winRatePct))}%"></div>
                </div>
                <span class="font-mono-num text-xs text-foreground">\${s.winRatePct.toFixed(1)}%</span>
              </div>
            </td>
            <td class="p-4 align-middle font-mono-num text-xs text-foreground">
              \${Number(s.profitFactor || 0).toFixed(2)}
            </td>
            <td class="p-4 align-middle text-right font-mono-num text-sm font-semibold \${pnlTextClass(s.netRealizedPnl)}">
              \${fmtSignedUsd(s.netRealizedPnl)}
            </td>
          </tr>
        \`;
      }).join('');
    }

    function renderSymbolFilterBar(data) {
      const bar = document.getElementById('symbol-filter-bar');
      if (!bar || !data.symbolBreakdown) return;
      const symbols = ['ALL', ...data.symbolBreakdown.map((s) => s.symbol)];
      bar.innerHTML = symbols.map((sym) => {
        const active = selectedSymbolFilter === sym;
        const cls = active
          ? 'inline-flex h-7 items-center rounded-md border border-transparent bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-sm'
          : 'inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground';
        const label = sym === 'ALL' ? 'Todas las monedas' : sym;
        return \`<button onclick="setSymbolFilter('\${sym}')" class="\${cls}">\${label}</button>\`;
      }).join('');
    }

    function renderClosedTrades(data) {
      const closedTbody = document.getElementById('closed-trades-tbody');
      const list = (data.closedTrades || []).filter((t) =>
        selectedSymbolFilter === 'ALL' ? true : t.symbol === selectedSymbolFilter
      );

      if (list.length === 0) {
        closedTbody.innerHTML = \`<tr><td colspan="8" class="p-8 text-center text-xs text-muted-foreground">No hay operaciones cerradas para el filtro seleccionado (\${selectedSymbolFilter === 'ALL' ? 'Todas' : selectedSymbolFilter}).</td></tr>\`;
        return;
      }

      closedTbody.innerHTML = list.map((t) => {
        const closeTs = t.closed_at || t.opened_at;
        const closeDate = closeTs ? new Date(closeTs).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
        const sideBadge = t.side === 'LONG'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
          : 'border-rose-500/30 bg-rose-500/10 text-rose-400';

        return \`
          <tr class="hover:bg-muted/40 transition-colors">
            <td class="p-4 align-middle font-mono-num text-xs text-muted-foreground">\${closeDate}</td>
            <td class="p-4 align-middle font-medium text-foreground">\${t.symbol}</td>
            <td class="p-4 align-middle">
              <span class="inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-mono font-medium \${sideBadge}">\${t.side}</span>
            </td>
            <td class="p-4 align-middle">
              <div class="flex items-center gap-1.5">
                <span class="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] font-mono text-secondary-foreground">\${t.strategy}</span>
                \${t.exit_reason ? \`<span class="text-[11px] font-mono text-muted-foreground">(\${t.exit_reason})</span>\` : ''}
              </div>
            </td>
            <td class="p-4 align-middle font-mono-num text-xs text-foreground">\${fmtPrice(t.entry_price)}</td>
            <td class="p-4 align-middle font-mono-num text-xs text-foreground">\${t.exit_price ? fmtPrice(t.exit_price) : '—'}</td>
            <td class="p-4 align-middle font-mono-num text-xs text-muted-foreground">-\$\${Number(t.fees_paid || 0).toFixed(2)}</td>
            <td class="p-4 align-middle text-right font-mono-num text-sm font-semibold \${pnlTextClass(t.realized_pnl)}">
              \${fmtSignedUsd(t.realized_pnl)}
            </td>
          </tr>
        \`;
      }).join('');
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        latestData = data;

        // Top Bar
        document.getElementById('mode-badge').textContent = data.mode;
        document.getElementById('tf-label').textContent = data.timeframe || '15m';
        document.getElementById('last-update').textContent = new Date(data.timestamp).toLocaleTimeString('es-ES');

        // KPI Cards
        document.getElementById('equity-val').textContent = fmtUsd(data.equity);
        document.getElementById('balance-val').textContent = fmtUsd(data.balance);

        const unrEl = document.getElementById('unrealized-val');
        unrEl.textContent = fmtSignedUsd(data.unrealizedPnl);
        unrEl.className = 'font-mono-num font-medium ' + pnlTextClass(data.unrealizedPnl);

        const netEl = document.getElementById('net-profit-val');
        netEl.textContent = fmtSignedUsd(data.netProfit);
        netEl.className = 'text-2xl font-semibold tracking-tight font-mono-num ' + pnlTextClass(data.netProfit);

        const retEl = document.getElementById('return-pct-val');
        const retSign = data.totalReturnPct > 0 ? '+' : '';
        retEl.textContent = retSign + data.totalReturnPct.toFixed(2) + '%';
        retEl.className = 'font-mono-num font-medium ' + pnlTextClass(data.totalReturnPct);

        document.getElementById('pf-val').textContent = Number(data.profitFactor || 0).toFixed(2);
        document.getElementById('winrate-val').textContent = data.winRatePct.toFixed(1) + '%';
        document.getElementById('winrate-bar').style.width = Math.min(100, Math.max(0, data.winRatePct)) + '%';
        document.getElementById('trades-count-val').textContent = \`\${data.totalTrades} cerradas (\${data.winningTrades}W / \${data.losingTrades}L)\`;

        document.getElementById('dd-val').textContent = data.maxDrawdownPct.toFixed(2) + '%';
        document.getElementById('slots-val').textContent = \`\${(data.openTrades || []).length} / \${data.maxConcurrentPositions || 3}\`;
        document.getElementById('risk-pct-val').textContent = \`\${(data.riskPerTradePct || 1.5).toFixed(1)}%\`;

        // Symbol Breakdown & Telemetry
        renderSymbolBreakdown(data);
        renderSymbolFilterBar(data);

        // Strategy Breakdown
        const stratContainer = document.getElementById('strategy-breakdown');
        const stratEntries = Object.entries(data.strategyBreakdown || {});
        if (stratEntries.length === 0) {
          stratContainer.innerHTML = '<div class="flex flex-1 items-center justify-center rounded-md border border-dashed border-border p-6 text-xs text-muted-foreground">Esperando primeras operaciones cerradas para atribución de estrategia.</div>';
        } else {
          stratContainer.innerHTML = stratEntries.map(([name, stats]) => {
            const desc = name === 'TREND_BREAKOUT'
              ? 'Ruptura Donchian 20 periodos + Chandelier Exit ATR'
              : 'Reversión Bollinger 2.0σ + RSI(14) Extremos';
            return \`
              <div class="flex flex-col justify-between gap-3 rounded-md border border-border bg-background p-4">
                <div class="flex items-start justify-between">
                  <div class="flex flex-col gap-0.5">
                    <span class="font-mono text-xs font-semibold text-foreground">\${name}</span>
                    <span class="text-xs text-muted-foreground">\${desc}</span>
                  </div>
                  <span class="font-mono-num text-sm font-semibold \${pnlTextClass(stats.netPnl)}">\${fmtSignedUsd(stats.netPnl)}</span>
                </div>
                <div class="flex items-center justify-between border-t border-border pt-2.5 text-xs text-muted-foreground">
                  <span>Operaciones: <strong class="font-mono-num text-foreground">\${stats.trades}</strong></span>
                  <span>Win Rate: <strong class="font-mono-num text-foreground">\${stats.winRatePct.toFixed(1)}%</strong></span>
                </div>
              </div>
            \`;
          }).join('');
        }

        // Open Trades
        const openTbody = document.getElementById('open-trades-tbody');
        document.getElementById('open-count-badge').textContent = (data.openTrades || []).length;
        if (!data.openTrades || data.openTrades.length === 0) {
          openTbody.innerHTML = '<tr><td colspan="9" class="p-8 text-center text-xs text-muted-foreground">No hay posiciones abiertas en este momento. El motor está escaneando velas de 15m.</td></tr>';
        } else {
          openTbody.innerHTML = data.openTrades.map((t) => {
            const sideBadge = t.side === 'LONG'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-400';
            const slDist = Math.abs(t.entry_price - t.initial_sl);
            const tp1Price = t.side === 'LONG' ? t.entry_price + slDist * 1.5 : t.entry_price - slDist * 1.5;
            return \`
              <tr class="hover:bg-muted/40 transition-colors">
                <td class="p-4 align-middle font-medium text-foreground">\${t.symbol}</td>
                <td class="p-4 align-middle">
                  <span class="inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-mono font-medium \${sideBadge}">\${t.side}</span>
                </td>
                <td class="p-4 align-middle">
                  <div class="flex flex-col gap-0.5">
                    <span class="font-mono text-xs text-foreground">\${t.strategy}</span>
                    <span class="text-[11px] text-muted-foreground">\${t.regime_at_entry}</span>
                  </div>
                </td>
                <td class="p-4 align-middle font-mono-num text-xs text-foreground">\${fmtPrice(t.entry_price)}</td>
                <td class="p-4 align-middle font-mono-num text-xs font-medium text-foreground">\${fmtPrice(t.currentPrice)}</td>
                <td class="p-4 align-middle font-mono-num text-xs text-muted-foreground">\${Number(t.remaining_size).toFixed(4)}</td>
                <td class="p-4 align-middle font-mono-num text-xs text-rose-400">\${fmtPrice(t.current_sl)}</td>
                <td class="p-4 align-middle font-mono-num text-xs text-emerald-400">\${fmtPrice(tp1Price)} \${t.tp1_hit ? '✓' : ''}</td>
                <td class="p-4 align-middle text-right font-mono-num text-sm font-semibold \${pnlTextClass(t.unrealizedPnl)}">
                  \${fmtSignedUsd(t.unrealizedPnl)}
                </td>
              </tr>
            \`;
          }).join('');
        }

        // Closed Trades
        renderClosedTrades(data);

        // Equity Curve Chart (shadcn monochrome aesthetic)
        const snaps = data.snapshots && data.snapshots.length > 0
          ? data.snapshots
          : [{ timestamp: data.timestamp, equity: data.equity }];
        const labels = snaps.map((s) => new Date(s.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }));
        const values = snaps.map((s) => s.equity);

        if (!chartInstance) {
          const ctx = document.getElementById('equityChart').getContext('2d');
          chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
              labels,
              datasets: [{
                label: 'Equity (USDT)',
                data: values,
                borderColor: '#fafafa',
                backgroundColor: 'rgba(250, 250, 250, 0.04)',
                borderWidth: 1.75,
                fill: true,
                tension: 0.2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor: '#fafafa',
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { display: false },
                tooltip: {
                  backgroundColor: '#09090b',
                  borderColor: '#27272a',
                  borderWidth: 1,
                  titleColor: '#a1a1aa',
                  bodyColor: '#fafafa',
                  titleFont: { family: 'Inter', size: 11 },
                  bodyFont: { family: 'JetBrains Mono', size: 12 },
                  padding: 10,
                  displayColors: false,
                },
              },
              scales: {
                x: {
                  grid: { color: 'rgba(39, 39, 42, 0.4)', drawBorder: false },
                  ticks: { color: '#71717a', maxTicksLimit: 7, font: { family: 'JetBrains Mono', size: 10 } },
                },
                y: {
                  grid: { color: 'rgba(39, 39, 42, 0.4)', drawBorder: false },
                  ticks: {
                    color: '#71717a',
                    font: { family: 'JetBrains Mono', size: 10 },
                    callback: (v) => '$' + Number(v).toLocaleString('en-US'),
                  },
                },
              },
            },
          });
        } else {
          chartInstance.data.labels = labels;
          chartInstance.data.datasets[0].data = values;
          chartInstance.update('none');
        }
      } catch (err) {
        console.error('Error sincronizando estado:', err);
      }
    }

    fetchStatus();
    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}
