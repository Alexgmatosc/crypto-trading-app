# Protocolo Oficial de Validación Cuantitativa (v2.1.0)

Este documento establece el marco estricto y determinista para validar el motor cuantitativo **Adaptive Multi-Regime Crypto Quant Engine (v2.1.0)**. 

El objetivo es **eliminar el bucle infinito de ajustes ad-hoc** y someter la versión actual a un proceso de auditoría formal con criterios de éxito claros antes de considerar cualquier cambio adicional.

---

## 1. Criterios de Aprobación (Pass / Fail)

Para considerar que la versión **v2.1.0** es técnicamente y matemáticamente viable, debe cumplir **simultáneamente** los siguientes 4 criterios:

| Métrica | Umbral Exigido | Propósito |
| :--- | :---: | :--- |
| **Estabilidad de Ejecución** | **0 errores** no capturados | Cero caídas de proceso, cero bloqueos por falta de margen (`-2019`) y captura limpia de errores de red en órdenes. |
| **Disciplina de Riesgo** | **100% cumplimiento** | El Drawdown Diario jamás debe superar el **4.0%** sin que se active el Kill Switch; Stop Loss y Take Profit exactos. |
| **Consistencia Matemática** | **1R exacto** | Cero distorsión en ratios de riesgo/beneficio (1.5R para TP1 y 2.0R para Trailing Stop). |
| **Rentabilidad / Expectativa** | **Profit Factor >= 1.10** | Tras deducir comisiones Taker reales (0.05%) y slippage (0.04%), el motor debe generar expectativa positiva. |

---

## 2. Fase A: Backtest Histórico Multi-Activo (60 Días)

* **Universo:** 4 pares simultáneos (`BTC/USDT`, `ETH/USDT`, `SOL/USDT`, `DOGE/USDT`).
* **Temporalidad:** Velas de 15 minutos (`15m`).
* **Período:** 60 días continuos (aprox. 5,760 velas de 15m por par = ~23,000 velas analizadas).
* **Condición de Simulación:**
  * Balance inicial: `$5,000.00 USDT`.
  * Apalancamiento: `2x`.
  * Ranuras concurrentes: Máximo 3 activos operando en paralelo con reparto equitativo de margen.
  * Comisiones: Modelo Taker completo con slippage en cada entrada y salida.

---

## 3. Fase B: Forward-Test en Vivo (Ventana de 72 Horas)

* **Entorno:** Binance Futures Testnet (`TESTNET_LIVE`).
* **Política de Intervención:** **RÉGIMEN ESTRICTO "HANDS-OFF"**.
  * **Prohibido:** Modificar código, indicadores, filtros o archivos de configuración durante las 72 horas.
  * **Permitido:** Monitorear logs cada 24 horas mediante `pnpm export:logs` y observar telemetría en el dashboard.
  * **Única excepción de detención:** Si se activa el *Daily Kill Switch* (-4.0% de pérdida en el día) o si ocurre una desconexión crítica irrecuperable de la API de Binance.

### Calendario de Revisiones:
1. **Checkpoint 24h:** Auditoría de aperturas, cierres por ranura y verificación de cero errores `-2019`.
2. **Checkpoint 48h:** Evaluación de drawdown acumulado y verificación del cooldown de 30m post-StopLoss.
3. **Checkpoint 72h:** Cierre de la ventana, exportación final de auditoría y comparación formal contra los criterios Pass/Fail.
