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
import { TIMERS_SCHEMA, type TimerRow, cancelTimer, dueTimers, earliestTimer, setTimer } from "./timers.ts";
import type { Lifecycle } from "agents/lifecycle";
import { ActordCapability } from "./capability.ts";

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
  | "effect.confirmed"
  | "effect.failed"
  | "effect.in_doubt"
  | "effect.denied"
  | "effect.awaiting_approval"
  | "scheduled"
  | "timer.set"
  | "timer.cancelled"
  | "timer.fired"
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
export const NOTABLE_KINDS: readonly EventKind[] = ["rejected", "failed", "retry.exhausted", "undeliverable", "effect.in_doubt", "effect.denied", "effect.failed"];

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

export interface EffectAdapter<I = unknown, O = unknown> {
  run(input: I, ctx: { key: string; attempt: number; signal: AbortSignal }): Promise<O>;
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
  approve(name: EffectsOf<S, A>, key: string): boolean;
  /** Refuse an effect parked for human approval. False if none is waiting. */
  deny(name: EffectsOf<S, A>, key: string, reason: string): boolean;
  /** Deliver `type` to this instance after `delay` (a Duration like "5m", or milliseconds). One timer per key: setting it again replaces it. Set only if this handler commits. */
  after<M extends TimerMessages<S, A>>(delay: Duration | number, type: M, payload: PayloadIn<S, M>, options: { key: string }): void;
  /** Deliver `type` to this instance at `when` (epoch milliseconds). Same rules as `after`. */
  at<M extends TimerMessages<S, A>>(when: number, type: M, payload: PayloadIn<S, M>, options: { key: string }): void;
  /** Cancel a pending timer. False if none is pending under that key. */
  cancelTimer(key: string): boolean;
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
  effects?: Partial<Record<EffectName<S>, EffectAdapter>>;
  /** Delivery attempts before a message is dead-lettered (default 6). */
  maxAttempts?: number;
  /** Backoff before attempt n+1 (default 1s doubling, capped at 5 minutes). */
  backoffMs?: (attempt: number) => number;
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
}

// ---- Test seams (used only by @actord/toolkit/testing, inert otherwise) ----

export type FaultPoint = "before-handler" | "after-handler" | "deliver";
interface TestSeams {
  faults: Array<{ actor: string; type?: string; at: FaultPoint; remaining: number; error: string }>;
  effects: Record<string, EffectAdapter>;
  budgets?: Record<string, { maxAttempts?: number; timeoutMs?: number }>;
  /** Each instance's runtime by ctx.id.toString(), so test helpers can drive it without the alarm. */
  runtimes?: Map<string, ActorRuntime>;
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
  console.log(JSON.stringify({ $actord: 1, ...event }));
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
  if (!spec) throw new Error(`actord: ${actorName} is not declared in system ${system.name}`);
  const now = options.now ?? (() => Date.now());
  const maxAttempts = options.maxAttempts ?? 6;
  const backoff = options.backoffMs ?? ((n: number) => Math.min(300_000, 1_000 * 2 ** (n - 1)));
  const retention = options.inboxRetentionMs ?? 7 * 86_400_000;
  const defaultKey = options.defaultKey ?? "main";
  const effectsDeclared = new Set<string>(spec.effects ?? []);
  for (const q of [...SCHEMA, ...TIMERS_SCHEMA]) ctx.storage.sql.exec(q);
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

