// A tiny system for runtime guarantees the reference apps can't reach without contortions.
import { DurableObject } from "cloudflare:workers";
import { Lifecycle, LifecycleCapability, type LifecycleJobContext } from "agents/lifecycle";
import { z } from "zod";
import { actorRuntime, type Envelope } from "../../src/runtime/index.ts";
import { defineSystem, inboundEmail, message, webhook } from "../../src/system.ts";
import { type ApprovalDecided, applyDecision, approvalDecided, handleEmail, handleWebhook } from "../../src/sources/index.ts";

const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional(), usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(), containerSeconds: z.number().optional() }).optional() });

export const system = defineSystem({
  name: "runtime-probe",
  messages: {
    "probe.misbehave": message({ version: 1, description: "Ask for an undeclared effect", payload: z.object({}) }),
    "probe.effect": message({ version: 1, description: "Request a named effect", payload: z.object({ effect: z.enum(["gateway.reconcilable", "gateway.plain", "gateway.approval", "gateway.publish", "gateway.keyed", "gateway.budgeted", "gateway.job-plain", "gateway.job-approval"]), key: z.string(), twice: z.boolean().optional(), fail: z.boolean().optional() }) }),
    "probe.outcome": message({ version: 1, description: "Effect outcome", payload: Outcome }),
    "probe.timer.set": message({ version: 1, description: "Set a timer", payload: z.object({ key: z.string(), delayMs: z.number(), fail: z.boolean().optional(), label: z.string().optional(), at: z.enum(["infinity", "nan", "negative"]).optional() }) }),
    "probe.timer.cancel": message({ version: 1, description: "Cancel a timer", payload: z.object({ key: z.string() }) }),
    "probe.timer.fired": message({ version: 1, description: "A timer fired", payload: z.object({ key: z.string() }) }),
    "probe.tick.hourly": message({ version: 1, description: "The hourly schedule ticked", payload: z.object({ at: z.number() }) }),
    "probe.tick.daily": message({ version: 1, description: "The daily schedule ticked", payload: z.object({ at: z.number() }) }),
    "probe.job.start": message({ version: 1, description: "Start a job", payload: z.object({ key: z.string() }) }),
    "probe.job.done": message({ version: 1, description: "A job reports it finished", payload: z.object({ key: z.string(), ok: z.boolean(), effect: z.enum(["gateway.job", "gateway.job-plain", "gateway.job-approval"]).optional() }) }),
    "probe.job.cancel": message({ version: 1, description: "Cancel a job", payload: z.object({ key: z.string() }) }),
    "probe.poked": message({ version: 1, description: "A declared source poked the probe", payload: z.object({ key: z.string() }) }),
    "probe.approve": message({ version: 1, description: "A person approves a parked effect", payload: z.object({ key: z.string(), by: z.string() }) }),
    "probe.deny": message({ version: 1, description: "A person denies a parked effect", payload: z.object({ key: z.string(), by: z.string(), effect: z.enum(["gateway.approval", "gateway.job-approval"]).optional() }) }),
    "approval.decided": message({ version: 1, description: "A person answered an approval request", payload: approvalDecided }),
  },
  sources: {
    hooks: webhook({ path: "/hooks/probe", verify: "github", secret: "PROBE_HOOK_SECRET", events: { "probe.poke": { message: "probe.poked", key: (e: { key: string }) => e.key, map: (e: { key: string }) => ({ key: e.key }) } } }),
    mail: inboundEmail({ secret: "PROBE_APPROVAL_SECRET", owner: "PROBE_OWNER", from: "PROBE_FROM", send: "PROBE_SEND", authserv: "PROBE_AUTHSERV", message: "approval.decided" }),
  },
  approvals: { notify: "notify.approval" },
  actors: {
    Probe: {
      binding: "PROBE",
      kind: "deterministic",
      purpose: "Exercises runtime edge cases",
      justification: ["state"],
      effects: ["gateway.reconcilable", "gateway.plain", "gateway.approval", "gateway.publish", "gateway.keyed", "gateway.budgeted", "gateway.job", "gateway.job-plain", "gateway.job-approval", "notify.approval"],
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
    "gateway.publish": { description: "Makes something public, so a person must approve it", idempotency: "key", approval: "human", publishes: true, result: "probe.outcome" },
    "gateway.keyed": { description: "Keyed", idempotency: "key", result: "probe.outcome" },
    "gateway.budgeted": { description: "Keyed, with its own budget", idempotency: "key", result: "probe.outcome", budget: { timeoutMs: 15, maxAttempts: 8 } },
    "gateway.job": { description: "Long work, settled later", kind: "job", idempotency: "key", deadline: "1h", probe: { every: "1m" }, completes: { message: "probe.job.done" }, result: "probe.outcome" },
    "gateway.job-plain": { description: "Long work whose start can't be retried", kind: "job", idempotency: "none", deadline: "1h", completes: { message: "probe.job.done" }, result: "probe.outcome" },
    "gateway.job-approval": { description: "Long work a person must approve first", kind: "job", idempotency: "key", approval: "human", deadline: "1h", completes: { message: "probe.job.done" }, result: "probe.outcome" },
    // Tests install approvalEmail with a fake send binding (overrideEffect); none is registered here.
    "notify.approval": { description: "Email the owner that an approval is waiting", idempotency: "none" },
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
    { from: "@ingress", message: "probe.job.start", to: "Probe" },
    { from: "@ingress", message: "probe.job.done", to: "Probe" },
    { from: "@ingress", message: "probe.job.cancel", to: "Probe" },
    { from: "@hooks", message: "probe.poked", to: "Probe" },
    { from: "@ingress", message: "probe.approve", to: "Probe" },
    { from: "@ingress", message: "probe.deny", to: "Probe" },
    { from: "@mail", message: "approval.decided", to: "Probe" },
  ],
});

/** The same system without approvals.notify, which instances keyed "quiet-…" run ([approval-notify-absent]). */
const unnotified: typeof system = { ...system, approvals: undefined };

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
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS approvals (key TEXT NOT NULL, ok INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pokes (id TEXT NOT NULL, cid TEXT)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS settled (key TEXT NOT NULL, ok INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS decided (payload TEXT NOT NULL)");
  }

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, this.ctx.id.name?.startsWith("quiet-") ? unnotified : system, "Probe", {
    "probe.misbehave": (_m, ctx) => {
      ctx.effect("gateway.undeclared" as never, {}, { key: "x" });
    },
    "probe.effect": ({ payload }, ctx) => {
      ctx.effect(payload.effect, { key: payload.key }, { key: payload.key });
      if (payload.twice) ctx.effect(payload.effect, { key: payload.key }, { key: payload.key });
      if (payload.fail) throw new Error("requested then failed");
    },
    "probe.outcome": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO outcomes (key, status, error, usage) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET status = excluded.status, error = excluded.error, usage = excluded.usage", payload.key, payload.status, payload.error ?? null, payload.usage ? JSON.stringify(payload.usage) : null);
    },
    "probe.timer.set": ({ payload }, ctx) => {
      // `label` is what the timer delivers (and fired() records); it defaults to the timer's key.
      const fired = { key: payload.label ?? payload.key };
      if (payload.at) ctx.at({ infinity: Infinity, nan: NaN, negative: -1 }[payload.at], "probe.timer.fired", fired, { key: payload.key });
      else ctx.after(payload.delayMs, "probe.timer.fired", fired, { key: payload.key });
      if (payload.fail) throw new Error("set then fail");
    },
    "probe.timer.cancel": ({ payload }, ctx) => {
      ctx.cancelTimer(payload.key);
    },
    "probe.timer.fired": ({ payload }, ctx) => {
      if (payload.key.startsWith("bad")) throw new Error("timer handler failed");
      ctx.sql.exec("INSERT INTO fired (key) VALUES (?)", payload.key);
      // Timers that act on other timers when they fire: kill-<k> cancels timer k, reset-<k> sets k again to
      // deliver "<k>-new", and rearm<…> sets itself again once.
      if (payload.key.startsWith("kill-")) ctx.cancelTimer(payload.key.slice("kill-".length));
      if (payload.key.startsWith("reset-")) {
        const k = payload.key.slice("reset-".length);
        ctx.after(60_000, "probe.timer.fired", { key: `${k}-new` }, { key: k });
      }
      if (payload.key.startsWith("rearm") && ctx.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fired WHERE key = ?", payload.key).one().n < 2) {
        ctx.after(60_000, "probe.timer.fired", { key: payload.key }, { key: payload.key });
      }
    },
    "probe.tick.hourly": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO ticks (message, at) VALUES ('probe.tick.hourly', ?)", payload.at);
    },
    "probe.tick.daily": (_m, ctx) => {
      ctx.sql.exec("INSERT INTO ticks (message) VALUES ('probe.tick.daily')");
    },
    "probe.job.start": ({ payload }, ctx) => {
      ctx.effect("gateway.job", { key: payload.key }, { key: payload.key });
    },
    "probe.job.done": ({ payload }, ctx) => {
      // Record what settleJob answered, not what the message claimed: false means the job was already settled.
      const settled = ctx.settleJob(payload.effect ?? "gateway.job", payload.key, payload.ok ? { status: "confirmed", value: { finished: true } } : { status: "failed", error: "the job reported failure" });
      ctx.sql.exec("INSERT INTO settled (key, ok) VALUES (?, ?)", payload.key, settled ? 1 : 0);
    },
    "probe.job.cancel": ({ payload }, ctx) => {
      ctx.cancelJob("gateway.job", payload.key);
    },
    "probe.poked": ({ id, correlationId }, ctx) => {
      ctx.sql.exec("INSERT INTO pokes (id, cid) VALUES (?, ?)", id, correlationId);
    },
    "probe.approve": ({ payload }, ctx) => {
      const ok = ctx.approve("gateway.approval", payload.key, { by: payload.by });
      ctx.sql.exec("INSERT INTO approvals (key, ok) VALUES (?, ?)", payload.key, ok ? 1 : 0);
    },
    "probe.deny": ({ payload }, ctx) => {
      const ok = ctx.deny(payload.effect ?? "gateway.approval", payload.key, "not today", { by: payload.by });
      ctx.sql.exec("INSERT INTO approvals (key, ok) VALUES (?, ?)", payload.key, ok ? 1 : 0);
    },
    "approval.decided": ({ payload }, ctx) => {
      const ok = applyDecision(ctx, payload);
      ctx.sql.exec("INSERT INTO approvals (key, ok) VALUES (?, ?)", payload.effectKey, ok ? 1 : 0);
      ctx.sql.exec("INSERT INTO decided (payload) VALUES (?)", JSON.stringify(payload));
    },
  }, { backoffMs: () => (globalThis as { __probeBackoffMs?: number }).__probeBackoffMs ?? 40 }); // a test can hold a retry back

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
  settled(): Array<{ key: string; ok: boolean }> {
    return this.ctx.storage.sql.exec<{ key: string; ok: number }>("SELECT key, ok FROM settled ORDER BY rowid").toArray().map((r) => ({ key: r.key, ok: r.ok === 1 }));
  }
  approvals(): Array<{ key: string; ok: boolean }> {
    return this.ctx.storage.sql.exec<{ key: string; ok: number }>("SELECT key, ok FROM approvals ORDER BY rowid").toArray().map((r) => ({ key: r.key, ok: r.ok === 1 }));
  }
  /** Every approval.decided payload this instance handled, as delivered. */
  decisions(): ApprovalDecided[] {
    return this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM decided ORDER BY rowid").toArray().map((r) => JSON.parse(r.payload) as ApprovalDecided);
  }
  poked(): string[] {
    return this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM pokes ORDER BY rowid").toArray().map((r) => r.id);
  }
  pokeCorrelations(): string[] {
    return this.ctx.storage.sql.exec<{ cid: string }>("SELECT cid FROM pokes ORDER BY rowid").toArray().map((r) => r.cid);
  }
  pingAt(time: number) {
    return this.pinger.pingAt(time);
  }
  pings(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT n FROM counters WHERE name = 'pings'").toArray()[0]?.n ?? 0;
  }
}

export default {
  async fetch(request, env) {
    const hooked = await handleWebhook(request, env, system);
    if (hooked !== null) return hooked;
    return new Response("runtime probe");
  },
  email: (message, env) => handleEmail(message, env, system),
} satisfies ExportedHandler<Env>;
