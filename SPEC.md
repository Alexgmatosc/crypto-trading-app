# System Prompt & Specification v2.0: Adaptive Multi-Regime Crypto Quant Engine

## 1. Contexto, Rol y Objetivo Principal
Actúa como un **Ingeniero de Software Cuantitativo Senior (Quant Developer)** y **Arquitecto de Sistemas Financieros**. Tu objetivo es construir un motor de trading algorítmico automatizado, modular y headless para operar futuros perpetuos (BTC/USDT y ETH/USDT) en temporalidad de 15 minutos (15m).

El sistema está diseñado bajo dos premisas innegociables:
1. **Entorno de Pruebas Realista y Transición Limpia:** Debe soportar tres modos de ejecución (`BACKTEST`, `PAPER_LOCAL`, `TESTNET_LIVE`) intercambiables por variables de entorno, leyendo siempre los datos de mercado (OHLCV) del feed público real (Mainnet) para evitar las distorsiones de liquidez de los sandboxes, pero ejecutando las órdenes en el simulador local o en la cuenta de prueba del exchange (`setSandboxMode(true)`).
2. **Maximización de Beneficio Adaptativa (Multi-Régimen):** En lugar de depender de una única condición de mercado, el bot debe clasificar matemáticamente el estado del mercado en cada vela (Tendencia vs. Rango Lateral) y alternar dinámicamente entre dos estrategias con ventaja estadística (*Edge*), operando tanto al alza (**LONG**) como a la baja (**SHORT**).

---

## 2. Stack Tecnológico y Dependencias Exactas

* **Runtime:** Node.js (v20+ LTS)
* **Lenguaje:** TypeScript (v5+) con `strict: true`
* **Gestor de paquetes:** `pnpm`
* **Dependencias de Producción:**
  * `ccxt` (^4.x): Ingesta de datos OHLCV de Mainnet y ejecución de órdenes en Testnet (Binance USD-M Futures / Bybit Unified).
  * `technicalindicators` (^3.1.0): Cálculo en JS puro de `EMA`, `ATR`, `ADX`, `RSI` y `BollingerBands`.
  * `better-sqlite3` (^9.x) y `drizzle-orm` (^0.30.x): Persistencia transaccional de trades, cierres parciales, snapshots de cuenta y resultados de backtest.
  * `zod` (^3.x): Validación estricta de variables de entorno y parámetros de `config.json`.
  * `pino` y `pino-pretty`: Logger estructurado de baja latencia.
  * `dotenv` (^16.x): Carga de configuración.
* **Dependencias de Desarrollo:**
  * `tsx`, `typescript`, `@types/node`, `@types/better-sqlite3`, `vitest`, `drizzle-kit`.

---

## 3. Arquitectura de Directorios

```text
crypto-quant-engine/
├── .env.example
├── config.json
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── src/
│   ├── index.ts                  # Daemon en tiempo real (PAPER_LOCAL / TESTNET_LIVE)
│   ├── backtest.ts               # CLI para ejecutar Backtesting histórico rápido
│   ├── report.ts                 # CLI para imprimir métricas de rendimiento y PnL
│   ├── config/
│   │   ├── env.ts                # Validación Zod (EXECUTION_MODE, API Keys)
│   │   └── strategyConfig.ts     # Carga tipada de config.json
│   ├── core/
│   │   ├── Engine.ts             # Orquestador del ciclo de vela y tick-checking
│   │   ├── RegimeDetector.ts     # Clasificador matemático: TRENDING | RANGING | CHOP
│   │   ├── RiskManager.ts        # Sizing por ATR, Scale-Out 50%, Trailing Stop y Kill Switch
│   │   └── strategies/
│   │       ├── IStrategy.ts
│   │       ├── TrendBreakout.ts  # Estrategia para mercados direccionales (Long/Short)
│   │       └── MeanReversion.ts  # Estrategia para mercados laterales (Long/Short)
│   ├── exchange/
│   │   ├── IExecutionBroker.ts   # Interfaz común para brokers de ejecución
│   │   ├── MarketDataFeed.ts     # Lee velas REALES de Mainnet pública vía CCXT
│   │   ├── PaperBroker.ts        # Simulador local con slippage, maker/taker fees y funding
│   │   └── TestnetBroker.ts      # Conector CCXT con sandboxMode activado (cuentas de prueba)
│   ├── indicators/
│   │   └── MathEngine.ts         # Wrapper tipado sobre technicalindicators
│   ├── db/
│   │   ├── client.ts
│   │   ├── schema.ts
│   │   └── repository.ts
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       └── logger.ts
└── tests/
    ├── MathEngine.test.ts
    ├── RegimeDetector.test.ts
    └── RiskManager.test.ts
```

