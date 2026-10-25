// actors-toolkit/testing: helpers for tests that run in workerd with @cloudflare/vitest-plugin.
// Import only from test files: it depends on the `cloudflare:test` module.
import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { EffectAdapter, FaultPoint } from "./runtime/index.ts";
import type { System } from "./system.ts";

interface Seams {
  faults: Array<{ actor: string; type?: string; at: FaultPoint; remaining: number; error: string }>;
  effects: Record<string, EffectAdapter>;
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

export function resetSeams(): void {
  seams().faults = [];
  seams().effects = {};
}

type Env = Record<string, { get(id: unknown): unknown; getByName(name: string): unknown }>;

async function pendingCount(stub: unknown): Promise<number> {
  return runInDurableObject(stub, (_i, state) => {
    try {
      return Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox WHERE status = 'pending'").toArray()[0]?.n ?? 0);
    } catch {
      return 0;
    }
  });
}

/**
 * Deliver every pending outbox row in the system, fast-forwarding retry backoff, until nothing is
 * pending or `rounds` run out. Returns the number of rounds that delivered something.
 */
export async function settle(env: unknown, system: System, options: { rounds?: number } = {}): Promise<number> {
  const e = env as Env;
  let busy = 0;
  for (let round = 0; round < (options.rounds ?? 25); round++) {
    let any = false;
    for (const spec of Object.values(system.actors)) {
      const ns = e[spec.binding];
      if (!ns) continue;
      for (const id of await listDurableObjectIds(ns)) {
        const stub = ns.get(id);
        if ((await pendingCount(stub)) === 0) continue;
        any = true;
        await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("UPDATE _actors_outbox SET next_at = 0 WHERE status = 'pending'"));
        await runDurableObjectAlarm(stub);
      }
    }
    if (!any) return busy;
    busy++;
  }
  return busy;
}

let ticks = 0;

/**
 * Simulate a scheduled wake now: mark the instance's next tick due and run its alarm. Each call is a
 * distinct wake (a distinct scheduled time, so a distinct message id).
 */
export async function tick(env: unknown, system: System, actor: string, key = "main"): Promise<boolean> {
  const spec = system.actors[actor];
  if (!spec) throw new Error(`${actor} is not declared`);
  const stub = (env as Env)[spec.binding]!.getByName(key);
  const due = String(Date.now() - 1_000_000 + ++ticks);
  await runInDurableObject(stub, async (_i, state) => {
    state.storage.sql.exec("INSERT INTO _actors_meta (k, v) VALUES ('schedule.next', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", due);
    // An alarm set to "now" would fire on its own and race the test; park one far ahead instead,
    // since runDurableObjectAlarm runs whatever alarm is set, whenever it is due.
    if ((await state.storage.getAlarm()) === null) await state.storage.setAlarm(Date.now() + 3_600_000);
  });
  return runDurableObjectAlarm(stub);
}
