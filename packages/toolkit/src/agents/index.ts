// @actord/toolkit/agents: agent actors on Pi and Computer. The only entry point that imports @earendil-works/* or
// @cloudflare/computer, so the runtime, system, sources and testing entry points stay free of them.
//
// An agent actor's Pi sessions run as one internal job effect, agent.session (decision 0018's jobs), keyed by the id
// of the message that started the session:
// - A message the actor's `on` maps to "start" opens a new pi session and submits the message, rendered, as its
//   prompt. A start while a session runs replaces it: the running job is cancelled (pi aborts the session) and the
//   new session gets the next generation. "steer" joins the running turn; "stop" cancels the job. A stop or a
//   replacement that lands before the session's start has returned is kept on its row (a stop mark, a newer
//   generation), and the start acts on it: before pi is asked, it starts nothing; after, it aborts the session.
// - The `finish` tool, whose parameters are the `returns` message's schema, records the session's result and asks
//   for a look now. The job's probe settles it: confirmed with the result; failed once pi has no work left for the
//   session and no tool effect of it awaits approval; failed "exhausted:<budget>" once a budget ran out.
// - The job's result message, agent.session.settled, becomes the `returns` message, agent.exhausted or agent.failed,
//   sent to the actor itself. A session a later start replaced settles with a note only, and so does its finish.
// - Each session keeps the instructions it started with, so a deploy that changes the instructions reaches new
//   sessions only. They are the session's own pi instructions (its "instructions" prompt section, a key pi reserves
//   for them), set from its row when it starts.
import { PiHarness, type PiReceipt } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { type Api, createModels, type Model, type ModelThinkingLevel, type MutableModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, createRegistry, type Extension, Harness, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  type ActorHost,
  type ActorRuntime,
  actorRuntime,
  type EffectAdapter,
  EffectNotDelivered,
  EffectRejected,
  type EffectUsage,
  emit,
  type HandlerContext,
  type Handlers,
  type InternalHandlers,
  type JobAdapter,
  type Message,
  type RuntimeOptions,
} from "../runtime/index.ts";
import { type ActorName, type ActorSpec, type Duration, durationMs, type StandardResult, type StandardSchemaV1, type System } from "../system.ts";
import type { scriptedModel } from "./scripted-model.ts";

export { type ScriptedRequest, type ScriptedTurn, scriptedModel } from "./scripted-model.ts";

type AnySystem = System;

/** The internal job effect an agent session runs as, and the message its outcome comes back as. */
const SESSION = "agent.session";
const SETTLED = "agent.session.settled";
/** The internal call effect that hands a steering message to a running session. */
const STEER = "agent.session.steer";
/** How often a waiting session is looked at, and how long past the actor's wallClock budget its job may wait. */
const PROBE_EVERY: Duration = "30s";
const DEADLINE_GRACE_MS = 10 * 60_000;
const BUDGETS = ["usd", "turns", "wallClock"] as const;
/** The `model.reasoning` an actor declares, as pi's thinking level for its sessions. */
const THINKING: Record<"low" | "medium" | "high", ModelThinkingLevel> = { low: "low", medium: "medium", high: "high" };

// ---- The messages an agent actor receives about its sessions ----

/** The payload of `agent.failed`: a session ended without a result. `session` is "" when pi never opened one. */
export interface AgentFailed {
  session: string;
  key: string;
  reason: string;
  usage?: EffectUsage;
}
/** The payload of `agent.exhausted`: a session ran out of one of its actor's budgets. */
export interface AgentExhausted {
  session: string;
  key: string;
  budget: (typeof BUDGETS)[number];
  usage?: EffectUsage;
}

type Issue = { message: string; path: [string] | [] };
const USAGE_FIELDS = ["inputTokens", "outputTokens", "costUsd", "containerSeconds"] as const;

