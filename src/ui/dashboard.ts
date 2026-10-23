import http from 'node:http';
import { APP_VERSION } from '../config/constants.js';
import { resolveSymbolStrategyConfig, strategyConfig } from '../config/strategyConfig.js';
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
          const state = this.regimeDetector.detect(candles, symbol);
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

      const symConfig = resolveSymbolStrategyConfig(strategyConfig, symbol);
      const lookback = symConfig.trendStrategy.donchianLookback;
      const lookbackHours = Number(((lookback * 15) / 60).toFixed(1));
      const volMult = symConfig.trendStrategy.volumeMultiplier;
      const slAtr = symConfig.trendStrategy.slAtrMultiplier;
      const bufferAtr = symConfig.trendStrategy.breakoutBufferAtr ?? 0;

      const profileLabel = `${lookbackHours}h · ${volMult}x`;
      const profileTooltip = `Perfil calibrado para ${symbol}: analiza las últimas ${lookbackHours}h (${lookback} velas de 15m), exige ${volMult}x de volumen normal, colchón de ${bufferAtr} ATR y Stop Loss de ${slAtr}x ATR.`;

      return {
        symbol,
        currentPrice,
        regime,
        adx,
        rsi,
        bbWidthPct,
        ema200,
        profileLabel,
        profileTooltip,
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
      snapshots: snapshots.map((s) => ({
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
    <!-- Top Bar -->
    <header class="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div class="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div class="flex items-center gap-2.5">
          <div class="flex size-7 items-center justify-center rounded-md border border-border bg-secondary text-xs font-semibold font-mono text-foreground">
            QE
          </div>
          <span class="font-semibold text-sm tracking-tight text-foreground">QuantEngine</span>
          <span class="text-xs text-muted-foreground font-mono">v\${APP_VERSION}</span>
          <span id="mode-badge" class="ml-1 inline-flex items-center rounded border border-border bg-secondary/80 px-1.5 py-0.5 text-[11px] font-mono text-secondary-foreground" title="Modo de ejecución del motor (TESTNET = Dinero de prueba en Binance, LIVE = Dinero real)">
            TESTNET
          </span>
        </div>

        <div class="flex items-center gap-3">
          <div class="flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1 text-xs text-muted-foreground">
            <span id="live-dot" class="size-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>Velas <strong id="tf-label" class="font-mono text-foreground" title="Temporalidad del gráfico analizado (15 minutos por vela)">15m</strong></span>
            <span class="text-border">|</span>
            <span id="last-update" class="font-mono" title="Hora de la última actualización de datos">--:--:--</span>
          </div>
          <button
            onclick="fetchStatus()"
            class="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            title="Refrescar datos y balance ahora"
          >
            <svg class="size-3.5 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
            Actualizar
          </button>
        </div>
      </div>
    </header>

    <!-- Main Container -->
    <main class="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
      <!-- Heading & Tabs -->
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-foreground">Panel de Control</h1>
          <p class="text-xs text-muted-foreground">Trading algorítmico automatizado • Perfiles adaptados para BTC, ETH, SOL y DOGE</p>
        </div>

        <!-- Tabs -->
        <div class="inline-flex h-8 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground self-start sm:self-auto" role="tablist">
          <button
            id="tab-btn-overview"
            onclick="switchTab('overview')"
            class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-0.5 text-xs font-medium ring-offset-background transition-all bg-background text-foreground shadow-sm"
          >
            General
          </button>
          <button
            id="tab-btn-assets"
            onclick="switchTab('assets')"
            class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-0.5 text-xs font-medium ring-offset-background transition-all hover:text-foreground text-muted-foreground"
          >
            Activos
          </button>
          <button
            id="tab-btn-ledger"
            onclick="switchTab('ledger')"
            class="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-0.5 text-xs font-medium ring-offset-background transition-all hover:text-foreground text-muted-foreground"
          >
            Operaciones
          </button>
        </div>
      </div>

      <!-- KPI Grid -->
      <section class="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <!-- Card 1: Equity -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm p-4 sm:p-5 flex flex-col justify-between gap-3" title="Patrimonio total: dinero en tu billetera más las ganancias o pérdidas de las operaciones que están abiertas ahora mismo.">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">Patrimonio Total</span>
            <svg class="size-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
          </div>
          <div class="flex flex-col gap-1">
            <div id="equity-val" class="text-2xl font-semibold tracking-tight font-mono-num">$0.00</div>
            <div class="flex items-center justify-between text-xs text-muted-foreground pt-0.5 border-t border-border/40">
              <span title="Saldo líquido consolidado en tu cuenta de Binance Futures">Billetera: <strong id="balance-val" class="font-mono-num text-foreground font-medium">$0.00</strong></span>
              <span title="Beneficio o pérdida temporal de las posiciones que siguen abiertas">Flotante: <strong id="unrealized-val" class="font-mono-num font-medium">$0.00</strong></span>
            </div>
          </div>
        </div>

        <!-- Card 2: Realized PnL -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm p-4 sm:p-5 flex flex-col justify-between gap-3" title="Beneficio limpio ya cerrado en tu cuenta de Binance tras descontar todas las comisiones.">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">Beneficio Cerrado (Limpio)</span>
            <svg class="size-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
          </div>
          <div class="flex flex-col gap-1">
            <div id="net-profit-val" class="text-2xl font-semibold tracking-tight font-mono-num">$0.00</div>
            <div class="flex items-center justify-between text-xs text-muted-foreground pt-0.5 border-t border-border/40">
              <span title="Rendimiento porcentual acumulado sobre el capital inicial">Retorno: <strong id="return-pct-val" class="font-mono-num font-medium">0.00%</strong></span>
              <span title="Ratio de Ganancia: dólares ganados por cada dólar perdido. Mayor a 1.0 es rentable">Ratio (PF): <strong id="pf-val" class="font-mono-num text-foreground font-medium">0.00</strong></span>
            </div>
          </div>
        </div>

        <!-- Card 3: Win Rate -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm p-4 sm:p-5 flex flex-col justify-between gap-3" title="Porcentaje de operaciones que han cerrado con ganancias frente al total.">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">Tasa de Acierto</span>
            <svg class="size-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20v-6M6 20V10M18 20V4"/></svg>
          </div>
          <div class="flex flex-col gap-1.5">
            <div class="flex items-baseline justify-between">
              <div id="winrate-val" class="text-2xl font-semibold tracking-tight font-mono-num">0.0%</div>
              <span id="trades-count-val" class="text-xs font-mono-num text-muted-foreground">0 cerradas</span>
            </div>
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div id="winrate-bar" class="h-full bg-primary transition-all duration-300" style="width: 0%"></div>
            </div>
          </div>
        </div>

        <!-- Card 4: Drawdown & Risk -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm p-4 sm:p-5 flex flex-col justify-between gap-3" title="Control estricto del capital: límite de 3 posiciones a la vez y riesgo máximo del 1% por operación.">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">Control de Riesgo</span>
            <svg class="size-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div class="flex flex-col gap-1">
            <div class="flex items-baseline justify-between">
              <div id="dd-val" class="text-2xl font-semibold tracking-tight font-mono-num">0.00%</div>
              <span class="text-xs text-muted-foreground" title="Caída máxima temporal sufrida desde el pico más alto de la cuenta">Caída Máx (DD)</span>
            </div>
            <div class="flex items-center justify-between text-xs text-muted-foreground pt-0.5 border-t border-border/40">
              <span title="Posiciones abiertas ahora mismo del límite de 3 permitidas">Posiciones: <strong id="slots-val" class="font-mono-num text-foreground font-medium">0 / 3</strong></span>
              <span title="Pérdida máxima si salta el Stop Loss en una operación">Riesgo/Op: <strong id="risk-pct-val" class="font-mono-num text-foreground font-medium">1.0%</strong></span>
            </div>
          </div>
        </div>
      </section>

      <!-- SECTION: Per-Asset Breakdown -->
      <section id="section-assets" class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
        <div class="flex flex-col gap-1 p-4 sm:p-5 border-b border-border sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-semibold tracking-tight">Estado de Activos y Perfiles</h2>
            <span class="inline-flex items-center rounded border border-border bg-secondary px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">4 pares calibrados</span>
          </div>
          <span class="text-xs text-muted-foreground">Pasa el cursor sobre la configuración de cada moneda para ver sus reglas</span>
        </div>

        <div class="relative w-full overflow-x-auto">
          <table class="w-full caption-bottom text-sm">
            <thead class="border-b border-border bg-muted/30">
              <tr class="text-left text-xs font-medium text-muted-foreground whitespace-nowrap">
                <th class="h-9 px-4 align-middle font-medium" title="Par de criptomonedas y su perfil técnico calibrado">Activo</th>
                <th class="h-9 px-4 align-middle font-medium" title="Precio oficial de referencia de la moneda en Binance Futures">Precio Mark</th>
                <th class="h-9 px-4 align-middle font-medium" title="Estado de la moneda: Alcista, Bajista, Rango Lateral o Sin Operar">Régimen</th>
                <th class="h-9 px-4 align-middle font-medium" title="Indicadores en vivo: Fuerza de tendencia (ADX), Termómetro (RSI) y Volatilidad (BBW)">Indicadores</th>
                <th class="h-9 px-4 align-middle font-medium" title="Posición abierta actualmente en este activo">Posición</th>
                <th class="h-9 px-4 align-middle font-medium" title="Historial de operaciones cerradas en esta moneda">Operaciones</th>
                <th class="h-9 px-4 align-middle font-medium" title="Porcentaje de operaciones ganadoras">Acierto</th>
                <th class="h-9 px-4 align-middle font-medium" title="Profit Factor: Ganancia total dividida entre pérdida total. Superior a 1.0 es rentable">PF</th>
                <th class="h-9 px-4 align-middle font-medium text-right" title="Beneficio limpio ya conseguido en este activo tras comisiones">PnL Neto</th>
              </tr>
            </thead>
            <tbody id="symbol-breakdown-tbody" class="divide-y divide-border text-sm">
              <tr>
                <td colspan="9" class="p-6 text-center text-xs text-muted-foreground">Cargando estado de activos...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- SECTION: Chart & Strategy Breakdown Grid -->
      <section id="section-chart-strategies" class="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <!-- Equity Curve Card (7 cols) -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm lg:col-span-7 flex flex-col">
          <div class="flex flex-col gap-2.5 p-4 sm:p-5 border-b border-border">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex items-center gap-2">
                <h2 class="text-sm font-semibold tracking-tight">Evolución de Capital</h2>
                <span class="inline-flex items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-emerald-400">
                  REAL
                </span>
              </div>

              <!-- Timeframe Selector -->
              <div class="inline-flex h-7 items-center justify-center rounded-md bg-muted p-0.5 text-muted-foreground self-start sm:self-auto" role="group">
                <button
                  id="tf-btn-24h"
                  onclick="setTimeframeFilter('24h')"
                  class="tf-btn inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded transition-all hover:text-foreground text-muted-foreground"
                >
                  24H
                </button>
                <button
                  id="tf-btn-3d"
                  onclick="setTimeframeFilter('3d')"
                  class="tf-btn inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded transition-all hover:text-foreground text-muted-foreground"
                >
                  3D
                </button>
                <button
                  id="tf-btn-7d"
                  onclick="setTimeframeFilter('7d')"
                  class="tf-btn inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded transition-all hover:text-foreground text-muted-foreground"
                >
                  1S
                </button>
                <button
                  id="tf-btn-30d"
                  onclick="setTimeframeFilter('30d')"
                  class="tf-btn inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded transition-all hover:text-foreground text-muted-foreground"
                >
                  1M
                </button>
                <button
                  id="tf-btn-all"
                  onclick="setTimeframeFilter('all')"
                  class="tf-btn inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded transition-all bg-background text-foreground shadow-sm"
                >
                  Total
                </button>
              </div>
            </div>

            <!-- Compact Telemetry Banner -->
            <div class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-1 text-xs font-mono">
              <span id="chart-period-range" class="text-muted-foreground">Calculando...</span>
              <div class="flex items-center gap-3">
                <span class="text-muted-foreground">Patrimonio: <strong id="chart-latest-equity" class="text-foreground">$0.00</strong></span>
                <span class="text-muted-foreground">Billetera: <strong id="chart-latest-balance" class="text-zinc-400">$0.00</strong></span>
                <span class="text-muted-foreground">Periodo: <strong id="chart-period-pnl" class="text-foreground">+0.00%</strong></span>
              </div>
            </div>
          </div>
          <div class="p-4 sm:p-5 flex-1 flex items-center justify-center">
            <div class="h-64 w-full">
              <canvas id="equityChart"></canvas>
            </div>
          </div>
        </div>

        <!-- Strategy Attribution Card (5 cols) -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm lg:col-span-5 flex flex-col">
          <div class="p-4 sm:p-5 border-b border-border">
            <h2 class="text-sm font-semibold tracking-tight">Rendimiento por Estrategia</h2>
          </div>
          <div id="strategy-breakdown" class="flex flex-1 flex-col gap-2.5 p-4 sm:p-5">
            <div class="text-xs text-muted-foreground">Cargando estrategias...</div>
          </div>
        </div>
      </section>

      <!-- SECTION: Open Positions & Trade History Ledger -->
      <section id="section-ledger" class="flex flex-col gap-5">
        <!-- Open Positions Card -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div class="flex items-center justify-between p-4 sm:p-5 border-b border-border">
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-semibold tracking-tight">Posiciones Abiertas</h2>
              <span id="open-count-badge" class="inline-flex items-center rounded border border-border bg-secondary px-1.5 py-0.5 text-xs font-mono font-medium text-foreground">0</span>
            </div>
          </div>

          <div class="relative w-full overflow-x-auto">
            <table class="w-full caption-bottom text-sm">
              <thead class="border-b border-border bg-muted/30">
                <tr class="text-left text-xs font-medium text-muted-foreground whitespace-nowrap">
                  <th class="h-9 px-4 align-middle font-medium" title="Par de criptomonedas operado en Binance Futures">Par</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Dirección de la posición: LONG (compra alcista) o SHORT (venta bajista)">Lado</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Estrategia cuantitativa: Ruptura tendencial o Reversión en rango">Estrategia</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Precio oficial de apertura de la posición">Entrada</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Precio de referencia en vivo de la moneda en Binance">Precio Mark</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Cantidad de contratos o monedas de la posición">Tamaño</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Límite máximo de pérdida y orden condicional activa en servidores de Binance">Stop Loss</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Objetivo a 1.5R: Venta del 50% y movimiento del SL a Break-Even (sin riesgo)">Take Profit</th>
                  <th class="h-9 px-4 align-middle font-medium text-right" title="Ganancia o pérdida provisional acumulada si la posición se cerrara ahora">PnL Flotante</th>
                </tr>
              </thead>
              <tbody id="open-trades-tbody" class="divide-y divide-border text-sm">
                <tr>
                  <td colspan="9" class="p-6 text-center text-xs text-muted-foreground">Sin posiciones abiertas en este momento.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Closed Trades History Card -->
        <div class="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
          <div class="flex flex-col gap-2 p-4 sm:p-5 sm:flex-row sm:items-center sm:justify-between border-b border-border">
            <h2 class="text-sm font-semibold tracking-tight">Historial de Operaciones</h2>
            <!-- Symbol Filter Pills -->
            <div id="symbol-filter-bar" class="flex flex-wrap items-center gap-1.5">
              <button onclick="setSymbolFilter('ALL')" class="inline-flex h-6 items-center rounded border border-border bg-primary px-2 text-xs font-medium text-primary-foreground">Todas</button>
            </div>
          </div>

          <div class="relative w-full overflow-x-auto">
            <table class="w-full caption-bottom text-sm">
              <thead class="border-b border-border bg-muted/30">
                <tr class="text-left text-xs font-medium text-muted-foreground whitespace-nowrap">
                  <th class="h-9 px-4 align-middle font-medium" title="Fecha y hora de cierre de la posición">Fecha</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Par de criptomonedas">Par</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Dirección: LONG (compra) o SHORT (venta)">Lado</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Estrategia cuantitativa y motivo de cierre">Estrategia</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Precio oficial al que se abrió la posición">Entrada</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Precio oficial al que se cerró y motivo">Salida</th>
                  <th class="h-9 px-4 align-middle font-medium" title="Comisión total pagada a Binance">Comisión</th>
                  <th class="h-9 px-4 align-middle font-medium text-right" title="Beneficio limpio ya consolidado en tu cuenta tras comisiones">PnL Neto</th>
                </tr>
              </thead>
              <tbody id="closed-trades-tbody" class="divide-y divide-border text-sm">
                <tr>
                  <td colspan="8" class="p-6 text-center text-xs text-muted-foreground">Sin operaciones registradas.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>

    <!-- Footer -->
    <footer class="border-t border-border py-3">
      <div class="mx-auto flex max-w-7xl items-center justify-between px-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
        <span>QuantEngine • Trading Algorítmico</span>
        <span class="font-mono">Binance USD-M Futures</span>
      </div>
    </footer>
  </div>

  <script>
    let chartInstance = null;
    let currentTab = 'overview';
    let selectedSymbolFilter = 'ALL';
    let selectedTimeframe = 'all'; // '24h', '3d', '7d', '30d', 'all'
    let currentFilteredSnaps = [];
    let latestData = null;

    function setTimeframeFilter(tf) {
      selectedTimeframe = tf;
      const tfs = ['24h', '3d', '7d', '30d', 'all'];
      tfs.forEach((t) => {
        const btn = document.getElementById('tf-btn-' + t);
        if (!btn) return;
        if (t === tf) {
          btn.className = 'tf-btn inline-flex items-center justify-center whitespace-nowrap rounded-md px-2.5 py-0.5 text-xs font-medium ring-offset-background transition-all bg-background text-foreground shadow-sm';
        } else {
          btn.className = 'tf-btn inline-flex items-center justify-center whitespace-nowrap rounded-md px-2.5 py-0.5 text-xs font-medium ring-offset-background transition-all hover:text-foreground text-muted-foreground';
        }
      });
      if (latestData) {
        renderChart(latestData);
      }
    }

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
          label: 'Alcista',
          title: 'Mercado subiendo con fuerza clara por encima de la EMA 200. El bot busca operaciones de compra (LONG).',
          cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
          dot: 'bg-emerald-400',
        },
        TRENDING_BEAR: {
          label: 'Bajista',
          title: 'Mercado cayendo con fuerza clara por debajo de la EMA 200. El bot busca operaciones de venta corta (SHORT).',
          cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
          dot: 'bg-rose-400',
        },
        RANGING: {
          label: 'Rango Lateral',
          title: 'El precio oscila en un canal sin rumbo fijo. El bot busca compras en suelo y ventas en techo (Reversión).',
          cls: 'border-border bg-secondary text-secondary-foreground',
          dot: 'bg-zinc-400',
        },
        VOLATILE_CHOP: {
          label: 'Sin Operar',
          title: 'Mercado errático, sin volumen o con riesgo de falsas rupturas. El bot se queda quieto para no arriesgar saldo.',
          cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
          dot: 'bg-amber-400',
        },
      };
      const item = map[regime] || {
        label: regime || 'Sincronizando',
        title: 'Calculando indicadores técnicos con las últimas velas...',
        cls: 'border-border bg-muted text-muted-foreground',
        dot: 'bg-zinc-500',
      };
      return \`<span class="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] font-mono font-medium cursor-help \${item.cls}" title="\${item.title}">
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
          ? \`<span class="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-xs font-mono text-emerald-400" title="Posición abierta activa en este activo">\${s.openCount} Activa (\${fmtSignedUsd(s.openUnrealizedPnl)})</span>\`
          : \`<span class="text-xs font-mono text-muted-foreground" title="Sin operaciones abiertas en esta moneda">—</span>\`;

        return \`
          <tr onclick="setSymbolFilter('\${isSelected ? 'ALL' : s.symbol}')" class="cursor-pointer transition-colors \${rowBg}">
            <td class="p-3.5 align-middle whitespace-nowrap">
              <div class="flex items-center gap-2">
                <div class="flex size-6 items-center justify-center rounded border border-border bg-secondary text-[10px] font-mono font-semibold text-foreground">
                  \${baseCoin.slice(0, 4)}
                </div>
                <span class="font-medium text-foreground text-xs">\${s.symbol}</span>
                <span class="inline-flex items-center rounded border border-border/80 bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground cursor-help" title="\${s.profileTooltip || 'Perfil calibrado por moneda'}">
                  \${s.profileLabel || 'Estándar'}
                </span>
              </div>
            </td>
            <td class="p-3.5 align-middle font-mono-num text-xs font-medium text-foreground whitespace-nowrap">
              \${fmtPrice(s.currentPrice)}
            </td>
            <td class="p-3.5 align-middle whitespace-nowrap">
              \${renderRegimeBadge(s.regime)}
            </td>
            <td class="p-3.5 align-middle whitespace-nowrap">
              <div class="flex items-center gap-1.5 font-mono-num text-[11px]">
                <span class="rounded border border-border/80 bg-background px-1 py-0.5 text-muted-foreground cursor-help" title="Fuerza del movimiento (ADX: \${adxStr}). Mayor a 22 significa que el precio se mueve con impulso real.">
                  ADX <strong class="text-foreground">\${adxStr}</strong>
                </span>
                <span class="rounded border border-border/80 bg-background px-1 py-0.5 text-muted-foreground cursor-help" title="Termómetro del precio (RSI: \${rsiStr}). >70 significa muy caro/sobrecomprado; <30 muy barato/sobrevendido.">
                  RSI <strong class="text-foreground">\${rsiStr}</strong>
                </span>
                <span class="rounded border border-border/80 bg-background px-1 py-0.5 text-muted-foreground cursor-help" title="Volatilidad del mercado (Ancho de Bandas BBW: \${bbwStr}). Indica si el canal de precios se estrecha o expande.">
                  BBW <strong class="text-foreground">\${bbwStr}</strong>
                </span>
              </div>
            </td>
            <td class="p-3.5 align-middle whitespace-nowrap">
              \${posBadge}
            </td>
            <td class="p-3.5 align-middle font-mono-num text-xs text-muted-foreground whitespace-nowrap">
              <span class="text-foreground font-medium">\${s.totalTrades}</span> (\${s.winningTrades}G/\${s.losingTrades}P)
            </td>
            <td class="p-3.5 align-middle font-mono-num text-xs text-foreground whitespace-nowrap">
              \${s.winRatePct.toFixed(0)}%
            </td>
            <td class="p-3.5 align-middle font-mono-num text-xs text-foreground whitespace-nowrap">
              \${Number(s.profitFactor || 0).toFixed(2)}
            </td>
            <td class="p-3.5 align-middle text-right font-mono-num text-xs font-semibold whitespace-nowrap \${pnlTextClass(s.netRealizedPnl)}">
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
          ? 'inline-flex h-6 items-center rounded border border-transparent bg-primary px-2 text-xs font-medium text-primary-foreground shadow-sm'
          : 'inline-flex h-6 items-center rounded border border-border bg-background px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground';
        const label = sym === 'ALL' ? 'Todas' : sym;
        return \`<button onclick="setSymbolFilter('\${sym}')" class="\${cls}">\${label}</button>\`;
      }).join('');
    }

    function renderClosedTrades(data) {
      const closedTbody = document.getElementById('closed-trades-tbody');
      const list = (data.closedTrades || []).filter((t) =>
        selectedSymbolFilter === 'ALL' ? true : t.symbol === selectedSymbolFilter
      );

      if (list.length === 0) {
        closedTbody.innerHTML = \`<tr><td colspan="8" class="p-6 text-center text-xs text-muted-foreground">Sin operaciones registradas para \${selectedSymbolFilter === 'ALL' ? 'todas las monedas' : selectedSymbolFilter}.</td></tr>\`;
        return;
      }

      closedTbody.innerHTML = list.map((t) => {
        const closeTs = t.closed_at || t.opened_at;
        const closeDate = closeTs ? new Date(closeTs).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        const sideBadge = t.side === 'LONG'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
          : 'border-rose-500/30 bg-rose-500/10 text-rose-400';
        const stratName = t.strategy === 'TREND_BREAKOUT' ? 'Tendencia' : 'Reversión';
        const exitMap = {
          STOP_LOSS: 'Corte de Pérdida (Stop Loss alcanzado)',
          TRAILING_STOP: 'Trailing Stop (Protección dinámica de ganancia)',
          TAKE_PROFIT: 'Cobro de Beneficio (Take Profit)',
          MEAN_TARGET: 'Objetivo de Reversión (Centro de Bollinger)',
          MANUAL_CLOSE: 'Cierre Manual ordenado por el operador',
          KILL_SWITCH: 'Freno de Emergencia Diario',
        };
        const exitTitle = exitMap[t.exit_reason] || t.exit_reason || 'Cierre de posición';
        const exitLabel = t.exit_reason === 'STOP_LOSS' ? 'SL'
          : t.exit_reason === 'TAKE_PROFIT' || t.exit_reason === 'TRAILING_STOP' ? 'Trailing'
          : t.exit_reason === 'MEAN_TARGET' ? 'Target'
          : t.exit_reason || '';

        return \`
          <tr class="hover:bg-muted/30 transition-colors">
            <td class="p-3.5 align-middle font-mono-num text-xs text-muted-foreground whitespace-nowrap">\${closeDate}</td>
            <td class="p-3.5 align-middle font-medium text-xs text-foreground whitespace-nowrap">\${t.symbol}</td>
            <td class="p-3.5 align-middle whitespace-nowrap">
              <span class="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono font-medium \${sideBadge}">\${t.side}</span>
            </td>
            <td class="p-3.5 align-middle whitespace-nowrap">
              <div class="flex items-center gap-1 text-xs">
                <span class="font-mono text-muted-foreground text-[11px]">\${stratName}</span>
                \${exitLabel ? \`<span class="text-[10px] font-mono text-muted-foreground/80 cursor-help" title="\${exitTitle}">(\${exitLabel})</span>\` : ''}
              </div>
            </td>
            <td class="p-3.5 align-middle font-mono-num text-xs text-foreground whitespace-nowrap">\${fmtPrice(t.entry_price)}</td>
            <td class="p-3.5 align-middle font-mono-num text-xs text-foreground whitespace-nowrap">\${t.exit_price ? fmtPrice(t.exit_price) : '—'}</td>
            <td class="p-3.5 align-middle font-mono-num text-xs text-muted-foreground whitespace-nowrap">-\$\${Number(t.fees_paid || 0).toFixed(2)}</td>
            <td class="p-3.5 align-middle text-right font-mono-num text-xs font-semibold whitespace-nowrap \${pnlTextClass(t.realized_pnl)}">
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
        document.getElementById('trades-count-val').textContent = \`\${data.winningTrades}G / \${data.losingTrades}P (\${data.totalTrades})\`;

        document.getElementById('dd-val').textContent = data.maxDrawdownPct.toFixed(2) + '%';
        document.getElementById('slots-val').textContent = \`\${(data.openTrades || []).length} / \${data.maxConcurrentPositions || 3}\`;
        document.getElementById('risk-pct-val').textContent = \`\${(data.riskPerTradePct || 1.0).toFixed(1)}%\`;

        // Symbol Breakdown & Telemetry
        renderSymbolBreakdown(data);
        renderSymbolFilterBar(data);

        // Strategy Breakdown
        const stratContainer = document.getElementById('strategy-breakdown');
        const stratEntries = Object.entries(data.strategyBreakdown || {});
        if (stratEntries.length === 0) {
          stratContainer.innerHTML = '<div class="flex flex-1 items-center justify-center rounded border border-dashed border-border p-5 text-xs text-muted-foreground">Sin operaciones cerradas aún.</div>';
        } else {
          stratContainer.innerHTML = stratEntries.map(([name, stats]) => {
            const cleanName = name === 'TREND_BREAKOUT' ? 'Ruptura de Tendencia' : 'Rebote en Rango';
            const techDesc = name === 'TREND_BREAKOUT'
              ? 'Busca impulsos que rompen el canal de varias horas con volumen'
              : 'Compra en suelo y vende en techo en mercados laterales';
            return \`
              <div class="flex flex-col justify-between gap-2.5 rounded border border-border bg-background/50 p-3.5">
                <div class="flex items-start justify-between">
                  <div class="flex flex-col">
                    <span class="font-semibold text-xs text-foreground">\${cleanName}</span>
                    <span class="text-[11px] text-muted-foreground">\${techDesc}</span>
                  </div>
                  <span class="font-mono-num text-sm font-semibold \${pnlTextClass(stats.netPnl)}">\${fmtSignedUsd(stats.netPnl)}</span>
                </div>
                <div class="flex items-center justify-between border-t border-border/60 pt-2 text-xs text-muted-foreground">
                  <span title="Total de operaciones cerradas con esta estrategia">Operaciones: <strong class="font-mono-num text-foreground">\${stats.trades}</strong></span>
                  <span title="Porcentaje de operaciones que salieron ganadoras">Acierto: <strong class="font-mono-num text-foreground">\${stats.winRatePct.toFixed(1)}%</strong></span>
                </div>
              </div>
            \`;
          }).join('');
        }

        // Open Trades
        const openTbody = document.getElementById('open-trades-tbody');
        document.getElementById('open-count-badge').textContent = (data.openTrades || []).length;
        if (!data.openTrades || data.openTrades.length === 0) {
          openTbody.innerHTML = '<tr><td colspan="9" class="p-6 text-center text-xs text-muted-foreground">Sin posiciones abiertas en este momento.</td></tr>';
        } else {
          openTbody.innerHTML = data.openTrades.map((t) => {
            const sideBadge = t.side === 'LONG'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-400';
            const sideLabel = t.side === 'LONG' ? 'LONG (Compra alcista)' : 'SHORT (Venta bajista)';
            const stratName = t.strategy === 'TREND_BREAKOUT' ? 'Tendencia' : 'Reversión';
            const slDist = Math.abs(t.entry_price - t.initial_sl);
            const tp1Price = t.side === 'LONG' ? t.entry_price + slDist * 1.5 : t.entry_price - slDist * 1.5;

            const slCell = t.stop_order_id
              ? \`<div class="flex items-center gap-1.5 whitespace-nowrap">
                   <span class="font-mono-num text-xs text-rose-400 font-medium">\${fmtPrice(t.current_sl)}</span>
                   <span class="inline-flex items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-0.2 text-[10px] font-mono text-emerald-400 cursor-help" title="ORDEN STOP_MARKET ACTIVA EN BINANCE (ID: \${t.stop_order_id}). Binance cortará la pérdida automáticamente en el exchange aunque el bot esté apagado.">
                     🛡️ Binance
                   </span>
                 </div>\`
              : \`<div class="flex items-center gap-1.5 whitespace-nowrap">
                   <span class="font-mono-num text-xs text-rose-400 font-medium">\${fmtPrice(t.current_sl)}</span>
                   <span class="inline-flex items-center rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.2 text-[10px] font-mono text-amber-400 cursor-help" title="Protección local temporal. El bot monitoriza el precio en cada vela y lo sincronizará con Binance.">
                     Local
                   </span>
                 </div>\`;

            const tpCell = t.tp1_hit
              ? \`<div class="flex items-center gap-1.5 whitespace-nowrap">
                   <span class="font-mono-num text-xs text-emerald-400 font-medium">\${fmtPrice(tp1Price)}</span>
                   <span class="inline-flex items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-0.2 text-[10px] font-mono text-emerald-400 cursor-help" title="El bot ya cobró la mitad de las ganancias y movió el Stop Loss a Break-Even (sin riesgo).">
                     ✓ 1.5R
                   </span>
                 </div>\`
              : \`<div class="flex items-center gap-1.5 whitespace-nowrap">
                   <span class="font-mono-num text-xs text-muted-foreground font-medium">\${fmtPrice(tp1Price)}</span>
                   <span class="text-[10px] font-mono text-muted-foreground cursor-help" title="Al alcanzar 1.5R de beneficio, el bot venderá la mitad y moverá el Stop Loss a precio de entrada.">
                     1.5R
                   </span>
                 </div>\`;

            return \`
              <tr class="hover:bg-muted/30 transition-colors">
                <td class="p-3.5 align-middle font-medium text-xs text-foreground whitespace-nowrap">\${t.symbol}</td>
                <td class="p-3.5 align-middle whitespace-nowrap">
                  <span class="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-mono font-medium cursor-help \${sideBadge}" title="\${sideLabel}">\${t.side}</span>
                </td>
                <td class="p-3.5 align-middle whitespace-nowrap">
                  <span class="font-mono text-xs text-muted-foreground">\${stratName}</span>
                </td>
                <td class="p-3.5 align-middle font-mono-num text-xs text-foreground whitespace-nowrap" title="Precio al que se abrió la posición">\${fmtPrice(t.entry_price)}</td>
                <td class="p-3.5 align-middle font-mono-num text-xs font-medium text-foreground whitespace-nowrap" title="Precio oficial actual de la moneda en Binance Futures">\${fmtPrice(t.currentPrice)}</td>
                <td class="p-3.5 align-middle font-mono-num text-xs text-muted-foreground whitespace-nowrap" title="Cantidad de contratos o monedas de la posición">\${Number(t.remaining_size).toFixed(2)}</td>
                <td class="p-3.5 align-middle whitespace-nowrap">
                  \${slCell}
                </td>
                <td class="p-3.5 align-middle whitespace-nowrap">
                  \${tpCell}
                </td>
                <td class="p-3.5 align-middle text-right font-mono-num text-xs font-semibold whitespace-nowrap \${pnlTextClass(t.unrealizedPnl)}" title="Ganancia o pérdida provisional acumulada">
                  \${fmtSignedUsd(t.unrealizedPnl)}
                </td>
              </tr>
            \`;
          }).join('');
        }

        // Closed Trades
        renderClosedTrades(data);

        // Render Real Equity Curve Chart
        renderChart(data);
      } catch (err) {
        console.error('Error sincronizando estado:', err);
      }
    }

    function renderChart(data) {
      if (!data) return;

      const rawSnaps = Array.isArray(data.snapshots) && data.snapshots.length > 0
        ? [...data.snapshots]
        : [];

      // Append live real-time point if available
      if (data.timestamp && typeof data.equity === 'number') {
        const lastSnap = rawSnaps[rawSnaps.length - 1];
        if (!lastSnap || Math.abs(data.timestamp - lastSnap.timestamp) > 30000) {
          rawSnaps.push({
            timestamp: data.timestamp,
            equity: data.equity,
            balance: data.balance,
            drawdown: data.maxDrawdownPct || 0,
          });
        }
      }

      if (rawSnaps.length === 0) {
        rawSnaps.push({
          timestamp: Date.now(),
          equity: data.equity || 5000,
          balance: data.balance || 5000,
          drawdown: 0,
        });
      }

      const now = data.timestamp || Date.now();
      let cutoff = 0;
      if (selectedTimeframe === '24h') cutoff = now - 24 * 60 * 60 * 1000;
      else if (selectedTimeframe === '3d') cutoff = now - 3 * 24 * 60 * 60 * 1000;
      else if (selectedTimeframe === '7d') cutoff = now - 7 * 24 * 60 * 60 * 1000;
      else if (selectedTimeframe === '30d') cutoff = now - 30 * 24 * 60 * 60 * 1000;

      let filtered = cutoff > 0 ? rawSnaps.filter((s) => s.timestamp >= cutoff) : rawSnaps;
      if (filtered.length === 0) {
        filtered = [rawSnaps[rawSnaps.length - 1]];
      }

      currentFilteredSnaps = filtered;

      // Calculate period return
      const firstPoint = filtered[0];
      const lastPoint = filtered[filtered.length - 1];
      const periodDiffUsd = lastPoint.equity - firstPoint.equity;
      const periodReturnPct = firstPoint.equity > 0 ? (periodDiffUsd / firstPoint.equity) * 100 : 0;

      // Update period banner
      const rangeEl = document.getElementById('chart-period-range');
      if (rangeEl) {
        const startStr = new Date(firstPoint.timestamp).toLocaleString('es-ES', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        const endStr = new Date(lastPoint.timestamp).toLocaleString('es-ES', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        rangeEl.textContent = startStr + ' → ' + endStr + ' (' + filtered.length + ' snapshots)';
      }

      const eqEl = document.getElementById('chart-latest-equity');
      if (eqEl) eqEl.textContent = fmtUsd(lastPoint.equity);

      const balEl = document.getElementById('chart-latest-balance');
      if (balEl) balEl.textContent = fmtUsd(lastPoint.balance);

      const pnlEl = document.getElementById('chart-period-pnl');
      if (pnlEl) {
        const sign = periodDiffUsd > 0 ? '+' : '';
        pnlEl.textContent = sign + '$' + periodDiffUsd.toFixed(2) + ' (' + sign + periodReturnPct.toFixed(2) + '%)';
        pnlEl.className = 'font-mono-num font-medium ' + pnlTextClass(periodDiffUsd);
      }

      // X-axis label formatting based on selected timeframe
      const labels = filtered.map((s) => {
        const d = new Date(s.timestamp);
        if (selectedTimeframe === '24h') {
          return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) + ' ' +
               d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      });

      const equityValues = filtered.map((s) => Number(s.equity.toFixed(2)));
      const balanceValues = filtered.map((s) => Number(s.balance.toFixed(2)));

      if (!chartInstance) {
        const canvas = document.getElementById('equityChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        chartInstance = new Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: 'Patrimonio (Equity)',
                data: equityValues,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.08)',
                borderWidth: 2,
                fill: true,
                tension: 0.15,
                pointRadius: filtered.length > 80 ? 0 : 2,
                pointHoverRadius: 5,
                pointHoverBackgroundColor: '#10b981',
              },
              {
                label: 'Balance Billetera',
                data: balanceValues,
                borderColor: '#71717a',
                borderDash: [4, 4],
                borderWidth: 1.5,
                fill: false,
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor: '#71717a',
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              mode: 'index',
              intersect: false,
            },
            plugins: {
              legend: {
                display: true,
                position: 'top',
                align: 'end',
                labels: {
                  boxWidth: 12,
                  boxHeight: 2,
                  color: '#a1a1aa',
                  font: { family: 'Inter', size: 11 },
                },
              },
              tooltip: {
                backgroundColor: '#09090b',
                borderColor: '#27272a',
                borderWidth: 1,
                titleColor: '#a1a1aa',
                bodyColor: '#fafafa',
                titleFont: { family: 'Inter', size: 11 },
                bodyFont: { family: 'JetBrains Mono', size: 12 },
                padding: 10,
                callbacks: {
                  title: function(items) {
                    const idx = items[0].dataIndex;
                    const item = currentFilteredSnaps[idx];
                    if (!item) return items[0].label;
                    const d = new Date(item.timestamp);
                    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
                           ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  },
                  label: function(ctx) {
                    const val = Number(ctx.raw || 0);
                    return ' ' + ctx.dataset.label + ': $' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  },
                },
              },
            },
            scales: {
              x: {
                grid: { color: 'rgba(39, 39, 42, 0.4)', drawBorder: false },
                ticks: {
                  color: '#71717a',
                  maxTicksLimit: 7,
                  font: { family: 'JetBrains Mono', size: 10 },
                },
              },
              y: {
                grid: { color: 'rgba(39, 39, 42, 0.4)', drawBorder: false },
                ticks: {
                  color: '#71717a',
                  font: { family: 'JetBrains Mono', size: 10 },
                  callback: (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
                },
              },
            },
          },
        });
      } else {
        chartInstance.data.labels = labels;
        chartInstance.data.datasets[0].data = equityValues;
        chartInstance.data.datasets[0].pointRadius = filtered.length > 80 ? 0 : 2;
        chartInstance.data.datasets[1].data = balanceValues;
        chartInstance.update('none');
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
