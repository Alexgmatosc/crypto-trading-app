# Changelog

Todos los cambios notables de **Adaptive Multi-Regime Crypto Quant Engine** se documentan en este archivo.
El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y este proyecto se adhiere a [Semantic Versioning](https://semver.org/lang/es/).

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
