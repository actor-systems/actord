// Job effects: external work that outlives a request (an agent session, a CI run). The adapter's start()
// returns a handle quickly; the job is then settled once, later, by its completion message, its probe,
// its deadline (in_doubt) or a cancel reported honestly. A job stays one outbox row:
//   pending → running (start) → awaiting_job (handle stored) → confirmed | failed | in_doubt
//                                awaiting_job → cancelling (cancelJob) → failed "cancelled" | in_doubt
// A completion message that arrives before the row is waiting is kept on it (body.earlyOutcome) and
// settles the job as soon as its start attempt finishes, whatever that attempt's own result.
// The row's next_at is when actord must look at it next: the nearer of its next probe and its deadline.
import type { Duration, EffectSpec } from "../system.ts";
import { durationMs } from "../system.ts";
import type { EffectUsage, SqlStorageLike } from "./index.ts";

export interface JobAdapter<I = unknown, H = unknown, O = unknown> {
  /** Begin the work and return a JSON handle for it, quickly: the job's outcome arrives later. */
  start(input: I, ctx: { key: string; attempt: number; signal: AbortSignal; reportUsage(u: EffectUsage): void }): Promise<H>;
  /** Ask whether the job has finished. Runs only when the effect declares `probe: { every }`. */
  probe?(handle: H, ctx: { key: string; signal: AbortSignal; reportUsage(u: EffectUsage): void }): Promise<JobProbe<O>>;
  /** Ask the destination to stop the job. Return true only when it confirms the job won't complete. */
  cancel?(handle: H, ctx: { key: string; signal: AbortSignal; reportUsage(u: EffectUsage): void }): Promise<boolean>;
}

export type JobProbe<O = unknown> = { done: false } | { done: true; status: "confirmed"; value: O } | { done: true; status: "failed"; error: string };

/** What settled a job, recorded on the row body and on the settling event. */
export type SettledBy = "message" | "probe" | "deadline" | "cancel";

/** The outcome a completion message reports, as passed to ctx.settleJob. */
export type CompletionOutcome = { status: "confirmed"; value?: unknown } | { status: "failed"; error: string };

/** The outbox row body of an effect request, with the fields a job adds once it has started. */
export interface JobBody {
  name: string;
  key: string;
  input: unknown;
  causationId: string;
  correlationId: string;
  usage?: EffectUsage;
  handle?: unknown;
  deadlineAt?: number;
  settledBy?: SettledBy;
  /** A completion that arrived before the job was waiting; the first one recorded wins. */
  earlyOutcome?: CompletionOutcome;
}

export interface JobRow {
  id: string;
  attempts: number;
  body: JobBody;
}

/** Statuses of a job row whose start hasn't yet returned a handle: a completion for it is kept for later. */
export const NOT_STARTED = new Set(["pending", "running", "awaiting_approval"]);

/** A job's deadline and probe period in milliseconds; deadline is null when it is missing or doesn't parse. */
export function jobTiming(fx: Pick<EffectSpec, "deadline" | "probe">): { deadlineMs: number | null; everyMs: number | null } {
  return { deadlineMs: fx.deadline ? durationMs(fx.deadline) : null, everyMs: fx.probe ? durationMs(fx.probe.every as Duration) : null };
}

/** When to look at a waiting job next: a probe period from now, but never after its deadline. */
export function nextLookAt(now: number, everyMs: number | null, deadlineAt: number): number {
  return everyMs === null ? deadlineAt : Math.min(now + everyMs, deadlineAt);
}

const parse = (r: { id: string; attempts: number; body: string }): JobRow => ({ id: r.id, attempts: r.attempts, body: JSON.parse(r.body) as JobBody });

/** running → awaiting_job: the start was acknowledged with a handle. False if the row was no longer running. */
export function awaitJob(sql: SqlStorageLike, id: string, attempts: number, body: JobBody, nextAt: number): boolean {
  return sql.exec("UPDATE _actors_outbox SET status = 'awaiting_job', attempts = ?, next_at = ?, last_error = NULL, body = ? WHERE id = ? AND status = 'running' RETURNING id", attempts, nextAt, JSON.stringify(body), id).toArray().length > 0;
}

