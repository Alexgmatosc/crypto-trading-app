# Reporte de Auditoría Cuantitativa — QuantEngine (TESTNET_LIVE)

Fecha de generación: 2026-10-17T21:40:19.715Z
Saldo actual en Binance Testnet: $4,946.74 USDT (Efectivo libre)
Saldo inicial de prueba: $5,000.00 USDT
Diferencia neta total: -$53.26 USDT (-1.06%)

## 1. Resumen de Ejecución

- **Operaciones en Testnet**: 23
- **Posiciones abiertas actualmente**: 0
- **Pares configurados**: BTC/USDT, ETH/USDT, SOL/USDT, DOGE/USDT (15m)

## 2. Historial Detallado de Operaciones (Audit Trail)

| # | Par | Lado | Estrategia | Entrada | Salida | PnL Realizado | Comisiones | Razón de Salida | Apertura | Cierre |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ETH/USDT | SHORT | TREND_BREAKOUT | $2422.37 | $2418.74 | +8.31 USDT | $4.74 | TRAILING_STOP | 15:16:35 | 17:15:00 |
| 2 | ETH/USDT | SHORT | TREND_BREAKOUT | $2415.00 | $2407.52 | +14.14 USDT | $4.75 | TRAILING_STOP | 17:30:04 | 18:45:00 |
| 3 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.64 USDT | $4.79 | STOP_LOSS | 23:30:59 | 23:15:00 |
| 4 | DOGE/USDT | SHORT | TREND_BREAKOUT | $0.08 | $0.08 | -1.49 USDT | $0.22 | STOP_LOSS | 23:31:01 | 23:15:00 |
| 5 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.69 USDT | $4.80 | STOP_LOSS | 23:34:09 | 23:15:00 |
| 6 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.67 USDT | $4.79 | STOP_LOSS | 23:34:16 | 23:15:00 |
| 7 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.57 USDT | $4.77 | STOP_LOSS | 23:34:23 | 23:15:00 |
| 8 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.58 USDT | $4.77 | STOP_LOSS | 23:34:29 | 23:15:00 |
| 9 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.57 USDT | $4.77 | STOP_LOSS | 23:34:36 | 23:15:00 |
| 10 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.54 USDT | $4.77 | STOP_LOSS | 23:34:43 | 23:15:00 |
| 11 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.52 USDT | $4.76 | STOP_LOSS | 23:34:50 | 23:15:00 |
| 12 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.50 USDT | $4.76 | STOP_LOSS | 23:34:57 | 23:15:00 |
| 13 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.48 USDT | $4.75 | STOP_LOSS | 23:35:05 | 23:15:00 |
| 14 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.45 USDT | $4.75 | STOP_LOSS | 23:35:13 | 23:15:00 |
| 15 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.43 USDT | $4.74 | STOP_LOSS | 23:35:20 | 23:15:00 |
| 16 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.40 USDT | $4.74 | STOP_LOSS | 23:35:27 | 23:15:00 |
| 17 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.38 USDT | $4.73 | STOP_LOSS | 23:35:34 | 23:15:00 |
| 18 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.37 USDT | $4.73 | STOP_LOSS | 23:35:41 | 23:15:00 |
| 19 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.34 USDT | $4.73 | STOP_LOSS | 23:35:48 | 23:15:00 |
| 20 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.32 USDT | $4.72 | STOP_LOSS | 23:35:55 | 23:15:00 |
| 21 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.30 USDT | $4.72 | STOP_LOSS | 23:36:02 | 23:15:00 |
| 22 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2402.45 | -23.28 USDT | $4.71 | STOP_LOSS | 23:36:10 | 23:15:00 |
| 23 | ETH/USDT | SHORT | TREND_BREAKOUT | $2393.00 | $2393.00 | -2.35 USDT | $2.35 | KILL_SWITCH | 23:36:17 | 23:39:07 |

## 3. Explicación Técnica de la Incidencia

1. **¿Qué dinero es?**: Es la cuenta **Binance USD-M Futures Testnet** (saldo virtual de prueba). No es dinero bancario real.
2. **Saldo Real**: El saldo NO cayó a 227 € ni se perdieron $4,769. El saldo en Binance es de **$4,946.74 USDT**.
3. **Causa del número visual erróneo**: Cuando hay posiciones abiertas, Binance bloquea margen de garantía. El conector leyó temporalmente `freeMargin` ($230) en vez de `totalWalletBalance` ($5,028), lo que generó un snapshot temporal erróneo en el reporte que indicaba un falso -95%.
4. **Causa del bucle de 2 minutos**: En el arranque, el daemon evaluaba la última vela histórica en lugar de esperar una nueva. Al fallar la segunda orden por margen insuficiente, Node arrojó error no capturado y PM2 reinició el proceso repetidamente. Se corrigió eliminando la ejecución en el arranque y añadiendo `try/catch` para blindar las órdenes.

