// @actord/toolkit/runtime: a small helper that a native Durable Object class composes (no base class).
// The class installs the Agents SDK's Lifecycle, and actord runs as one capability on it (capability.ts).
//
// What it guarantees, and how (each is exercised by tests that run in workerd):
// - Validation: an envelope is refused unless it is well formed, travels a declared route, carries the
//   declared message version, and its payload passes the message's Standard Schema.
// - Dedupe: a message id is handled at most once per actor instance while its inbox row is retained.
// - Atomic handling: the handler runs inside ctx.storage.transaction(). Its SQL writes, the inbox mark,
//   its outgoing messages, and its effect intents commit together or not at all. A throw anywhere rolls
//   everything back and the sender retries. The transaction holds the input gate, so keep handlers to
//   storage work: anything slow belongs in an effect.
// - Delivery: outgoing messages sit in a SQLite outbox and are delivered after commit, retried with
//   backoff from actord's Lifecycle job until acknowledged or exhausted (at least once; receivers
//   dedupe). Messages from one sender to one receiver keep their order except across retries.
// - Effects: run after commit, outside the transaction, so other messages interleave while they wait.
//   An attempt whose acknowledgment is lost is retried only when the effect declares an idempotency key;
//   otherwise it is recorded and reported as in_doubt, never as delivered.
// - Jobs: a job effect's start() returns a handle, and the job is settled once: by its completion message,
//   its probe, its deadline (in_doubt), or a cancel reported honestly (jobs.ts).
// Not guaranteed: exactly-once external effects, global ordering, cross-actor transactions, or that a
// route is a security boundary (any code holding the binding can call receive()).
import type {
  ActorName,
  ActorSpec,
  IngressMessages,
  EffectName,
  MessageName,
  MessagesFrom,
  MessagesTo,
  PayloadIn,
  PayloadOut,
  Receivers,
  StandardSchemaV1,
  System,
  TimerMessages,
} from "../system.ts";
import { durationMs, type Duration } from "../system.ts";
import { TIMERS_SCHEMA, type TimerRow, cancelTimer, consumeTimer, dueTimers, earliestTimer, retryTimer, setTimer, timerSet } from "./timers.ts";
import type { Lifecycle } from "agents/lifecycle";
import { ActordCapability } from "./capability.ts";
import { migrateLegacy, nextDue, scheduleKey } from "./schedules.ts";
import {
  type CompletionOutcome,
  type JobAdapter,
  type JobBody,
  type JobProbe,
  type JobRow,
  type SettledBy,
  awaitingJob,
  awaitJob,
  cancellingJob,
  cancellingJobs,
  dueJobs,
  earliestJob,
  earlyOutcome,
  jobRowAt,
  jobTiming,
  markCancelling,
  NOT_STARTED,
  nextLookAt,
  recordEarlyOutcome,
  rescheduleJob,
} from "./jobs.ts";
export type { JobAdapter, JobProbe } from "./jobs.ts";

// ---- Minimal structural types for the Durable Object APIs we use (no dependency on workers-types) ----

interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
}
/** Structurally compatible with the native SqlStorage, so handlers can pass row types to exec<T>(). */
export interface SqlStorageLike {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors SqlStorage's own row constraint
  exec<T extends Record<string, any> = Record<string, any>>(query: string, ...bindings: any[]): SqlCursor<T>;
}
export interface DurableObjectStateLike {
  id: { name?: string; toString(): string };
  waitUntil?(promise: Promise<unknown>): void;
  storage: {
    sql: SqlStorageLike;
    transaction<T>(closure: () => Promise<T>): Promise<T>;
  };
}
/** What actorRuntime needs from the Durable Object: its Lifecycle, which owns the alarm, and ctx and env. */
export interface ActorHost {
  lifecycle: Lifecycle;
  ctx: DurableObjectStateLike;
  env: unknown;
}
interface StubLike {
  receive(envelope: Envelope): Promise<Receipt>;
}
interface NamespaceLike {
  getByName(name: string): StubLike;
}

// ---- Envelopes, receipts, events ----

export const ENVELOPE_VERSION = 1;

export interface Envelope<P = unknown> {
  v: 1;
  id: string;
  type: string;
  version: number;
  /** "Actor:key", "@clock", or "@ingress". */
  from: string;
  /** "Actor:key". */
  to: string;
  correlationId: string;
  causationId: string | null;
  attempt: number;
  sentAt: number;
  payload: P;
}

export type Receipt =
  | { status: "handled"; messageId: string }
  | { status: "duplicate"; messageId: string }
  | { status: "rejected"; messageId: string | null; reason: RejectReason; detail?: string }
  | { status: "failed"; messageId: string; error: string };

export type RejectReason = "malformed" | "wrong_recipient" | "unauthorized_route" | "unknown_message" | "version_mismatch" | "invalid_payload";

export type EventKind =
  | "received"
  | "duplicate"
  | "rejected"
  | "handled"
  | "failed"
  | "sent"
  | "delivered"
  | "retry.scheduled"
  | "retry.exhausted"
  | "undeliverable"
  | "effect.requested"
  | "effect.duplicate"
  | "effect.confirmed"
  | "effect.failed"
  | "effect.in_doubt"
  | "effect.parked"
  | "effect.denied"
  | "effect.awaiting_approval"
  | "scheduled"
  | "timer.set"
  | "timer.cancelled"
  | "timer.fired"
  | "job.started"
  | "job.probed"
  | "job.cancel_requested"
  | "note";

/** One structured event, written as a single JSON console line (Workers Logs in production). */
export interface ActorEvent {
  $actord: 1;
  kind: EventKind;
  at: number;
  actor: string;
  messageId?: string;
  type?: string;
  version?: number;
  from?: string;
  to?: string;
  correlationId?: string;
  causationId?: string | null;
  attempt?: number;
  effect?: string;
  effectKey?: string;
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Kinds that the monitor and `actord events --notable` surface. */
export const NOTABLE_KINDS: readonly EventKind[] = ["rejected", "failed", "retry.exhausted", "undeliverable", "effect.in_doubt", "effect.parked", "effect.denied", "effect.failed"];

// ---- Effects ----

export type EffectOutcome<T = unknown> =
  | { status: "confirmed"; key: string; value: T }
  | { status: "failed"; key: string; error: string }
  | { status: "in_doubt"; key: string; error: string }
  | { status: "awaiting_approval"; key: string }
  | { status: "denied"; key: string; error: string };

/** Throw from an adapter when the request provably never reached the destination (safe to retry). */
export class EffectNotDelivered extends Error {
  readonly notDelivered = true;
}
/** Throw from an adapter when the destination definitively refused the request (never retried). */
export class EffectRejected extends Error {
  readonly rejected = true;
}

/**
 * What an attempt consumed. Every field is optional; reports are summed field by field.
 * Not guaranteed: usage from an attempt that crashed the Durable Object is lost, and usage reported
 * after an attempt has timed out or ended is dropped.
 */
export interface EffectUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  containerSeconds?: number;
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "costUsd", "containerSeconds"] as const;
const hasUsage = (u: EffectUsage | undefined): u is EffectUsage => u !== undefined && USAGE_FIELDS.some((f) => u[f] !== undefined);
function addUsage(into: EffectUsage, u: EffectUsage): void {
  for (const f of USAGE_FIELDS) if (typeof u[f] === "number") into[f] = (into[f] ?? 0) + u[f];
}
/** A row body carrying `usage`, or without the field when nothing was reported. */
function withUsage<T extends { usage?: EffectUsage }>(body: T, usage: EffectUsage | undefined): T {
  const { usage: _, ...rest } = body;
  return (hasUsage(usage) ? { ...rest, usage: { ...usage } } : rest) as T;
}
/** Rejects with the signal's reason once it aborts: raced against an adapter call to bound it. */
const aborted = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
const messageOf = (err: unknown) => (err as { message?: string } | null)?.message ?? String(err);