/** Checks the fields every session message has, and copies the declared ones. */
function sessionFields(value: unknown, issues: Issue[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push({ message: "expected an object", path: [] });
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.session !== "string") issues.push({ message: "session: expected a string", path: ["session"] });
  if (typeof v.key !== "string" || v.key === "") issues.push({ message: "key: expected a non-empty string", path: ["key"] });
  if (v.usage !== undefined) {
    const u = v.usage as Record<string, unknown> | null;
    if (typeof u !== "object" || u === null || Array.isArray(u)) issues.push({ message: "usage: expected an object", path: ["usage"] });
    else for (const f of USAGE_FIELDS) if (u[f] !== undefined && (typeof u[f] !== "number" || !Number.isFinite(u[f]) || (u[f] as number) < 0)) issues.push({ message: `usage.${f}: expected a finite number at or above 0`, path: ["usage"] });
  }
  return v;
}
const usageOf = (v: Record<string, unknown>) => (v.usage === undefined ? {} : { usage: Object.fromEntries(USAGE_FIELDS.filter((f) => (v.usage as Record<string, unknown>)[f] !== undefined).map((f) => [f, (v.usage as Record<string, unknown>)[f]])) });

const usageJsonSchema = () => ({ type: "object", properties: Object.fromEntries(USAGE_FIELDS.map((f) => [f, { type: "number", minimum: 0 }])), additionalProperties: false });

/** The Standard Schema for `agent.failed`'s payload, written by hand so apps need no schema library. */
export const agentFailed: StandardSchemaV1<AgentFailed> = {
  "~standard": {
    version: 1,
    vendor: "actord",
    validate(value): StandardResult<AgentFailed> {
      const issues: Issue[] = [];
      const v = sessionFields(value, issues);
      if (v && typeof v.reason !== "string") issues.push({ message: "reason: expected a string", path: ["reason"] });
      if (!v || issues.length > 0) return { issues };
      return { value: { session: v.session, key: v.key, reason: v.reason, ...usageOf(v) } as AgentFailed };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { session: { type: "string" }, key: { type: "string", minLength: 1 }, reason: { type: "string" }, usage: usageJsonSchema() },
        required: ["session", "key", "reason"],
        additionalProperties: false,
      }),
    },
  },
};

/** The Standard Schema for `agent.exhausted`'s payload, written by hand so apps need no schema library. */
export const agentExhausted: StandardSchemaV1<AgentExhausted> = {
  "~standard": {
    version: 1,
    vendor: "actord",
    validate(value): StandardResult<AgentExhausted> {
      const issues: Issue[] = [];
      const v = sessionFields(value, issues);
      if (v && !BUDGETS.includes(v.budget as AgentExhausted["budget"])) issues.push({ message: 'budget: expected "usd", "turns" or "wallClock"', path: ["budget"] });
      if (!v || issues.length > 0) return { issues };
      return { value: { session: v.session, key: v.key, budget: v.budget, ...usageOf(v) } as AgentExhausted };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { session: { type: "string" }, key: { type: "string", minLength: 1 }, budget: { type: "string", enum: [...BUDGETS] }, usage: usageJsonSchema() },
        required: ["session", "key", "budget"],
        additionalProperties: false,
      }),
    },
  },
};

/** agent.session.settled: the job's outcome, as every job effect's result message carries it. */
interface Settled {
  key: string;
  status: "confirmed" | "failed" | "in_doubt";
  value?: unknown;
  error?: string;
  usage?: EffectUsage;
}
const settled: StandardSchemaV1<Settled> = {
  "~standard": {
    version: 1,
    vendor: "actord",
    validate(value): StandardResult<Settled> {
      const v = value as Partial<Settled> | null;
      if (typeof v !== "object" || v === null || typeof v.key !== "string" || !["confirmed", "failed", "in_doubt"].includes(v.status as string)) {
        return { issues: [{ message: "expected { key, status: confirmed | failed | in_doubt }" }] };
      }
      return { value: v as Settled };
    },
  },
};

