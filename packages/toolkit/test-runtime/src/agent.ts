// A Durable Object that hosts a Pi session beside actord, the way an agent actor will (spike 3).
import { DurableObject } from "cloudflare:workers";
import { Lifecycle, LifecycleCapability } from "agents/lifecycle";
import { PiHarness } from "agents/harness/pi";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { z } from "zod";
import { type ScriptedTurn, scriptedModel } from "../../src/agents/index.ts";
import { actorRuntime, type Envelope } from "../../src/runtime/index.ts";
import { defineSystem, message } from "../../src/system.ts";

export const scribeSystem = defineSystem({
  name: "scribe-probe",
  messages: {
    // From @ingress, with delayMs, it sets a timer that delivers it again from @timer, without.
    "scribe.tick": message({ version: 1, description: "Set a timer, or a timer fired", payload: z.object({ key: z.string(), delayMs: z.number().optional() }) }),
  },
  actors: {
    Scribe: { binding: "SCRIBE", kind: "deterministic", purpose: "Hosts a Pi session beside actord", justification: ["state"] },
  },
  routes: [
    { from: "@ingress", message: "scribe.tick", to: "Scribe" },
    { from: "@timer", message: "scribe.tick", to: "Scribe" },
  ],
});

/**
 * Each instance's script, by its name: "echo-…" calls the echo tool, "json-…" calls its JSON Schema twin, and others
 * say hello once a test opens `__scribeGate`, if it set one, holding Pi's run in flight until then.
 */
function scriptFor(name: string): Parameters<typeof scriptedModel>[0] {
  if (name.startsWith("echo-")) {
    return [
      { calls: [{ name: "echo", args: { v: 1 } }], usage: { input: 10, output: 5, costUsd: 0.001 } },
      { text: "echoed", usage: { input: 20, output: 3, costUsd: 0.002 } },
    ];
  }
  if (name.startsWith("json-")) return [{ calls: [{ name: "echo", args: { v: "one" } }, { name: "echo", args: { v: 2 } }] }, { text: "done" }];
  return async (): Promise<ScriptedTurn> => {
    await (globalThis as { __scribeGate?: Promise<void> }).__scribeGate;
    return { text: "hello" };
  };
}

/** Records each set of job ids cf_agents_jobs holds when a job is added or changed, to show which were due together. */
class JobLog extends LifecycleCapability {
  constructor() {
    super("job-log");
  }
  onStart(): void {
    const sql = this.lifecycle.storage.sql;
    this.lifecycle.jobs.get("job-log"); // Lifecycle creates its job table on first use; the triggers need it
    sql.exec("CREATE TABLE IF NOT EXISTS job_sets (ids TEXT NOT NULL)");
    for (const event of ["INSERT", "UPDATE"]) {
      sql.exec(`CREATE TRIGGER IF NOT EXISTS job_sets_${event.toLowerCase()} AFTER ${event} ON cf_agents_jobs BEGIN
        INSERT INTO job_sets (ids) SELECT group_concat(id, ',') FROM (SELECT id FROM cf_agents_jobs ORDER BY id); END`);
    }
  }
}

export class Scribe extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);
  readonly script = scriptedModel(scriptFor(this.ctx.id.name ?? ""));
  // One per object, never at module scope: pi keeps each Harness subscribed to its registry until it closes.
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => Harness.open(storage, { models: this.script.models, registry: this.registry, onWake }, context),
    defaults: { model: this.script.model },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(new JobLog());
    this.lifecycle.use(this.harness);
    const name = ctx.id.name ?? "";
    if (name.startsWith("echo-")) this.registry.install({ name: "echo", tools: [echoTool(ctx.storage.sql)] });
    if (name.startsWith("json-")) this.registry.install({ name: "echo", tools: [jsonEchoTool(ctx.storage.sql)] });
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fired (key TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS echo_calls (call_id TEXT NOT NULL, args TEXT NOT NULL)");
  }

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, scribeSystem, "Scribe", {
    "scribe.tick": ({ payload }, ctx) => {
      if (payload.delayMs !== undefined) ctx.after(payload.delayMs, "scribe.tick", { key: payload.key }, { key: payload.key });
      else ctx.sql.exec("INSERT INTO fired (key) VALUES (?)", payload.key);
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
  submit(prompt: string, operationId: string) {
    return this.harness.submit(prompt, { operationId });
  }
  wait(operationId: string) {
    return this.harness.wait(operationId);
  }
  pending() {
    return this.harness.pending();
  }
  messages() {
    return this.harness.messages();
  }
  async usage() {
    return (await this.harness.pi()).usage(BACKGROUND_CONTEXT);
  }
  fired(): string[] {
    return this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM fired ORDER BY rowid").toArray().map((r) => r.key);
  }
  jobSets(): string[][] {
    return this.ctx.storage.sql.exec<{ ids: string }>("SELECT ids FROM job_sets ORDER BY rowid").toArray().map((r) => r.ids.split(","));
  }
  echoCalls(): Array<{ callId: string; args: unknown }> {
    return this.ctx.storage.sql.exec<{ call_id: string; args: string }>("SELECT call_id, args FROM echo_calls ORDER BY rowid").toArray().map((r) => ({ callId: r.call_id, args: JSON.parse(r.args) }));
  }
}

/**
 * A stand-in for `ctx.container`, which Durable Objects under @cloudflare/vitest-plugin don't have (spike 3), for
 * container tests to install. `running` follows `start` and `destroy`, `calls` records them, and
 * `getTcpPort(port).fetch` answers with the handler a test sets in `ports` while the container runs.
 */
export class ContainerStub {
  running = false;
  readonly calls: Array<{ op: "start" | "destroy"; options?: unknown }> = [];
  readonly ports = new Map<number, (request: Request) => Response | Promise<Response>>();

  start(options?: unknown): void {
    this.calls.push({ op: "start", options });
    this.running = true;
  }
  async destroy(): Promise<void> {
    this.calls.push({ op: "destroy" });
    this.running = false;
  }
  getTcpPort(port: number): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } {
    return {
      fetch: async (input, init) => {
        const handler = this.ports.get(port);
        if (!this.running || !handler) throw new Error(`the container is not listening on port ${port}`);
        return handler(new Request(input, init));
      },
    };
  }
}

const Echo = Type.Object({ v: Type.Number() });

function echoTool(sql: SqlStorage): ToolRegistration<typeof Echo> {
  return {
    name: "echo",
    description: "Echo a number back.",
    parameters: Echo,
    async execute({ v }, api) {
      sql.exec("INSERT INTO echo_calls (call_id, args) VALUES (?, ?)", api.callId, JSON.stringify({ v }));
      return { output: [{ type: "text", text: `echo ${v}` }] };
    },
  };
}

/** The same tool, its parameters plain JSON Schema as Computer's Pi tools give them. */
function jsonEchoTool(sql: SqlStorage): ToolRegistration {
  return {
    name: "echo",
    description: "Echo a number back.",
    parameters: z.toJSONSchema(z.object({ v: z.number() })) as ToolRegistration["parameters"],
    async execute(args, api) {
      sql.exec("INSERT INTO echo_calls (call_id, args) VALUES (?, ?)", api.callId, JSON.stringify(args));
      return { output: [{ type: "text", text: `echo ${(args as { v: number }).v}` }] };
    },
  };
}
