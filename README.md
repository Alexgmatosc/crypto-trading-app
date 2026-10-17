# Adaptive Multi-Regime Crypto Quant Engine (v2.0)

> **Documento de Contexto y Especificación Técnica para Modelos de Inteligencia Artificial (Gemini Argon / LLMs) e Ingenieros Cuantitativos.**

---

## 1. Visión General del Proyecto

**Adaptive Multi-Regime Crypto Quant Engine** es un sistema de trading cuantitativo autónomo, determinista y modular escrito en **TypeScript (Node.js v20+)**. Opera contratos de futuros perpetuos USD-M en **Binance Futures** en temporalidad de **15 minutos (`15m`)** sobre 4 pares principales:

* **`BTC/USDT`**
* **`ETH/USDT`**
* **`SOL/USDT`**
* **`DOGE/USDT`**

### Premisas Centrales de Diseño:
1. **Separación de Datos de Mercado y Ejecución**: La ingestión de velas (OHLCV) se realiza en tiempo real directamente desde el feed público de **Binance Mainnet** para evitar las distorsiones de liquidez y *slippage* falso de los entornos de prueba. Sin embargo, la ejecución de órdenes se enruta a través de la cuenta de pruebas (`setSandboxMode(true)` en `TESTNET_LIVE`) o el simulador local (`PAPER_LOCAL`).
2. **Arquitectura Multi-Régimen Determinista**: En lugar de depender de una única estrategia que falle cuando el mercado cambia de tendencia a rango, el motor clasifica el régimen del mercado en cada vela y conmuta dinámicamente entre un motor tendencial y uno de reversión a la media.
3. **Gestión de Riesgo No Negociable**: Sizing basado en volatilidad (ATR), límite de 1.5% de riesgo por trade, Take Profit parcial de 50% al alcanzar 1.5R con movimiento de Stop Loss a Break-Even + costes, y Chandelier Exit dinámico.

---

## 2. Dónde Encontrar los Logs y el Contexto Histórico

Para que cualquier modelo de IA (como **Gemini Argon**) o desarrollador pueda inspeccionar el historial completo, los datos se encuentran estructurados en dos capas:

### A. Archivos Sincronizados en este Repositorio de GitHub
*(Gemini puede leer directamente estos archivos en el repo sin requerir acceso al servidor)*:

| Archivo | Descripción y Contenido |
|---|---|
| [`AUDIT_LOG.md`](./AUDIT_LOG.md) | **Bitácora de auditoría detallada**: tabla cronológica con cada trade ejecutado, precio de entrada, precio de salida, comisiones pagadas, PnL y análisis del incidente del bucle de reinicios. |
| [`logs/trades_history.json`](./logs/trades_history.json) | **JSON estructurado** con todas las operaciones ejecutadas (`TradeRecord[]`), ideal para análisis estadístico automatizado con código o LLMs. |
| [`logs/snapshots_history.json`](./logs/snapshots_history.json) | **JSON estructurado** de la curva de patrimonio histórico (`EquitySnapshotRecord[]`) con balances, equidad y drawdown en cada marca de tiempo. |
| [`logs/LATEST_STATUS.md`](./logs/LATEST_STATUS.md) | Resumen condensado del estado operativo actual generado por el comando `pnpm export:logs`. |
| [`config.json`](./config.json) | Parámetros cuantitativos activos (apalancamiento, riesgo por trade, periodos de ADX/BB/EMA/ATR). |
| [`SPEC.md`](./SPEC.md) | Especificación funcional y de ingeniería completa del sistema. |

### B. Registros en el Servidor Local / Entorno de Ejecución:
* **Terminal y Dashboard Web en Vivo**: `http://localhost:3000` (desarrollado con componentes y tokens semánticos de **shadcn/ui**, mostrando desglose por activo, régimen en vivo y filtrado interactivo).
* **Logs del Proceso PM2**:
  * Salida estándar: `/home/alexgmatosc/.pm2/logs/quant-bot-out.log`
  * Errores del sistema: `/home/alexgmatosc/.pm2/logs/quant-bot-error.log`
* **Base de Datos Transaccional (SQLite WAL)**:
  * Archivo en disco: `./data/quant_bot.sqlite`
  * Tablas gestionadas por Drizzle ORM: `trades`, `equity_snapshots`, `cached_candles`, `backtest_runs`.

