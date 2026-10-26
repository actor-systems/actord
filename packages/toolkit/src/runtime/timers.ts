// Timers a handler sets: one row per key in the actor's own SQLite, written in the handler's transaction.
import type { SqlStorageLike } from "./index.ts";

export const TIMERS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS _actors_timers (key TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, causation_id TEXT, correlation_id TEXT NOT NULL)",
];

export interface TimerRow {
  key: string;
  type: string;
  payload: string;
  due_at: number;
  attempts: number;
  causation_id: string | null;
  correlation_id: string;
}

/** Set a timer; a key that already exists is replaced, and its attempts start over. */
export function setTimer(sql: SqlStorageLike, row: Omit<TimerRow, "attempts">): void {
  sql.exec(
    "INSERT INTO _actors_timers (key, type, payload, due_at, attempts, causation_id, correlation_id) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT (key) DO UPDATE SET type = excluded.type, payload = excluded.payload, due_at = excluded.due_at, attempts = 0, causation_id = excluded.causation_id, correlation_id = excluded.correlation_id",
    row.key,
    row.type,
    row.payload,
    row.due_at,
    row.causation_id,
    row.correlation_id,
  );
}

/** Remove a pending timer. False if none was pending under that key. */
export function cancelTimer(sql: SqlStorageLike, key: string): boolean {
  return sql.exec("DELETE FROM _actors_timers WHERE key = ? RETURNING key", key).toArray().length > 0;
}

// One timer is its row as set: key, due time and cause. A cancel deletes it and setting the key again
// replaces it, so a firing that no longer matches its row was cancelled or replaced, and must not run.
const MATCH = "key = ? AND due_at = ? AND causation_id IS ?";
const match = (t: TimerRow) => [t.key, t.due_at, t.causation_id] as const;

/** Whether this timer is still set: not cancelled, replaced or delivered since it was read. */
export function timerSet(sql: SqlStorageLike, t: TimerRow): boolean {
  return sql.exec(`SELECT 1 FROM _actors_timers WHERE ${MATCH}`, ...match(t)).toArray().length > 0;
}

/** Remove this timer if it is still set. True if it was: inside a handler's transaction, that decides it fires. */
export function consumeTimer(sql: SqlStorageLike, t: TimerRow): boolean {
  return sql.exec(`DELETE FROM _actors_timers WHERE ${MATCH} RETURNING key`, ...match(t)).toArray().length > 0;
}

/** Book this timer's next delivery attempt, if it is still set. */
export function retryTimer(sql: SqlStorageLike, t: TimerRow, attempts: number, dueAt: number): void {
  sql.exec(`UPDATE _actors_timers SET attempts = ?, due_at = ? WHERE ${MATCH}`, attempts, dueAt, ...match(t));
}

export function dueTimers(sql: SqlStorageLike, now: number): TimerRow[] {
  return sql.exec<TimerRow>("SELECT key, type, payload, due_at, attempts, causation_id, correlation_id FROM _actors_timers WHERE due_at <= ? ORDER BY due_at, key", now).toArray();
}

export function earliestTimer(sql: SqlStorageLike): number | null {
  return sql.exec<{ t: number | null }>("SELECT MIN(due_at) AS t FROM _actors_timers").toArray()[0]?.t ?? null;
}
