// Scribe: the probe system's agent actor (declared in index.ts). Its Pi sessions run beside actord in one Durable
// Object, as agent.session jobs (src/agents), on a scripted model.
import { DurableObject } from "cloudflare:workers";
import { Lifecycle, LifecycleCapability } from "agents/lifecycle";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { z } from "zod";
import { agentRuntime, type ScriptedRequest, type ScriptedTurn, scriptedModel } from "../../src/agents/index.ts";
import type { EffectAdapter, Envelope } from "../../src/runtime/index.ts";
// index.ts re-exports Scribe from here, so this import is circular: `system` is read only when an instance is built.
import { system } from "./index.ts";

/** A test's script for one instance, by its name: answers each model request (agents.test.ts installs them). */
type Script = (request: ScriptedRequest) => ScriptedTurn | Promise<ScriptedTurn>;
const shared = globalThis as { __scribeGate?: Promise<void>; __scribeScripts?: Record<string, Script>; __scribeInstructions?: Record<string, string>; __scribeNotedThrows?: Record<string, number>; __scribes?: Record<string, Scribe> };

/** The instructions an instance is built with, unless a test set others for its name. */
const INSTRUCTIONS = "You are Scribe. Write up the task you're given, then call finish with a summary.";

/**
 * Each instance's script, by its name: a script a test installed for it, read at each request; else "echo-…" calls
 * the echo tool, "json-…" calls its JSON Schema twin, and others say hello once a test opens `__scribeGate`, if it
 * set one, holding Pi's run in flight until then.
 */
