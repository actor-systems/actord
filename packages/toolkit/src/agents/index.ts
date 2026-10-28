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
// - Budgets (budget.ts): a watcher of the session's events marks it exhausted once its turns or cost reach the actor's
//   `turns` or `usd`, aborts it, and asks for a look; a timer asks for one at its `wallClock`, counted from the start
//   message, waits for a person included. Each look reads turns and cost again from what pi recorded, checks all
//   three, and reports what the session spent since the last (EffectUsage), so the job's events and agent.* carry it.
//   The watcher and the timer are in memory only: a look re-arms them after a restart.
// - A session whose job settles in doubt (its deadline passed, or a cancel wasn't confirmed) is aborted after the
//   settlement commits (agent.session.abort), so pi doesn't keep spending on a job actord has given up on.
// - The job's result message, agent.session.settled, becomes the `returns` message, agent.exhausted or agent.failed,
//   sent to the actor itself. A session a later start replaced settles with a note only, and so does its finish.
// - Each session keeps the instructions it started with, so a deploy that changes the instructions reaches new
//   sessions only. They are the session's own pi instructions (its "instructions" prompt section, a key pi reserves
//   for them), set from its row when it starts.
// - Events (agent.started, agent.turn, agent.tool, agent.ended) are recorded under the session job's effect and key, so
//   `actord trace` shows a session as one node. The watcher records turns and tool calls (never a tool's arguments);
//   agent.ended carries the outcome and what the session spent, and, given `transcripts`, names the R2 object its
//   messages were written to. The transcript is never copied into events.
// - The effects in the actor's `tools` are pi tools (tools.ts), each call one effect request keyed
//   "<session>:<callId>". One that needs a person answers "waiting" at once, and the wait is recorded
//   (_actors_agent_waits): the session's job isn't done while a result is owed to it. When the effect's result message
//   arrives, it is steered into the session (agent.session.steer, with the operation id "result:<key>"), which starts
//   a new run if the session's run had ended; for a session replaced or ended meanwhile it is a note only. Every tool
//   result message, owed to a session or not, also reaches the actor's own handler for it, if it has one. The job's
//   probe is the backstop: it steers in a waited request that settled with no steer yet (a person's denial sends no
//   result message, an effect may declare none, a message may be refused), and gives up one whose steer failed.
// - A harness with `workspace: computer(...)` gets a Computer workspace in this object's SQLite (workspace.ts), and the
//   `workspace.*` entries of `tools` are its Pi tools. With a container backend, the Durable Object is built with
//   withWorkspaceContainer, passes itself as `container`, and hands its fetch to the runtime's: computerd connects
//   back, and the container's egress arrives, through it.
import { PiHarness, type PiReceipt } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { type Api, createModels, type Model, type ModelThinkingLevel, type MutableModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, createRegistry, type Extension, Harness, type Registry, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Workspace, WorkspaceRegisteredBackend } from "@cloudflare/computer";
import {
  type ActorHost,
  type ActorRuntime,
  actorRuntime,
  budgetOverride,
  type EffectAdapter,
  EffectNotDelivered,
  EffectRejected,
  type EffectUsage,
  emit,
  type HandlerContext,
  type Handlers,
  type InternalContext,
  type InternalHandlers,
  type JobAdapter,
  type JobProbe,
  type Message,
  type RuntimeOptions,
  WITHDRAW_APPROVAL,
} from "../runtime/index.ts";
import { jsonSchemaOf } from "../model/manifest.ts";
import { type ActorName, type ActorSpec, type Duration, durationMs, type EffectName, type StandardResult, type StandardSchemaV1, type System } from "../system.ts";
import { reachedLimit, type SessionBudget, type SessionObserver, type Spent, spentBy, watchBudget } from "./budget.ts";
import type { scriptedModel } from "./scripted-model.ts";
import { effectTools, shown, type ToolSession } from "./tools.ts";
import { type Gateway, workspaceFetch, workspaceFor, workspaceTools } from "./workspace.ts";

export { type ScriptedRequest, type ScriptedTurn, scriptedModel } from "./scripted-model.ts";
export { gitClone, gitPushEffect } from "./git.ts";
export { type Gateway, RegistryReadGateway, workspaceFetch, workspaceFor, workspaceTools } from "./workspace.ts";
export { WorkspaceProxy } from "@cloudflare/computer";
export { withWorkspaceContainer } from "@cloudflare/computer/backends/container";

type AnySystem = System;

/** The internal job effect an agent session runs as, and the message its outcome comes back as. */
const SESSION = "agent.session";
const SETTLED = "agent.session.settled";
/** The tool a session returns its result with. */
const FINISH = "finish";
/** The internal call effect that hands a steering message, or a tool's owed result, to a running session. */
const STEER = "agent.session.steer";
/** The internal call effect that aborts a session whose job settled in doubt, once that settlement has committed. */
const ABORT = "agent.session.abort";
/** The kind of the transcript entry a tool's owed result enters a session as. */
const RESULT_ENTRY = "actord.effect_result";
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