---

## 4. Configuración y Esquema de Datos

### Variables de Entorno (`.env.example`)
```ini
# Modos permitidos: BACKTEST | PAPER_LOCAL | TESTNET_LIVE
EXECUTION_MODE=PAPER_LOCAL
EXCHANGE_ID=binanceusdm
TESTNET_API_KEY=your_testnet_key_optional_in_local_mode
TESTNET_API_SECRET=your_testnet_secret_optional_in_local_mode
DB_PATH=./data/quant_bot.sqlite
LOG_LEVEL=info
```

### Parámetros Cuantitativos (`config.json`)
```json
{
  "symbols": ["BTC/USDT", "ETH/USDT"],
  "timeframe": "15m",
  "initialBalance": 10000,
  "leverage": 1,
  "riskPerTrade": 0.015,
  "maxConcurrentPositions": 2,
  "maxDailyDrawdown": 0.04,
  "fees": {
    "maker": 0.0002,
    "taker": 0.0005,
    "slippage": 0.0004
  },
  "regime": {
    "adxPeriod": 14,
    "trendingThreshold": 25,
    "rangingThreshold": 20
  },
  "trendStrategy": {
    "emaBaseline": 200,
    "donchianLookback": 20,
    "volumeMultiplier": 1.2,
    "atrPeriod": 14,
    "slAtrMultiplier": 1.5
  },
  "meanReversionStrategy": {
    "bbPeriod": 20,
    "bbStdDev": 2.0,
    "rsiPeriod": 14,
    "rsiOversold": 30,
    "rsiOverbought": 70,
    "slAtrMultiplier": 1.2
  },
  "tradeManagement": {
    "partialTakeProfitR": 1.5,
    "partialClosePct": 0.5,
    "trailingActivationR": 2.0,
    "trailingAtrMultiplier": 1.5
  }
}
```

### Esquema SQLite (`src/db/schema.ts`)
1. **`trades`**:
   - `id`: `TEXT PRIMARY KEY` (UUID)
   - `mode`: `TEXT NOT NULL` ('BACKTEST' | 'PAPER_LOCAL' | 'TESTNET_LIVE')
   - `symbol`: `TEXT NOT NULL`
   - `strategy`: `TEXT NOT NULL` ('TREND_BREAKOUT' | 'MEAN_REVERSION')
   - `regime_at_entry`: `TEXT NOT NULL`
   - `side`: `TEXT NOT NULL` ('LONG' | 'SHORT')
   - `entry_price`: `REAL NOT NULL`
   - `exit_price`: `REAL`
   - `initial_size`: `REAL NOT NULL`
   - `remaining_size`: `REAL NOT NULL`
   - `initial_sl`: `REAL NOT NULL`
   - `current_sl`: `REAL NOT NULL`
   - `tp1_hit`: `INTEGER NOT NULL DEFAULT 0` (Boolean 0/1)
   - `realized_pnl`: `REAL NOT NULL DEFAULT 0` (Acumula el cierre parcial + cierre final neto de fees)
   - `fees_paid`: `REAL NOT NULL DEFAULT 0`
   - `status`: `TEXT NOT NULL` ('OPEN' | 'CLOSED')
   - `exit_reason`: `TEXT` ('STOP_LOSS' | 'TRAILING_STOP' | 'MEAN_TARGET' | 'KILL_SWITCH')
   - `opened_at`: `INTEGER NOT NULL`
   - `closed_at`: `INTEGER`

2. **`equity_snapshots`**:
   - `id`: `INTEGER PRIMARY KEY AUTOINCREMENT`
   - `timestamp`: `INTEGER NOT NULL`
   - `mode`: `TEXT NOT NULL`
   - `balance_usdt`: `REAL NOT NULL`
   - `equity_usdt`: `REAL NOT NULL` (Balance + Unrealized PnL)
   - `drawdown_pct`: `REAL NOT NULL`

---

## 5. Lógica del Cerebro Cuantitativo (Reglas Exactas)

