// Scribe and Builder: the probe system's agent actors (declared in index.ts). Their Pi sessions run beside actord in
// one Durable Object, as agent.session jobs (src/agents), on a scripted model. Builder's tools are a Computer workspace.
import { DurableObject } from "cloudflare:workers";
import { Lifecycle, LifecycleCapability } from "agents/lifecycle";
import { Type } from "@earendil-works/pi-ai";
import { type Extension, hook, ToolTask, type ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { z } from "zod";
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { agentRuntime, RegistryReadGateway, type ScriptedRequest, type ScriptedTurn, scriptedModel, withWorkspaceContainer } from "../../src/agents/index.ts";
import type { EffectAdapter, Envelope } from "../../src/runtime/index.ts";
import { decisionAdapters } from "../../src/decisions/index.ts";
// index.ts re-exports Scribe from here, so this import is circular: `system` and `stubAi` are read only when an
// instance is built.
import { stubAi, system } from "./index.ts";

/** A test's script for one instance, by its name: answers each model request (agents.test.ts installs them). */
type Script = (request: ScriptedRequest) => ScriptedTurn | Promise<ScriptedTurn>;
const shared = globalThis as { __scribeGate?: Promise<void>; __scribeToolGates?: Record<string, () => Promise<void>>; __scribeScripts?: Record<string, Script>; __scribeInstructions?: Record<string, string>; __scribeNotedThrows?: Record<string, number>; __scribes?: Record<string, Scribe> };

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
      // judge.task is a decision: its result, scribe.judged, starts a session (Scribe's `on`).
      "scribe.judge": ({ payload }, ctx) => {
        ctx.effect("judge.task", { state: payload.state }, { key: payload.key });
      },
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
      effects: { ...decisionAdapters(system, { ai: stubAi }), "note.keyed": noteAdapter(this.ctx.storage.sql, "note.keyed"), "note.plain": noteAdapter(this.ctx.storage.sql, "note.plain"), "note.approved": noteAdapter(this.ctx.storage.sql, "note.approved"), "note.silent": noteAdapter(this.ctx.storage.sql, "note.silent"), "note.hidden": noteAdapter(this.ctx.storage.sql, "note.hidden") },
      extensions: this.#name.startsWith("echo-") ? [{ name: "echo", tools: [echoTool(this.ctx.storage.sql)] }] : this.#name.startsWith("json-") ? [{ name: "echo", tools: [jsonEchoTool(this.ctx.storage.sql)] }] : this.#name.startsWith("toolgate-") ? [toolGate(this.#name)] : [],
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
 * container tests to install. `running` follows `start` and `destroy`, `calls` records them and the egress intercepts,
 * and `getTcpPort(port).fetch` answers with the handler a test sets in `ports` while the container runs. `destroy`
 * fails the requests still in flight and settles `monitor()`, as a container's exit does. With `failStart` set, `start`
 * throws it. It runs nothing: Computer's computerd never answers, so a ContainerBackend over it never connects.
 */
export class ContainerStub {
  running = false;
  readonly calls: Array<{ op: "start" | "destroy" | "intercept"; options?: unknown }> = [];
  readonly ports = new Map<number, (request: Request) => Response | Promise<Response>>();
  /** What Computer's container host picks an image from by name, as wrangler's `images` block gives it. */
  readonly images: Record<string, string> = { app: "stub-image" };
  /** The fetchers egress was handed to, by what they intercept: the container's outbound requests would go to them. */
  readonly egress: Array<{ kind: "http" | "all" | "https"; host?: string; fetcher: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } }> = [];
  failStart?: string;
  #exit = Promise.withResolvers<void>();
  readonly #inFlight = new Set<(reason: Error) => void>();

  start(options?: unknown): void {
    this.calls.push({ op: "start", options });
    if (this.failStart) throw new Error(this.failStart);
    this.running = true;
    this.#exit = Promise.withResolvers<void>();
  }
  monitor(): Promise<void> {
    return this.#exit.promise;
  }
  async destroy(): Promise<void> {
    this.calls.push({ op: "destroy" });
    this.running = false;
    for (const fail of this.#inFlight) fail(new Error("the container was destroyed"));
    this.#inFlight.clear();
    this.#exit.resolve();
  }
  async setInactivityTimeout(_ms: number): Promise<void> {}
  interceptOutboundHttp(host: string, fetcher: ContainerStub["egress"][number]["fetcher"]): void {
    this.#intercept("http", fetcher, host);
  }
  interceptAllOutboundHttp(fetcher: ContainerStub["egress"][number]["fetcher"]): void {
    this.#intercept("all", fetcher);
  }
  interceptOutboundHttps(host: string, fetcher: ContainerStub["egress"][number]["fetcher"]): void {
    this.#intercept("https", fetcher, host);
  }
  #intercept(kind: "http" | "all" | "https", fetcher: ContainerStub["egress"][number]["fetcher"], host?: string): void {
    this.calls.push({ op: "intercept", options: { kind, ...(host === undefined ? {} : { host }) } });
    this.egress.push({ kind, ...(host === undefined ? {} : { host }), fetcher });
  }
  getTcpPort(port: number): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } {
    return {
      fetch: async (input, init) => {
        const handler = this.ports.get(port);
        if (!this.running || !handler) throw new Error(`the container is not listening on port ${port}`);
        let fail!: (reason: Error) => void;
        const destroyed = new Promise<never>((_, reject) => (fail = reject));
        this.#inFlight.add(fail);
        try {
          return await Promise.race([handler(new Request(input, init)), destroyed]);
        } finally {
          this.#inFlight.delete(fail);
        }
      },
    };
  }
}

