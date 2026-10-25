// A tiny system for runtime guarantees the reference apps can't reach without contortions.
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { actorRuntime, type Envelope } from "../../src/runtime/index.ts";
import { defineSystem, message } from "../../src/system.ts";

const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional() });

export const system = defineSystem({
  name: "runtime-probe",
  messages: {
    "probe.misbehave": message({ version: 1, description: "Ask for an undeclared effect", payload: z.object({}) }),
    "probe.effect": message({ version: 1, description: "Request a named effect", payload: z.object({ effect: z.enum(["gateway.reconcilable", "gateway.plain", "gateway.approval", "gateway.keyed"]), key: z.string() }) }),
    "probe.outcome": message({ version: 1, description: "Effect outcome", payload: Outcome }),
  },
  actors: {
    Probe: {
      binding: "PROBE",
      kind: "deterministic",
      purpose: "Exercises runtime edge cases",
      justification: ["state"],
      effects: ["gateway.reconcilable", "gateway.plain", "gateway.approval", "gateway.keyed"],
    },
  },
  effects: {
    "gateway.reconcilable": { description: "No key, but outcomes can be looked up", idempotency: "none", reconcile: true, result: "probe.outcome" },
    "gateway.plain": { description: "No key, no lookup", idempotency: "none", result: "probe.outcome" },
    "gateway.approval": { description: "Needs a person", idempotency: "key", approval: "human", result: "probe.outcome" },
    "gateway.keyed": { description: "Keyed", idempotency: "key", result: "probe.outcome" },
  },
  routes: [
    { from: "@ingress", message: "probe.misbehave", to: "Probe" },
    { from: "@ingress", message: "probe.effect", to: "Probe" },
    { from: "Probe", message: "probe.outcome", to: "Probe" },
  ],
});

export class Probe extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS outcomes (key TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT)");
  }

  actor = actorRuntime({ ctx: this.ctx, env: this.env }, system, "Probe", {
    "probe.misbehave": (_m, ctx) => {
      ctx.effect("gateway.undeclared" as never, {}, { key: "x" });
    },
    "probe.effect": ({ payload }, ctx) => {
      ctx.effect(payload.effect, { key: payload.key }, { key: payload.key });
    },
    "probe.outcome": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO outcomes (key, status, error) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET status = excluded.status, error = excluded.error", payload.key, payload.status, payload.error ?? null);
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
  alarm() {
    return this.actor.alarm();
  }
  decide(key: string, decision: "approve" | "deny") {
    return this.actor.decide(key, decision);
  }
  outcomes() {
    return this.ctx.storage.sql.exec<{ key: string; status: string; error: string | null }>("SELECT key, status, error FROM outcomes ORDER BY key").toArray();
  }
}

export default { fetch: () => new Response("runtime probe") } satisfies ExportedHandler<Env>;
