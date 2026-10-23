# Changelog

Todos los cambios notables de **Adaptive Multi-Regime Crypto Quant Engine** se documentan en este archivo.
El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y este proyecto se adhiere a [Semantic Versioning](https://semver.org/lang/es/).

## [2.2.0] - 2026-10-24

### Added
- **Stops Nativos en Binance Futures (`STOP_MARKET` condicional)**:
  - Implementación en `TestnetBroker.ts` y contrato `IExecutionBroker.ts` de colocación nativa de Stop Loss (`STOP_MARKET`, `reduceOnly: true`) directamente en el motor de casación de Binance mediante Algo Orders (`fapiPrivatePostAlgoOrder`).
  - Si el bot o el host se suspenden, se reinician o pierden conexión a Internet, Binance corta la pérdida de manera autónoma en el exchange.
  - Gestión completa del ciclo de vida de la orden stop en `Engine.ts`:
    - Registro persistente de `stop_order_id` en SQLite.
    - Sustitución atómica (`replaceStopLossOrder`) al alcanzar cobro parcial `1.5R` (Break-Even) y al actualizar el Trailing Stop dinámico a partir de `2.0R`.
    - Cancelación de órdenes stop huérfanas en Binance al cerrar la posición por Take Profit, señal opuesta o cierre manual (`cancelStopLossOrder` con `{ trigger: true }`).
    - Reconciliación al arranque del daemon (`ensureOpenTradesProtected`) para verificar que cualquier posición abierta cuente con su orden condicional activa en Binance.
  - Manejo de excepciones de Binance:
    - Error `-2021` / `-4117` (`Order would immediately trigger`): captura automática y forzado de cierre a mercado inmediato.
    - Error `-2022` (`ReduceOnly Order is rejected`): captura y reconciliación de posición ya ejecutada por el exchange.
- **Arquitectura de Parámetros por Moneda (`symbolOverrides`)**:
  - Soporte en `strategyConfig.ts` (`SymbolOverrideSchema`) y `config.json` para definir perfiles individuales de sensibilidad técnica por activo (`BTC/USDT`, `ETH/USDT`, `SOL/USDT`, `DOGE/USDT`).
  - Función `resolveSymbolStrategyConfig(baseConfig, symbol)` para resolver dinámicamente los parámetros en `RegimeDetector`, `TrendBreakout`, `MeanReversion`, `RiskManager` y `Engine`.
- **Filtro Anti-Trampas de Liquidez y Falsas Rupturas (`TrendBreakout.ts`)**:
  - Buffer de penetración Donchian (`breakoutBufferAtr`): exige que el precio supere el canal por un margen adicional $\text{Close} > \text{Donchian}_{\text{upper}} + (k \times \text{ATR}_{14})$ en LONG y simétrico en SHORT, eliminando falsas rupturas por escasos ticks.
  - Filtro de expansión de volatilidad (`requireAtrExpansion`): exige $\text{ATR}_{14} \ge \text{SMA}(\text{ATR}_{14}, 20)$, descartando rupturas en fases de compresión sin volumen.
  - Proporción mínima de cuerpo de vela (`minBodyRatio`): exige ratio mínimo entre cuerpo y rango total para evitar trampas con mechas de barrido de liquidez.
- **Migración Automática de Base de Datos**:
  - Migración en `src/db/client.ts` para añadir de forma retrocompatible la columna `stop_order_id TEXT` a la tabla `trades` en SQLite.
- **Suites de Tests Unitarios**:
  - `tests/EngineStopLoss.test.ts`: Validación del ciclo de vida de stop orders, reemplazo y tolerancia a fallos.
  - `tests/SymbolOverridesAndAntiTrap.test.ts`: Validación de fusión de `symbolOverrides` y filtrado anti-trampas.

### Changed
- **Calibración Óptima de `config.json` (Basada en Simulación de 90 Días)**:
  - `BTC/USDT`: `donchianLookback: 96` (24h), `volumeMultiplier: 2.2`, `slAtrMultiplier: 3.4`, `trendingThreshold: 28`, `rangingThreshold: 17`, `minBbWidth: 0.014`, `breakoutBufferAtr: 0.20`, `requireAtrExpansion: true`, `minBodyRatio: 0.40`.
  - `ETH/USDT`: `donchianLookback: 60` (15h), `volumeMultiplier: 1.8`, `slAtrMultiplier: 2.8`, `trendingThreshold: 22`, `rangingThreshold: 18`, `minBbWidth: 0.012`, `breakoutBufferAtr: 0.22`, `requireAtrExpansion: false`.
  - `SOL/USDT`: `donchianLookback: 25`, `volumeMultiplier: 1.2`, `slAtrMultiplier: 2.2`, `trendingThreshold: 22`, `rangingThreshold: 18`, `minBbWidth: 0.012`, `breakoutBufferAtr: 0.08`, `requireAtrExpansion: true`.
  - `DOGE/USDT`: `donchianLookback: 48` (12h), `volumeMultiplier: 2.0`, `slAtrMultiplier: 2.8`, `trendingThreshold: 22`, `rangingThreshold: 18`, `minBbWidth: 0.012`, `breakoutBufferAtr: 0.15`, `requireAtrExpansion: true`.
- **Rendimiento de Portafolio en Backtesting (90 Días, 15m, 4 Pares Concurrentes)**:
  - Reducción del sobre-trading en un **50.8%** (de 242 trades a 119 trades).
  - Reducción de comisiones pagadas de **\$661.93** a **\$401.30**.
  - Aumento del Win Rate de **39.7%** a **52.1%**.
  - Giro del PnL Neto de **-\$867.67 (-17.35%)** a **+\$1,257.54 (+25.15%)**, con un Profit Factor de **1.58** y reducción del Max Drawdown de **17.91%** a **11.48%**.

## [2.1.1] - 2026-10-20

### Fixed
- **Lectura Precisa de Dinero Real (`totalWalletBalance` en `TestnetBroker.ts`)**: Corregida la lectura del saldo de la cuenta priorizando `totalWalletBalance` en lugar de `balance.USDT.total` (que en CCXT Binance Futures devolvía el `marginBalance`). Esto elimina por completo la duplicación artificial del beneficio flotante (*floating PnL double-counting*) al registrar los snapshots de patrimonio.
- **Validación Estricta de Ejecución en Exchange (`TestnetBroker.ts`)**: Validación explícita de `executedQty > 0` y estado de la orden (`!EXPIRED`, `!CANCELED`). Si el exchange no ejecuta la orden en el mercado, se lanza un error controlado para que `Engine.ts` mantenga la posición abierta en SQLite para reintentar en el siguiente ciclo, evitando la creación de posiciones huérfanas en Binance.
- **Reconciliación y Cierre de Posición Huérfana**: Ejecutado el cierre a mercado en Binance Testnet de la posición huérfana de `0.0357 BTC` (asegurando `+$15.59 USDT` de ganancia neta en la billetera real).

## [2.1.0] - 2026-10-18

### Added
- **Reparto Real de Margen Multi-Activo (`RiskManager.ts`)**: Asignación de margen por ranura (`(availableBalance / maxSlots) * leverage * 0.90`) para permitir hasta 3 posiciones simultáneas sin bloqueos por falta de margen (`-2019`).
- **Bloqueo Anti-Reentrada en Misma Vela y Cooldown Post-StopLoss (`Engine.ts`)**: Mapas `lastCandleTsBySymbol` y `slCooldownUntilBySymbol` (30 minutos / 2 velas de 15m tras un `STOP_LOSS`) para evitar *whipsaw chaining*.
- **Persistencia del Daily Kill Switch ante Reinicios (`Engine.ts`)**: Hidratación y consulta directa del PnL realizado diario desde SQLite (`hydrateDailyRealizedPnlFromDb` y `checkAndEnforceKillSwitch`).
- **Precisión Decimal Dinámica para Altcoins (`src/utils/formatPrice.ts`)**: Formateo automático a 5 decimales para activos con precio `< $1` (ej. `DOGE/USDT`) y 2 decimales para activos `>= $1`.
- **Filtros Institucionales en `TrendBreakoutStrategy`**: Confirmación de doble estructura (`EMA 200` + `EMA 50` + pendiente), dirección de ADX (`+DI/-DI`), proporción de cuerpo de vela (`>= 40%`) y guardia de agotamiento RSI.

### Changed
- **`config.json` & `strategyConfig.ts`**:
  - `initialBalance`: `5000` USDT
  - `leverage`: `2`x
  - `riskPerTrade`: `0.01` (1.0%)
  - `regime.trendingThreshold`: `23` y `regime.minBbWidth`: `0.0065` (desbloquea `MeanReversionStrategy` en velas de 15m).
  - `trendStrategy`: `donchianLookback: 30`, `volumeMultiplier: 1.4`, `slAtrMultiplier: 2.2`.
  - `meanReversionStrategy.slAtrMultiplier`: `1.8`.
  - `tradeManagement.trailingAtrMultiplier`: `2.0`.

### Fixed
- **Consistencia Matemática de `1R` (`Engine.ts`)**: Cálculo homogéneo de `initial_sl` a distancia exacta `sizing.slDistance` desde `exec.filledPrice` para preservar `getOneR(trade)`.
- **Blindaje `try/catch` en Órdenes de Cierre (`Engine.ts`)**: Protección contra errores transitorios de red o `reduceOnly` en `executePartialScaleOut` y `closeFullPosition`.
- **Balance Total en `TestnetBroker.ts`**: Lectura de `totalWalletBalance` (`USDT.total`) en lugar de margen libre para evitar falsas alarmas de caída de patrimonio cuando hay posiciones abiertas.

## [2.0.0] - 2026-10-17

### Added
- Arquitectura inicial **Adaptive Multi-Regime Crypto Quant Engine** en TypeScript (Node.js v20+).
- Motor `RegimeDetector` (ADX + Bollinger Bandwidth) con conmutación automática entre `TrendBreakoutStrategy` y `MeanReversionStrategy`.
- Persistencia transaccional en SQLite (`better-sqlite3` + Drizzle ORM) para operaciones, snapshots de equity y caché de velas.
- Dashboard web en tiempo real con estética **shadcn/ui** Zinc Dark y telemetría por activo.