  async function receive(raw: unknown): Promise<Receipt> {
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
    await ensureSchedule();
    emit({ kind: "received", at: now(), actor: self, ...ids(envelope), detail: { payloadKeys: Object.keys((validated.value as object) ?? {}).sort() } });

    const pending: Pending[] = [];
    const notes: Array<Omit<ActorEvent, "$actord">> = [];
    const handler = (handlers as Record<string, (m: unknown, c: unknown) => void | Promise<void>>)[envelope.type];
    let duplicate = false;
    try {
      if (!handler) throw new Error(`${actorName} has no handler for ${envelope.type}`);
      await ctx.storage.transaction(async () => {
        // Another copy may have been handled while this one waited for the transaction: the check above
        // is only a fast path, and this one decides.
        if (sql.exec("SELECT 1 FROM _actors_inbox WHERE id = ?", envelope.id).toArray().length > 0) {
          duplicate = true;
          return;
        }
        maybeFault(actorName, envelope.type, "before-handler");
        await handler({ ...envelope, payload: validated.value }, handlerContext(envelope, pending, notes));
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
    emit({ kind: "handled", at: now(), actor: self, ...ids(envelope) });
    for (const n of notes) emit(n);
    for (const p of pending) emit(p.event);
    // A drain already running (this may be a self-delivery from inside it) picks up the new rows.
    if (!draining) await drain();
    return { status: "handled", messageId: envelope.id };
  }

  function ids(e: Envelope) {
    return { messageId: e.id, type: e.type, version: e.version, from: e.from, to: e.to, correlationId: e.correlationId, causationId: e.causationId, attempt: e.attempt };
  }

  function handlerContext(current: Envelope, pending: Pending[], notes: Array<Omit<ActorEvent, "$actord">>): HandlerContext<S, A> {
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
        const body = JSON.stringify({ name: effectName, key: opts.key, input, causationId: current.id, correlationId: current.correlationId });
        pending.push({ kind: "effect", id, target: effectName, body, event: { kind: "effect.requested", at: now(), actor: self, effect: effectName, effectKey: opts.key, causationId: current.id, correlationId: current.correlationId } });
      },
      approve(name, effectKey) {
        const id = `fx:${name as string}:${effectKey}`;
        const row = sql.exec<{ body: string }>("SELECT body FROM _actors_outbox WHERE id = ? AND status = 'awaiting_approval'", id).toArray()[0];
        if (!row) return false;
        sql.exec("UPDATE _actors_outbox SET status = 'pending', next_at = ?, body = ? WHERE id = ?", now(), JSON.stringify({ ...JSON.parse(row.body), approved: true, approvedBy: current.id }), id);
        notes.push({ kind: "note", at: now(), actor: self, messageId: current.id, correlationId: current.correlationId, effect: name as string, effectKey, reason: "approved by a person" });
        return true;
      },
      deny(name, effectKey, reason) {
        const id = `fx:${name as string}:${effectKey}`;
        const row = sql.exec<{ body: string }>("SELECT body FROM _actors_outbox WHERE id = ? AND status = 'awaiting_approval'", id).toArray()[0];
        if (!row) return false;
        const req = JSON.parse(row.body) as { causationId: string; correlationId: string };
        sql.exec("UPDATE _actors_outbox SET status = 'denied', last_error = ? WHERE id = ?", reason, id);
        notes.push({ kind: "effect.denied", at: now(), actor: self, effect: name as string, effectKey, causationId: req.causationId, correlationId: req.correlationId, reason });
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
    const orphans = sql.exec<{ id: string; target: string; body: string; attempts: number }>("SELECT id, target, body, attempts FROM _actors_outbox WHERE status = 'running'").toArray();
    for (const row of orphans) {
      if (inflight.has(row.id)) continue;
      const req = JSON.parse(row.body) as { name: string; key: string; causationId: string; correlationId: string };
      const fx = system.effects?.[req.name];
      const reason = "interrupted: the actor restarted while the attempt was in flight";
      if (fx?.idempotency === "key") {
        sql.exec("UPDATE _actors_outbox SET status = 'pending', attempts = ?, next_at = ?, last_error = ? WHERE id = ?", row.attempts + 1, now(), reason, row.id);
        emit({ kind: "retry.scheduled", at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, attempt: row.attempts + 2, reason });
      } else {
        sql.exec("UPDATE _actors_outbox SET status = 'in_doubt', attempts = ?, last_error = ? WHERE id = ?", row.attempts + 1, reason, row.id);
        emit({ kind: "effect.in_doubt", at: now(), actor: self, effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId, reason });
        if (fx?.result) enqueueResult(fx.result, row.id, req, { key: req.key, status: "in_doubt", error: reason });
      }
    }
    if (orphans.length > 0) await cap.arm(earliestWake());
  }

  function retryOrExhaust(row: { id: string; attempts: number }, error: string, event: Omit<ActorEvent, "$actord" | "kind" | "at" | "actor">, overloaded = false): void {
    const attempts = row.attempts + 1;
    if (attempts >= maxAttempts) {
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

  async function runEffect(row: { id: string; target: string; body: string; attempts: number }): Promise<void> {
    const req = JSON.parse(row.body) as { name: string; key: string; input: unknown; causationId: string; correlationId: string; approved?: boolean };
    const fx = system.effects?.[req.name];
    const base = { effect: req.name, effectKey: req.key, causationId: req.causationId, correlationId: req.correlationId };
    if (fx?.approval === "human" && !req.approved) {
      sql.exec("UPDATE _actors_outbox SET status = 'awaiting_approval' WHERE id = ?", row.id);
      emit({ kind: "effect.awaiting_approval", at: now(), actor: self, ...base });
      return;
    }
    const adapter = seams()?.effects[req.name] ?? (options.effects as Record<string, EffectAdapter> | undefined)?.[req.name];
    const attempt = row.attempts + 1;
    const finish = (status: "confirmed" | "failed" | "in_doubt", value: unknown, error: string | null, kind: EventKind) => {
      sql.exec("UPDATE _actors_outbox SET status = ?, attempts = ?, last_error = ?, body = ? WHERE id = ?", status, attempt, error, JSON.stringify({ ...req, outcome: value }), row.id);
      emit({ kind, at: now(), actor: self, ...base, attempt, ...(error ? { reason: error } : {}) });
      if (fx?.result) enqueueResult(fx.result, row.id, req, { key: req.key, status, ...(status === "confirmed" ? { value } : { error: error ?? "" }) });
    };
    if (!adapter) {
      finish("failed", null, `no adapter registered for effect ${req.name}`, "effect.failed");
      return;
    }
    const budget = { ...spec.budget, ...seams()?.budgets?.[actorName] };
    const timeoutMs = budget.timeoutMs ?? 30_000;
    const budgetAttempts = budget.maxAttempts ?? maxAttempts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`effect timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      const value = await Promise.race([
        adapter.run(req.input, { key: req.key, attempt, signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason))),
      ]);
      finish("confirmed", value, null, "effect.confirmed");
    } catch (err) {
      const e = err as { message?: string; notDelivered?: boolean; rejected?: boolean };
      const error = e.message ?? String(err);
      if (e.rejected) finish("failed", null, error, "effect.failed");
      else if (e.notDelivered || fx?.idempotency === "key") {
        if (attempt >= budgetAttempts) {
          // Retries exhausted. Without proof the request never arrived, the outcome is unknown.
          if (e.notDelivered) finish("failed", null, error, "effect.failed");
          else finish("in_doubt", null, error, "effect.in_doubt");
        } else retryOrExhaust(row, error, base);
      } else if (fx?.reconcile && adapter.reconcile) {
        const r = await adapter.reconcile(req.key).catch(() => undefined);
        if (r?.delivered) finish("confirmed", r.value, null, "effect.confirmed");
        else if (r && !r.delivered) finish("failed", null, error, "effect.failed");
        else finish("in_doubt", null, error, "effect.in_doubt");
      } else {
        finish("in_doubt", null, error, "effect.in_doubt");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Deliver an effect's outcome back to this actor as its declared result message (a self-route). */
  function enqueueResult(type: string, effectRowId: string, req: { causationId: string; correlationId: string }, payload: Record<string, unknown>): void {
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
    emit({ kind: "sent", at: now(), actor: self, ...ids(envelope), effect, effectKey: rest.join(":"), detail: { effectResult: true } });
  }

  async function ensureSchedule(): Promise<void> {
    if (!spec.schedule) return;
    if (meta("schedule.next") === null) {
      const every = durationMs(spec.schedule.every) ?? 3_600_000;
      setMeta("schedule.next", String(now() + every));
      await cap.arm(earliestWake());
    }
  }

  /** The one place every source of a wake meets: the earliest time actord must run, or null for never. */
  function earliestWake(): number | null {
    const candidates: number[] = [];
    const next = sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM _actors_outbox WHERE status = 'pending'").toArray()[0]?.t;
    if (next !== null && next !== undefined) candidates.push(next);
    const tick = meta("schedule.next");
    if (tick) candidates.push(Number(tick));
    const timer = earliestTimer(sql);
    if (timer !== null) candidates.push(timer);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  async function start(): Promise<void> {
    await recoverOrphans();
    await ensureSchedule();
    await cap.arm(earliestWake());
  }

  /** What the actord job runs: the schedule's tick if due, inbox retention, then the outbox. */
  async function drive(): Promise<void> {
    await cap.ready();
    await recoverOrphans();
    const tick = meta("schedule.next");
    if (spec.schedule && tick && Number(tick) <= now()) {
      const every = durationMs(spec.schedule.every) ?? 3_600_000;
      setMeta("schedule.next", String(now() + every));
      const id = deriveId(self, "tick", tick);
      emit({ kind: "scheduled", at: now(), actor: self, messageId: id, type: spec.schedule.message, detail: { every: spec.schedule.every } });
      await receive({
        v: 1,
        id,
        type: spec.schedule.message,
        version: system.messages[spec.schedule.message]!.version,
        from: "@clock",
        to: self,
        correlationId: id,
        causationId: null,
        attempt: 1,
        sentAt: now(),
        payload: { at: Number(tick) },
      });
    }
    for (const t of dueTimers(sql, now())) await fireTimer(t);
    sql.exec("DELETE FROM _actors_inbox WHERE handled_at < ?", now() - retention);
    await drain();
  }

  /** Deliver one due timer to this instance. The id is derived from the key and due time, so a redelivery is a duplicate. */
  async function fireTimer(t: TimerRow): Promise<void> {
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
    const receipt = await receive(envelope);
    // Match on due_at too: the handler may have set this key again, and that new timer must survive.
    const remove = () => sql.exec("DELETE FROM _actors_timers WHERE key = ? AND due_at = ?", t.key, t.due_at);
    if (receipt.status === "failed") {
      const attempts = t.attempts + 1;
      if (attempts >= maxAttempts) {
        remove();
        emit({ kind: "retry.exhausted", at: now(), actor: self, ...event, attempt: attempts, reason: receipt.error });
      } else {
        const delay = backoff(attempts);
        sql.exec("UPDATE _actors_timers SET attempts = ?, due_at = ? WHERE key = ? AND due_at = ?", attempts, now() + delay, t.key, t.due_at);
        emit({ kind: "retry.scheduled", at: now(), actor: self, ...event, attempt: attempts + 1, reason: receipt.error, detail: { delayMs: delay } });
      }
      return;
    }
    remove();
    if (receipt.status === "rejected") emit({ kind: "undeliverable", at: now(), actor: self, ...event, reason: receipt.reason });
  }

  const runtime: ActorRuntime = {
    receive,
    drive,
    async decide(effectKey, decision, reason) {
      const row = sql.exec<{ id: string; body: string; attempts: number; target: string }>("SELECT id, body, attempts, target FROM _actors_outbox WHERE id LIKE ? AND status = 'awaiting_approval'", `fx:%:${effectKey}`).toArray()[0];
      if (!row) return { status: "denied", key: effectKey, error: "no effect awaiting approval with that key" };
      const req = JSON.parse(row.body) as { name: string; causationId: string; correlationId: string };
      if (decision === "deny") {
        sql.exec("UPDATE _actors_outbox SET status = 'denied', last_error = ? WHERE id = ?", reason ?? "denied by a person", row.id);
        emit({ kind: "effect.denied", at: now(), actor: self, effect: req.name, effectKey, causationId: req.causationId, correlationId: req.correlationId, reason: reason ?? "denied by a person" });
        return { status: "denied", key: effectKey, error: reason ?? "denied by a person" };
      }
      sql.exec("UPDATE _actors_outbox SET status = 'pending', body = ?, next_at = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.body), approved: true }), now(), row.id);
      await drain();
      await inflight.get(row.id);
      const done = sql.exec<{ status: string; body: string; last_error: string | null }>("SELECT status, body, last_error FROM _actors_outbox WHERE id = ?", row.id).toArray()[0]!;
      const outcome = (JSON.parse(done.body) as { outcome?: unknown }).outcome;
      if (done.status === "confirmed") return { status: "confirmed", key: effectKey, value: outcome };
      if (done.status === "in_doubt") return { status: "in_doubt", key: effectKey, error: done.last_error ?? "unknown" };
      if (done.status === "pending" || done.status === "running") return { status: "in_doubt", key: effectKey, error: `not settled yet: ${done.last_error ?? "in flight"}` };
      return { status: "failed", key: effectKey, error: done.last_error ?? "failed" };
    },
    outbox() {
      return sql
        .exec<{ id: string; kind: string; target: string; status: string; attempts: number; last_error: string | null }>("SELECT id, kind, target, status, attempts, last_error FROM _actors_outbox ORDER BY seq")
        .toArray()
        .map((r) => ({ id: r.id, kind: r.kind, target: r.target, status: r.status, attempts: r.attempts, lastError: r.last_error }));
    },
  };
  seams()?.runtimes?.set(ctx.id.toString(), runtime);
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