### A. Paso 1: Detección de Régimen (`src/core/RegimeDetector.ts`)
Al cierre de cada vela de 15m, calcular `ADX(14)` y el ancho de las Bandas de Bollinger (`BB_Width = (Upper - Lower) / Middle`):
- **`TRENDING`**: Si `ADX > 25`. Se activa exclusivamente `TrendBreakout.ts`.
- **`RANGING`**: Si `ADX < 20` y `BB_Width > 0.015` (hay espacio suficiente en el canal para cubrir comisiones). Se activa exclusivamente `MeanReversion.ts`.
- **`NO_TRADE (Zona Muerta)`**: Si `20 <= ADX <= 25` o el canal es ultra estrecho (`BB_Width <= 0.015`). No se abren nuevas operaciones; solo se gestionan las posiciones abiertas.

### B. Paso 2: Motores de Estrategia (`src/core/strategies/`)

#### 1. Estrategia A: `TrendBreakout.ts` (Cuando el régimen es `TRENDING`)
- **Señal LONG:**
  1. `Close > EMA(200)` (Tendencia macro alcista).
  2. `Close > Max(High de las 20 velas previas)` (Ruptura Donchian al alza).
  3. `Volume > 1.2 * SMA(Volume, 20)` (Confirmación de volumen institucional).
- **Señal SHORT:**
  1. `Close < EMA(200)` (Tendencia macro bajista).
  2. `Close < Min(Low de las 20 velas previas)` (Ruptura Donchian a la baja).
  3. `Volume > 1.2 * SMA(Volume, 20)`.

#### 2. Estrategia B: `MeanReversion.ts` (Cuando el régimen es `RANGING`)
- **Señal LONG (Rebote en soporte):**
  1. La vela previa cerró por debajo o tocó `BB_Lower(20, 2.0)` y la vela actual cierra dentro de la banda (`Close > BB_Lower`).
  2. `RSI(14) < 32` (Sobreventa confirmada).
- **Señal SHORT (Rechazo en resistencia):**
  1. La vela previa tocó o superó `BB_Upper(20, 2.0)` y la vela actual cierra dentro (`Close < BB_Upper`).
  2. `RSI(14) > 68` (Sobrecompra confirmada).
- **Objetivo específico en Reversión a la Media:** Además del Stop Loss y gestión por R, si el precio toca la media central (`BB_Middle`), cerrar la posición completa por objetivo cumplido (`MEAN_TARGET`).

### C. Paso 3: Gestión de Riesgo, Scale-Out y Trailing Stop (`src/core/RiskManager.ts`)
Esta capa gobierna la supervivencia y rentabilidad de la cartera:

1. **Dimensionamiento Dinámico de Posición (Volatility Parity):**
   - `Risk_USD = Balance_Disponible * 0.015` (1.5% de riesgo máximo si salta el Stop Loss).
   - `SL_Distance = slAtrMultiplier * ATR(14)` (`1.5 * ATR` en tendencia, `1.2 * ATR` en rango).
   - En **LONG**: `Initial_SL = Entry_Price - SL_Distance`.
   - En **SHORT**: `Initial_SL = Entry_Price + SL_Distance`.
   - `Position_Size_Coins = Risk_USD / SL_Distance`.
   - *Restricción de Margen:* El valor nocional (`Position_Size_Coins * Entry_Price`) nunca puede superar `Balance_Disponible * leverage * 0.95`.

2. **Toma de Beneficios Parcial (Scale-Out en 1.5R) y Break-Even:**
   - Definir unidad de riesgo inicial: `One_R = abs(Entry_Price - Initial_SL)`.
   - Cuando la posición alcance un beneficio latente igual o superior a `1.5 * One_R` y `tp1_hit == false`:
     1. Ejecutar orden de cierre parcial por el **50%** de `initial_size`.
     2. Sumar el beneficio neto (descontando fee y slippage) a `realized_pnl`.
     3. Marcar `tp1_hit = true`.
     4. **Mover `current_sl` a Break-Even + Costes:**
        - En LONG: `Entry_Price * 1.0015`
        - En SHORT: `Entry_Price * 0.9985`
     *(A partir de este instante, es matemáticamente imposible perder dinero en ese trade).*

