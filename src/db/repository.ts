import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  Candle,
  EquitySnapshotRecord,
  ExecutionMode,
  ExitReason,
  TradeRecord,
} from '../types/index.js';
import { createDatabaseConnection, getDatabaseConnection, type DatabaseConnection } from './client.js';
import { candlesCache, equitySnapshots, trades } from './schema.js';

export class QuantRepository {
  private readonly conn: DatabaseConnection;

  constructor(customConnection?: DatabaseConnection | string) {
    if (typeof customConnection === 'string') {
      this.conn = createDatabaseConnection(customConnection);
    } else if (customConnection) {
      this.conn = customConnection;
    } else {
      this.conn = getDatabaseConnection();
    }
  }

  public insertTrade(trade: TradeRecord): void {
    this.conn.db
      .insert(trades)
      .values({
        id: trade.id,
        mode: trade.mode,
        symbol: trade.symbol,
        strategy: trade.strategy,
        regime_at_entry: trade.regime_at_entry,
        side: trade.side,
        entry_price: trade.entry_price,
        exit_price: trade.exit_price,
        initial_size: trade.initial_size,
        remaining_size: trade.remaining_size,
        initial_sl: trade.initial_sl,
        current_sl: trade.current_sl,
        stop_order_id: trade.stop_order_id ?? null,
        tp1_hit: trade.tp1_hit,
        realized_pnl: trade.realized_pnl,
        fees_paid: trade.fees_paid,
        status: trade.status,
        exit_reason: trade.exit_reason,
        opened_at: trade.opened_at,
        closed_at: trade.closed_at,
      })
      .run();
  }

  public updateTradePartialClose(params: {
    id: string;
    remainingSize: number;
    currentSl: number;
    stopOrderId?: string | null;
    realizedPnlDelta: number;
    feesPaidDelta: number;
  }): TradeRecord | undefined {
    const tx = this.conn.sqlite.transaction(() => {
      const existing = this.getTradeById(params.id);
      if (!existing) {
        return undefined;
      }

      const updatedRealizedPnl = existing.realized_pnl + params.realizedPnlDelta;
      const updatedFeesPaid = existing.fees_paid + params.feesPaidDelta;

      this.conn.db
        .update(trades)
        .set({
          remaining_size: params.remainingSize,
          current_sl: params.currentSl,
          stop_order_id: params.stopOrderId !== undefined ? params.stopOrderId : existing.stop_order_id ?? null,
          tp1_hit: 1,
          realized_pnl: updatedRealizedPnl,
          fees_paid: updatedFeesPaid,
        })
        .where(eq(trades.id, params.id))
        .run();

      return this.getTradeById(params.id);
    });

    return tx();
  }

  public updateTradeStopLoss(id: string, newSl: number, stopOrderId?: string | null): void {
    const updatePayload: Partial<typeof trades.$inferInsert> = { current_sl: newSl };
    if (stopOrderId !== undefined) {
      updatePayload.stop_order_id = stopOrderId;
    }
    this.conn.db
      .update(trades)
      .set(updatePayload)
      .where(eq(trades.id, id))
      .run();
  }

  public updateTradeStopOrderId(id: string, stopOrderId: string | null): void {
    this.conn.db
      .update(trades)
      .set({ stop_order_id: stopOrderId })
      .where(eq(trades.id, id))
      .run();
  }

  public closeTrade(params: {
    id: string;
    exitPrice: number;
    realizedPnlDelta: number;
    feesPaidDelta: number;
    exitReason: ExitReason;
    closedAt: number;
  }): TradeRecord | undefined {
    const tx = this.conn.sqlite.transaction(() => {
      const existing = this.getTradeById(params.id);
      if (!existing) {
        return undefined;
      }

      const finalRealizedPnl = existing.realized_pnl + params.realizedPnlDelta;
      const finalFeesPaid = existing.fees_paid + params.feesPaidDelta;

      this.conn.db
        .update(trades)
        .set({
          exit_price: params.exitPrice,
          remaining_size: 0,
          stop_order_id: null,
          realized_pnl: finalRealizedPnl,
          fees_paid: finalFeesPaid,
          status: 'CLOSED',
          exit_reason: params.exitReason,
          closed_at: params.closedAt,
        })
        .where(eq(trades.id, params.id))
        .run();

      return this.getTradeById(params.id);
    });

    return tx();
  }

  public getTradeById(id: string): TradeRecord | undefined {
    const rows = this.conn.db.select().from(trades).where(eq(trades.id, id)).all();
    if (rows.length === 0) return undefined;
    return this.mapRowToTradeRecord(rows[0]);
  }

  public getOpenTrades(mode: ExecutionMode, symbol?: string): TradeRecord[] {
    const conditions = [eq(trades.mode, mode), eq(trades.status, 'OPEN')];
    if (symbol) {
      conditions.push(eq(trades.symbol, symbol));
    }

    const rows = this.conn.db
      .select()
      .from(trades)
      .where(and(...conditions))
      .orderBy(asc(trades.opened_at))
      .all();

    return rows.map((row) => this.mapRowToTradeRecord(row));
  }

  public getClosedTrades(mode: ExecutionMode, sinceTimestamp?: number): TradeRecord[] {
    const conditions = [eq(trades.mode, mode), eq(trades.status, 'CLOSED')];
    if (sinceTimestamp !== undefined) {
      conditions.push(gte(trades.closed_at, sinceTimestamp));
    }

    const rows = this.conn.db
      .select()
      .from(trades)
      .where(and(...conditions))
      .orderBy(asc(trades.closed_at))
      .all();

    return rows.map((row) => this.mapRowToTradeRecord(row));
  }