/** agent.session.settled: the job's outcome, as every effect's result message carries it (a tool's result too). */
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

/** What the runtime needs of an R2 bucket (structurally compatible with R2Bucket). */
export interface TranscriptBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export interface AgentRuntimeOptions<S extends AnySystem = AnySystem> extends RuntimeOptions<S> {
  /** The text of the actor's `instructions` file, imported by the Worker (a wrangler Text module). */
  instructions: string;
  /** Test seam: a scripted model instead of Workers AI (`scriptedModel`). */
  model?: ReturnType<typeof scriptedModel>;
  /** The prompt an `on` message becomes; default: "<type>\n\n" + JSON of the payload, indented. */
  render?(type: string, payload: unknown): string;
  /** More pi extensions to install beside the agent's own (its `finish` tool and instructions). */
  extensions?: readonly Extension[];
  /** Where a session's transcript is written when it ends: transcripts/<actor>/<key>/<session>.json. Without it, none is kept. */
  transcripts?: TranscriptBucket;
  /** For a workspace with a container backend: the Durable Object, built with withWorkspaceContainer (`this`). */
  container?: unknown;
  /** For a workspace whose egress is "registry-read": where the container's requests go; default: a RegistryReadGateway. */
  gateway?: Gateway;
  /**
   * @internal Test seam: a command backend in place of the container's (Computer's WorkspaceBackend, with id
   * "container"). With it, the workspace's localOnly and its egress gateway don't apply, since no container is started.
   */
  backend?: WorkspaceRegisteredBackend;
}

export interface AgentRuntime extends ActorRuntime {
  readonly harness: PiHarness;
  /** The tools and extensions pi runs the actor's sessions with. */
  readonly registry: Registry;
  /** The actor's Computer workspace, when its harness declares one. */
  readonly workspace?: Workspace;
  /** Hand the Durable Object's fetch here: its container's computerd connection and egress. Anything else is a 404. */
  fetch(request: Request): Promise<Response>;
  /** @internal for tests: the job keys of the sessions whose budget this instance watches in memory. */
  watched(): string[];
}

/** The messages an agent actor's `on` maps to a verb: agentRuntime handles them itself. */
type OnMessages<S extends AnySystem, A extends ActorName<S>> = Extract<keyof NonNullable<S["actors"][A]["on"]>, string>;
/** The result messages of the actor's tool effects. */
type ToolResults<S extends AnySystem, A extends ActorName<S>> = S["actors"][A] extends { tools: readonly (infer T)[] }
  ? { [E in Extract<T, EffectName<S>>]: NonNullable<S["effects"]>[E] extends { result: infer R extends string } ? R : never }[Extract<T, EffectName<S>>]
  : never;
/**
 * Handlers for every message the actor receives except its `on` messages. A handler for a tool effect's result
 * message is optional: agentRuntime steers the results owed to sessions itself, and passes every result to it too.
 */
export type AgentHandlers<S extends AnySystem, A extends ActorName<S>> = Omit<Handlers<S, A>, OnMessages<S, A> | ToolResults<S, A>> & Partial<Pick<Handlers<S, A>, Extract<ToolResults<S, A>, keyof Handlers<S, A>>>>;

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

/** A tool request that answered "waiting": its result is owed to its session until `done_at` (steered in, or noted). */
interface WaitRow {
  key: string;
  effect: string;
  session: string;
  expires_at: number;
  done_at: number | null;
}

/**
 * One row per session the actor started: the job's key, pi's session id once open, the result `finish` recorded.
 * One row per tool request that answered "waiting", keyed "<session>:<callId>".
 */
