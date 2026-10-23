import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const trades = sqliteTable('trades', {
  id: text('id').primaryKey(),
  mode: text('mode').notNull(),
  symbol: text('symbol').notNull(),
  strategy: text('strategy').notNull(),
  regime_at_entry: text('regime_at_entry').notNull(),
  side: text('side').notNull(),
  entry_price: real('entry_price').notNull(),
  exit_price: real('exit_price'),
  initial_size: real('initial_size').notNull(),
  remaining_size: real('remaining_size').notNull(),
  initial_sl: real('initial_sl').notNull(),
  current_sl: real('current_sl').notNull(),
  stop_order_id: text('stop_order_id'),
  tp1_hit: integer('tp1_hit').notNull().default(0),
  realized_pnl: real('realized_pnl').notNull().default(0),
  fees_paid: real('fees_paid').notNull().default(0),
  status: text('status').notNull(),
  exit_reason: text('exit_reason'),
  opened_at: integer('opened_at').notNull(),
  closed_at: integer('closed_at'),
});

export const equitySnapshots = sqliteTable('equity_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp').notNull(),
  mode: text('mode').notNull(),
  balance_usdt: real('balance_usdt').notNull(),
  equity_usdt: real('equity_usdt').notNull(),
  drawdown_pct: real('drawdown_pct').notNull(),
});

export const candlesCache = sqliteTable(
  'candles_cache',
  {
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    timestamp: integer('timestamp').notNull(),
    open: real('open').notNull(),
    high: real('high').notNull(),
    low: real('low').notNull(),
    close: real('close').notNull(),
    volume: real('volume').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.symbol, table.timeframe, table.timestamp] }),
  })
);