/** The row if it is waiting for its job to finish; nothing else may be settled or cancelled. */
export function awaitingJob(sql: SqlStorageLike, id: string): JobRow | null {
  const r = sql.exec<{ id: string; attempts: number; body: string }>("SELECT id, attempts, body FROM _actors_outbox WHERE id = ? AND status = 'awaiting_job'", id).toArray()[0];
  return r ? parse(r) : null;
}

/** The job row under `id` in any status, or null when there is none. */
export function jobRowAt(sql: SqlStorageLike, id: string): (JobRow & { status: string }) | null {
  const r = sql.exec<{ id: string; attempts: number; body: string; status: string }>("SELECT id, attempts, body, status FROM _actors_outbox WHERE id = ? AND kind = 'effect'", id).toArray()[0];
  return r ? { ...parse(r), status: r.status } : null;
}

/** The completion recorded on a row before its job was waiting, read fresh: a handler may have written it mid-attempt. */
export function earlyOutcome(sql: SqlStorageLike, id: string): CompletionOutcome | undefined {
  return jobRowAt(sql, id)?.body.earlyOutcome;
}

/** Keep a completion on a row whose start hasn't returned. False if one is already kept (the first wins). */
export function recordEarlyOutcome(sql: SqlStorageLike, id: string, outcome: CompletionOutcome): boolean {
  const row = jobRowAt(sql, id);
  if (!row || row.body.earlyOutcome) return false;
  sql.exec("UPDATE _actors_outbox SET body = ? WHERE id = ?", JSON.stringify({ ...row.body, earlyOutcome: outcome }), id);
  return true;
}

/** Waiting jobs due a look: a probe, or a deadline that has passed. */
export function dueJobs(sql: SqlStorageLike, now: number): JobRow[] {
  return sql.exec<{ id: string; attempts: number; body: string }>("SELECT id, attempts, body FROM _actors_outbox WHERE status = 'awaiting_job' AND next_at <= ? ORDER BY next_at, seq", now).toArray().map(parse);
}

/** Push a waiting job's next look out, keeping any usage the look reported. False if it is no longer waiting. */
export function rescheduleJob(sql: SqlStorageLike, id: string, nextAt: number, body: JobBody): boolean {
  return sql.exec("UPDATE _actors_outbox SET next_at = ?, body = ? WHERE id = ? AND status = 'awaiting_job' RETURNING id", nextAt, JSON.stringify(body), id).toArray().length > 0;
}

/**
 * awaiting_job → cancelling, inside the handler's transaction. False if it wasn't waiting. The interruption count
 * starts again: from here it counts restarts that cut the cancel off, not the start's.
 */
export function markCancelling(sql: SqlStorageLike, id: string, now: number): boolean {
  return sql.exec("UPDATE _actors_outbox SET status = 'cancelling', next_at = ?, interruptions = 0 WHERE id = ? AND status = 'awaiting_job' RETURNING id", now, id).toArray().length > 0;
}

export function cancellingJob(sql: SqlStorageLike, id: string): JobRow | null {
  const r = sql.exec<{ id: string; attempts: number; body: string }>("SELECT id, attempts, body FROM _actors_outbox WHERE id = ? AND status = 'cancelling'", id).toArray()[0];
  return r ? parse(r) : null;
}

/** The earliest look any waiting job needs, or null when none is waiting. */
export function earliestJob(sql: SqlStorageLike): number | null {
  return sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM _actors_outbox WHERE status = 'awaiting_job'").toArray()[0]?.t ?? null;
}

/** For @actord/toolkit/testing: move every waiting job's deadline to `at`. Returns how many were waiting. */
export function expireJobRows(sql: SqlStorageLike, at: number): number {
  const rows = sql.exec<{ id: string; attempts: number; body: string }>("SELECT id, attempts, body FROM _actors_outbox WHERE status = 'awaiting_job'").toArray().map(parse);
  for (const r of rows) sql.exec("UPDATE _actors_outbox SET next_at = ?, body = ? WHERE id = ?", at, JSON.stringify({ ...r.body, deadlineAt: at }), r.id);
  return rows.length;
}