  public getAllTrades(mode?: ExecutionMode): TradeRecord[] {
    const rows = mode
      ? this.conn.db
          .select()
          .from(trades)
          .where(eq(trades.mode, mode))
          .orderBy(asc(trades.opened_at))
          .all()
      : this.conn.db.select().from(trades).orderBy(asc(trades.opened_at)).all();

    return rows.map((row) => this.mapRowToTradeRecord(row));
  }

  public insertEquitySnapshot(snapshot: EquitySnapshotRecord): void {
    this.conn.db
      .insert(equitySnapshots)
      .values({
        timestamp: snapshot.timestamp,
        mode: snapshot.mode,
        balance_usdt: snapshot.balance_usdt,
        equity_usdt: snapshot.equity_usdt,
        drawdown_pct: snapshot.drawdown_pct,
      })
      .run();
  }

  public getEquitySnapshots(mode: ExecutionMode): EquitySnapshotRecord[] {
    const rows = this.conn.db
      .select()
      .from(equitySnapshots)
      .where(eq(equitySnapshots.mode, mode))
      .orderBy(asc(equitySnapshots.timestamp))
      .all();

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      mode: row.mode as ExecutionMode,
      balance_usdt: row.balance_usdt,
      equity_usdt: row.equity_usdt,
      drawdown_pct: row.drawdown_pct,
    }));
  }

  public getLatestEquitySnapshot(mode: ExecutionMode): EquitySnapshotRecord | undefined {
    const rows = this.conn.db
      .select()
      .from(equitySnapshots)
      .where(eq(equitySnapshots.mode, mode))
      .orderBy(desc(equitySnapshots.timestamp), desc(equitySnapshots.id))
      .limit(1)
      .all();

    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      id: row.id,
      timestamp: row.timestamp,
      mode: row.mode as ExecutionMode,
      balance_usdt: row.balance_usdt,
      equity_usdt: row.equity_usdt,
      drawdown_pct: row.drawdown_pct,
    };
  }

  public clearModeData(mode: ExecutionMode): void {
    const tx = this.conn.sqlite.transaction(() => {
      this.conn.db.delete(trades).where(eq(trades.mode, mode)).run();
      this.conn.db.delete(equitySnapshots).where(eq(equitySnapshots.mode, mode)).run();
    });
    tx();
  }

  public saveCandlesBatch(symbol: string, timeframe: string, candles: Candle[]): void {
    if (candles.length === 0) return;

    const stmt = this.conn.sqlite.prepare(`
      INSERT OR REPLACE INTO candles_cache (symbol, timeframe, timestamp, open, high, low, close, volume)
      VALUES (@symbol, @timeframe, @timestamp, @open, @high, @low, @close, @volume)
    `);

    const insertMany = this.conn.sqlite.transaction((items: Candle[]) => {
      for (const c of items) {
        stmt.run({
          symbol,
          timeframe,
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        });
      }
    });

    insertMany(candles);
  }

  public getCachedCandles(
    symbol: string,
    timeframe: string,
    startTimeMs: number,
    endTimeMs: number
  ): Candle[] {
    const rows = this.conn.db
      .select()
      .from(candlesCache)
      .where(
        and(
          eq(candlesCache.symbol, symbol),
          eq(candlesCache.timeframe, timeframe),
          gte(candlesCache.timestamp, startTimeMs),
          lte(candlesCache.timestamp, endTimeMs)
        )
      )
      .orderBy(asc(candlesCache.timestamp))
      .all();

    return rows.map((r) => ({
      timestamp: r.timestamp,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }

  public getCachedCandleBounds(
    symbol: string,
    timeframe: string
  ): { minTimestamp: number | null; maxTimestamp: number | null; count: number } {
    const row = this.conn.db
      .select({
        minTimestamp: sql<number | null>`MIN(${candlesCache.timestamp})`,
        maxTimestamp: sql<number | null>`MAX(${candlesCache.timestamp})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(candlesCache)
      .where(and(eq(candlesCache.symbol, symbol), eq(candlesCache.timeframe, timeframe)))
      .get();

    return {
      minTimestamp: row?.minTimestamp ?? null,
      maxTimestamp: row?.maxTimestamp ?? null,
      count: row?.count ?? 0,
    };
  }

  public close(): void {
    this.conn.sqlite.close();
  }

  private mapRowToTradeRecord(row: typeof trades.$inferSelect): TradeRecord {
    return {
      id: row.id,
      mode: row.mode as ExecutionMode,
      symbol: row.symbol,
      strategy: row.strategy as TradeRecord['strategy'],
      regime_at_entry: row.regime_at_entry as TradeRecord['regime_at_entry'],
      side: row.side as TradeRecord['side'],
      entry_price: row.entry_price,
      exit_price: row.exit_price,
      initial_size: row.initial_size,
      remaining_size: row.remaining_size,
      initial_sl: row.initial_sl,
      current_sl: row.current_sl,
      stop_order_id: row.stop_order_id ?? null,
      tp1_hit: row.tp1_hit,
      realized_pnl: row.realized_pnl,
      fees_paid: row.fees_paid,
      status: row.status as TradeRecord['status'],
      exit_reason: (row.exit_reason as ExitReason | null) ?? null,
      opened_at: row.opened_at,
      closed_at: row.closed_at,
    };
  }
}

export const repository = new QuantRepository();