// ---- agentRuntime ----

export interface AgentRuntimeOptions<S extends AnySystem = AnySystem> extends RuntimeOptions<S> {
  /** The text of the actor's `instructions` file, imported by the Worker (a wrangler Text module). */
  instructions: string;
  /** Test seam: a scripted model instead of Workers AI (`scriptedModel`). */
  model?: ReturnType<typeof scriptedModel>;
  /** The prompt an `on` message becomes; default: "<type>\n\n" + JSON of the payload, indented. */
  render?(type: string, payload: unknown): string;
  /** More pi extensions to install beside the agent's own (its `finish` tool and instructions). */
  extensions?: readonly Extension[];
}

export interface AgentRuntime extends ActorRuntime {
  readonly harness: PiHarness;
}

/** The messages an agent actor's `on` maps to a verb: agentRuntime handles them itself. */
type OnMessages<S extends AnySystem, A extends ActorName<S>> = Extract<keyof NonNullable<S["actors"][A]["on"]>, string>;
/** Handlers for every message the actor receives except its `on` messages. */
export type AgentHandlers<S extends AnySystem, A extends ActorName<S>> = Omit<Handlers<S, A>, OnMessages<S, A>>;

/** What a session's job handle records: pi's session id, the operation its prompt was submitted as, its generation. */
interface SessionHandle {
  session: string;
  operation: string;
  generation: number;
}
interface SessionRow {
  key: string;
  session: string | null;
  operation: string;
  generation: number;
  instructions: string;
  started_at: number;
  result: string | null;
  exhausted: string | null;
  /** When a stop landed before the session's start had returned, so the job couldn't be cancelled yet. */
  stopped_at: number | null;
}

/** One row per session the actor started: the job's key, pi's session id once open, the result `finish` recorded. */
const SESSIONS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS _actors_agent_sessions (key TEXT PRIMARY KEY, session TEXT, operation TEXT NOT NULL, generation INTEGER NOT NULL, instructions TEXT NOT NULL, started_at INTEGER NOT NULL, result TEXT, exhausted TEXT, stopped_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS _actors_agent_sessions_session ON _actors_agent_sessions (session)",
];
/** Job statuses of a session that is still running or about to: a steer joins it, a start replaces it. */
const LIVE = new Set(["pending", "running", "awaiting_job"]);
const STOPPED = "stopped";
const NOT_STEERED = "the session has ended; not steered";

const defaultRender = (type: string, payload: unknown) => `${type}\n\n${JSON.stringify(payload, null, 2)}`;
const text = (t: string): ToolExecutionResult["output"] => [{ type: "text", text: t }];

/** The Standard JSON Schema of a payload, or null when the schema library offers none. */
function jsonSchemaOf(schema: StandardSchemaV1): Record<string, unknown> | null {
  try {
    return schema["~standard"].jsonSchema?.input({ target: "draft-2020-12" }) ?? null;
  } catch {
    return null;
  }
}

/**
 * An agent actor's runtime: actord, with its Pi sessions as agent.session jobs. Installs PiHarness on
 * host.lifecycle beside actord; `handlers` cover every message except the actor's `on` messages, which drive
 * sessions. The actor declares `returns`, a self-route for it and for agent.failed and agent.exhausted
 * (`actord check` requires them), and `budget.wallClock`, which bounds a session's job.
 */
