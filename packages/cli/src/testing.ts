// @actord/toolkit/testing: helpers for tests that run in workerd with @cloudflare/vitest-plugin.
// Import only from test files: it depends on the `cloudflare:test` module.
import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { EffectAdapter, FaultPoint } from "./runtime/index.ts";
import type { System } from "./system.ts";

interface Seams {
  faults: Array<{ actor: string; type?: string; at: FaultPoint; remaining: number; error: string }>;
  effects: Record<string, EffectAdapter>;
  budgets?: Record<string, { maxAttempts?: number; timeoutMs?: number }>;
}
function seams(): Seams {
  const g = globalThis as { __actorsTestSeams?: Seams };
  g.__actorsTestSeams ??= { faults: [], effects: {} };
  return g.__actorsTestSeams;
}

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

/** Replace an effect's adapter for the rest of the test file (or until resetSeams). */
export function overrideEffect(name: string, adapter: EffectAdapter): void {
  seams().effects[name] = adapter;
}

/** Shrink an actor's declared model budget for a test (for example a 50 ms timeout). */
export function overrideBudget(actor: string, budget: { maxAttempts?: number; timeoutMs?: number }): void {
  seams().budgets = { ...seams().budgets, [actor]: budget };
}

export function resetSeams(): void {
  seams().faults = [];
  seams().effects = {};
  seams().budgets = {};
}

type Env = Record<string, { get(id: unknown): unknown; getByName(name: string): unknown }>;

async function outboxCounts(stub: unknown): Promise<{ pending: number; running: number }> {
  return runInDurableObject(stub, (_i, state) => {
    try {
      const rows = state.storage.sql.exec("SELECT status, COUNT(*) AS n FROM _actors_outbox WHERE status IN ('pending', 'running') GROUP BY status").toArray();
      const get = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
      return { pending: get("pending"), running: get("running") };
    } catch {
      return { pending: 0, running: 0 };
    }
  });
}

/**
 * Wait until no effect is running anywhere in the system and, unless `deliver` is false, deliver every
 * pending outbox row, fast-forwarding retry backoff. Stops when the system is quiet or `rounds` run out;
 * returns the number of busy rounds.
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
        const stub = ns.get(id);
        const { pending, running } = await outboxCounts(stub);
        if (running > 0) any = true;
        if (pending === 0 || options.deliver === false) continue;
        any = true;
        await runInDurableObject(stub, async (_i, state) => {
          state.storage.sql.exec("UPDATE _actors_outbox SET next_at = 0 WHERE status = 'pending'");
          if ((await state.storage.getAlarm()) === null) await state.storage.setAlarm(Date.now() + 3_600_000);
        });
        await runDurableObjectAlarm(stub);
      }
    }
    if (!any) return busy;
    busy++;
    await new Promise((r) => setTimeout(r, 5));
  }
  return busy;
}

let lastWake = 0;

/**
 * Simulate a scheduled wake now: mark the instance's next tick due at the current time and run its alarm,
 * as when an alarm fires on schedule, so the wake's `payload.at` is now. Each call is a distinct wake (a
 * later scheduled time, so a distinct message id).
 */
export async function tick(env: unknown, system: System, actor: string, key = "main"): Promise<boolean> {
  const spec = system.actors[actor];
  if (!spec) throw new Error(`${actor} is not declared`);
  const stub = (env as Env)[spec.binding]!.getByName(key);
  const at = Math.max(Date.now(), lastWake + 1);
  lastWake = at;
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now() + 1));
  const due = String(at);
  await runInDurableObject(stub, async (_i, state) => {
    state.storage.sql.exec("INSERT INTO _actors_meta (k, v) VALUES ('schedule.next', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", due);
    // An alarm set to "now" would fire on its own and race the test; park one far ahead instead,
    // since runDurableObjectAlarm runs whatever alarm is set, whenever it is due.
    if ((await state.storage.getAlarm()) === null) await state.storage.setAlarm(Date.now() + 3_600_000);
  });
  return runDurableObjectAlarm(stub);
}