function scriptFor(name: string): Parameters<typeof scriptedModel>[0] {
  if (name.startsWith("echo-")) {
    return [
      { calls: [{ name: "echo", args: { v: 1 } }], usage: { input: 10, output: 5, costUsd: 0.001 } },
      { text: "echoed", usage: { input: 20, output: 3, costUsd: 0.002 } },
    ];
  }
  if (name.startsWith("json-")) return [{ calls: [{ name: "echo", args: { v: "one" } }, { name: "echo", args: { v: 2 } }] }, { text: "done" }];
  return async (request): Promise<ScriptedTurn> => {
    const script = shared.__scribeScripts?.[name];
    if (script) return script(request);
    await shared.__scribeGate;
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
  // Tests reach Scribe by name; an id without one (idFromString, newUniqueId) gets the hello script and no tools.
  readonly #name = this.ctx.id.name ?? "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The newest instance by name, so a script can look at the instance whose model it answers (after a restart too).
    shared.__scribes = { ...shared.__scribes, [this.#name]: this };
    this.lifecycle.use(new JobLog());
    for (const table of ["fired (key TEXT NOT NULL)", "echo_calls (call_id TEXT NOT NULL, args TEXT NOT NULL)", "done (id TEXT NOT NULL, sender TEXT NOT NULL, summary TEXT NOT NULL)", "failures (type TEXT NOT NULL, payload TEXT NOT NULL)", "noted (effect TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL)", "results (key TEXT NOT NULL, status TEXT NOT NULL)"]) {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  }

  readonly actor = agentRuntime(
    { lifecycle: this.lifecycle, ctx: this.ctx, env: this.env },
    system,
    "Scribe",
    {
      "scribe.tick": ({ payload }, ctx) => {
        if (payload.delayMs !== undefined) ctx.after(payload.delayMs, "scribe.tick", { key: payload.key }, { key: payload.key });
        else ctx.sql.exec("INSERT INTO fired (key) VALUES (?)", payload.key);
      },
      "scribe.done": ({ id, from, payload }, ctx) => {
        ctx.sql.exec("INSERT INTO done (id, sender, summary) VALUES (?, ?, ?)", id, from, payload.summary);
      },
      "agent.failed": ({ type, payload }, ctx) => {
        ctx.sql.exec("INSERT INTO failures (type, payload) VALUES (?, ?)", type, JSON.stringify(payload));
      },
      "agent.exhausted": ({ type, payload }, ctx) => {
        ctx.sql.exec("INSERT INTO failures (type, payload) VALUES (?, ?)", type, JSON.stringify(payload));
      },
      // Optional for a tool effect's result message; it gets every one, steered into a session or not. A test can make
      // it throw for an instance's next deliveries (`__scribeNotedThrows`), to show the delivery is retried.
      "scribe.noted": ({ payload }, ctx) => {
        const throws = shared.__scribeNotedThrows;
        if (throws?.[this.#name]) {
          throws[this.#name]!--;
          throw new Error("the test made scribe.noted's handler throw");
        }
        ctx.sql.exec("INSERT INTO results (key, status) VALUES (?, ?)", payload.key, payload.status);
      },
    },
    {
      instructions: shared.__scribeInstructions?.[this.#name] ?? INSTRUCTIONS,
      model: scriptedModel(scriptFor(this.#name)),
      transcripts: this.env.TRANSCRIPTS,
      effects: { "note.keyed": noteAdapter(this.ctx.storage.sql, "note.keyed"), "note.plain": noteAdapter(this.ctx.storage.sql, "note.plain"), "note.approved": noteAdapter(this.ctx.storage.sql, "note.approved"), "note.silent": noteAdapter(this.ctx.storage.sql, "note.silent"), "note.hidden": noteAdapter(this.ctx.storage.sql, "note.hidden") },
      extensions: this.#name.startsWith("echo-") ? [{ name: "echo", tools: [echoTool(this.ctx.storage.sql)] }] : this.#name.startsWith("json-") ? [{ name: "echo", tools: [jsonEchoTool(this.ctx.storage.sql)] }] : [],
    },
  );

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
  submit(prompt: string, operationId: string, session?: string) {
    return this.actor.harness.submit(prompt, { operationId, ...(session ? { session } : {}) });
  }
  wait(operationId: string, session?: string) {
    return this.actor.harness.wait(operationId, session ? { session } : {});
  }
  pending() {
    return this.actor.harness.pending();
  }
  messages(session?: string) {
    return this.actor.harness.messages(session ? { session } : {});
  }
  async usage() {
    return (await this.actor.harness.pi()).usage(BACKGROUND_CONTEXT);
  }
  async piSessions() {
    return this.actor.harness.sessions.list();
  }
  decide(key: string, decision: "approve" | "deny") {
    return this.actor.decide(key, decision);
  }
  /** The tools pi offers the model in a session: the agent's own and its declared effects'. */
  async offeredTools(session: string): Promise<string[]> {
    const conversation = await (await this.actor.harness.pi()).conversation(Number(session) as never, BACKGROUND_CONTEXT);
    return (await conversation!.agent(BACKGROUND_CONTEXT)).tools.map((t) => t.name);
  }
  /** The tool results the actor's own scribe.noted handler recorded, in order. */
  results(): Array<{ key: string; status: string }> {
    return this.ctx.storage.sql.exec<{ key: string; status: string }>("SELECT key, status FROM results ORDER BY rowid").toArray();
  }
  /** The notes each note effect's adapter wrote, in order. */
  noted(): Array<{ effect: string; key: string; text: string }> {
    return this.ctx.storage.sql.exec<{ effect: string; key: string; text: string }>("SELECT effect, key, text FROM noted ORDER BY rowid").toArray();
  }
  probeNow(key: string) {
    return this.actor.probeNow("agent.session", key);
  }
  /** The job keys of the sessions whose budget this instance watches in memory. */
  watched(): string[] {
    return this.actor.watched();
  }
  outbox() {
    return this.actor.outbox();
  }
  /** The agent.session job's row body for a start message's id: its handle, settledBy and outcome. */
  job(key: string): Record<string, unknown> | null {
    const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM _actors_outbox WHERE id = ?", `fx:agent.session:${key}`).toArray()[0];
    return row ? (JSON.parse(row.body) as Record<string, unknown>) : null;
  }
  sessions(): Array<Record<string, unknown>> {
    return this.ctx.storage.sql.exec("SELECT * FROM _actors_agent_sessions ORDER BY generation").toArray();
  }
  done(): Array<{ id: string; sender: string; summary: string }> {
    return this.ctx.storage.sql.exec<{ id: string; sender: string; summary: string }>("SELECT id, sender, summary FROM done ORDER BY rowid").toArray();
  }
  failures(): Array<{ type: string; payload: Record<string, unknown> }> {
    return this.ctx.storage.sql.exec<{ type: string; payload: string }>("SELECT type, payload FROM failures ORDER BY rowid").toArray().map((r) => ({ type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
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

/** A note effect's adapter: it records the note and answers with it. */
function noteAdapter(sql: SqlStorage, effect: string): EffectAdapter<{ text: string }, { noted: string }> {
  return {
    async run({ text }, { key }) {
      sql.exec("INSERT INTO noted (effect, key, text) VALUES (?, ?, ?)", effect, key, text);
      return { noted: text };
    },
  };
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
