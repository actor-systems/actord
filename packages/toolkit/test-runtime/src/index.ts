// A tiny system for runtime guarantees the reference apps can't reach without contortions.
import { DurableObject } from "cloudflare:workers";
import { Lifecycle, LifecycleCapability, type LifecycleJobContext } from "agents/lifecycle";
import { z } from "zod";
import { actorRuntime, type Envelope } from "../../src/runtime/index.ts";
import { defineSystem, message } from "../../src/system.ts";

const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional(), usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(), containerSeconds: z.number().optional() }).optional() });

export const system = defineSystem({
  name: "runtime-probe",
  messages: {
    "probe.misbehave": message({ version: 1, description: "Ask for an undeclared effect", payload: z.object({}) }),
    "probe.effect": message({ version: 1, description: "Request a named effect", payload: z.object({ effect: z.enum(["gateway.reconcilable", "gateway.plain", "gateway.approval", "gateway.keyed", "gateway.budgeted"]), key: z.string() }) }),
    "probe.outcome": message({ version: 1, description: "Effect outcome", payload: Outcome }),
    "probe.timer.set": message({ version: 1, description: "Set a timer", payload: z.object({ key: z.string(), delayMs: z.number(), fail: z.boolean().optional() }) }),
    "probe.timer.cancel": message({ version: 1, description: "Cancel a timer", payload: z.object({ key: z.string() }) }),
    "probe.timer.fired": message({ version: 1, description: "A timer fired", payload: z.object({ key: z.string() }) }),
    "probe.tick.hourly": message({ version: 1, description: "The hourly schedule ticked", payload: z.object({ at: z.number() }) }),
    "probe.tick.daily": message({ version: 1, description: "The daily schedule ticked", payload: z.object({ at: z.number() }) }),
  },
  actors: {
    Probe: {
      binding: "PROBE",
      kind: "deterministic",
      purpose: "Exercises runtime edge cases",
      justification: ["state"],
      effects: ["gateway.reconcilable", "gateway.plain", "gateway.approval", "gateway.keyed", "gateway.budgeted"],
      schedules: [
        { every: "1h", message: "probe.tick.hourly" },
        { cron: "0 9 * * *", message: "probe.tick.daily" },
      ],
    },
  },
  effects: {
    "gateway.reconcilable": { description: "No key, but outcomes can be looked up", idempotency: "none", reconcile: true, result: "probe.outcome" },
    "gateway.plain": { description: "No key, no lookup", idempotency: "none", result: "probe.outcome" },
    "gateway.approval": { description: "Needs a person", idempotency: "key", approval: "human", result: "probe.outcome" },
    "gateway.keyed": { description: "Keyed", idempotency: "key", result: "probe.outcome" },
    "gateway.budgeted": { description: "Keyed, with its own budget", idempotency: "key", result: "probe.outcome", budget: { timeoutMs: 15, maxAttempts: 8 } },
  },
  routes: [
    { from: "@ingress", message: "probe.misbehave", to: "Probe" },
    { from: "@ingress", message: "probe.effect", to: "Probe" },
    { from: "Probe", message: "probe.outcome", to: "Probe" },
    { from: "@ingress", message: "probe.timer.set", to: "Probe" },
    { from: "@ingress", message: "probe.timer.cancel", to: "Probe" },
    { from: "@timer", message: "probe.timer.fired", to: "Probe" },
    { from: "@clock", message: "probe.tick.hourly", to: "Probe" },
    { from: "@clock", message: "probe.tick.daily", to: "Probe" },
  ],
});

/** Another Lifecycle capability with its own job, to show actord shares the object's one alarm. */
class Pinger extends LifecycleCapability {
  constructor() {
    super("pinger");
  }
  async pingAt(time: number): Promise<void> {
    await this.lifecycle.jobs.push({ id: "ping", fn: "ping", time });
  }
  onJob({ job }: LifecycleJobContext): void {
    if (job.fn === "ping") this.lifecycle.storage.sql.exec("INSERT INTO counters (name, n) VALUES ('pings', 1) ON CONFLICT (name) DO UPDATE SET n = n + 1");
  }
}

export class Probe extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);
  readonly pinger = new Pinger();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.pinger);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS outcomes (key TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT, usage TEXT)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fired (key TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ticks (message TEXT NOT NULL, at INTEGER)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  }

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "Probe", {
    "probe.misbehave": (_m, ctx) => {
      ctx.effect("gateway.undeclared" as never, {}, { key: "x" });
    },
    "probe.effect": ({ payload }, ctx) => {
      ctx.effect(payload.effect, { key: payload.key }, { key: payload.key });
    },
    "probe.outcome": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO outcomes (key, status, error, usage) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET status = excluded.status, error = excluded.error, usage = excluded.usage", payload.key, payload.status, payload.error ?? null, payload.usage ? JSON.stringify(payload.usage) : null);
    },
    "probe.timer.set": ({ payload }, ctx) => {
      ctx.after(payload.delayMs, "probe.timer.fired", { key: payload.key }, { key: payload.key });
      if (payload.fail) throw new Error("set then fail");
    },
    "probe.timer.cancel": ({ payload }, ctx) => {
      ctx.cancelTimer(payload.key);
    },
    "probe.timer.fired": ({ payload }, ctx) => {
      if (payload.key.startsWith("bad")) throw new Error("timer handler failed");
      ctx.sql.exec("INSERT INTO fired (key) VALUES (?)", payload.key);
    },
    "probe.tick.hourly": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO ticks (message, at) VALUES ('probe.tick.hourly', ?)", payload.at);
    },
    "probe.tick.daily": (_m, ctx) => {
      ctx.sql.exec("INSERT INTO ticks (message) VALUES ('probe.tick.daily')");
    },
  }, { backoffMs: () => 40 });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
  decide(key: string, decision: "approve" | "deny") {
    return this.actor.decide(key, decision);
  }
  outcomes() {
    return this.ctx.storage.sql
      .exec<{ key: string; status: string; error: string | null; usage: string | null }>("SELECT key, status, error, usage FROM outcomes ORDER BY key")
      .toArray()
      .map(({ usage, ...r }) => ({ ...r, ...(usage ? { usage: JSON.parse(usage) as Record<string, number> } : {}) }));
  }
  fired(): string[] {
    return this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM fired ORDER BY rowid").toArray().map((r) => r.key);
  }
  ticks(): string[] {
    return this.ctx.storage.sql.exec<{ message: string }>("SELECT message FROM ticks ORDER BY message").toArray().map((r) => r.message);
  }
  tickAts(): Array<number | null> {
    return this.ctx.storage.sql.exec<{ at: number | null }>("SELECT at FROM ticks WHERE message = 'probe.tick.hourly' ORDER BY rowid").toArray().map((r) => r.at);
  }
  pingAt(time: number) {
    return this.pinger.pingAt(time);
  }
  pings(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT n FROM counters WHERE name = 'pings'").toArray()[0]?.n ?? 0;
  }
}

export default { fetch: () => new Response("runtime probe") } satisfies ExportedHandler<Env>;
