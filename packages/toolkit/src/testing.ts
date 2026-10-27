// @actord/toolkit/testing: helpers for tests that run in workerd with @cloudflare/vitest-plugin.
// Import only from test files: it depends on the `cloudflare:test` module.
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import type { ActorEvent, ActorRuntime, EffectAdapter, FaultPoint, JobAdapter } from "./runtime/index.ts";
import { expireJobRows } from "./runtime/jobs.ts";
import { scheduleKey } from "./runtime/schedules.ts";
import type { System } from "./system.ts";

interface Seams {
  faults: Array<{ actor: string; type?: string; at: FaultPoint; remaining: number; error: string }>;
  effects: Record<string, EffectAdapter | JobAdapter>;
  budgets?: Record<string, { maxAttempts?: number; timeoutMs?: number }>;
  effectBudgets?: Record<string, { maxAttempts?: number; timeoutMs?: number }>;
  runtimes: Map<string, ActorRuntime>;
  names: Map<string, string>;
  events?: ActorEvent[];
}
function seams(): Seams {
  const g = globalThis as { __actorsTestSeams?: Seams };
  g.__actorsTestSeams ??= { faults: [], effects: {}, runtimes: new Map(), names: new Map() };
  return g.__actorsTestSeams;
}
// Create the seams at import, before any actor is constructed, so every runtime registers itself in them.
seams();

/**
 * Make the next `times` matching steps throw. "before-handler" fails before any state change,
 * "after-handler" fails after the handler's writes but before commit, "deliver" fails the sender's
 * delivery attempt as if the receiver were unreachable.
 */
export function injectFault(fault: { actor: string; type?: string; at: FaultPoint; times?: number; error?: string }): void {
  seams().faults.push({
    actor: fault.actor,
    ...(fault.type ? { type: fault.type } : {}),
    at: fault.at,
    remaining: fault.times ?? 1,
    error: fault.error ?? `injected fault at ${fault.at}`,
  });
}

/** Replace an effect's adapter (a JobAdapter for a job effect) for the rest of the test file (or until resetSeams). */
export function overrideEffect(name: string, adapter: EffectAdapter | JobAdapter): void {
  seams().effects[name] = adapter;
}

/** Shrink an actor's declared model budget for a test (for example a 50 ms timeout). */
export function overrideBudget(actor: string, budget: { maxAttempts?: number; timeoutMs?: number }): void {
  seams().budgets = { ...seams().budgets, [actor]: budget };
}

/** Override one effect's budget for a test; it wins over the effect's own and its actor's. */
export function overrideEffectBudget(effect: string, budget: { maxAttempts?: number; timeoutMs?: number }): void {
  seams().effectBudgets = { ...seams().effectBudgets, [effect]: budget };
}

/** Start capturing every event the runtime emits; returns the live array, which fills until resetSeams(). */
export function captureEvents(): ActorEvent[] {
  const events: ActorEvent[] = [];
  seams().events = events;
  return events;
}

/** Retry `check` until it passes, or throw its last failure after `ms`: for what real time decides, such as an alarm firing. */
export async function eventually(check: () => Promise<void>, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > until) throw err;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function resetSeams(): void {
  delete seams().events;
  seams().faults = [];
  seams().effects = {};
  seams().budgets = {};
  seams().effectBudgets = {};
}

type Env = Record<string, { get(id: unknown): unknown; getByName(name: string): unknown }>;

/** Rows waiting to be delivered or run, and work in flight: running effects, cancels, and the runtime's background probes. */
async function outboxCounts(stub: unknown): Promise<{ pending: number; running: number }> {
  return runInDurableObject(stub, (_i, state) => {
    const background = seams().runtimes.get(state.id.toString())?.busy() ?? 0;
    try {
      const rows = state.storage.sql.exec("SELECT status, COUNT(*) AS n FROM _actors_outbox WHERE status IN ('pending', 'running', 'cancelling') GROUP BY status").toArray();
      const get = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
      return { pending: get("pending"), running: get("running") + get("cancelling") + background };
    } catch {
      return { pending: 0, running: background };
    }
  });
}

/**
 * Wait until no effect, job probe or cancel is in flight anywhere in the system and, unless `deliver` is
 * false, deliver every pending outbox row, fast-forwarding retry backoff by driving the runtime directly
 * rather than through the alarm. Waiting jobs' probes and deadlines are left when they are due (use
 * expireJobs, or make a probe due yourself). Stops when the system is quiet or `rounds` run out; returns
 * the number of busy rounds.
 */