export interface EffectAdapter<I = unknown, O = unknown> {
  run(input: I, ctx: { key: string; attempt: number; signal: AbortSignal; /** Add to this effect's usage. Ignored once the attempt has timed out or ended. */ reportUsage(usage: EffectUsage): void }): Promise<O>;
  /** Look up the outcome of an unacknowledged attempt; return undefined when it can't be determined. */
  reconcile?(key: string): Promise<{ delivered: true; value: O } | { delivered: false } | undefined>;
}

// ---- Typed handler surface ----

type AnySystem = System;

export interface Message<S extends AnySystem, M extends MessageName<S>> {
  id: string;
  type: M;
  version: number;
  from: string;
  to: string;
  correlationId: string;
  causationId: string | null;
  attempt: number;
  payload: PayloadOut<S, M>;
}

export interface HandlerContext<S extends AnySystem, A extends ActorName<S>> {
  /** "Actor:key" of this instance. */
  readonly self: string;
  /** The instance key (the name passed to getByName). */
  readonly key: string;
  /** Native SQLite storage. Writes are part of this handler's transaction. */
  readonly sql: SqlStorageLike;
  /** Queue a message; it is committed with this handler and delivered after commit. */
  send<M extends MessagesFrom<S, A>>(type: M, payload: PayloadIn<S, M>, options?: { to?: Receivers<S, A, M>; key?: string }): void;
  /** Queue an external effect, deduplicated by key; it runs after commit, outside the transaction. */
  effect(name: EffectsOf<S, A>, input: unknown, options: { key: string }): void;
  /** Release an effect parked for human approval; it runs after this handler commits. False if none is waiting. */
  approve(name: EffectsOf<S, A>, key: string, identity?: { by: string }): boolean;
  /** Refuse an effect parked for human approval. False if none is waiting. */
  deny(name: EffectsOf<S, A>, key: string, reason: string, identity?: { by: string }): boolean;
  /** Deliver `type` to this instance after `delay` (a Duration like "5m", or milliseconds). One timer per key: setting it again replaces it. Set only if this handler commits. */
  after<M extends TimerMessages<S, A>>(delay: Duration | number, type: M, payload: PayloadIn<S, M>, options: { key: string }): void;
  /** Deliver `type` to this instance at `when` (epoch milliseconds). Same rules as `after`. */
  at<M extends TimerMessages<S, A>>(when: number, type: M, payload: PayloadIn<S, M>, options: { key: string }): void;
  /** Cancel a pending timer. False if none is pending under that key. */
  cancelTimer(key: string): boolean;
  /**
   * Settle a job effect with the outcome its completion message reports, as part of this handler's
   * transaction (nothing changes if the handler throws). Call it from the handler of the effect's
   * `completes` message. A waiting job, or one being cancelled, settles now and its result message is
   * queued. A job whose start hasn't returned yet keeps the outcome and settles with it as soon as the start
   * attempt finishes, whatever that attempt's result. False, and nothing changes, when the job is already
   * settled (including past its deadline), already has a kept outcome, or there is no such job.
   */
  settleJob(name: EffectsOf<S, A>, key: string, outcome: { status: "confirmed"; value?: unknown } | { status: "failed"; error: string }): boolean;
  /**
   * Ask for a waiting job to be cancelled. Marked in this transaction; after commit the adapter's cancel(handle)
   * runs. A confirmed cancel settles it failed ("cancelled"); anything else is in_doubt ("cancel not confirmed").
   * False unless the job is waiting.
   */
  cancelJob(name: EffectsOf<S, A>, key: string): boolean;
  /** Record a structured note in the event log (for inspection; no behavior). */
  note(text: string, detail?: Record<string, unknown>): void;
  now(): number;
}

export type EffectsOf<S extends AnySystem, A extends ActorName<S>> = S["actors"][A] extends { effects: readonly (infer E)[] } ? Extract<E, string> : never;

export type Handlers<S extends AnySystem, A extends ActorName<S>> = {
  [M in MessagesTo<S, A>]: (message: Message<S, M>, ctx: HandlerContext<S, A>) => void | Promise<void>;
};

export interface RuntimeOptions<S extends AnySystem> {
  /** Effect adapters by effect name. Tests can override them with @actord/toolkit/testing. */
  effects?: Partial<Record<EffectName<S>, EffectAdapter | JobAdapter>>;
  /** Delivery attempts before a message is dead-lettered (default 6). */
  maxAttempts?: number;
  /** Backoff before attempt n+1 (default 1s doubling, capped at 5 minutes). */
  backoffMs?: (attempt: number) => number;
  /** Interruptions a keyed effect survives before it is parked as in_doubt instead of retried (default 5). */
  parkAfterInterruptions?: number;
  /** How long inbox rows are kept for dedupe (default 7 days). Older duplicates aren't detected. */
  inboxRetentionMs?: number;
  /** Default instance key for receivers when send() names none (default "main"). */
  defaultKey?: string;
  now?: () => number;
}

export interface ActorRuntime {
  /** The RPC entry point: expose it as a public `receive(envelope)` method on the Durable Object. */
  receive(envelope: unknown): Promise<Receipt>;
  /** @internal for @actord/toolkit/testing */
  drive(): Promise<void>;
  /** Resolve an effect parked for human approval. */
  decide(effectKey: string, decision: "approve" | "deny", reason?: string): Promise<EffectOutcome>;
  /** Pending and dead outbox rows, for tests and inspection. */
  outbox(): Array<{ id: string; kind: string; target: string; status: string; attempts: number; lastError: string | null }>;
  /** @internal for @actord/toolkit/testing: background work in flight here (effect attempts, job probes and cancels). */
  busy(): number;
}

// ---- Test seams (used only by @actord/toolkit/testing, inert otherwise) ----

export type FaultPoint = "before-handler" | "after-handler" | "deliver";
interface TestSeams {
  faults: Array<{ actor: string; type?: string; at: FaultPoint; remaining: number; error: string }>;
  effects: Record<string, EffectAdapter | JobAdapter>;
  budgets?: Record<string, { maxAttempts?: number; timeoutMs?: number }>;
  effectBudgets?: Record<string, { maxAttempts?: number; timeoutMs?: number }>;
  /** Each instance's runtime by ctx.id.toString(), so test helpers can drive it without the alarm. */
  runtimes?: Map<string, ActorRuntime>;
  /** Each instance's name by ctx.id.toString(): listDurableObjectIds returns ids without names, and a Lifecycle object can't start without one. */
  names?: Map<string, string>;
  /** While set, emit() also pushes every event here (captureEvents). */
  events?: ActorEvent[];
}
function seams(): TestSeams | undefined {
  return (globalThis as { __actorsTestSeams?: TestSeams }).__actorsTestSeams;
}
function maybeFault(actor: string, type: string | undefined, at: FaultPoint): void {
  const f = seams()?.faults.find((x) => x.actor === actor && x.at === at && (!x.type || x.type === type) && x.remaining > 0);
  if (f) {
    f.remaining--;
    throw new Error(f.error);
  }
}

// ---- Implementation ----

/** How far away the wake may be while an effect runs: the longest a lost attempt goes unnoticed. */
const HEARTBEAT_MS = 30_000;
/** How long an approval request waits for a person, unless the effect says otherwise. */
const DEFAULT_APPROVAL_EXPIRES: Duration = "3d";
const APPROVAL_EXPIRED = "approval expired";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS _actors_inbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, sender TEXT NOT NULL, handled_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS _actors_outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, seq INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS _actors_outbox_due ON _actors_outbox (status, next_at)",
  "CREATE TABLE IF NOT EXISTS _actors_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
];

/** FNV-1a (64-bit) as base36: short, deterministic ids derived from causal position. */
export function deriveId(...parts: Array<string | number>): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of parts.join("|")) {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(36).padStart(13, "0");
}

export function emit(event: Omit<ActorEvent, "$actord">): void {
  const full = { $actord: 1 as const, ...event };
  seams()?.events?.push(full as ActorEvent);
  console.log(JSON.stringify(full));
}

interface Pending {
  kind: "message" | "effect";
  id: string;
  target: string;
  body: string;
  event: Omit<ActorEvent, "$actord">;
}