/** Put `stub` where Computer's container host looks for the container: `ctx.container`, which the plugin leaves out. */
function withContainer(ctx: DurableObjectState, stub: ContainerStub): ContainerStub {
  Object.defineProperty(ctx, "container", { value: stub, configurable: true });
  return stub;
}

/** One command a HeldBackend runs: what it was asked, and how the test ends it. */
export interface HeldRun {
  source: string;
  env: Record<string, string> | undefined;
  timeoutMs: number | undefined;
  exit(code: number, stdout: string): void;
  lose(error: Error): void;
}

/**
 * A command backend of the test's own (Computer's public WorkspaceBackend), for what the stub can't show: a command
 * that is running. Each exec starts a run that stays open until the test ends it (`exit`) or loses it (`lose`: its
 * event stream fails, as when the container's connection breaks mid-command); `onRun` sees each run as it starts, in
 * the object's own context. Nothing syncs: the files stay in vfs_*.
 */
export class HeldBackend implements WorkspaceBackend {
  readonly id = "container";
  readonly type = "test-held";
  readonly description = "A Linux shell (a stand-in the test drives).";
  readonly runs: HeldRun[] = [];
  constructor(readonly onRun?: (run: HeldRun) => void) {}
  async connect(): Promise<BackendHandle> {
    const shell = {
      exec: async (input: { source: string; id?: string; env?: Record<string, string>; timeoutMs?: number }) => {
        const id = input.id ?? `run-${this.runs.length + 1}`;
        let events!: ReadableStreamDefaultController<unknown>;
        const stream = new ReadableStream({ start: (c) => void (events = c) });
        const run: HeldRun = {
          source: input.source,
          env: input.env,
          timeoutMs: input.timeoutMs,
          exit(code, stdout) {
            events.enqueue({ id, seq: 0, name: "stdout", value: new TextEncoder().encode(stdout) });
            events.enqueue({ id, seq: 1, name: "exit", code });
            events.close();
          },
          lose: (error) => events.error(error),
        };
        this.runs.push(run);
        this.onRun?.(run);
        return { id, events: stream };
      },
      getExec: async () => {
        throw new Error("the container was destroyed");
      },
      killExec: async () => {},
      disposeExec: async () => {},
    };
    return { rpc: { shell, sync: {} } as unknown as BackendHandle["rpc"], sync: "none", close: async () => {} };
  }
}