---

## 3. Estado de Fondos e Historial de Incidentes (Post-Mortem Técnico)

### Balance Actual Verificado:
* **Capital Actual en Binance USD-M Testnet**: **`$4,946.74 USDT`** (100% efectivo libre).
* **Capital Inicial de Prueba**: **`$5,000.00 USDT`**.
* **Diferencia Neta Total**: **`-$53.26 USDT`** (`-1.06%`).
* **¿Se perdió dinero real?**: **NO.** El entorno es Binance Futures Testnet (fondos simulados de prueba proporcionados por el exchange para desarrollo).

### Incidencia del 17 de Octubre de 2026 (23:34 - 23:36):
1. **Síntoma Inicial**: El dashboard mostró momentáneamente un balance de ~$230 USDT y luego un falso drawdown de 95.4% con 13 operaciones cerradas seguidas.
2. **Causa Raíz #1 (Lectura de Saldo)**: En Binance Futures, al abrir posiciones con apalancamiento x1, casi todo el saldo se asigna a margen colateral (`initialMargin`), dejando temporalmente ~$230 USDT en `availableBalance (free)`. En [`src/exchange/TestnetBroker.ts`](./src/exchange/TestnetBroker.ts), el método `getBalance()` estaba leyendo erróneamente `balance.USDT.free` en lugar de `balance.USDT.total` (o `totalWalletBalance`).
3. **Causa Raíz #2 (Bucle de Reinicios en Arranque)**: En [`src/index.ts`](./src/index.ts), el ciclo de inicio (`start()`) ejecutaba `processCandleClose()` sobre las velas históricas descargadas durante el *warm-up*. Al evaluar la última vela cerrada, intentó abrir ETH y luego DOGE. Al abrir DOGE sin margen suficiente, Binance devolvió `InsufficientFunds`. Al no estar envuelto en un bloque `try/catch` dentro de [`src/core/Engine.ts`](./src/core/Engine.ts), Node arrojó una excepción fatal y PM2 reinició el proceso automáticamente cada 7 segundos, abriendo y cerrando micro-operaciones en cada reinicio.
4. **Soluciones Implementadas y Blindaje**:
   * **Desacople en arranque**: Se eliminó `processCandleClose()` del inicio. El bot solo evalúa señales cuando una vela **nueva** de 15 minutos cierra en vivo.
   * **Tolerancia a fallos**: Se envolvió `executeMarketOrder()` en `try/catch`. Si el broker rechaza una orden por margen insuficiente o límites del exchange, el motor descarta la orden pacíficamente sin detener el proceso.
   * **Corrección de saldo**: Se fijó la lectura a `totalWalletBalance` y se limpiaron los registros anómalos.

---

## 4. Arquitectura del Código Fuente

```text
crypto-trading-app/
├── AUDIT_LOG.md               # Bitácora histórica completa y auditoría de operaciones
├── README.md                  # Este archivo de arquitectura y contexto para LLMs
├── config.json                # Configuración de estrategias y control de riesgo
├── package.json               # Dependencias (CCXT, technicalindicators, better-sqlite3)
├── logs/                      # Datos exportados en JSON y Markdown para Gemini/LLMs
│   ├── trades_history.json    # Historial de operaciones
│   ├── snapshots_history.json # Historial de curvas de equidad
│   └── LATEST_STATUS.md       # Estado operativo reciente
├── src/
│   ├── index.ts               # Demonio de ejecución principal (sincronizado a 15m)
│   ├── backtest.ts            # Motor de simulación histórica
│   ├── report.ts              # Generador CLI de estadísticas de rendimiento
│   ├── export_logs.ts         # Exportador automático de base de datos a logs/
│   ├── config/
│   │   ├── env.ts             # Esquema Zod de variables de entorno (.env)
│   │   └── strategyConfig.ts  # Esquema Zod y validador de config.json
│   ├── core/
│   │   ├── Engine.ts          # Orquestador del ciclo de vida de trades y Stop Loss
│   │   ├── RegimeDetector.ts  # Clasificador matemático de regímenes de mercado
│   │   ├── RiskManager.ts     # Cálculo de sizing (1.5% riesgo) y trailing exits
│   │   └── strategies/
│   │       ├── IStrategy.ts   # Interfaz tipada para estrategias
│   │       ├── TrendBreakout.ts # Ruptura Donchian 20 + EMA 200 + Filtro Volumen
│   │       └── MeanReversion.ts # Bandas de Bollinger 2.0σ + RSI(14) en rango
│   ├── db/
│   │   ├── client.ts          # Conexión SQLite con modo WAL de alto rendimiento
│   │   ├── schema.ts          # Esquema Drizzle ORM
│   │   └── repository.ts      # Repositorio transaccional de persistencia
│   ├── exchange/
│   │   ├── IExecutionBroker.ts# Interfaz abstracta de broker
│   │   ├── MarketDataFeed.ts  # Descarga de velas reales desde Binance Mainnet
│   │   ├── PaperBroker.ts     # Simulador local para PAPER_LOCAL y BACKTEST
│   │   └── TestnetBroker.ts   # Conector CCXT Binance USD-M Futures (Sandbox)
│   ├── indicators/
│   │   └── MathEngine.ts      # Motor matemático de cálculo vectorial de indicadores
│   └── ui/
│       └── dashboard.ts       # Servidor HTTP del dashboard shadcn/ui en :3000
```