export async function settle(env: unknown, system: System, options: { rounds?: number; deliver?: boolean } = {}): Promise<number> {
  const e = env as Env;
  let busy = 0;
  for (let round = 0; round < (options.rounds ?? 50); round++) {
    let any = false;
    for (const spec of Object.values(system.actors)) {
      const ns = e[spec.binding];
      if (!ns) continue;
      for (const id of await listDurableObjectIds(ns)) {
        // After abortAllDurableObjects the listing can hand back ids with no name, and Lifecycle won't start an
        // instance whose ctx.id.name is missing. Nothing can be driven or counted there, so skip it.
        // listDurableObjectIds returns ids without names (and, after abortAllDurableObjects, so does ctx.id), and
        // Lifecycle won't start an instance whose ctx.id.name is missing. Resolve each id through the name its
        // runtime registered; an id never seen by a runtime has nothing to drive or count, so skip it.
        const name = seams().names.get(String(id));
        if (name === undefined) continue;
        const stub = ns.getByName(name);
        const { pending, running } = await outboxCounts(stub);
        if (running > 0) any = true;
        if (options.deliver === false) continue;
        if (pending > 0) any = true;
        // Drive every instance each round, not only those with pending rows: a schedule can be due with an empty outbox.
        const started = await runInDurableObject(stub, async (_i, state) => {
          if (pending > 0) state.storage.sql.exec("UPDATE _actors_outbox SET next_at = 0 WHERE status = 'pending'");
          const runtime = seams().runtimes.get(state.id.toString());
          await runtime?.drive();
          // drive() may have started background work (a probe, an effect), which another round waits for.
          return runtime?.busy() ?? 0;
        });
        if (started > 0) any = true;
      }
    }
    if (!any) return busy;
    busy++;
    await new Promise((r) => setTimeout(r, 5));
  }
  return busy;
}

/**
 * The runtime an instance registered when it was constructed. A helper that drove nothing would let a test pass
 * for the wrong reason, so a missing one is an error, not a no-op.
 */
function registered(state: { id: { toString(): string } }, actor: string, key: string): ActorRuntime {
  const runtime = seams().runtimes.get(state.id.toString());
  if (!runtime) throw new Error(`${actor} "${key}" has no actord runtime registered: send it a message first, so the instance constructs its runtime`);
  return runtime;
}

let lastWake = 0;

/**
 * Simulate a scheduled wake now: mark the instance's next tick of one schedule (by `message`, default the
 * first) due at the current time and drive it, as
 * when its job fires on schedule, so the wake's `payload.at` is now. Each call is a distinct wake (a
 * later scheduled time, so a distinct message id).
 */
export async function tick(env: unknown, system: System, actor: string, key = "main", message?: string): Promise<boolean> {
  const spec = system.actors[actor];
  if (!spec) throw new Error(`${actor} is not declared`);
  const target = message ?? spec.schedules?.[0]?.message;
  if (!target || !spec.schedules?.some((sc) => sc.message === target)) throw new Error(`${actor} has no schedule for ${target ?? "any message"}`);
  const stub = (env as Env)[spec.binding]!.getByName(key);
  const at = Math.max(Date.now(), lastWake + 1);
  lastWake = at;
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now() + 1));
  const due = String(at);
  await runInDurableObject(stub, async (_i, state) => {
    const runtime = registered(state, actor, key);
    state.storage.sql.exec("INSERT INTO _actors_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", scheduleKey(target), due);
    await runtime.drive();
  });
  return true;
}

/**
 * Make an instance's pending timers due now and drive it, as when its job fires after their delays.
 * Returns how many the drive fired, whether or not their delivery was handled.
 */
export async function fireTimers(env: unknown, system: System, actor: string, key = "main"): Promise<number> {
  const spec = system.actors[actor];
  if (!spec) throw new Error(`${actor} is not declared`);
  const stub = (env as Env)[spec.binding]!.getByName(key);
  return runInDurableObject(stub, async (_i, state) => {
    const runtime = registered(state, actor, key);
    const before = state.storage.sql.exec<{ key: string; attempts: number }>("SELECT key, attempts FROM _actors_timers").toArray();
    state.storage.sql.exec("UPDATE _actors_timers SET due_at = 0");
    await runtime.drive();
    // A fired timer's row is gone (handled or out of attempts), or pushed out to its retry or a new setting; a row
    // still due at 0 with the same attempts didn't fire.
    const unfired = new Set(state.storage.sql.exec<{ key: string; attempts: number }>("SELECT key, attempts FROM _actors_timers WHERE due_at = 0").toArray().map((r) => `${r.attempts}:${r.key}`));
    return before.filter((r) => !unfired.has(`${r.attempts}:${r.key}`)).length;
  });
}

/**
 * Make every job an instance is waiting on reach its deadline now, and drive it, as when its job fires at
 * the deadline: each becomes in_doubt. Returns how many were waiting.
 */
export async function expireJobs(env: unknown, system: System, actor: string, key = "main"): Promise<number> {
  const spec = system.actors[actor];
  if (!spec) throw new Error(`${actor} is not declared`);
  const stub = (env as Env)[spec.binding]!.getByName(key);
  return runInDurableObject(stub, async (_i, state) => {
    const runtime = registered(state, actor, key);
    const waiting = expireJobRows(state.storage.sql, Date.now());
    await runtime.drive();
    return waiting;
  });
}

/**
 * Make every approval an instance is waiting on expire now, and drive it, as when the approval's
 * deadline passes: each becomes denied with "approval expired". Returns how many were waiting.
 */
export async function expireApprovals(env: unknown, system: System, actor: string, key = "main"): Promise<number> {
  const spec = system.actors[actor];
  if (!spec) throw new Error(`${actor} is not declared`);
  const stub = (env as Env)[spec.binding]!.getByName(key);
  return runInDurableObject(stub, async (_i, state) => {
    const runtime = registered(state, actor, key);
    const waiting = state.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox WHERE status = 'awaiting_approval'").one().n as number;
    state.storage.sql.exec("UPDATE _actors_outbox SET next_at = ? WHERE status = 'awaiting_approval'", Date.now());
    await runtime.drive();
    return waiting;
  });
}