/** A test's script for one Builder instance, by its name (without one, it says hello), and what a "held-…" one's commands do. */
const builders = globalThis as { __builderScripts?: Record<string, Script>; __builderRuns?: Record<string, (run: HeldRun) => void> };

/**
 * Builder: the probe system's agent actor with a Computer workspace whose commands run in a container (declared in
 * index.ts). Its container is a ContainerStub (spike 3), driven by Computer's own container host; its registry-read
 * gateway forwards to `upstream`, which records each request and answers for the registry, so no test reaches the network.
 */
export class Builder extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly lifecycle = Lifecycle.install(this);
  readonly #name = this.ctx.id.name ?? "";
  readonly container = withContainer(this.ctx, new ContainerStub());
  readonly upstream: Array<{ method: string; url: string; headers: Record<string, string> }> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const table of ["done (summary TEXT NOT NULL)", "failures (type TEXT NOT NULL, payload TEXT NOT NULL)"]) ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table}`);
  }

  readonly actor = agentRuntime(
    { lifecycle: this.lifecycle, ctx: this.ctx, env: this.env },
    system,
    "Builder",
    {
      "builder.done": ({ payload }, ctx) => {
        ctx.sql.exec("INSERT INTO done (summary) VALUES (?)", payload.summary);
      },
      "agent.failed": ({ type, payload }, ctx) => {
        ctx.sql.exec("INSERT INTO failures (type, payload) VALUES (?, ?)", type, JSON.stringify(payload));
      },
      "agent.exhausted": ({ type, payload }, ctx) => {
        ctx.sql.exec("INSERT INTO failures (type, payload) VALUES (?, ?)", type, JSON.stringify(payload));
      },
    },
    {
      instructions: "You are Builder. Change the files the task names, run its command, then call finish with a summary.",
      model: scriptedModel(async (request) => builders.__builderScripts?.[this.#name]?.(request) ?? { text: "hello" }),
      container: this,
      // A "held-…" instance runs its commands on a HeldBackend, which the test drives through `__builderRuns`.
      ...(this.#name.startsWith("held-") ? { backend: new HeldBackend((run) => builders.__builderRuns?.[this.#name]?.(run)) } : {}),
      gateway: new RegistryReadGateway({
        fetch: async (request) => {
          this.upstream.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers) });
          return new Response(`registry stub: ${request.method} ${new URL(request.url).pathname}`);
        },
      }),
    },
  );

  /** The container's computerd connection and its egress requests arrive here. */
  async fetch(request: Request): Promise<Response> {
    return this.actor.fetch(request);
  }
  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
  messages(session?: string) {
    return this.actor.harness.messages(session ? { session } : {});
  }
  sessions(): Array<Record<string, unknown>> {
    return this.ctx.storage.sql.exec("SELECT * FROM _actors_agent_sessions ORDER BY generation").toArray();
  }
  done(): string[] {
    return this.ctx.storage.sql.exec<{ summary: string }>("SELECT summary FROM done ORDER BY rowid").toArray().map((r) => r.summary);
  }
  failures(): Array<{ type: string; payload: Record<string, unknown> }> {
    return this.ctx.storage.sql.exec<{ type: string; payload: string }>("SELECT type, payload FROM failures ORDER BY rowid").toArray().map((r) => ({ type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }
  readFile(path: string): Promise<string> {
    return this.actor.workspace!.fs.readFile(path, "utf8");
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

/** For "toolgate-…" instances: every tool call waits, before it runs, on the instance's `__scribeToolGates` entry, if any. */
function toolGate(name: string): Extension {
  return { name: "toolgate", hooks: [hook(ToolTask, { beforeTool: async () => void (await shared.__scribeToolGates?.[name]?.()) })] };
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