export function actorRuntime<S extends AnySystem, A extends ActorName<S>>(
  host: ActorHost,
  system: S,
  actorName: A,
  handlers: Handlers<S, A>,
  options: RuntimeOptions<S> = {},
): ActorRuntime {
  const { ctx } = host;
  const env = host.env as Record<string, NamespaceLike>;
  const spec = system.actors[actorName] as ActorSpec | undefined as ActorSpec;
  const schedules = spec.schedules ?? [];
  if (!spec) throw new Error(`actord: ${actorName} is not declared in system ${system.name}`);
  const now = options.now ?? (() => Date.now());
  const maxAttempts = options.maxAttempts ?? 6;
  const parkAfterInterruptions = options.parkAfterInterruptions ?? 5;
  const backoff = options.backoffMs ?? ((n: number) => Math.min(300_000, 1_000 * 2 ** (n - 1)));
  const retention = options.inboxRetentionMs ?? 7 * 86_400_000;
  const defaultKey = options.defaultKey ?? "main";
  const effectsDeclared = new Set<string>(spec.effects ?? []);
  for (const q of [...SCHEMA, ...TIMERS_SCHEMA]) ctx.storage.sql.exec(q);
  // Rows written before interruptions were counted lack the column.
  if (!ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(_actors_outbox)").toArray().some((c) => c.name === "interruptions")) {
    ctx.storage.sql.exec("ALTER TABLE _actors_outbox ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0");
  }
  // Lifecycle runs start() once per instance, before its first fetch or alarm; receive() and drive()
  // start it themselves, since native RPC and the test helpers bypass that.
  const cap = new ActordCapability({ start, drive });
  host.lifecycle.use(cap);
  const key = ctx.id.name ?? ctx.id.toString();
  const self = `${actorName}:${key}`;
  let draining: Promise<void> | null = null;
  // Effects in flight in this instance. A row marked running that isn't here was orphaned by a restart.
  const inflight = new Map<string, Promise<void>>();
  let recovered = false;

  const sql = ctx.storage.sql;
  const meta = (k: string): string | null => sql.exec<{ v: string }>("SELECT v FROM _actors_meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  const setMeta = (k: string, v: string) => sql.exec("INSERT INTO _actors_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  const nextSeq = (): number => {
    const n = Number(meta("seq") ?? "0") + 1;
    setMeta("seq", String(n));
    return n;
  };

  function routeAllowed(fromActor: string, type: string): boolean {
    return system.routes.some((r) => r.from === fromActor && r.message === type && r.to === actorName);
  }

  function reject(env: Partial<Envelope> | null, reason: RejectReason, detail?: string): Receipt {
    emit({
      kind: "rejected",
      at: now(),
      actor: self,
      messageId: env?.id,
      type: env?.type,
      version: env?.version,
      from: env?.from,
      to: env?.to,
      correlationId: env?.correlationId,
      causationId: env?.causationId ?? null,
      reason,
      ...(detail ? { detail: { detail } } : {}),
    });
    return { status: "rejected", messageId: env?.id ?? null, reason, ...(detail ? { detail } : {}) };
  }

  /**
   * `timer` is set only by fireTimer, for a timer's delivery: the handler then runs only if that timer's row
   * is still set when its transaction starts, and the row is removed in the same transaction.
   */
  async function receive(raw: unknown, timer?: TimerRow): Promise<Receipt> {
    await cap.ready();
    await recoverOrphans();
    const e = raw as Partial<Envelope>;
    if (!e || typeof e !== "object" || e.v !== ENVELOPE_VERSION || typeof e.id !== "string" || typeof e.type !== "string" || typeof e.from !== "string" || typeof e.to !== "string" || typeof e.version !== "number") {
      return reject(e && typeof e === "object" ? e : null, "malformed", "missing or mistyped envelope fields");
    }
    if (e.to !== self) return reject(e, "wrong_recipient", `addressed to ${e.to}, delivered to ${self}`);
    const msgSpec = system.messages[e.type];
    if (!msgSpec) return reject(e, "unknown_message");
    const fromActor = e.from.startsWith("@") ? e.from : e.from.split(":")[0]!;
    if (!routeAllowed(fromActor, e.type)) return reject(e, "unauthorized_route", `no route ${fromActor} → ${e.type} → ${actorName}`);
    if (e.version !== msgSpec.version) return reject(e, "version_mismatch", `got v${e.version}, declared v${msgSpec.version}`);
    const validated = await (msgSpec.payload as StandardSchemaV1)["~standard"].validate(e.payload);
    if (validated.issues) return reject(e, "invalid_payload", validated.issues.map((i) => i.message).join("; "));
    const envelope = e as Envelope;
    if (sql.exec("SELECT 1 FROM _actors_inbox WHERE id = ?", envelope.id).toArray().length > 0) {
      emit({ kind: "duplicate", at: now(), actor: self, ...ids(envelope) });
      return { status: "duplicate", messageId: envelope.id };
    }
    await ensureSchedules();
    emit({ kind: "received", at: now(), actor: self, ...ids(envelope), detail: { payloadKeys: Object.keys((validated.value as object) ?? {}).sort() } });

    const pending: Pending[] = [];
    const notes: Array<Omit<ActorEvent, "$actord">> = [];
    // Jobs this handler asked to cancel: the adapter is asked only once the request has committed.
    const cancels: string[] = [];
    const handler = (handlers as Record<string, (m: unknown, c: unknown) => void | Promise<void>>)[envelope.type];
    let duplicate = false;
    // The timer being delivered was cancelled or replaced after it was found due: it doesn't fire.
    let timerGone = false;
    try {
      if (!handler) throw new Error(`${actorName} has no handler for ${envelope.type}`);
      await ctx.storage.transaction(async () => {
        // Another copy may have been handled while this one waited for the transaction: the check above
        // is only a fast path, and this one decides.
        if (sql.exec("SELECT 1 FROM _actors_inbox WHERE id = ?", envelope.id).toArray().length > 0) {
          duplicate = true;
          return;
        }
        // A cancel or a replacement that committed first wins. Removing the row here means a handler that
        // throws leaves it set, to be retried, and one that commits can't fire it again.
        if (timer && !consumeTimer(sql, timer)) {
          timerGone = true;
          return;
        }
        maybeFault(actorName, envelope.type, "before-handler");
        await handler({ ...envelope, payload: validated.value }, handlerContext(envelope, pending, notes, cancels));
        maybeFault(actorName, envelope.type, "after-handler");
        sql.exec("INSERT INTO _actors_inbox (id, type, sender, handled_at) VALUES (?, ?, ?, ?)", envelope.id, envelope.type, envelope.from, now());
        for (const p of pending) {
          sql.exec(
            "INSERT INTO _actors_outbox (id, kind, target, body, status, attempts, next_at, last_error, created_at, seq) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?) ON CONFLICT (id) DO NOTHING",
            p.id,
            p.kind,
            p.target,
            p.body,
            now(),
            now(),
            nextSeq(),
          );
        }
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emit({ kind: "failed", at: now(), actor: self, ...ids(envelope), reason: error });
      return { status: "failed", messageId: envelope.id, error };
    }
    if (duplicate) {
      emit({ kind: "duplicate", at: now(), actor: self, ...ids(envelope) });
      return { status: "duplicate", messageId: envelope.id };
    }
    if (timerGone) {
      // Only fireTimer passes a timer, and it reads this as "nothing to deliver": not handled, never to be.
      emit({ kind: "note", at: now(), actor: self, ...ids(envelope), reason: "timer cancelled or replaced before it fired; not delivered" });
      return { status: "duplicate", messageId: envelope.id };
    }
    emit({ kind: "handled", at: now(), actor: self, ...ids(envelope) });
    for (const n of notes) emit(n);
    for (const p of pending) emit(p.event);
    for (const id of cancels) startCancel(id);
    // A drain already running (this may be a self-delivery from inside it) picks up the new rows.
    if (!draining) await drain();
    return { status: "handled", messageId: envelope.id };
  }

  function ids(e: Envelope) {
    return { messageId: e.id, type: e.type, version: e.version, from: e.from, to: e.to, correlationId: e.correlationId, causationId: e.causationId, attempt: e.attempt };
  }

  function handlerContext(current: Envelope, pending: Pending[], notes: Array<Omit<ActorEvent, "$actord">>, cancels: string[]): HandlerContext<S, A> {
    let n = 0;
    const schedule = (dueAt: number, type: string, payload: unknown, timerKey: string) => {
      // A timer is a self-delivery from @timer, so the route @timer → type → this actor must exist.
      if (!system.routes.some((r) => r.from === "@timer" && r.message === type && r.to === actorName)) throw new Error(`${actorName} has no route @timer → ${type} → ${actorName}; declare it in system.ts`);
      setTimer(sql, { key: timerKey, type, payload: JSON.stringify(payload), due_at: dueAt, causation_id: current.id, correlation_id: current.correlationId });
      notes.push({ kind: "timer.set", at: now(), actor: self, messageId: current.id, type, correlationId: current.correlationId, detail: { key: timerKey, dueAt } });
    };
    return {
      self,
      key,
      sql,
      now,
      send(type, payload, opts) {
        const routes = system.routes.filter((r) => r.from === actorName && r.message === type);
        const to = (opts?.to as string | undefined) ?? (routes.length === 1 ? routes[0]!.to : undefined);
        if (!to || !routes.some((r) => r.to === to)) throw new Error(`${actorName} has no route for ${String(type)}${opts?.to ? ` to ${String(opts.to)}` : ""}; declare it in system.ts`);
        const targetKey = opts?.key ?? defaultKey;
        const id = deriveId(current.id, "send", n++, type as string, to, targetKey);
        const envelope: Envelope = {
          v: 1,
          id,
          type: type as string,
          version: system.messages[type as string]!.version,
          from: self,
          to: `${to}:${targetKey}`,
          correlationId: current.correlationId,
          causationId: current.id,
          attempt: 1,
          sentAt: now(),
          payload,
        };
        pending.push({ kind: "message", id, target: envelope.to, body: JSON.stringify(envelope), event: { kind: "sent", at: now(), actor: self, ...ids(envelope) } });
      },
      effect(name, input, opts) {
        const effectName = name as string;
        if (!effectsDeclared.has(effectName)) {
          emit({ kind: "effect.denied", at: now(), actor: self, effect: effectName, effectKey: opts.key, causationId: current.id, correlationId: current.correlationId, reason: "undeclared capability" });
          throw new Error(`${actorName} may not request effect ${effectName}: it isn't in its declared effects`);
        }
        const id = `fx:${effectName}:${opts.key}`;
        // An effect key names one effect for the actor's lifetime: asking again runs nothing, and says so.
        const inHandler = pending.find((p) => p.id === id);
        const stored = inHandler ? undefined : sql.exec<{ status: string; body: string }>("SELECT status, body FROM _actors_outbox WHERE id = ?", id).toArray()[0];
        if (inHandler || stored) {
          const firstCausationId = inHandler ? current.id : ((JSON.parse(stored!.body) as { causationId?: string }).causationId ?? null);
          notes.push({ kind: "effect.duplicate", at: now(), actor: self, effect: effectName, effectKey: opts.key, causationId: current.id, correlationId: current.correlationId, detail: { existingStatus: inHandler ? "pending" : stored!.status, firstCausationId } });
          return;
        }
        const body = JSON.stringify({ name: effectName, key: opts.key, input, causationId: current.id, correlationId: current.correlationId });
        pending.push({ kind: "effect", id, target: effectName, body, event: { kind: "effect.requested", at: now(), actor: self, effect: effectName, effectKey: opts.key, causationId: current.id, correlationId: current.correlationId } });
      },
      approve(name, effectKey, identity) {
        const id = `fx:${name as string}:${effectKey}`;
        const row = sql.exec<{ body: string }>("SELECT body FROM _actors_outbox WHERE id = ? AND status = 'awaiting_approval' AND next_at > ?", id, now()).toArray()[0];
        if (!row) return false;
        sql.exec("UPDATE _actors_outbox SET status = 'pending', next_at = ?, body = ? WHERE id = ?", now(), JSON.stringify({ ...JSON.parse(row.body), approved: true, approvedBy: { messageId: current.id, from: current.from, by: identity?.by ?? null } }), id);
        notes.push({ kind: "note", at: now(), actor: self, messageId: current.id, correlationId: current.correlationId, effect: name as string, effectKey, reason: "approved by a person", detail: { by: identity?.by ?? null, via: current.from } });
        return true;
      },
      deny(name, effectKey, reason, identity) {
        const id = `fx:${name as string}:${effectKey}`;
        const row = sql.exec<{ body: string }>("SELECT body FROM _actors_outbox WHERE id = ? AND status = 'awaiting_approval' AND next_at > ?", id, now()).toArray()[0];
        if (!row) return false;
        const req = JSON.parse(row.body) as { causationId: string; correlationId: string };
        sql.exec("UPDATE _actors_outbox SET status = 'denied', last_error = ? WHERE id = ?", reason, id);
        notes.push({ kind: "effect.denied", at: now(), actor: self, effect: name as string, effectKey, causationId: req.causationId, correlationId: req.correlationId, reason, detail: { by: identity?.by ?? null, via: current.from } });
        return true;
      },
      after(delay, type, payload, opts) {
        const ms = typeof delay === "number" ? delay : durationMs(delay);
        if (ms === null) throw new Error(`${actorName} set a timer with an invalid delay: ${String(delay)}`);
        schedule(now() + ms, type as string, payload, opts.key);
      },
      at(when, type, payload, opts) {
        schedule(when, type as string, payload, opts.key);
      },
      cancelTimer(timerKey) {
        if (!cancelTimer(sql, timerKey)) return false;
        notes.push({ kind: "timer.cancelled", at: now(), actor: self, messageId: current.id, correlationId: current.correlationId, detail: { key: timerKey } });
        return true;
      },
      settleJob(name, effectKey, outcome) {
        const status = (outcome as { status?: unknown } | undefined)?.status;
        if (status !== "confirmed" && status !== "failed") throw new Error(`${actorName} settled job ${name as string} with status ${String(status)}; use "confirmed" or "failed"`);
        if (system.effects?.[name as string]?.kind !== "job") return false;
        const row = jobRowAt(sql, `fx:${name as string}:${effectKey}`);
        if (!row) return false;
        // Inside the transaction: the events wait for the commit, like the handler's own.
        const defer = (e: Omit<ActorEvent, "$actord">) => void notes.push(e);
        // The completion is direct evidence the work ran, so it wins over a cancel still waiting for its answer.
        if (row.status === "awaiting_job" || row.status === "cancelling") {
          settleByMessage(row, row.body, outcome, defer);
          return true;
        }
        if (!NOT_STARTED.has(row.status) || !recordEarlyOutcome(sql, row.id, outcome)) return false;
        notes.push({ kind: "note", at: now(), actor: self, messageId: current.id, correlationId: current.correlationId, effect: row.body.name, effectKey, reason: "completion kept: the job settles with it when its start returns" });
        return true;
      },
      cancelJob(name, effectKey) {
        const id = `fx:${name as string}:${effectKey}`;
        const row = awaitingJob(sql, id);
        if (!row || !markCancelling(sql, id, now())) return false;
        notes.push({ kind: "job.cancel_requested", at: now(), actor: self, effect: row.body.name, effectKey, causationId: current.id, correlationId: current.correlationId, detail: { handle: row.body.handle } });
        cancels.push(id);
        return true;
      },
      note(text, detail) {
        notes.push({ kind: "note", at: now(), actor: self, messageId: current.id, correlationId: current.correlationId, reason: text, ...(detail ? { detail } : {}) });
      },
    };
  }

  /** One drain at a time per instance; a caller arriving mid-drain shares it (new rows are picked up). */
  function drain(): Promise<void> {
    draining ??= drainThenArm();
    return draining;
  }

  async function drainThenArm(): Promise<void> {
    try {
      await drainLoop();
    } finally {
      // Release the guard before arming, which awaits storage: a row queued meanwhile (an effect's
      // result) then starts its own drain instead of joining one that has stopped looking. The await
      // above means drain() has set the guard by now, even when the loop finds nothing to do.
      draining = null;
      await cap.arm(earliestWake());
    }
  }

  async function drainLoop(): Promise<void> {
    for (;;) {
      const due = sql
        .exec<{ id: string; kind: string; target: string; body: string; attempts: number }>(
          "SELECT id, kind, target, body, attempts FROM _actors_outbox WHERE status = 'pending' AND next_at <= ? ORDER BY seq LIMIT 1",
          now(),
        )
        .toArray()[0];
      if (!due) break;
      if (due.kind === "message") await deliverMessage(due);
      else startEffect(due);
    }
  }

  /**
   * Effects run in the background so a slow one (a model call) never holds up message delivery. next_at
   * records when the attempt started; a completed effect drains again to deliver its result message.
   */
  function startEffect(row: { id: string; target: string; body: string; attempts: number }): void {
    sql.exec("UPDATE _actors_outbox SET status = 'running', next_at = ? WHERE id = ?", now(), row.id);
    const run: Promise<void> = runEffect(row)
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        sql.exec("UPDATE _actors_outbox SET status = 'in_doubt', last_error = ? WHERE id = ? AND status = 'running'", error, row.id);
        emit({ kind: "effect.in_doubt", at: now(), actor: self, effect: row.target, reason: `effect runner failed: ${error}` });
      })
      .finally(() => {
        inflight.delete(row.id);
        drain().catch((err) => emit({ kind: "note", at: now(), actor: self, reason: `drain after effect failed: ${String(err)}` }));
      });
    inflight.set(row.id, run);
    ctx.waitUntil?.(run);
  }

  /** Once per instance: attempts left running by a previous instance are retried only when that's safe. */
  async function recoverOrphans(): Promise<void> {
    if (recovered) return;
    recovered = true;
    const orphans = sql.exec<{ id: string; target: string; body: string; attempts: number; interruptions: number }>("SELECT id, target, body, attempts, interruptions FROM _actors_outbox WHERE status = 'running'").toArray();
    for (const row of orphans) {
      if (inflight.has(row.id)) continue;
      const req = JSON.parse(row.body) as { name: string; key: string; causationId: string; correlationId: string };
      const fx = system.effects?.[req.name];
      const reason = "interrupted: the actor restarted while the attempt was in flight";
      const kept = fx?.kind === "job" ? earlyOutcome(sql, row.id) : undefined;
      if (kept && fx?.idempotency !== "key") {
        // The start's own outcome is unknown, but the job's completion already arrived: that settles it.
        settleByMessage({ id: row.id, attempts: row.attempts + 1 }, JSON.parse(row.body) as JobBody, kept);
      } else if (kept && row.interruptions + 1 >= parkAfterInterruptions) {
        // About to be parked, but the job's completion is known: that outcome wins over a start in doubt.
        settleByMessage({ id: row.id, attempts: row.attempts + 1 }, JSON.parse(row.body) as JobBody, kept);
      } else if (fx?.idempotency === "key" && row.interruptions + 1 >= parkAfterInterruptions) {
        // Interrupted again and again without ever settling: stop retrying, and say so honestly.
        const parked = `parked: interrupted ${row.interruptions + 1} times without settling`;
        sql.exec("UPDATE _actors_outbox SET status = 'in_doubt', attempts = ?, interruptions = ?, last_error = ? WHERE id = ?", row.attempts + 1, row.interruptions + 1, parked, row.id);
        emit({ kind: "effect.parked", at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, reason: parked });
        emit({ kind: "effect.in_doubt", at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, reason: parked });
        if (fx.result) enqueueResult(fx.result, row.id, req, { key: req.key, status: "in_doubt", error: parked });
      } else if (fx?.idempotency === "key") {
        sql.exec("UPDATE _actors_outbox SET status = 'pending', attempts = ?, interruptions = ?, next_at = ?, last_error = ? WHERE id = ?", row.attempts + 1, row.interruptions + 1, now(), reason, row.id);
        emit({ kind: "retry.scheduled", at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, attempt: row.attempts + 2, reason });
      } else {
        sql.exec("UPDATE _actors_outbox SET status = 'in_doubt', attempts = ?, last_error = ? WHERE id = ?", row.attempts + 1, reason, row.id);
        emit({ kind: "effect.in_doubt", at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, reason });
        if (fx?.result) enqueueResult(fx.result, row.id, req, { key: req.key, status: "in_doubt", error: reason });
      }
    }
    // A waiting job has nothing in flight, so it isn't an orphan. A cancel that was in flight is asked
    // again: the job is still marked cancelling, and only the adapter's answer settles it.
    for (const id of cancellingJobs(sql)) startCancel(id);
    if (orphans.length > 0) await cap.arm(earliestWake());
  }

  function retryOrExhaust(row: { id: string; attempts: number }, error: string, event: Omit<ActorEvent, "$actord" | "kind" | "at" | "actor">, overloaded = false, limit = maxAttempts): void {
    const attempts = row.attempts + 1;
    if (attempts >= limit) {
      sql.exec("UPDATE _actors_outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?", attempts, error, row.id);
      emit({ kind: "retry.exhausted", at: now(), actor: self, ...event, attempt: attempts, reason: error });
    } else {
      const delay = backoff(attempts) * (overloaded ? 4 : 1);
      sql.exec("UPDATE _actors_outbox SET status = 'pending', attempts = ?, next_at = ?, last_error = ? WHERE id = ?", attempts, now() + delay, error, row.id);
      emit({ kind: "retry.scheduled", at: now(), actor: self, ...event, attempt: attempts + 1, reason: error, detail: { delayMs: delay } });
    }
  }

  async function deliverMessage(row: { id: string; target: string; body: string; attempts: number }): Promise<void> {
    const envelope = { ...(JSON.parse(row.body) as Envelope), attempt: row.attempts + 1 };
    const [targetActor, targetKey] = [envelope.to.slice(0, envelope.to.indexOf(":")), envelope.to.slice(envelope.to.indexOf(":") + 1)];
    const binding = system.actors[targetActor]?.binding;
    const event = ids(envelope);
    let receipt: Receipt;
    try {
      maybeFault(actorName, envelope.type, "deliver");
      const ns = binding ? env[binding] : undefined;
      if (!ns) throw new Error(`no binding ${binding} for ${targetActor} in env`);
      receipt = targetActor === actorName && targetKey === key ? await receive(envelope) : await ns.getByName(targetKey).receive(envelope);
    } catch (err) {
      const e = err as { message?: string; overloaded?: boolean };
      retryOrExhaust(row, e.message ?? String(err), event, e.overloaded === true);
      return;
    }
    if (receipt.status === "handled" || receipt.status === "duplicate") {
      sql.exec("UPDATE _actors_outbox SET status = 'delivered', attempts = ? WHERE id = ?", row.attempts + 1, row.id);
      emit({ kind: "delivered", at: now(), actor: self, ...event, detail: { receipt: receipt.status } });
    } else if (receipt.status === "rejected") {
      sql.exec("UPDATE _actors_outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?", row.attempts + 1, receipt.reason, row.id);
      emit({ kind: "undeliverable", at: now(), actor: self, ...event, reason: receipt.reason });
    } else {
      retryOrExhaust(row, receipt.error, event);
    }
  }

  /** An effect's bounds, narrowest first: the test override for the effect, the effect, the test override for the actor, the actor, the defaults. */
  function resolveBudget(effect: string): { timeoutMs: number; maxAttempts: number } {
    const layers = [seams()?.effectBudgets?.[effect], system.effects?.[effect]?.budget, seams()?.budgets?.[actorName], spec.budget];
    return {
      timeoutMs: layers.find((l) => l?.timeoutMs !== undefined)?.timeoutMs ?? 30_000,
      maxAttempts: layers.find((l) => l?.maxAttempts !== undefined)?.maxAttempts ?? maxAttempts,
    };
  }

  const adapterFor = (name: string): EffectAdapter | JobAdapter | undefined => seams()?.effects[name] ?? (options.effects as Record<string, EffectAdapter | JobAdapter> | undefined)?.[name];

  /**
   * Record an effect's outcome on its row and queue its result message ({ key, status, value | error, usage? }).
   * Every outcome takes this path: a call's attempt, and each way a job settles. `out` defers the events when
   * the caller is inside a handler's transaction.
   */
  function finishEffect(
    row: { id: string; attempts: number },
    req: JobBody,
    status: "confirmed" | "failed" | "in_doubt",
    value: unknown,
    error: string | null,
    extra: { settledBy?: SettledBy; cancelError?: string } = {},
    out: (e: Omit<ActorEvent, "$actord">) => void = emit,
  ): void {
    const usage = hasUsage(req.usage) ? { usage: { ...req.usage } } : {};
    sql.exec("UPDATE _actors_outbox SET status = ?, attempts = ?, last_error = ?, body = ? WHERE id = ?", status, row.attempts, error, JSON.stringify({ ...withUsage(req, req.usage), ...extra, outcome: value }), row.id);
    const detail = { ...extra, ...usage };
    out({ kind: `effect.${status}`, at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, attempt: row.attempts, ...(error ? { reason: error } : {}), ...(Object.keys(detail).length > 0 ? { detail } : {}) });
    const result = system.effects?.[req.name]?.result;
    if (result) enqueueResult(result, row.id, req, { key: req.key, status, ...(status === "confirmed" ? { value } : { error: error ?? "" }), ...usage }, out);
  }

  /** Settle a job with the outcome its completion message reported. */
  function settleByMessage(row: { id: string; attempts: number }, req: JobBody, outcome: CompletionOutcome, out: (e: Omit<ActorEvent, "$actord">) => void = emit): void {
    if (outcome.status === "confirmed") finishEffect(row, req, "confirmed", outcome.value, null, { settledBy: "message" }, out);
    else finishEffect(row, req, "failed", null, outcome.error, { settledBy: "message" }, out);
  }

  async function runEffect(row: { id: string; target: string; body: string; attempts: number }): Promise<void> {
    const req = JSON.parse(row.body) as JobBody & { approved?: boolean };
    const fx = system.effects?.[req.name];
    const base = { effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId };
    if (fx?.approval === "human" && !req.approved) {
      const expiresMs = durationMs(fx.expires ?? DEFAULT_APPROVAL_EXPIRES) ?? durationMs(DEFAULT_APPROVAL_EXPIRES)!;
      sql.exec("UPDATE _actors_outbox SET status = 'awaiting_approval', next_at = ? WHERE id = ?", now() + expiresMs, row.id);
      emit({ kind: "effect.awaiting_approval", at: now(), actor: self, ...base });
      return;
    }
    const adapter = adapterFor(req.name);
    const job = fx?.kind === "job";
    const attempt = row.attempts + 1;
    // Usage accumulates on the row body so it survives retries; reports after the attempt ends are dropped.
    const usage: EffectUsage = { ...req.usage };
    let attemptOpen = true;
    const reportUsage = (u: EffectUsage) => {
      if (attemptOpen) addUsage(usage, u);
    };
    // A job's completion message may arrive while this attempt runs; it is kept on the row, so read it fresh.
    const kept = () => (job ? earlyOutcome(sql, row.id) : undefined);
    const finish = (status: "confirmed" | "failed" | "in_doubt", value: unknown, error: string | null) => {
      attemptOpen = false;
      const outcome = kept();
      // A kept completion is direct evidence the work ran: it wins over the start's own failure or doubt.
      if (outcome) settleByMessage({ id: row.id, attempts: attempt }, { ...req, usage, earlyOutcome: outcome }, outcome);
      else finishEffect({ id: row.id, attempts: attempt }, { ...req, usage }, status, value, error);
    };
    if (!adapter) {
      finish("failed", null, `no adapter registered for effect ${req.name}`);
      return;
    }
    // A call's attempt is run(); a job's is start(), which only begins the work and answers with a handle.
    const begin = job ? (adapter as JobAdapter).start : (adapter as EffectAdapter).run;
    if (typeof begin !== "function") {
      finish("failed", null, `the adapter for ${req.name} has no ${job ? "start" : "run"}()`);
      return;
    }
    const timing = job ? jobTiming(fx!) : null;
    if (timing && timing.deadlineMs === null) {
      // A job that can't time out could wait forever; `actord check` reports this as JOB_DEADLINE_MISSING.
      finish("failed", null, `job effect ${req.name} declares no valid deadline`);
      return;
    }
    const { timeoutMs, maxAttempts: budgetAttempts } = resolveBudget(req.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`effect timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const value = await Promise.race([begin.call(adapter, req.input, { key: req.key, attempt, signal: controller.signal, reportUsage }), aborted(controller.signal)]);
      if (timing) {
        attemptOpen = false;
        jobStarted(row.id, attempt, { ...req, usage, earlyOutcome: kept() }, value, timing.deadlineMs!, timing.everyMs);
      } else finish("confirmed", value, null);
    } catch (err) {
      const e = err as { message?: string; notDelivered?: boolean; rejected?: boolean };
      const error = e.message ?? String(err);
      if (e.rejected) finish("failed", null, error);
      else if (e.notDelivered || fx?.idempotency === "key") {
        if (attempt >= budgetAttempts) {
          // Retries exhausted. Without proof the request never arrived, the outcome is unknown.
          if (e.notDelivered) finish("failed", null, error);
          else finish("in_doubt", null, error);
        } else {
          attemptOpen = false;
          if (hasUsage(usage)) sql.exec("UPDATE _actors_outbox SET body = ? WHERE id = ?", JSON.stringify({ ...withUsage(req, usage), earlyOutcome: kept() }), row.id);
          retryOrExhaust(row, error, base, false, budgetAttempts);
        }
      } else if (!job && fx?.reconcile && (adapter as EffectAdapter).reconcile) {
        const r = await (adapter as EffectAdapter).reconcile!(req.key).catch(() => undefined);
        if (r?.delivered) finish("confirmed", r.value, null);
        else if (r && !r.delivered) finish("failed", null, error);
        else finish("in_doubt", null, error);
      } else {
        finish("in_doubt", null, error);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * running → awaiting_job: store the handle and the deadline, and book the first look (a probe or the
   * deadline). A completion kept while the start ran settles the job at once instead, with no look.
   */
  function jobStarted(id: string, attempts: number, req: JobBody, handle: unknown, deadlineMs: number, everyMs: number | null): void {
    const deadlineAt = now() + deadlineMs;
    const nextAt = nextLookAt(now(), everyMs, deadlineAt);
    const started = (detail: Record<string, unknown>) =>
      emit({ kind: "job.started", at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, attempt: attempts, detail: { handle, ...detail } });
    if (req.earlyOutcome) {
      started({});
      settleByMessage({ id, attempts }, { ...req, handle }, req.earlyOutcome);
      return;
    }
    if (!awaitJob(sql, id, attempts, { ...withUsage(req, req.usage), handle, deadlineAt }, nextAt)) return;
    started({ deadlineAt, nextAt });
  }

  /**
   * Look at a waiting job in the background, like an effect attempt, bounded by the effect's timeout. The
   * next look is booked first: a probe lost with the instance is simply tried again then, and a look that
   * comes due while a probe still runs waits a period instead of holding the wake in the past.
   */
  function startProbe(job: JobRow): void {
    const { everyMs } = jobTiming(system.effects?.[job.body.name] ?? {});
    const deadlineAt = job.body.deadlineAt ?? now();
    rescheduleJob(sql, job.id, nextLookAt(now(), everyMs, deadlineAt), job.body);
    // A probe is keyed apart from the row's id, which a cancel requested meanwhile uses: the cancel must still start.
    const probeKey = `probe:${job.id}`;
    if (everyMs === null || inflight.has(probeKey)) return; // no probe declared (the next look is the deadline), or one is running
    const adapter = adapterFor(job.body.name) as JobAdapter | undefined;
    const { timeoutMs } = resolveBudget(job.body.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
    const usage: EffectUsage = {};
    let open = true;
    const reportUsage = (u: EffectUsage) => {
      if (open) addUsage(usage, u);
    };
    const run: Promise<void> = (async () => {
      let result: JobProbe | null = null;
      let error: string | null = null;
      try {
        if (typeof adapter?.probe !== "function") throw new Error(`the adapter for ${job.body.name} has no probe()`);
        result = await Promise.race([adapter.probe(job.body.handle, { key: job.body.key, signal: controller.signal, reportUsage }), aborted(controller.signal)]);
      } catch (err) {
        error = messageOf(err);
      } finally {
        open = false;
        clearTimeout(timer);
      }
      probed(job.id, result, error, usage);
    })()
      .catch((err) => emit({ kind: "note", at: now(), actor: self, effect: job.body.name, effectKey: job.body.key, reason: `probe runner failed: ${messageOf(err)}` }))
      .finally(() => {
        inflight.delete(probeKey);
        drain().catch((err) => emit({ kind: "note", at: now(), actor: self, reason: `drain after probe failed: ${String(err)}` }));
      });
    inflight.set(probeKey, run);
    ctx.waitUntil?.(run);
  }

  /** A probe's answer. Done settles the job; anything else books the next look. Moot if the job settled meanwhile. */
  function probed(id: string, result: JobProbe | null, error: string | null, reported: EffectUsage): void {
    const row = awaitingJob(sql, id);
    if (!row) return;
    const usage: EffectUsage = { ...row.body.usage };
    addUsage(usage, reported);
    const req = { ...row.body, usage };
    if (result?.done && result.status === "confirmed") return finishEffect(row, req, "confirmed", result.value, null, { settledBy: "probe" });
    if (result?.done && result.status === "failed") return finishEffect(row, req, "failed", null, result.error ?? "", { settledBy: "probe" });
    const why = error ?? (result?.done ? `probe returned an unknown status: ${String((result as { status?: unknown }).status)}` : null);
    const { everyMs } = jobTiming(system.effects?.[row.body.name] ?? {});
    const nextAt = nextLookAt(now(), everyMs, row.body.deadlineAt ?? now());
    rescheduleJob(sql, id, nextAt, withUsage(row.body, usage));
    emit({ kind: "job.probed", at: now(), actor: self, effect: row.body.name, effectKey: row.body.key, causationId: row.body.causationId, correlationId: row.body.correlationId, ...(why ? { reason: why } : {}), detail: { done: false, nextAt } });
  }

  /**
   * Ask the adapter to cancel a job marked cancelling, in the background, bounded by the effect's timeout.
   * Only a confirmed cancel fails the job; false, a throw, a timeout or no cancel() leaves it in doubt.
   */
  function startCancel(id: string): void {
    if (inflight.has(id)) return;
    const row = cancellingJob(sql, id);
    if (!row) return;
    const adapter = adapterFor(row.body.name) as JobAdapter | undefined;
    const { timeoutMs } = resolveBudget(row.body.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`cancel timed out after ${timeoutMs}ms`)), timeoutMs);
    const run: Promise<void> = (async () => {
      let confirmed = false;
      let error: string | null = null;
      try {
        if (typeof adapter?.cancel !== "function") throw new Error(`the adapter for ${row.body.name} has no cancel()`);
        confirmed = (await Promise.race([adapter.cancel(row.body.handle, { key: row.body.key, signal: controller.signal }), aborted(controller.signal)])) === true;
      } catch (err) {
        error = messageOf(err);
      } finally {
        clearTimeout(timer);
      }
      const current = cancellingJob(sql, id);
      if (!current) return;
      if (confirmed) finishEffect(current, current.body, "failed", null, "cancelled", { settledBy: "cancel" });
      else finishEffect(current, current.body, "in_doubt", null, "cancel not confirmed", { settledBy: "cancel", ...(error ? { cancelError: error } : {}) });
    })()
      .catch((err) => emit({ kind: "note", at: now(), actor: self, effect: row.body.name, effectKey: row.body.key, reason: `cancel runner failed: ${messageOf(err)}` }))
      .finally(() => {
        inflight.delete(id);
        drain().catch((err) => emit({ kind: "note", at: now(), actor: self, reason: `drain after cancel failed: ${String(err)}` }));
      });
    inflight.set(id, run);
    ctx.waitUntil?.(run);
  }

  /** Deliver an effect's outcome back to this actor as its declared result message (a self-route). */
  function enqueueResult(type: string, effectRowId: string, req: { causationId: string; correlationId: string }, payload: Record<string, unknown>, out: (e: Omit<ActorEvent, "$actord">) => void = emit): void {
    const id = deriveId(effectRowId, "result");
    const envelope: Envelope = {
      v: 1,
      id,
      type,
      version: system.messages[type]?.version ?? 1,
      from: self,
      to: self,
      correlationId: req.correlationId,
      causationId: req.causationId,
      attempt: 1,
      sentAt: now(),
      payload,
    };
    sql.exec(
      "INSERT INTO _actors_outbox (id, kind, target, body, status, attempts, next_at, last_error, created_at, seq) VALUES (?, 'message', ?, ?, 'pending', 0, ?, NULL, ?, ?) ON CONFLICT (id) DO NOTHING",
      id,
      self,
      JSON.stringify(envelope),
      now(),
      now(),
      nextSeq(),
    );
    const [, effect, ...rest] = effectRowId.split(":");
    out({ kind: "sent", at: now(), actor: self, ...ids(envelope), effect, effectKey: rest.join(":"), detail: { effectResult: true } });
  }

  /** The meta key of each schedule this actor declares today; any other `schedule.next` key is a leftover. */
  const scheduleKeys = (): string[] => schedules.map((sc) => scheduleKey(sc.message));

  /** Start every declared schedule that has no due time yet, and drop due times for schedules no longer declared. */
  async function ensureSchedules(): Promise<void> {
    const delMeta = (k: string) => sql.exec("DELETE FROM _actors_meta WHERE k = ?", k);
    migrateLegacy(meta, setMeta, schedules, delMeta);
    const live = new Set(scheduleKeys());
    for (const { k } of sql.exec<{ k: string }>("SELECT k FROM _actors_meta WHERE k LIKE 'schedule.next:%'").toArray()) if (!live.has(k)) delMeta(k);
    let started = false;
    for (const sc of schedules) {
      if (meta(scheduleKey(sc.message)) !== null) continue;
      setMeta(scheduleKey(sc.message), String(nextDue(sc, now())));
      started = true;
    }
    if (started) await cap.arm(earliestWake());
  }

  /** The one place every source of a wake meets: the earliest time actord must run, or null for never. */
  function earliestWake(): number | null {
    const candidates: number[] = [];
    // A parked approval's next_at is when it expires.
    const next = sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM _actors_outbox WHERE status IN ('pending', 'awaiting_approval')").toArray()[0]?.t;
    if (next !== null && next !== undefined) candidates.push(next);
    // Only declared schedules count: a removed schedule's leftover due time must not hold the alarm.
    for (const key of scheduleKeys()) {
      const due = meta(key);
      if (due !== null) candidates.push(Number(due));
    }
    const timer = earliestTimer(sql);
    if (timer !== null) candidates.push(timer);
    // While an attempt runs (or a cancel is in flight) keep a wake near, so a lost instance is noticed.
    if (sql.exec("SELECT 1 FROM _actors_outbox WHERE status IN ('running', 'cancelling') LIMIT 1").toArray().length > 0) candidates.push(now() + HEARTBEAT_MS);
    // A waiting job's next look: its next probe, or its deadline.
    const job = earliestJob(sql);
    if (job !== null) candidates.push(job);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  async function start(): Promise<void> {
    await recoverOrphans();
    await ensureSchedules();
    await cap.arm(earliestWake());
  }

  /** What the actord job runs: each due schedule's tick, due timers, due job probes and deadlines, inbox retention, then the outbox. */
  async function drive(): Promise<void> {
    await cap.ready();
    await recoverOrphans();
    for (const sc of schedules) {
      const dueMeta = meta(scheduleKey(sc.message));
      if (dueMeta === null || Number(dueMeta) > now()) continue;
      const due = Number(dueMeta);
      // Missed periods aren't replayed: one tick, then the next due time is counted from now.
      setMeta(scheduleKey(sc.message), String(nextDue(sc, now())));
      const id = deriveId(self, "tick", sc.message, due);
      emit({ kind: "scheduled", at: now(), actor: self, messageId: id, type: sc.message, detail: sc.cron !== undefined ? { cron: sc.cron } : { every: sc.every } });
      await receive({
        v: 1,
        id,
        type: sc.message,
        version: system.messages[sc.message]!.version,
        from: "@clock",
        to: self,
        correlationId: id,
        causationId: null,
        attempt: 1,
        sentAt: now(),
        payload: { at: due },
      });
    }
    for (const t of dueTimers(sql, now())) await fireTimer(t);
    for (const job of dueJobs(sql, now())) {
      if ((job.body.deadlineAt ?? 0) <= now()) finishEffect(job, job.body, "in_doubt", null, "deadline passed", { settledBy: "deadline" });
      else startProbe(job);
    }
    expireApprovals();
    sql.exec("DELETE FROM _actors_inbox WHERE handled_at < ?", now() - retention);
    await drain();
  }

  /** An approval nobody answered in time is a denial: the effect never runs, and the actor hears it failed. A kept job completion doesn't change that. */
  function expireApprovals(): void {
    const due = sql.exec<{ id: string; attempts: number; body: string }>("SELECT id, attempts, body FROM _actors_outbox WHERE status = 'awaiting_approval' AND next_at <= ?", now()).toArray();
    for (const row of due) {
      const req = JSON.parse(row.body) as JobBody;
      sql.exec("UPDATE _actors_outbox SET status = 'denied', last_error = ? WHERE id = ?", APPROVAL_EXPIRED, row.id);
      emit({ kind: "effect.denied", at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, reason: APPROVAL_EXPIRED });
      const result = system.effects?.[req.name]?.result;
      if (result) enqueueResult(result, row.id, req, { key: req.key, status: "failed", error: APPROVAL_EXPIRED });
    }
  }

  /**
   * Deliver one due timer to this instance, if it is still set: an earlier timer's handler, or a message
   * handled meanwhile, may have cancelled or replaced it. The id is derived from the key and due time, so a
   * redelivery is a duplicate.
   */
  async function fireTimer(t: TimerRow): Promise<void> {
    if (!timerSet(sql, t)) return;
    const id = deriveId(self, "timer", t.key, t.due_at);
    const envelope: Envelope = {
      v: 1,
      id,
      type: t.type,
      version: system.messages[t.type]?.version ?? 1,
      from: "@timer",
      to: self,
      correlationId: t.correlation_id,
      causationId: t.causation_id,
      attempt: t.attempts + 1,
      sentAt: now(),
      payload: JSON.parse(t.payload),
    };
    const event = ids(envelope);
    emit({ kind: "timer.fired", at: now(), actor: self, ...event, detail: { key: t.key, dueAt: t.due_at } });
    // A handled delivery removed the row in its own transaction. Every other outcome left it set, and only
    // this timer's row is touched: the key may have been set again meanwhile, and that new timer must survive.
    const receipt = await receive(envelope, t);
    if (receipt.status === "failed") {
      const attempts = t.attempts + 1;
      if (attempts >= maxAttempts) {
        consumeTimer(sql, t);
        emit({ kind: "retry.exhausted", at: now(), actor: self, ...event, attempt: attempts, reason: receipt.error });
      } else {
        const delay = backoff(attempts);
        retryTimer(sql, t, attempts, now() + delay);
        emit({ kind: "retry.scheduled", at: now(), actor: self, ...event, attempt: attempts + 1, reason: receipt.error, detail: { delayMs: delay } });
      }
      return;
    }
    // Refused, or already handled: this row will never be delivered.
    consumeTimer(sql, t);
    if (receipt.status === "rejected") emit({ kind: "undeliverable", at: now(), actor: self, ...event, reason: receipt.reason });
  }

  const runtime: ActorRuntime = {
    receive: (envelope) => receive(envelope),
    drive,
    async decide(effectKey, decision, reason) {
      await cap.ready();
      await recoverOrphans();
      // A request past its expiry time is expired even if the alarm hasn't yet processed it.
      const row = sql.exec<{ id: string; body: string; attempts: number; target: string }>("SELECT id, body, attempts, target FROM _actors_outbox WHERE id LIKE ? AND status = 'awaiting_approval' AND next_at > ?", `fx:%:${effectKey}`, now()).toArray()[0];
      if (!row && sql.exec("SELECT 1 FROM _actors_outbox WHERE id LIKE ? AND status = 'awaiting_approval'", `fx:%:${effectKey}`).toArray().length > 0) {
        expireApprovals();
        await drain();
        return { status: "denied", key: effectKey, error: APPROVAL_EXPIRED };
      }
      if (!row) return { status: "denied", key: effectKey, error: "no effect awaiting approval with that key" };
      const req = JSON.parse(row.body) as { name: string; causationId: string; correlationId: string };
      if (decision === "deny") {
        sql.exec("UPDATE _actors_outbox SET status = 'denied', last_error = ? WHERE id = ?", reason ?? "denied by a person", row.id);
        emit({ kind: "effect.denied", at: now(), actor: self, effect: req.name, effectKey, causationId: req.causationId, correlationId: req.correlationId, reason: reason ?? "denied by a person", detail: { by: null, via: "@rpc" } });
        return { status: "denied", key: effectKey, error: reason ?? "denied by a person" };
      }
      sql.exec("UPDATE _actors_outbox SET status = 'pending', body = ?, next_at = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.body), approved: true, approvedBy: { messageId: null, from: "@rpc", by: null } }), now(), row.id);
      emit({ kind: "note", at: now(), actor: self, correlationId: req.correlationId, effect: req.name, effectKey, reason: "approved by a person", detail: { by: null, via: "@rpc" } });
      await drain();
      await inflight.get(row.id);
      const done = sql.exec<{ status: string; body: string; last_error: string | null }>("SELECT status, body, last_error FROM _actors_outbox WHERE id = ?", row.id).toArray()[0]!;
      const outcome = (JSON.parse(done.body) as { outcome?: unknown }).outcome;
      if (done.status === "confirmed") return { status: "confirmed", key: effectKey, value: outcome };
      if (done.status === "in_doubt") return { status: "in_doubt", key: effectKey, error: done.last_error ?? "unknown" };
      if (["pending", "running", "awaiting_job", "cancelling"].includes(done.status)) return { status: "in_doubt", key: effectKey, error: `not settled yet: ${done.last_error ?? (done.status === "awaiting_job" ? "the job is running" : "in flight")}` };
      return { status: "failed", key: effectKey, error: done.last_error ?? "failed" };
    },
    outbox() {
      return sql
        .exec<{ id: string; kind: string; target: string; status: string; attempts: number; last_error: string | null }>("SELECT id, kind, target, status, attempts, last_error FROM _actors_outbox ORDER BY seq")
        .toArray()
        .map((r) => ({ id: r.id, kind: r.kind, target: r.target, status: r.status, attempts: r.attempts, lastError: r.last_error }));
    },
    busy: () => inflight.size,
  };
  seams()?.runtimes?.set(ctx.id.toString(), runtime);
  if (ctx.id.name !== undefined) seams()?.names?.set(ctx.id.toString(), ctx.id.name);
  return runtime;
}

/**
 * Send a message into the system from the Worker's own code (route sender "@ingress"). Returns the
 * receiver's receipt; the caller decides whether to retry (same id → deduplicated).
 */
export async function ingress<S extends AnySystem, A extends ActorName<S>, M extends IngressMessages<S, A>>(
  env: unknown,
  system: S,
  to: A,
  type: M,
  payload: PayloadIn<S, M>,
  options: { key?: string; id?: string } = {},
): Promise<Receipt> {
  const spec = system.actors[to];
  if (!spec) throw new Error(`actord: ${to} is not declared`);
  const ns = (env as Record<string, NamespaceLike>)[spec.binding];
  if (!ns) throw new Error(`actord: no binding ${spec.binding} in env`);
  const key = options.key ?? "main";
  const id = options.id ?? crypto.randomUUID();
  return ns.getByName(key).receive({
    v: 1,
    id,
    type,
    version: system.messages[type]!.version,
    from: "@ingress",
    to: `${to}:${key}`,
    correlationId: id,
    causationId: null,
    attempt: 1,
    sentAt: Date.now(),
    payload,
  });
}
