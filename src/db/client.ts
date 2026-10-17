import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export interface DatabaseConnection {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  regime_at_entry TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL,
  initial_size REAL NOT NULL,
  remaining_size REAL NOT NULL,
  initial_sl REAL NOT NULL,
  current_sl REAL NOT NULL,
  tp1_hit INTEGER NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  fees_paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  exit_reason TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_trades_mode_status ON trades(mode, status);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades(symbol, status);
CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(mode, closed_at);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  timestamp INTEGER NOT NULL,
  mode TEXT NOT NULL,
  balance_usdt REAL NOT NULL,
  equity_usdt REAL NOT NULL,
  drawdown_pct REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_equity_mode_timestamp ON equity_snapshots(mode, timestamp);

CREATE TABLE IF NOT EXISTS candles_cache (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (symbol, timeframe, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles_cache(symbol, timeframe, timestamp);
`;

export function createDatabaseConnection(customDbPath?: string): DatabaseConnection {
  const targetPath = customDbPath ?? env.DB_PATH;
  if (targetPath !== ':memory:') {
    const resolvedDir = path.dirname(path.resolve(process.cwd(), targetPath));
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }
  }

  const sqlite = new Database(targetPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(INIT_SQL);

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

let defaultConnection: DatabaseConnection | null = null;

export function getDatabaseConnection(): DatabaseConnection {
  if (!defaultConnection) {
    defaultConnection = createDatabaseConnection();
  }
  return defaultConnection;
}