3. **Trailing Stop Dinámico sobre el 50% Restante (en 2.0R):**
   - Cuando el precio avance a favor `>= 2.0 * One_R`:
     - En LONG: `New_SL = Current_Price - (1.5 * ATR_Actual)`. Actualizar `current_sl = max(current_sl, New_SL)`.
     - En SHORT: `New_SL = Current_Price + (1.5 * ATR_Actual)`. Actualizar `current_sl = min(current_sl, New_SL)`.

4. **Kill Switch Diario (Circuit Breaker):**
   - Si la suma de pérdidas realizadas del día más el PnL latente negativo alcanza el `-4.0%` del balance de apertura del día (00:00 UTC), cerrar todas las posiciones inmediatamente y bloquear nuevas entradas durante 24 horas.

---

## 6. Arquitectura Híbrida de Datos y Ejecución (`src/exchange/`)

1. **`MarketDataFeed.ts`:**
   - Instancia pública de CCXT conectada siempre a **Mainnet** (sin API keys) para descargar velas OHLCV reales y limpias.
2. **`PaperBroker.ts` (`EXECUTION_MODE=PAPER_LOCAL`):**
   - No requiere cuenta en ningún exchange.
   - Simula ejecuciones aplicando `slippage` (`0.04%`) en contra del trader y descontando `takerFee` (`0.05%`).
3. **`TestnetBroker.ts` (`EXECUTION_MODE=TESTNET_LIVE`):**
   - Instancia autenticada de CCXT con `exchange.setSandboxMode(true)` apuntando a Binance USD-M Futures Testnet o Bybit Testnet.
   - Envía órdenes reales al entorno de pruebas del exchange para validar latencia de red, rechazos de margen, precisión de decimales (`exchange.amountToPrecision`) y sincronización de estado.

---

## 7. Plan de Ejecución Paso a Paso para Argon

Implementa y verifica el proyecto siguiendo estrictamente este orden:

### Fase 1: Fundaciones, Configuración y Base de Datos
- Inicializar proyecto con `pnpm`, configurar TypeScript estricto y esquemas Zod en `src/config/`.
- Implementar `src/db/schema.ts` y `src/db/repository.ts` con SQLite (`better-sqlite3` + Drizzle).

### Fase 2: Motor Matemático, Detector de Régimen y Tests Unitarios
- Implementar `src/indicators/MathEngine.ts` (EMA, ATR, ADX, RSI, BollingerBands).
- Implementar `src/core/RegimeDetector.ts`.
- Crear tests en `tests/` verificando que los indicadores y el clasificador de régimen funcionen sin errores ante arrays de velas históricos.

### Fase 3: RiskManager y Estrategias Bidireccionales (Long/Short)
- Implementar `src/core/RiskManager.ts` con soporte completo para LONG y SHORT, cierre parcial del 50% en `1.5R`, subida a Break-Even y Trailing Stop en `2.0R`.
- Implementar `TrendBreakout.ts` y `MeanReversion.ts`.
- Verificar con `tests/RiskManager.test.ts` que un Stop Loss nunca drene más del `1.5%` + fees de la cuenta, y que tras tocar `1.5R` el trade quede libre de riesgo.

### Fase 4: Motor de Backtesting Histórico (`pnpm backtest`)
- Implementar `src/exchange/MarketDataFeed.ts` con descarga paginada y caché local en SQLite de los últimos 90-180 días de velas de 15m de `BTC/USDT` y `ETH/USDT`.
- Implementar `src/backtest.ts` para recorrer las velas históricas en segundos usando `PaperBroker` y generar un informe completo:
  - Retorno Total (%) y Beneficio Neto ($).
  - Win Rate (%), Profit Factor y Esperanza Matemática por Trade ($).
  - Max Drawdown (%) y desglose de ganancias por estrategia (`TREND_BREAKOUT` vs `MEAN_REVERSION`).

### Fase 5: Daemon en Tiempo Real (`PAPER_LOCAL` y `TESTNET_LIVE`) y Reportes
- Implementar `src/exchange/TestnetBroker.ts` con `setSandboxMode(true)` y formateo de precisión de CCXT.
- Implementar `src/index.ts` para correr en bucle continuo sincronizado con el cierre de cada vela de 15m y monitoreo de Stop Loss cada 10 segundos.
- Implementar `src/report.ts` (`pnpm report`) para mostrar por terminal una tabla con el estado actual de la cartera de prueba, operaciones abiertas y métricas acumuladas.