const SESSIONS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS _actors_agent_sessions (key TEXT PRIMARY KEY, session TEXT, operation TEXT NOT NULL, generation INTEGER NOT NULL, instructions TEXT NOT NULL, started_at INTEGER NOT NULL, result TEXT, exhausted TEXT, stopped_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS _actors_agent_sessions_session ON _actors_agent_sessions (session)",
  "CREATE TABLE IF NOT EXISTS _actors_agent_waits (key TEXT PRIMARY KEY, effect TEXT NOT NULL, session TEXT NOT NULL, expires_at INTEGER NOT NULL, done_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS _actors_agent_waits_session ON _actors_agent_waits (session)",
];
/** Job statuses of a session that is still running or about to: a steer joins it, a start replaces it. */
const LIVE = new Set(["pending", "running", "awaiting_job"]);
const STOPPED = "stopped";
/** Why a session a newer start replaced must not run any more. */
const REPLACED = "replaced by a newer start";
/** setTimeout's longest delay: a timer for a longer wallClock waits in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const NOT_STEERED = "the session has ended; not steered";

const defaultRender = (type: string, payload: unknown) => `${type}\n\n${JSON.stringify(payload, null, 2)}`;
const text = (t: string): ToolExecutionResult["output"] => [{ type: "text", text: t }];
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** A request's outcome from its outbox row, as its result message would carry it; null while it hasn't settled. */
function settledOutcome(fx: { status: string; body: string; last_error: string | null }): Pick<Settled, "status" | "value" | "error"> | null {
  if (fx.status === "confirmed") return { status: "confirmed", value: (JSON.parse(fx.body) as { outcome?: unknown }).outcome };
  if (fx.status === "in_doubt") return { status: "in_doubt", error: fx.last_error ?? "unknown" };
  // A denial (by a person, or an expiry) is a failure, as the runtime reports it.
  if (fx.status === "failed" || fx.status === "denied" || fx.status === "dead") return { status: "failed", error: fx.last_error ?? fx.status };
  return null;
}
/** A tool's owed result, as the session gets it. */
const resultPrompt = (effect: string, key: string, outcome: Pick<Settled, "status" | "value" | "error">) => {
  const detail = shown(outcome.status === "confirmed" ? outcome.value : outcome.error);
  return `Result of ${effect} (request ${key}): ${outcome.status}${detail ? ` ${detail}` : ""}`;
};

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
  const { instructions, model: scripted, render = defaultRender, extensions = [], transcripts, container, gateway, backend, ...runtimeOptions } = options;
  const workspaceSpec = spec.harness?.workspace;
  // `actord check` reports workspace tools without a workspace (AGENT_WORKSPACE_TOOLS_WITHOUT_WORKSPACE).
  if (!workspaceSpec && (spec.tools ?? []).some((t) => t.startsWith("workspace."))) throw new Error(`actord: agent actor ${actor} lists workspace tools, but its harness has no workspace`);
  const now = options.now ?? (() => Date.now());
  const { ctx } = host;
  const sql = ctx.storage.sql;
  const self = `${actor}:${ctx.id.name ?? ctx.id.toString()}`;
  for (const q of SESSIONS_SCHEMA) sql.exec(q);
  const workspace = workspaceSpec && workspaceFor(host, workspaceSpec, { container, gateway, binding: spec.binding, ...(backend ? { backend } : {}) });

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
    return row && latest()?.generation !== row.generation ? REPLACED : null;
  };
  /** Whether a tool effect of this session (keyed "<session>:<callId>") waits for a person. */
  const awaitingApproval = (session: string) =>
    sql.exec("SELECT 1 FROM _actors_outbox WHERE kind = 'effect' AND status = 'awaiting_approval' AND substr(json_extract(body, '$.key'), 1, ?) = ? LIMIT 1", session.length + 1, `${session}:`).toArray().length > 0;
  const waitByKey = (key: string) => sql.exec<WaitRow>("SELECT * FROM _actors_agent_waits WHERE key = ?", key).toArray()[0];
  /** The tool results a session is still owed. */
  const openWaits = (session: string) => sql.exec<WaitRow>("SELECT * FROM _actors_agent_waits WHERE session = ? AND done_at IS NULL ORDER BY key", session).toArray();
  const closeWait = (key: string) => sql.exec("UPDATE _actors_agent_waits SET done_at = ? WHERE key = ? AND done_at IS NULL", now(), key);
  /** What a tool needs of the session a pi conversation is: the session's start message caused its effects. */
  const toolSession = (conversationId: string): ToolSession | undefined => {
    const row = rowBySession(conversationId);
    if (!row) return undefined;
    const job = sql.exec<{ c: string | null }>("SELECT json_extract(body, '$.correlationId') AS c FROM _actors_outbox WHERE id = ?", `fx:${SESSION}:${row.key}`).toArray()[0];
    return {
      session: conversationId,
      causationId: row.key,
      correlationId: job?.c ?? row.key,
      waiting(key, effect, expiresAt) {
        sql.exec("INSERT INTO _actors_agent_waits (key, effect, session, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING", key, effect, conversationId, expiresAt);
        return waitByKey(key)!.expires_at;
      },
      waited: (key) => waitByKey(key)?.expires_at,
      ended() {
        const why = halted(row.key);
        if (why) return why === REPLACED ? "this session was replaced by a new start" : "this session was stopped";
        const job = jobStatus(row.key);
        return LIVE.has(job ?? "") ? null : job === "cancelling" ? "this session was stopped (its job is being cancelled)" : "this session has ended";
      },
    };
  };

  // ---- Pi ----
  const { models, model } = scripted ?? workersAI(actor, spec, host.env.AI);
  const reasoning = spec.model?.reasoning;
  // One per object, never at module scope: pi keeps each Harness subscribed to its registry until it closes.
  // Filled once the runtime exists, below: the effect tools request through it. pi reads it only once it opens.
  const registry = createRegistry();
  const harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      const pi = await Harness.open(storage, { models, registry, onWake }, context);
      // pi resumes its sessions' runs once this returns: watch their budgets first, so none runs on unwatched. A
      // failure here is noted per session (the watcher's onError), never a failure to open pi.
      await guardWaiting(pi).catch((err) => emit({ kind: "note", at: now(), actor: self, effect: SESSION, reason: `watching waiting sessions' budgets failed: ${messageOf(err)}` }));
      return pi;
    },
    defaults: { model, ...(reasoning ? { thinkingLevel: THINKING[reasoning] } : {}) },
  });

  /** When pi settles an operation, look at the session's job now rather than at its next probe. In memory only. */
  const watch = (session: string, operation: string, key: string) => {
    harness
      .wait(operation, { session })
      .then(() => runtime.probeNow(SESSION, key))
      .catch(() => undefined); // pi closed, or the object went away: the job's probe period is the backstop
  };

  // ---- Budgets ----
  /** The actor's session budget, with a test's override laid over it; read at each use. */
  const budget = (): SessionBudget & { wallClockMs: number } => {
    const o = budgetOverride(actor);
    return { usd: o?.usd ?? spec.budget?.usd ?? Infinity, turns: o?.turns ?? spec.budget?.turns ?? Infinity, wallClockMs: o?.wallClockMs ?? wallClockMs };
  };
  /** The first budget a session has used up, if any: turns, then cost, then its wallClock since its start message. */
  const overBudget = (row: SessionRow, spent: Spent): AgentExhausted["budget"] | null => {
    const b = budget();
    return reachedLimit(b, spent.turns, spent.usage.costUsd) ?? (now() - row.started_at >= b.wallClockMs ? "wallClock" : null);
  };
  /** Mark a session exhausted. The first budget recorded stays; returns it. */
  const markExhausted = (key: string, which: string): string => {
    sql.exec("UPDATE _actors_agent_sessions SET exhausted = ? WHERE key = ? AND exhausted IS NULL", which, key);
    return rowByKey(key)?.exhausted ?? which;
  };
  /** What a session spent beyond what its job has recorded: the delta a look reports. Fields with nothing new are left out. */
  const unreported = (key: string, total: Spent["usage"]): EffectUsage => {
    const u = sql.exec<{ u: string | null }>("SELECT json_extract(body, '$.usage') AS u FROM _actors_outbox WHERE id = ?", `fx:${SESSION}:${key}`).toArray()[0]?.u;
    const recorded = (u ? JSON.parse(u) : {}) as EffectUsage;
    const delta: EffectUsage = {};
    for (const [field, value] of Object.entries(total) as Array<[keyof Spent["usage"], number]>) {
      const d = value - (recorded[field] ?? 0);
      // A billionth of a dollar is float noise from summing the same costs in another order, not spending.
      if (d > 1e-9) delta[field] = d;
    }
    return delta;
  };
  /**
   * In memory, per running session: its budget watcher and its wallClock timer, both of which ask for a look. Armed
   * when the start returns; for every waiting session when pi opens (an instance's start), before pi resumes their runs;
   * and by a look that finds none (its watcher failed). Disarmed once the job is settled or being cancelled.
   */
  const guards = new Map<string, () => void>();
  const note = (key: string, reason: string) => emit({ kind: "note", at: now(), actor: self, effect: SESSION, effectKey: key, reason });
  /** The tool each effect in `tools` is, by pi's name for it: a call of one is a request keyed "<session>:<callId>". */
  const toolEffects = new Set((spec.tools ?? []).filter((t) => !t.startsWith("workspace.")).map((t) => t.replaceAll(".", "_")));
  const agentEvent = (kind: "agent.started" | "agent.turn" | "agent.tool" | "agent.ended", key: string, session: string, detail: Record<string, unknown>, reason?: string) =>
    emit({ kind, at: now(), actor: self, effect: SESSION, effectKey: key, ...(reason ? { reason } : {}), detail: { session, key, ...detail } });
  /** The last turn recorded for each session this instance watches. */
  const turnsSeen = new Map<string, number>();
  const observer = (key: string, session: string): SessionObserver => ({
    attached: (turns) => void turnsSeen.set(key, Math.max(turns, turnsSeen.get(key) ?? 0)),
    turn: (turn, usage) => (turnsSeen.set(key, turn), agentEvent("agent.turn", key, session, { turn, usage })),
    // The call's arguments stay out of the event: they are in the transcript, and in the effect's own record.
    // `finish` is how the session returns its result, not work it did: leaving it out makes the log deterministic (the
    // watcher can stop before the event for it arrives).
    tool: (tool, callId) => tool !== FINISH && agentEvent("agent.tool", key, session, { tool, callId, ...(toolEffects.has(tool) ? { effectKey: `${session}:${callId}` } : {}) }),
  });
  const ended = new Set<string>();
  /** Record a session's end once: its outcome and spending, and its transcript in R2 when there is a bucket. Never throws. */
  const recordEnd = async (key: string, session: string, outcome: string, spent: Spent | null, reason?: string) => {
    if (ended.has(key)) return;
    ended.add(key);
    // A session's end settles its job and stops the watcher, which can be before pi's last turn_end reaches it: record
    // the turns it missed, with the session's final usage.
    if (spent && turnsSeen.has(key)) for (let turn = turnsSeen.get(key)! + 1; turn <= spent.turns; turn++) agentEvent("agent.turn", key, session, { turn, usage: spent.usage, late: true });
    turnsSeen.delete(key);
    let transcript: string | undefined;
    if (transcripts) {
      const name = `transcripts/${actor}/${key}/${session}.json`;
      try {
        await transcripts.put(name, JSON.stringify(await harness.messages({ session })), { httpMetadata: { contentType: "application/json" } });
        transcript = name;
      } catch (err) {
        note(key, `the transcript of session ${session} couldn't be written: ${messageOf(err)}`);
      }
    }
    agentEvent("agent.ended", key, session, { outcome, ...(spent ? { turns: spent.turns, usage: spent.usage } : {}), ...(transcript ? { transcript } : {}) }, reason);
  };
  const look = (key: string) => runtime.probeNow(SESSION, key).catch((err) => note(key, `look at a session's budget failed: ${messageOf(err)}`));
  /** Whether a session's job may still spend: started or waiting, not settled or being cancelled. Read fresh. */
  const unsettled = (key: string) => ["running", "awaiting_job"].includes(jobStatus(key) ?? "");
  /** Resolves once the session's watcher counts (or has failed). `pi`: the pi the harness factory has just opened. */
  const guard = (key: string, session: string, startedAt: number, pi?: Harness): Promise<void> => {
    // Never for a settled job: nothing would disarm it.
    if (guards.has(key) || !unsettled(key)) return Promise.resolve();
    const b = budget();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      if (guards.get(key) === dispose) guards.delete(key);
      unwatch();
      clearTimeout(timer);
    };
    const unwatch = watchBudget(
      pi ?? harness,
      session,
      b,
      async (which) => {
        // Settled meanwhile: there is nothing to stop, and its row stays as it settled.
        if (!unsettled(key)) return dispose();
        markExhausted(key, which);
        // The look aborts it too, so one failed abort here still ends the session. Through the pi the factory opened,
        // when there is one: until the instance has started, the harness's methods wait, and pi's run doesn't.
        const aborting = pi ? pi.conversation(Number(session) as ConversationId, BACKGROUND_CONTEXT).then((c) => c?.abort(BACKGROUND_CONTEXT)) : harness.abort({ session });
        await aborting.catch((err) => note(key, `abort of an exhausted session failed: ${messageOf(err)}`));
        await look(key);
      },
      // Dropped, so the next look that finds the session still running watches it again.
      (err) => {
        note(key, `budget watcher failed: ${messageOf(err)}`);
        dispose();
      },
      observer(key, session),
    );
    // Looks once the wallClock has passed by this instance's clock: a timer that fires early, or a step of a long
    // wallClock, waits again. Always from a timer, so a look is never asked for from inside the instance's start.
    const left = () => startedAt + b.wallClockMs - now();
    const arm = () => {
      timer = setTimeout(() => (left() > 0 ? arm() : void look(key)), Math.min(Math.max(0, left()), MAX_TIMER_MS));
    };
    arm();
    guards.set(key, dispose);
    return unwatch.ready;
  };
  const unguard = (key: string) => guards.get(key)?.();
  /**
   * When pi opens: watch every session whose job waits, before pi resumes their runs by itself (a restart). A watcher
   * of a pi that closed (pi reopens after a storage failure) is replaced.
   */
  const guardWaiting = async (pi: Harness) => {
    const waiting = sql.exec<{ key: string; session: string; started_at: number }>(
      "SELECT s.key, s.session, s.started_at FROM _actors_agent_sessions s JOIN _actors_outbox o ON o.id = ? || s.key WHERE o.status = 'awaiting_job' AND s.session IS NOT NULL",
      `fx:${SESSION}:`,
    );
    await Promise.all(
      waiting.toArray().map((row) => {
        unguard(row.key);
        return guard(row.key, row.session, row.started_at, pi);
      }),
    );
  };

  const sessionJob: JobAdapter<{ prompt: string }, SessionHandle> = {
    async start(input, { key }) {
      const row = rowByKey(key);
      if (!row) throw new EffectRejected(`no agent session was recorded for ${key}`);
      let session = row.session;
      try {
        // Stopped or replaced while this start waited (to run, or to be tried again): pi is never asked.
        const before = halted(key);
        if (before) throw new EffectRejected(before);
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
        const receipt = await harness.session(session).submit(input.prompt, { operationId: row.operation });
        // A retry of this start is accepted: false, and was recorded the first time.
        if (receipt.accepted) agentEvent("agent.started", key, session, { generation: row.generation });
        // Stopped or replaced while this start ran, too early to cancel the job: stop the session now. Its probe then
        // settles the job: failed "stopped", or, once replaced, a note.
        if (halted(key)) await harness.abort({ session });
        else guard(key, session, row.started_at);
        watch(session, row.operation, key);
        return { session, operation: row.operation, generation: row.generation };
      } catch (err) {
        // Refused once pi opened the session (on this try or an earlier one): the job fails with no probe to record the
        // session's end, so this does. Any other failure is tried again, or ends the job in doubt, whose settlement records it.
        if (session !== null && err instanceof EffectRejected) await recordEnd(key, session, "failed", await spentBy(harness, session).catch(() => null), err.message);
        throw err;
      }
    },
    async probe(handle, { key, reportUsage }) {
      // Owed results first, then pi's work and spending, then the row. A steer closes its wait once pi has the result,
      // so a wait found closed shows as pi's work; and finish records a result before its run ends, so a run found
      // ended had it.
      const waits = openWaits(handle.session);
      const pending = await harness.pending({ session: handle.session });
      const spent = await spentBy(harness, handle.session);
      const row = rowByKey(key);
      const settle = async (outcome: JobProbe) => {
        unguard(key);
        let final = spent;
        if (outcome.done && outcome.status === "failed") {
          // A session that ends without its result must stop spending, whatever it was doing; what the request the
          // abort cut off spent counts too.
          await harness.abort({ session: handle.session });
          final = await spentBy(harness, handle.session);
        }
        reportUsage(unreported(key, final.usage));
        await recordEnd(key, handle.session, outcome.done && outcome.status === "confirmed" ? "confirmed" : "failed", final, outcome.done && outcome.status === "failed" ? outcome.error : undefined);
        return outcome;
      };
      if (row?.result != null) return settle({ done: true, status: "confirmed", value: JSON.parse(row.result) as unknown });
      // Out of budget, as marked by its watcher, or found now (turns and cost again from pi's records, and wallClock).
      const over = row && (row.exhausted ?? overBudget(row, spent));
      if (row && over) return settle({ done: true, status: "failed", error: `exhausted:${markExhausted(key, over)}` });
      // A stop kept on the row, which may have landed after the start's last look at it: pi may still be running.
      if (row?.stopped_at != null) return settle({ done: true, status: "failed", error: STOPPED });
      const owed = row && waits.length > 0 ? await steerSettled(row, waits) : waits;
      // A session being stopped has no work left by design: its cancel, not this look, settles it.
      if (pending.length > 0 || owed.length > 0 || awaitingApproval(handle.session) || jobStatus(key) === "cancelling") {
        reportUsage(unreported(key, spent.usage));
        if (row) guard(key, handle.session, row.started_at); // again, if its watcher failed; never once the job has settled
        return { done: false };
      }
      return settle({ done: true, status: "failed", error: "ended without returning a result" });
    },
    async cancel(handle, { key, signal, reportUsage }) {
      unguard(key);
      const aborted = await harness.abort({ session: handle.session });
      // No look reports what the session spent since the last one, the request the abort cut off included: this does.
      let spent: Spent | null = null;
      try {
        spent = await spentBy(harness, handle.session);
        reportUsage(unreported(key, spent.usage));
      } catch (err) {
        note(key, `what a stopped session spent couldn't be read: ${messageOf(err)}`);
      }
      // Cancelled only if this answer counts: past the cancel's timeout the job settles in doubt, and that settlement
      // records the end. Nothing is awaited between the check and the answer, so the timeout can't land between them.
      if (aborted && !signal.aborted) {
        const ending = recordEnd(key, handle.session, "cancelled", spent);
        ctx.waitUntil?.(ending);
      }
      return aborted;
    },
  };

  /**
   * Steer only a session whose job still runs, that wasn't stopped or replaced, and that hasn't returned its result or
   * run out of budget. pi takes a steer to an idle session (one whose turn ended on a tool that waits for a person, say)
   * as new input, which starts a run: the job tracks it, since its probe counts pi's pending work as the session's. A
   * tool's owed result (`result`, its request's key) goes in as input of its own kind.
   */
  const steerCall: EffectAdapter<{ key: string; prompt: string; result?: string }, PiReceipt> = {
    async run(input, { key: operationId }) {
      const row = rowByKey(input.key);
      if (!row) throw new EffectRejected(`no agent session was recorded for ${input.key}`);
      const notSteered = (why: Record<string, unknown>) => {
        // A result that can't reach its session is owed to it no longer.
        if (input.result !== undefined) closeWait(input.result);
        emit({ kind: "note", at: now(), actor: self, effect: STEER, effectKey: operationId, reason: NOT_STEERED, detail: { key: input.key, ...why } });
        return new EffectRejected(NOT_STEERED);
      };
      const status = jobStatus(input.key);
      if (!LIVE.has(status ?? "") || halted(input.key)) throw notSteered({ job: status ?? null, halted: halted(input.key) });
      // Its result is in, or its budget ran out: the job settles without another run, and a run started now would go
      // on unwatched after it.
      if (row.result != null) throw notSteered({ job: status, result: true });
      if (row.exhausted != null) throw notSteered({ job: status, exhausted: row.exhausted });
      // Sent before the start returns, a steer could reach pi ahead of the prompt it is meant to follow.
      if (row.session === null || status !== "awaiting_job") throw new EffectNotDelivered("the session's start hasn't returned yet");
      const session = row.session;
      const receipt =
        input.result === undefined
          ? await harness.session(session).steer(input.prompt, { operationId })
          : await harness.session(session).submit(input.prompt, { operationId, whenBusy: "steer", entry: { kind: RESULT_ENTRY, data: { request: input.result } } });
      // pi has the result now, so the job's probe sees it as the session's work.
      if (input.result !== undefined) closeWait(input.result);
      // The job settled while the steer was on its way: withdraw it, rather than leave it to run untracked.
      if (jobStatus(input.key) !== "awaiting_job") {
        await harness.abort({ session, operationId });
        throw notSteered({ job: jobStatus(input.key) ?? null, withdrawn: true });
      }
      watch(session, operationId, input.key);
      return receipt;
    },
  };

  /**
   * Abort a session whose job settled in doubt, and record its end: no probe settled the job (its deadline did, or a
   * cancel that wasn't confirmed). Runs after the settlement commits, so nothing of pi's or R2's is awaited inside a
   * handler's transaction. Aborting a session with nothing running does nothing, and an end is recorded once, so a
   * retry is safe.
   */
  const abortCall: EffectAdapter<{ session: string; key?: string; error?: string }, boolean> = {
    async run({ session, key, error }) {
      try {
        return await harness.abort({ session });
      } finally {
        // What it spent is unknown if pi can't say.
        if (key !== undefined) await recordEnd(key, session, "in_doubt", await spentBy(harness, session).catch(() => null), error);
      }
    },
  };

  /** The tool the model returns its result with. Its parameters are the `returns` message's payload schema. */
  function finishTool(): ToolRegistration {
    return {
      name: FINISH,
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

  /**
   * The backstop for a session's owed results, at each look at it. A waited request that has settled with no steer
   * yet is steered in from its row: a person's denial sends no result message, an effect may declare none, and a
   * result message may be refused or undeliverable. Its key is the result message's own steer's, so the two never both
   * reach the session. A wait whose steer settled without reaching pi (failed, in doubt) is given up: nothing else
   * will come. Returns the waits still owed.
   */
  async function steerSettled(row: SessionRow, waits: WaitRow[]): Promise<WaitRow[]> {
    const owed: WaitRow[] = [];
    for (const wait of waits) {
      const steerKey = `result:${wait.key}`;
      const steer = sql.exec<{ status: string }>("SELECT status FROM _actors_outbox WHERE id = ?", `fx:${STEER}:${steerKey}`).toArray()[0]?.status;
      if (steer !== undefined) {
        // On its way: still owed. Settled: a confirmed steer closed its wait once pi had the result; any other end is final.
        if (steer === "pending" || steer === "running") owed.push(wait);
        else closeWait(wait.key);
        continue;
      }
      const fx = sql.exec<{ status: string; body: string; last_error: string | null }>("SELECT status, body, last_error FROM _actors_outbox WHERE id = ?", `fx:${wait.effect}:${wait.key}`).toArray()[0];
      if (!fx) {
        closeWait(wait.key); // no request to wait for
        continue;
      }
      owed.push(wait);
      const outcome = settledOutcome(fx);
      if (!outcome || halted(row.key)) continue; // still parked for a person, or running
      const prompt = resultPrompt(wait.effect, wait.key, outcome);
      await runtime.requestEffect(STEER, { key: row.key, prompt, result: wait.key }, { key: steerKey, causationId: row.key, correlationId: toolSession(wait.session)?.correlationId ?? row.key });
    }
    return owed;
  }

  // ---- Handlers: the actor's `on` messages, its sessions' outcomes, and its tools' results ----
  type Ctx = HandlerContext<System, string> & InternalContext;
  const cancel = (c: Ctx, key: string) => c.cancelJob(SESSION as never, key);
  /**
   * Deny a stopped or replaced session's tool requests (keyed "<session>:<callId>") still waiting for a person. Not
   * through ctx.deny: a start or stop may come from a decision's result, whose handlers can't deny, and this is the
   * runtime withdrawing the session's own requests, not the decision deciding them.
   */
  const withdrawApprovals = (c: Ctx, row: SessionRow, reason: string) => {
    if (row.session === null) return; // no tool has run yet
    const parked = c.sql
      .exec<{ name: string; key: string }>(
        "SELECT json_extract(body, '$.name') AS name, json_extract(body, '$.key') AS key FROM _actors_outbox WHERE kind = 'effect' AND status = 'awaiting_approval' AND substr(json_extract(body, '$.key'), 1, ?) = ?",
        row.session.length + 1,
        `${row.session}:`,
      )
      .toArray();
    for (const fx of parked) c[WITHDRAW_APPROVAL](fx.name, fx.key, reason);
  };
  const verbs: Record<string, (message: Message<System, string>, c: Ctx) => void> = {
    start(message, c) {
      if (rowByKey(message.id)) {
        c.note("session already started for this message; nothing new", { key: message.id });
        return;
      }
      const current = latest();
      if (current && LIVE.has(jobStatus(current.key) ?? "") && !cancel(c, current.key)) {
        c.note("replaced session hasn't started yet; its start stops it", { key: current.key });
      }
      if (current) withdrawApprovals(c, current, "the session was replaced");
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
      else {
        if (current.stopped_at != null) c.note("stop already recorded", { key: current.key });
        else if (!cancel(c, current.key)) {
          // The start hasn't returned, so there is no job to cancel yet: keep the stop for the start to act on.
          c.sql.exec("UPDATE _actors_agent_sessions SET stopped_at = ? WHERE key = ?", c.now(), current.key);
          c.note("stop recorded; the session stops when its start runs", { key: current.key, job: status ?? null });
        }
        withdrawApprovals(c, current, "the session was stopped");
      }
    },
  };
  const internalHandlers: InternalHandlers = {};
  for (const [type, verb] of Object.entries(spec.on ?? {})) {
    if (!Object.hasOwn(verbs, verb)) throw new Error(`actord: agent actor ${actor} maps ${type} to ${JSON.stringify(verb)}; use "start", "steer" or "stop"`);
    internalHandlers[type] = verbs[verb]!;
  }
  // A tool effect's result message: steered into the session that waits for it (or noted, when that session has
  // ended), and then, whatever the session did with it, handed to the actor's own handler for the message, if it has
  // one. Both run in the one handler transaction: a throw in either rolls back both, the steer included, and the
  // delivery is retried.
  const ownHandlers = handlers as unknown as InternalHandlers;
  const owedResult = (message: Message<System, string>, c: Ctx) => {
    const { key, status, value, error } = message.payload as Settled;
    const wait = waitByKey(key);
    if (!wait) return; // the tool returned the value itself
    if (wait.done_at != null) {
      c.note("tool result already given to its session", { key, status });
      return;
    }
    const row = rowBySession(wait.session);
    const job = row ? jobStatus(row.key) : undefined;
    if (!row || !LIVE.has(job ?? "") || halted(row.key)) {
      c.sql.exec("UPDATE _actors_agent_waits SET done_at = ? WHERE key = ?", c.now(), key);
      c.note("stale tool result", { key, session: wait.session, generation: row?.generation ?? null, job: job ?? null, status });
      return;
    }
    c.effect(STEER as never, { key: row.key, prompt: resultPrompt(wait.effect, key, { status, value, error }), result: key }, { key: `result:${key}` });
  };
  const toolResult: InternalHandlers[string] = async (message, c) => {
    owedResult(message, c);
    if (Object.hasOwn(ownHandlers, message.type)) await ownHandlers[message.type]!(message, c);
  };
  for (const tool of spec.tools ?? []) {
    const result = system.effects?.[tool]?.result;
    if (result !== undefined && !Object.hasOwn(internalHandlers, result)) internalHandlers[result] = toolResult;
  }
  internalHandlers[SETTLED] = async (message, c) => {
    const { key, status, value, error, usage } = message.payload as Settled;
    const row = rowByKey(key);
    const session = row?.session ?? "";
    const spent = usage ? { usage } : {};
    unguard(key);
    // Given up on in doubt (its deadline passed, a cancel wasn't confirmed): pi may still be running it, so stop it and
    // record its end, after this commits. Replaced sessions too: nothing will use what they do.
    if (status === "in_doubt" && row?.session) c.effect(ABORT as never, { session: row.session, key, error }, { key });
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
          // The budget's wallClock ends a session (a look exhausts it); the deadline is the backstop for one nothing ended.
          deadline: `${(wallClockMs + DEADLINE_GRACE_MS) / 1000}s`,
          probe: { every: PROBE_EVERY },
          result: SETTLED,
          adapter: sessionJob as JobAdapter,
        },
        [STEER]: { description: `Steer a running Pi session of ${actor}`, idempotency: "key", adapter: steerCall as EffectAdapter },
        [ABORT]: { description: `Abort a Pi session of ${actor} whose job settled in doubt`, idempotency: "key", adapter: abortCall as EffectAdapter },
      },
      messages: { [SETTLED]: { version: 1, description: "An agent session's job settled", payload: settled } },
      handlers: internalHandlers,
    },
  });
  registry.install({ name: "actord.agent", tools: [finishTool(), ...effectTools(runtime, system, actor, toolSession)] });
  if (workspace) registry.install({ name: "actord.workspace", tools: workspaceTools(workspace, spec.tools ?? []) });
  for (const extension of extensions) registry.install(extension);
  host.lifecycle.use(harness);
  const fetch = (request: Request) => (workspace ? workspaceFetch(workspace, request) : Promise.resolve(new Response("not found", { status: 404 })));
  return { ...runtime, harness, registry, ...(workspace ? { workspace } : {}), fetch, watched: () => [...guards.keys()] };
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