---

## 5. Modelos Matemáticos y Estrategias

### A. Clasificación de Régimen (`RegimeDetector.ts`):
En cada cierre de vela de 15 minutos:
* **`TRENDING`**: Si $ADX(14) > 25$.
  * Se subdivide en **`TRENDING_BULL`** si $Precio \ge EMA(200)$ o **`TRENDING_BEAR`** si $Precio < EMA(200)$.
* **`RANGING`**: Si $ADX(14) < 20$ **Y** Ancho de Bollinger $BBW \ge 1.50\%$.
* **`NO_TRADE` / `VOLATILE_CHOP`**: Si $20 \le ADX \le 25$ o $BBW < 1.50\%$ (mercado comprimido donde las comisiones destruyen el beneficio).

### B. Motor Tendencial (`TrendBreakout.ts`):
* **LONG**: Régimen en tendencia, $Precio > EMA(200)$, Cierre rompe el máximo del Canal Donchian de 20 periodos, y Volumen de la vela $> 1.2 \times SMA(Volumen, 20)$.
* **SHORT**: Régimen en tendencia, $Precio < EMA(200)$, Cierre rompe el mínimo del Canal Donchian de 20 periodos, y Volumen $> 1.2 \times SMA(Volumen, 20)$.
* **Stop Loss**: $1.5 \times ATR(14)$ anclado al precio de ejecución real.
* **Salida**: Chandelier Exit basado en $1.5 \times ATR$ tras activación de trailing en $+2.0R$.

### C. Motor de Reversión a la Media (`MeanReversion.ts`):
* **LONG**: Régimen en rango ($ADX < 20$), Cierre toca o perfora la Banda de Bollinger Inferior ($2.0\sigma$), y $RSI(14) < 30$ (sobreventa extrema).
* **SHORT**: Régimen en rango ($ADX < 20$), Cierre toca o perfora la Banda Superior ($2.0\sigma$), y $RSI(14) > 70$ (sobrecompra extrema).
* **Take Profit**: Banda Media de Bollinger (SMA 20).

---

## 6. Guía de Comandos y Herramientas CLI

Todos los comandos se ejecutan con `pnpm`:

```bash
# Iniciar el daemon en vivo (en primer plano)
pnpm start

# Inspeccionar el reporte de métricas y rendimiento en consola
pnpm report

# Exportar el historial de base de datos a logs/ (JSON y Markdown)
pnpm export:logs

# Ejecutar Backtest histórico simulado
pnpm backtest

# Ejecutar suite de pruebas unitarias (Vitest)
pnpm test

# Verificación estricta de tipos de TypeScript
pnpm typecheck
```

### Gestión con PM2 en Segundo Plano:
```bash
# Ver estado del proceso
pm2 status

# Ver logs en tiempo real
pm2 logs quant-bot

# Reiniciar el daemon
pm2 restart quant-bot

# Detener el daemon
pm2 stop quant-bot
```