export function agentRuntime<S extends AnySystem, A extends ActorName<S>>(
  host: ActorHost & { env: { AI?: unknown } },
  system: S,
  actor: A,
  handlers: AgentHandlers<S, A>,
  options: AgentRuntimeOptions<S>,
): AgentRuntime {
  const spec = system.actors[actor] as ActorSpec | undefined;
  if (!spec) throw new Error(`actord: ${actor} is not declared in system ${system.name}`);
  const returns = spec.returns;
  const returnsSpec = returns === undefined ? undefined : system.messages[returns];
  if (returns === undefined || !returnsSpec) throw new Error(`actord: agent actor ${actor} must declare \`returns\`, a declared message its result is delivered as`);
  const returnsSchema = returnsSpec.payload;
  const wallClockMs = spec.budget?.wallClock === undefined ? null : durationMs(spec.budget.wallClock);
  if (wallClockMs === null) throw new Error(`actord: agent actor ${actor} must declare budget.wallClock, a duration like "30m"`);
  const { instructions, model: scripted, render = defaultRender, extensions = [], ...runtimeOptions } = options;
  const now = options.now ?? (() => Date.now());
  const { ctx } = host;
  const sql = ctx.storage.sql;
  const self = `${actor}:${ctx.id.name ?? ctx.id.toString()}`;
  for (const q of SESSIONS_SCHEMA) sql.exec(q);

  const rowByKey = (key: string) => sql.exec<SessionRow>("SELECT * FROM _actors_agent_sessions WHERE key = ?", key).toArray()[0];
  const rowBySession = (session: string) => sql.exec<SessionRow>("SELECT * FROM _actors_agent_sessions WHERE session = ?", session).toArray()[0];
  /** The newest session: the only one whose result is delivered. */
  const latest = () => sql.exec<SessionRow>("SELECT * FROM _actors_agent_sessions ORDER BY generation DESC LIMIT 1").toArray()[0];
  // The job's row in the runtime's outbox (runtime/index.ts SCHEMA): its status, and below, its body's key.
  const jobStatus = (key: string) => sql.exec<{ status: string }>("SELECT status FROM _actors_outbox WHERE id = ?", `fx:${SESSION}:${key}`).toArray()[0]?.status;
  /** Why a session must not run any more, read fresh: a stop kept on its row, or a newer start. Null while it may. */
  const halted = (key: string): string | null => {
    const row = rowByKey(key);
    if (row?.stopped_at != null) return STOPPED;
    return row && latest()?.generation !== row.generation ? "replaced by a newer start" : null;
  };
  /** Whether a tool effect of this session (keyed "<session>:<callId>") waits for a person. */
  const awaitingApproval = (session: string) =>
    sql.exec("SELECT 1 FROM _actors_outbox WHERE kind = 'effect' AND status = 'awaiting_approval' AND substr(json_extract(body, '$.key'), 1, ?) = ? LIMIT 1", session.length + 1, `${session}:`).toArray().length > 0;

  // ---- Pi ----
  const { models, model } = scripted ?? workersAI(actor, spec, host.env.AI);
  const reasoning = spec.model?.reasoning;
  // One per object, never at module scope: pi keeps each Harness subscribed to its registry until it closes.
  const registry = createRegistry();
  registry.install({ name: "actord.agent", tools: [finishTool()] });
  for (const extension of extensions) registry.install(extension);
  const harness = new PiHarness({
    harness: ({ storage, context, onWake }) => Harness.open(storage, { models, registry, onWake }, context),
    defaults: { model, ...(reasoning ? { thinkingLevel: THINKING[reasoning] } : {}) },
  });

  /** When pi settles an operation, look at the session's job now rather than at its next probe. In memory only. */
  const watch = (session: string, operation: string, key: string) => {
    harness
      .wait(operation, { session })
      .then(() => runtime.probeNow(SESSION, key))
      .catch(() => undefined); // pi closed, or the object went away: the job's probe period is the backstop
  };

  const sessionJob: JobAdapter<{ prompt: string }, SessionHandle> = {
    async start(input, { key }) {
      const row = rowByKey(key);
      if (!row) throw new EffectRejected(`no agent session was recorded for ${key}`);
      // Stopped or replaced while this start waited (to run, or to be tried again): pi is never asked.
      const before = halted(key);
      if (before) throw new EffectRejected(before);
      let session = row.session;
      if (session === null) {
        // A start retried after a restart reuses the session it recorded; a crash before the record leaves an empty one.
        session = (await harness.sessions.create()).id;
        sql.exec("UPDATE _actors_agent_sessions SET session = ? WHERE key = ?", session, key);
      }
      // The instructions the session started with, before its prompt; setting them again on a retry changes nothing.
      const conversation = await (await harness.pi()).conversation(Number(session) as ConversationId, BACKGROUND_CONTEXT);
      if (!conversation) throw new EffectRejected(`pi has no session ${session}`);
      await conversation.configure({ instructions: row.instructions }, BACKGROUND_CONTEXT);
      // The operation id makes the submit idempotent: a retry is accepted: false, and nothing runs twice.
      await harness.session(session).submit(input.prompt, { operationId: row.operation });
      // Stopped or replaced while this start ran, too early to cancel the job: stop the session now. Its probe then
      // settles the job: failed "stopped", or, once replaced, a note.
      if (halted(key)) await harness.abort({ session });
      watch(session, row.operation, key);
      return { session, operation: row.operation, generation: row.generation };
    },
    async probe(handle, { key }) {
      // pi's work first, then the row: finish records a result before its run ends, so a run found ended had recorded it.
      const pending = await harness.pending({ session: handle.session });
      const row = rowByKey(key);
      if (row?.result != null) return { done: true, status: "confirmed", value: JSON.parse(row.result) as unknown };
      if (row?.exhausted != null) {
        // Out of budget: the session must stop spending, whatever it was doing.
        await harness.abort({ session: handle.session });
        return { done: true, status: "failed", error: `exhausted:${row.exhausted}` };
      }
      if (row?.stopped_at != null) return { done: true, status: "failed", error: STOPPED };
      // A session being stopped has no work left by design: its cancel, not this look, settles it.
      if (pending.length > 0 || awaitingApproval(handle.session) || jobStatus(key) === "cancelling") return { done: false };
      return { done: true, status: "failed", error: "ended without returning a result" };
    },
    async cancel(handle) {
      return harness.abort({ session: handle.session });
    },
  };

  /**
   * Steer only a session whose job still runs, and whose run is going: pi takes a steer to an idle session as new
   * input, which would start a run no job tracks, whose result would go nowhere.
   */
  const steerCall: EffectAdapter<{ key: string; prompt: string }, PiReceipt> = {
    async run(input, { key: operationId }) {
      const row = rowByKey(input.key);
      if (!row) throw new EffectRejected(`no agent session was recorded for ${input.key}`);
      const notSteered = (why: Record<string, unknown>) => {
        emit({ kind: "note", at: now(), actor: self, effect: STEER, effectKey: operationId, reason: NOT_STEERED, detail: { key: input.key, ...why } });
        return new EffectRejected(NOT_STEERED);
      };
      const status = jobStatus(input.key);
      if (!LIVE.has(status ?? "") || halted(input.key)) throw notSteered({ job: status ?? null, halted: halted(input.key) });
      // Sent before the start returns, a steer could reach pi ahead of the prompt it is meant to follow.
      if (row.session === null || status !== "awaiting_job") throw new EffectNotDelivered("the session's start hasn't returned yet");
      const session = row.session;
      if ((await harness.pending({ session })).length === 0) throw notSteered({ job: status, run: "ended" });
      const receipt = await harness.session(session).steer(input.prompt, { operationId });
      // The job settled while the steer was on its way: withdraw it, rather than leave it to run untracked.
      if (jobStatus(input.key) !== "awaiting_job") {
        await harness.abort({ session, operationId });
        throw notSteered({ job: jobStatus(input.key) ?? null, withdrawn: true });
      }
      watch(session, operationId, input.key);
      return receipt;
    },
  };

  /** The tool the model returns its result with. Its parameters are the `returns` message's payload schema. */
  function finishTool(): ToolRegistration {
    return {
      name: "finish",
      description: `Finish the task: return its result as the ${returns} message, which ends this session. Call it once the work is done. If the result is refused, correct what the error says and call it again.`,
      parameters: (jsonSchemaOf(returnsSchema) ?? { type: "object" }) as ToolRegistration["parameters"],
      // Recording a result is idempotent (the first one stays), so a rerun after a restart is safe.
      replay: "safe",
      async execute(args, api) {
        const session = String(api.conversationId);
        const row = rowBySession(session);
        if (!row) return { isError: true, output: text(`This session wasn't started by ${actor}, so it has no result to return.`) };
        // pi checked the arguments against the JSON Schema; the payload schema may say more.
        const validated = await returnsSchema["~standard"].validate(args);
        if (validated.issues) {
          const issues = validated.issues.map((i) => `- ${i.path?.length ? `${i.path.map((p) => String(typeof p === "object" ? p.key : p)).join(".")}: ` : ""}${i.message}`);
          return { isError: true, output: text(`The result doesn't match ${returns}:\n${issues.join("\n")}`) };
        }
        if (latest()?.generation !== row.generation) {
          emit({ kind: "note", at: now(), actor: self, reason: "stale session result", detail: { key: row.key, session, generation: row.generation, via: "finish" } });
          return { output: text("A newer task replaced this session, so this result was not delivered."), control: { terminate: true } };
        }
        // Stopped, or its job already settled (failed, in doubt, being cancelled): a result now would go nowhere.
        const status = jobStatus(row.key);
        if (row.stopped_at != null || !LIVE.has(status ?? "")) {
          emit({ kind: "note", at: now(), actor: self, reason: "result after the session ended", detail: { key: row.key, session, job: status ?? null, stopped: row.stopped_at != null } });
          return { output: text("This session has ended, so this result was not delivered."), control: { terminate: true } };
        }
        // The arguments as given, not the parsed value: the returns message is validated again when it's delivered.
        sql.exec("UPDATE _actors_agent_sessions SET result = ? WHERE key = ? AND result IS NULL", JSON.stringify(args), row.key);
        runtime.probeNow(SESSION, row.key).catch((err) => emit({ kind: "note", at: now(), actor: self, effect: SESSION, effectKey: row.key, reason: `look after finish failed: ${String(err)}` }));
        return { output: text("Result recorded."), control: { terminate: true } };
      },
    };
  }

  // ---- Handlers: the actor's `on` messages and its sessions' outcomes ----
  type Ctx = HandlerContext<System, string>;
  const cancel = (c: Ctx, key: string) => c.cancelJob(SESSION as never, key);
  const verbs: Record<string, (message: Message<System, string>, c: Ctx) => void> = {
    start(message, c) {
      if (rowByKey(message.id)) {
        c.note("session already started for this message; nothing new", { key: message.id });
        return;
      }
      const current = latest();
      if (current && LIVE.has(jobStatus(current.key) ?? "") && !cancel(c, current.key)) {
        c.note("replaced session hasn't started yet; it is aborted once it does", { key: current.key });
      }
      const generation = (current?.generation ?? 0) + 1;
      c.sql.exec("INSERT INTO _actors_agent_sessions (key, session, operation, generation, instructions, started_at) VALUES (?, NULL, ?, ?, ?, ?)", message.id, message.id, generation, instructions, c.now());
      c.effect(SESSION as never, { prompt: render(message.type, message.payload) }, { key: message.id });
    },
    steer(message, c) {
      const current = latest();
      if (!current || !LIVE.has(jobStatus(current.key) ?? "")) {
        c.note("no active session; not steered", { type: message.type });
        return;
      }
      c.effect(STEER as never, { key: current.key, prompt: render(message.type, message.payload) }, { key: message.id });
    },
    stop(message, c) {
      const current = latest();
      const status = current ? jobStatus(current.key) : undefined;
      if (!current || !LIVE.has(status ?? "")) c.note("no active session; nothing to stop", { type: message.type });
      // Its result is in: the probe settles the job with it, as a completion wins over a cancel.
      else if (current.result != null) c.note("the session already returned its result; nothing to stop", { key: current.key });
      else if (current.stopped_at != null) c.note("stop already recorded", { key: current.key });
      else if (!cancel(c, current.key)) {
        // The start hasn't returned, so there is no job to cancel yet: keep the stop for the start to act on.
        c.sql.exec("UPDATE _actors_agent_sessions SET stopped_at = ? WHERE key = ?", c.now(), current.key);
        c.note("stop recorded; the session stops when its start runs", { key: current.key, job: status ?? null });
      }
    },
  };
  const internalHandlers: InternalHandlers = {};
  for (const [type, verb] of Object.entries(spec.on ?? {})) {
    if (!Object.hasOwn(verbs, verb)) throw new Error(`actord: agent actor ${actor} maps ${type} to ${JSON.stringify(verb)}; use "start", "steer" or "stop"`);
    internalHandlers[type] = verbs[verb]!;
  }
  internalHandlers[SETTLED] = async (message, c) => {
    const { key, status, value, error, usage } = message.payload as Settled;
    const row = rowByKey(key);
    const session = row?.session ?? "";
    const spent = usage ? { usage } : {};
    // To this actor by name: its returns message may also have routes to others, and these messages are its own.
    const send = (type: string, payload: unknown) => c.send(type as never, payload as never, { to: actor as never, key: c.key });
    if (!row || latest()?.generation !== row.generation) {
      c.note("stale session result", { key, session, generation: row?.generation ?? null, status });
      return;
    }
    if (status === "confirmed") {
      const validated = await returnsSchema["~standard"].validate(value);
      if (!validated.issues) return send(returns, value);
      return send("agent.failed", { session, key, reason: `the result doesn't match ${returns}: ${validated.issues.map((i) => i.message).join("; ")}`, ...spent });
    }
    const budget = status === "failed" && error?.startsWith("exhausted:") ? error.slice("exhausted:".length) : undefined;
    if (budget !== undefined && (BUDGETS as readonly string[]).includes(budget)) return send("agent.exhausted", { session, key, budget, ...spent });
    // A cancel of the current session is a stop: a replaced one settled above.
    send("agent.failed", { session, key, reason: status === "failed" && error === "cancelled" ? "stopped" : error || status, ...spent });
  };

  const runtime = actorRuntime(host, system, actor, handlers as unknown as Handlers<S, A>, {
    ...runtimeOptions,
    internal: {
      effects: {
        [SESSION]: {
          description: `A Pi session of ${actor}`,
          kind: "job",
          idempotency: "key",
          // The budget's wallClock ends a session (Task 7); the deadline is the backstop for a session nothing ended.
          deadline: `${(wallClockMs + DEADLINE_GRACE_MS) / 1000}s`,
          probe: { every: PROBE_EVERY },
          result: SETTLED,
          adapter: sessionJob as JobAdapter,
        },
        [STEER]: { description: `Steer a running Pi session of ${actor}`, idempotency: "key", adapter: steerCall as EffectAdapter },
      },
      messages: { [SETTLED]: { version: 1, description: "An agent session's job settled", payload: settled } },
      handlers: internalHandlers,
    },
  });
  host.lifecycle.use(harness);
  return { ...runtime, harness };
}

/** Workers AI through the `AI` binding: the actor's pinned model id, in a pi-ai registry of its own. */
function workersAI(actor: string, spec: ActorSpec, binding: unknown): { models: MutableModels; model: Model<Api> } {
  if (!spec.model) throw new Error(`actord: agent actor ${actor} must declare \`model\``);
  if (binding === undefined) throw new Error(`actord: agent actor ${actor} needs the Workers AI binding, env.AI`);
  const ai = createAI({ binding: binding as never });
  const models = createModels();
  models.setProvider(ai.provider);
  return { models, model: ai(spec.model.id) };
}
