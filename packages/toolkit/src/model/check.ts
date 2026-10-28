// `actord check`: what the type system can't express. Hard errors fail the check; warnings are advice.
// Every diagnostic has a stable code so tests, hooks, and graders can match on it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCronExpression } from "cron-schedule";
import type { Project } from "./load.ts";
import { type ActorSpec, durationMs } from "../system.ts";
import { MANIFEST_FILE, type Manifest, type ManifestEffect, serializeManifest } from "./manifest.ts";

function cronParses(expr: string): boolean {
  try {
    parseCronExpression(expr);
    return true;
  } catch {
    return false;
  }
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: string;
  severity: Severity;
  subject: string | null;
  message: string;
  fix: string | null;
}

const ACTOR_NAME = /^[A-Z][A-Za-z0-9]*$/;
const MESSAGE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const FIXED_SENDERS = ["@clock", "@ingress", "@timer"];
/** Senders the runtime writes itself: the fixed route senders, and "@rpc" for a decision made through decide(). */
const RESERVED_SENDERS = [...FIXED_SENDERS, "@rpc"];

/** agent.session and every agent.session.* name: the agent runtime's internal effects and messages (src/agents), which win over declared ones. */
const reservedAgentName = (name: string) => name === "agent.session" || name.startsWith("agent.session.");

type AddFn = (severity: Severity, code: string, subject: string | null, message: string, fix?: string | null) => void;

/** Computer rejects an ignore pattern unless it starts with "/" or "**\/", uses only * and **, and has none of {}[]?\, . */
function localOnlyInvalid(pattern: string): boolean {
  return !(pattern.startsWith("/") || pattern.startsWith("**/")) || /[{}[\]?\\,]/.test(pattern) || /\*{3,}/.test(pattern);
}

function checkAgent(project: Project, m: Manifest, a: Manifest["actors"][number], add: AddFn) {
  if (!a.harness) add("error", "AGENT_HARNESS_MISSING", a.name, `${a.name} is an agent but declares no harness`, "Add harness: pi({ workspace: computer() }).");
  if (!a.model) add("error", "AGENT_MODEL_MISSING", a.name, `${a.name} is an agent but declares no model`, 'Add model: { id: "claude-opus-5-5" }.');
  if (!a.returns) add("error", "AGENT_RETURNS_MISSING", a.name, `${a.name} is an agent but declares no returns message`, "Add returns: the message its final answer is delivered as.");
  const b = a.budget;
  if (b && (b.usd === undefined || b.turns === undefined || b.wallClock === undefined))
    add("error", "AGENT_BUDGET_INCOMPLETE", a.name, `${a.name} is an agent whose budget lacks ${(["usd", "turns", "wallClock"] as const).filter((f) => b[f] === undefined).join(", ")}`, "An agent budget needs usd, turns and wallClock.");

  const routedTo = (message: string) => m.routes.some((r) => r.message === message && r.to === a.name);
  const selfRouted = (message: string) => m.routes.some((r) => r.message === message && r.from === a.name && r.to === a.name);
  for (const message of Object.keys(a.on ?? {}))
    if (!routedTo(message)) add("error", "AGENT_ON_UNROUTED", `${a.name} ← ${message}`, `${a.name} reacts to ${message}, but no route delivers it to ${a.name}`, `Add a route that delivers ${message} to ${a.name}.`);
  for (const message of [...(a.returns ? [a.returns] : []), "agent.failed", "agent.exhausted"])
    if (!selfRouted(message)) add("error", "AGENT_SELF_ROUTE_MISSING", `${a.name} → ${message}`, `${a.name} is told ${message} by its own session, but no route delivers it from ${a.name} to itself`, `Add { from: "${a.name}", message: "${message}", to: "${a.name}" }.`);

  const effects = new Map(m.effects.map((e) => [e.name, e]));
  const workspace = a.harness?.workspace;
  for (const t of a.tools ?? []) {
    if (t.startsWith("workspace.")) {
      if (!workspace) add("error", "AGENT_WORKSPACE_TOOLS_WITHOUT_WORKSPACE", `${a.name} → ${t}`, `${a.name} lists ${t}, but its harness has no workspace`, "Add workspace: computer() to the harness, or remove the tool.");
      continue;
    }
    if (!a.effects.includes(t) || !effects.has(t)) add("error", "AGENT_TOOL_UNDECLARED", `${a.name} → ${t}`, `${a.name} lists tool "${t}", which is neither workspace.* nor an effect in its effects`, `Declare ${t} under effects and list it in ${a.name}'s effects, or remove the tool.`);
    else if (effects.get(t)!.input === undefined) add("error", "AGENT_TOOL_INPUT_MISSING", `${a.name} → ${t}`, `${t} is a tool of ${a.name} but declares no input, so the agent can't be told its parameters`, "Add input: a schema of the tool's parameters.");
    else if (effects.get(t)!.approval === "human" && effects.get(t)!.result === null)
      add("warning", "AGENT_TOOL_APPROVAL_RESULT_MISSING", `${a.name} → ${t}`, `${t} is a tool of ${a.name} that needs a person's approval but declares no result message, so the session learns its outcome from the job's probe, up to a probe period after it settles`, `Add result: a declared message to ${t}, and a route that delivers it to ${a.name}.`);
  }
  if (workspace && !workspace.backend && (a.tools ?? []).some((t) => t === "workspace.*" || t === "workspace.exec"))
    add("warning", "AGENT_EXEC_WITHOUT_BACKEND", a.name, `${a.name} lists workspace.exec (or workspace.*) but its workspace has no container backend, so exec is left out`, 'Add backend: containerBackend({ image }) and localOnly: ["**/node_modules"] to the workspace.');
  if (workspace?.backend && workspace.localOnly === undefined)
    add("error", "AGENT_LOCAL_ONLY_MISSING", `${a.name} workspace`, "a workspace with a container backend must declare localOnly: without it, node_modules syncs into the Durable Object (spike 2: npm ci 7.8x slower, 405 MB in the object)", 'Add localOnly: ["**/node_modules"], or localOnly: [] to sync everything.');
  // From the declaration, not the manifest, whose JSON writes NaN and Infinity as null.
  const declared = (project.system?.actors[a.name] as ActorSpec | undefined)?.harness?.workspace;
  const timeout: unknown = declared ? declared.execTimeoutMs : workspace?.execTimeoutMs;
  if (timeout !== undefined && !(Number.isInteger(timeout) && (timeout as number) > 0))
    add("error", "AGENT_EXEC_TIMEOUT_INVALID", `${a.name} execTimeoutMs ${String(timeout)}`, `execTimeoutMs ${String(timeout)} isn't a positive whole number of milliseconds, so no command could be given it as a timeout`, "Write it as a whole number of milliseconds, such as 600000 for 10 minutes.");
  for (const pattern of workspace?.localOnly ?? [])
    if (localOnlyInvalid(pattern)) add("error", "AGENT_LOCAL_ONLY_INVALID", `${a.name} localOnly ${pattern}`, `localOnly pattern "${pattern}" would be rejected by Computer: it must start with "/" or "**/", use only * and **, and avoid {}[]?\\,`, 'Write it as "/dir" or "**/*.log".');
  if (workspace?.backend) {
    const entry = project.config?.containers?.find((c) => c.class_name === a.name);
    const file = project.configFile ?? "wrangler.jsonc";
    // wrangler rejects `image` for a container the Durable Object schedules, and needs `images`.
    const wrong = !entry || entry.scheduling_policy !== "durable_object" ? `has no containers entry for class ${a.name} with scheduling_policy "durable_object"` : entry.image !== undefined ? `gives class ${a.name}'s container "image", which wrangler rejects for scheduling_policy "durable_object"` : entry.images === undefined ? `gives class ${a.name}'s container no "images"` : null;
    if (wrong)
      add("error", "AGENT_CONTAINER_CONFIG_MISSING", a.name, `${a.name} runs commands in a container, but ${file} ${wrong}`, `Add containers: [{ "class_name": "${a.name}", "scheduling_policy": "durable_object", "images": { "app": { "dockerfile": "${workspace.backend.image}" } } }] (wrangler rejects "image" for a container the Durable Object schedules).`);
  }
  if (a.instructions !== undefined && !existsSync(join(project.root, a.instructions)))
    add("error", "AGENT_INSTRUCTIONS_MISSING", a.name, `${a.name}'s instructions file ${a.instructions} doesn't exist next to system.ts`, `Create ${a.instructions}, or fix the path.`);
}

export function checkProject(project: Project): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (severity: Severity, code: string, subject: string | null, message: string, fix: string | null = null) =>
    out.push({ code, severity, subject, message, fix });

  if (project.loadError || !project.system || !project.manifest) {
    add("error", "DECLARATION_LOAD_FAILED", "system.ts", project.loadError ?? "system.ts did not load");
    return sortDiagnostics(out);
  }
  const m = project.manifest;
  const system = project.system;
  const actors = new Map(m.actors.map((a) => [a.name, a]));
  const messages = new Map(m.messages.map((x) => [x.name, x]));
  const effects = new Map(m.effects.map((e) => [e.name, e]));
  const external = new Set([...FIXED_SENDERS, ...(m.sources ?? []).map((src) => `@${src.name}`)]);

  for (const a of m.actors) {
    if (!ACTOR_NAME.test(a.name)) add("error", "NAME_INVALID", a.name, `Actor name "${a.name}" must be a PascalCase class name`);
    if (a.justification.length === 0)
      add("error", "ACTOR_UNJUSTIFIED", a.name, `${a.name} lists no justification for being an actor`, "Name which of identity, state, lifecycle, isolation, scheduling, or permissions applies, or make it a function.");
    if ((a.kind === "agent" || a.kind === "model-assisted") && !a.budget)
      add("error", "ACTOR_BUDGET_MISSING", a.name, `${a.name} is ${a.kind} but declares no budget`, a.kind === "agent" ? 'Add budget: { usd, turns, wallClock } (such as { usd: 5, turns: 40, wallClock: "30m" }) so each session is bounded.' : "Add budget: { maxAttempts, timeoutMs } so model work is bounded.");
    // The manifest writes an absent maxTokens, maxAttempts and timeoutMs as null.
    for (const [field, v] of Object.entries(a.budget ?? {})) {
      if (v === null) continue;
      if (field === "usd") {
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) add("error", "ACTOR_BUDGET_INVALID", a.name, `${a.name} declares budget.usd ${String(v)}, which isn't a positive finite number`, "Use a positive number of US dollars, such as 5.");
      } else if (field === "wallClock") {
        if (typeof v !== "string" || durationMs(v) === null) add("error", "ACTOR_BUDGET_INVALID", a.name, `${a.name} declares budget.wallClock ${String(v)}, which isn't a duration like 30m`, 'Use a duration such as "30m" or "2h".');
      } else if (!Number.isInteger(v) || (v as number) < 1)
        add("error", "ACTOR_BUDGET_INVALID", a.name, `${a.name} declares budget.${field} ${String(v)}, which isn't a positive whole number`, "Use a positive integer.");
    }
    if (a.kind === "model-assisted" && a.budget && (a.budget.maxAttempts === null || a.budget.timeoutMs === null))
      add("error", "ACTOR_BUDGET_MISSING", a.name, `${a.name} is model-assisted but its budget lacks maxAttempts or timeoutMs`, "Add budget: { maxAttempts, timeoutMs } so model work is bounded.");
    if (a.kind === "agent") checkAgent(project, m, a, add);
    const scheduled = new Set<string>();
    for (const s of a.schedules) {
      if (s.cron !== null && !cronParses(s.cron)) add("error", "SCHEDULE_INVALID", a.name, `schedule cron "${s.cron}" isn't a valid cron expression like 0 9 * * *`);
      else if (s.cron === null && s.everyMs === null) add("error", "SCHEDULE_INVALID", a.name, `schedule.every "${s.every}" isn't a duration like 15m`);
      if (scheduled.has(s.message)) add("error", "SCHEDULE_DUPLICATE", a.name, `${a.name} schedules ${s.message} more than once`, "Keep one schedule per message; a second message gives a second cadence.");
      scheduled.add(s.message);
      if (!m.routes.some((r) => r.from === "@clock" && r.to === a.name && r.message === s.message))
        add("error", "SCHEDULE_ROUTE_MISSING", a.name, `${a.name} schedules ${s.message} but no route delivers it from @clock`, `Add { from: "@clock", message: "${s.message}", to: "${a.name}" }.`);
    }
    for (const e of a.effects)
      if (!effects.has(e)) add("error", "EFFECT_UNDECLARED", a.name, `${a.name} requests effect "${e}", which the system doesn't declare`, "Declare it under effects, with its idempotency, or remove it.");
    if (a.receives.length === 0)
      add("warning", "ACTOR_UNREACHABLE", a.name, `No route delivers anything to ${a.name}, so nothing can ever activate it`);
  }
  for (const msg of m.messages)
    if (reservedAgentName(msg.name)) add("error", "AGENT_NAME_RESERVED", msg.name, `${msg.name} is reserved for the agent runtime and can't be declared as a message`, "Rename it.");
  for (const e of m.effects)
    if (reservedAgentName(e.name)) add("error", "AGENT_NAME_RESERVED", e.name, `${e.name} is reserved for the agent runtime and can't be declared as an effect`, "Rename it.");
  const bindings = new Map<string, string[]>();
  for (const a of m.actors) bindings.set(a.binding, [...(bindings.get(a.binding) ?? []), a.name]);
  for (const [b, names] of bindings) if (names.length > 1) add("error", "BINDING_DUPLICATE", b, `Binding ${b} is used by ${names.join(" and ")}`);

  for (const msg of m.messages) {
    if (!MESSAGE_NAME.test(msg.name)) add("error", "NAME_INVALID", msg.name, `Message name "${msg.name}" must be lowercase and dotted, like release.observed`);
    if (!Number.isInteger(msg.version) || msg.version < 1) add("error", "MESSAGE_VERSION_INVALID", msg.name, `${msg.name} version must be a positive integer`);
    const schema = (system.messages[msg.name] as { payload?: { "~standard"?: unknown } } | undefined)?.payload;
    if (!schema?.["~standard"]) add("error", "MESSAGE_SCHEMA_INVALID", msg.name, `${msg.name} payload isn't a Standard Schema (zod 4, valibot, arktype, ...)`);
    else if (!msg.payload) add("warning", "PAYLOAD_SCHEMA_OPAQUE", msg.name, `${msg.name} payload can't be exported as JSON Schema, so diffs can't classify its changes`);
    if (!m.routes.some((r) => r.message === msg.name)) add("warning", "MESSAGE_UNUSED", msg.name, `${msg.name} is declared but no route carries it`);
  }

  const seen = new Set<string>();
  for (const r of m.routes) {
    const label = `${r.from} → ${r.message} → ${r.to}`;
    if (seen.has(label)) add("error", "ROUTE_DUPLICATE", label, `Route ${label} is declared twice`);
    seen.add(label);
    if (r.from.startsWith("@") && !external.has(r.from))
      add("error", "ROUTE_INVALID_SENDER", label, `${r.from} isn't a sender; use @clock, @ingress, @timer, ${(m.sources ?? []).length ? `${(m.sources ?? []).map((src) => `@${src.name}`).join(", ")}, ` : ""}or an actor`, `Declare a source named ${r.from.slice(1)} under sources, or use a sender that exists.`);
    else if (!r.from.startsWith("@") && !actors.has(r.from)) add("error", "ROUTE_UNKNOWN_ACTOR", label, `Route sender ${r.from} isn't a declared actor`);
    if (!actors.has(r.to)) add("error", "ROUTE_UNKNOWN_ACTOR", label, `Route receiver ${r.to} isn't a declared actor`);
    if (!messages.has(r.message)) add("error", "ROUTE_UNKNOWN_MESSAGE", label, `Route message ${r.message} isn't declared`);
    if (r.from === "@clock" && !actors.get(r.to)?.schedules.some((s) => s.message === r.message))
      add("error", "CLOCK_ROUTE_WITHOUT_SCHEDULE", label, `@clock delivers ${r.message} to ${r.to}, but ${r.to} has no schedule for it`);
  }
  for (const e of m.effects) {
    for (const [field, v] of Object.entries(e.budget ?? {}))
      if (!Number.isInteger(v) || v < 1) add("error", "EFFECT_BUDGET_INVALID", e.name, `${e.name} declares budget.${field} ${String(v)}, which isn't a positive whole number`, "Use a positive integer, or remove the field to inherit the actor's budget.");
    if (e.result) {
      if (!messages.has(e.result)) add("error", "EFFECT_RESULT_UNKNOWN_MESSAGE", e.name, `${e.name} delivers its outcome as ${e.result}, which isn't a declared message`);
      for (const a of m.actors.filter((a) => a.effects.includes(e.name)))
        if (!m.routes.some((r) => r.from === a.name && r.to === a.name && r.message === e.result))
          add("error", "EFFECT_RESULT_ROUTE_MISSING", `${a.name} → ${e.name}`, `${a.name} requests ${e.name}, whose outcome arrives as ${e.result}, but no route delivers ${e.result} from ${a.name} to itself`, `Add { from: "${a.name}", message: "${e.result}", to: "${a.name}" }.`);
    }
    if (e.expires !== undefined && e.approval !== "human")
      add("warning", "APPROVAL_EXPIRES_IGNORED", e.name, `${e.name} sets expires: "${e.expires}" but has no approval: "human", so nothing waits to expire`, `Add approval: "human", or remove expires.`);
    if (e.kind === "job") {
      if (e.deadline === null || durationMs(e.deadline) === null)
        add("error", "JOB_DEADLINE_MISSING", e.name, e.deadline === null ? `${e.name} is a job with no deadline, so a job that never reports back would wait forever` : `${e.name} has deadline "${e.deadline}", which isn't a duration like 2h`, `Add deadline: "2h": how long to wait before the outcome is in_doubt.`);
      if (!e.probe && !e.completes)
        add("warning", "JOB_UNOBSERVABLE", e.name, `${e.name} is a job with neither probe nor completes: nothing can tell it finished, so every run ends in_doubt at its deadline`, `Add completes: { message } and call ctx.settleJob from that message's handler, or probe: { every } with a probe() in the adapter.`);
      if (e.completes) {
        const done = e.completes.message;
        for (const a of m.actors.filter((a) => a.effects.includes(e.name)))
          if (!messages.has(done) || !m.routes.some((r) => r.message === done && r.to === a.name))
            add("error", "JOB_COMPLETES_ROUTE_MISSING", `${a.name} → ${e.name}`, `${a.name} requests job ${e.name}, which completes with ${done}, but ${messages.has(done) ? `no route delivers ${done} to ${a.name}` : `${done} isn't a declared message`}`, `Declare ${done} and a route that delivers it to ${a.name}, for example { from: "@ingress", message: "${done}", to: "${a.name}" }.`);
      }
    }
    if (e.kind === "decision" || e.kind === "extraction") checkDecisionEffect(e, add);
    else if (e.questions !== null || e.fields !== null || e.mode !== null || e.model !== null)
      add("error", "DECISION_FIELD_MISPLACED", e.name, `${e.name} is a ${e.kind} effect but declares ${[e.model !== null && "model", e.questions !== null && "questions", e.fields !== null && "fields", e.mode !== null && "mode"].filter(Boolean).join(", ")}, which only a decision or an extraction uses`, `Set kind: "decision" or kind: "extraction", or remove the field.`);
    if (!m.actors.some((a) => a.effects.includes(e.name))) add("warning", "EFFECT_UNUSED", e.name, `Effect ${e.name} is declared but no actor may request it`);
    if (e.idempotency === "none" && !e.reconcile)
      add("warning", "EFFECT_IN_DOUBT", e.name, `${e.name} has no idempotency key and no reconciliation: an attempt whose acknowledgment is lost is in doubt and must be reported as in_doubt, never retried blindly or reported as delivered`);
  }
  for (const cycle of findCycles(m)) add("warning", "ROUTE_CYCLE", cycle.join(" → "), `Messages can loop: ${cycle.join(" → ")}. Make sure handlers terminate and dedupe redeliveries.`);

  checkSources(project, m, add);
  checkConfig(project, m, add);
  checkManifest(project, m, add);
  return sortDiagnostics(out);
}

type Add = (s: Severity, c: string, subj: string | null, msg: string, fix?: string | null) => void;

/** Sources and approvals: the routes a source needs, one path per webhook, declared secrets, and the approval-by-email contract. */
function checkSources(project: Project, m: Manifest, add: Add) {
  const sources = m.sources ?? [];
  const routesFrom = (name: string, message: string) => m.routes.filter((r) => r.from === `@${name}` && r.message === message);
  const paths = new Map<string, string[]>();
  for (const src of sources) {
    if (RESERVED_SENDERS.includes(`@${src.name}`))
      add("error", "SOURCE_NAME_RESERVED", `@${src.name}`, `A source can't be named ${src.name}: @${src.name} is a sender the runtime uses itself, so the source's messages couldn't be told apart from the runtime's`, `Rename the source, for example after the provider it listens to (github, email).`);
    const mapped = src.kind === "webhook" ? src.events.map((e) => e.message) : src.message ? [src.message] : [];
    for (const msg of [...new Set(mapped)]) {
      const found = routesFrom(src.name, msg);
      if (found.length === 0)
        add("error", "SOURCE_ROUTE_MISSING", `@${src.name}`, `@${src.name} delivers ${msg}, but no route carries it from @${src.name}`, `Add { from: "@${src.name}", message: "${msg}", to: "<actor>" }.`);
      // An email reply goes to the actor named in its signed token, so one route per gated actor is the intended shape.
      else if (found.length > 1 && src.kind !== "email")
        add("error", "SOURCE_ROUTE_AMBIGUOUS", `@${src.name}`, `More than one route from @${src.name} carries ${msg} (to ${found.map((r) => r.to).join(" and ")}), so the source can't tell which actor receives it`, "Keep one route per message from a source.");
    }
    if (src.path !== null) paths.set(src.path, [...(paths.get(src.path) ?? []), src.name]);
  }
  for (const [path, names] of paths)
    if (names.length > 1) add("error", "SOURCE_PATH_DUPLICATE", path, `Sources ${names.join(" and ")} both listen on ${path}`, "Give each webhook source its own path.");

  const declared = declaredEnvNames(project);
  const sendBindings = new Set((project.config?.send_email ?? []).map((b) => b.name));
  for (const [name, spec] of Object.entries(project.system?.sources ?? {})) {
    if (!declared.has(spec.secret))
      add("warning", "SOURCE_SECRET_UNDECLARED", `@${name}`, `@${name} verifies with ${spec.secret}, which is in neither wrangler vars nor .dev.vars.example`, `List ${spec.secret} in .dev.vars.example (and set it with \`wrangler secret put ${spec.secret}\`).`);
    if (spec.kind !== "email") continue;
    // handleEmail reads these too: each says what the runtime does when its entry is missing.
    const reads: Array<[string | undefined, string, string]> = [
      [spec.owner, `reads the owner's address from ${spec.owner}`, "every reply would be refused (owner_missing)"],
      [spec.from, `sends its replies from the address in ${spec.from}`, "no reply could be sent"],
      [spec.authserv, `trusts the authserv-id in ${spec.authserv}`, "every reply would be refused (authserv_missing)"],
    ];
    for (const [entry, what, then] of reads)
      if (entry !== undefined && !declared.has(entry))
        add("warning", "SOURCE_ENV_UNDECLARED", `@${name}`, `@${name} ${what}, which is in neither wrangler vars nor .dev.vars.example, so ${then}`, `Add ${entry} to wrangler vars, or list it in .dev.vars.example.`);
    if (!sendBindings.has(spec.send))
      add("warning", "SOURCE_SEND_UNDECLARED", `@${name}`, `@${name} replies through the send_email binding ${spec.send}, which wrangler's send_email bindings don't declare, so the owner would never hear back`, `Add { "name": "${spec.send}" } to send_email in the wrangler config.`);
  }

  const notify = m.approvals?.notify;
  const gatedActors = m.actors.filter((a) => a.effects.some((e) => m.effects.find((x) => x.name === e)?.approval === "human"));
  if (notify !== undefined) {
    const known = m.effects.some((e) => e.name === notify);
    if (!known) add("error", "APPROVAL_NOTIFY_UNKNOWN", notify, `approvals.notify names ${notify}, which isn't a declared effect`, `Declare ${notify} under effects, or change approvals.notify.`);
    if (m.effects.find((e) => e.name === notify)?.approval === "human")
      add("error", "APPROVAL_NOTIFY_NEEDS_APPROVAL", notify, `${notify} tells a person an approval is waiting, but it needs approval itself, so the request could never be sent`, `Remove approval: "human" from ${notify}.`);
    for (const a of known ? gatedActors : [])
      if (!a.effects.includes(notify)) add("error", "APPROVAL_NOTIFY_UNDECLARED", a.name, `${a.name} requests approvals but doesn't list ${notify}, the effect that tells a person one is waiting`, `Add "${notify}" to ${a.name}'s effects.`);
  }
  const email = sources.find((src) => src.kind === "email");
  if (email?.message)
    for (const a of gatedActors)
      if (!m.routes.some((r) => r.from === `@${email.name}` && r.message === email.message && r.to === a.name))
        add("error", "APPROVAL_ROUTE_MISSING", a.name, `${a.name} requests approvals, but no route delivers ${email.message} from @${email.name} to it, so a reply could never reach it`, `Add { from: "@${email.name}", message: "${email.message}", to: "${a.name}" }.`);
  for (const e of m.effects)
    if (e.publishes === true && e.approval !== "human")
      add("error", "PUBLISHES_WITHOUT_APPROVAL", e.name, `${e.name} publishes but doesn't need approval, so nothing checks what goes public`, `Add approval: "human", or remove publishes.`);
}

/** Names the project declares for its Worker's env: wrangler `vars` and the lines of `.dev.vars.example`. */
function declaredEnvNames(project: Project): Set<string> {
  const names = new Set(Object.keys(project.config?.vars ?? {}));
  const example = join(project.root, ".dev.vars.example");
  if (existsSync(example))
    for (const line of readFileSync(example, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m?.[1]) names.add(m[1]);
    }
  return names;
}

function checkConfig(project: Project, m: Manifest, add: Add) {
  if (!project.config) {
    add("error", "CONFIG_MISSING", "wrangler.jsonc", project.configFile ? `${project.configFile} doesn't parse` : "No wrangler.jsonc next to system.ts", "Add one; `actord init --adopt` writes the Durable Object bindings and exports the declaration needs.");
    return;
  }
  const cfg = project.config;
  const bindings = cfg.durable_objects?.bindings ?? [];
  const legacy = Array.isArray(cfg.migrations) && cfg.migrations.length > 0;
  if (legacy) add("warning", "CONFIG_LEGACY_MIGRATIONS", project.configFile, "wrangler config uses the legacy migrations array; Cloudflare's declarative exports map is the current flow", "Move Durable Object classes to exports (see docs/decisions/0006).");
  const legacyClasses = new Set(
    (cfg.migrations ?? []).flatMap((x) => [...((x as { new_sqlite_classes?: string[] }).new_sqlite_classes ?? []), ...((x as { new_classes?: string[] }).new_classes ?? [])]),
  );
  for (const a of m.actors) {
    const b = bindings.find((x) => x.name === a.binding);
    if (!b) add("error", "CONFIG_BINDING_MISSING", a.name, `wrangler config has no Durable Object binding ${a.binding} for ${a.name}`, `Add { "name": "${a.binding}", "class_name": "${a.name}" } to durable_objects.bindings.`);
    else if (b.class_name !== a.name) add("error", "CONFIG_BINDING_CLASS_MISMATCH", a.name, `Binding ${a.binding} points at class ${b.class_name}, not ${a.name}`);
    const exp = cfg.exports?.[a.name];
    const live = exp && exp.type === "durable-object" && (exp.state ?? "created") === "created";
    if (!live && !legacyClasses.has(a.name))
      add("error", "CONFIG_EXPORT_MISSING", a.name, `wrangler config doesn't declare ${a.name} as a live Durable Object export`, `Add "exports": { "${a.name}": { "type": "durable-object", "storage": "sqlite" } }.`);
    if (project.entryExports && !project.entryExports.has(a.name))
      add("error", "ENTRY_EXPORT_MISSING", a.name, `The Worker entry (${project.entryFile}) doesn't export class ${a.name}`, `Export it, for example: export { ${a.name} } from "./actors/...";`);
  }
  if (!project.entryExports) add("error", "ENTRY_MISSING", project.configFile, "wrangler config has no main entry file, or it doesn't exist");
  const declared = new Set(m.actors.map((a) => a.binding));
  for (const b of bindings)
    if (!declared.has(b.name)) add("warning", "CONFIG_UNDECLARED_DO", b.name, `Durable Object binding ${b.name} (${b.class_name}) isn't in system.ts; it's an escape hatch the checks can't see`);
}

function checkManifest(project: Project, m: Manifest, add: Add) {
  if (project.committedManifestRaw === null) {
    add("warning", "MANIFEST_MISSING", MANIFEST_FILE, `No ${MANIFEST_FILE}; \`actord diff\` uses the committed copy as its base`, "Run `actord graph --write` and commit it.");
  } else if (project.committedManifestRaw !== serializeManifest(m)) {
    add("error", "MANIFEST_STALE", MANIFEST_FILE, `${MANIFEST_FILE} doesn't match system.ts`, "Run `actord graph --write` and commit the result.");
  }
}

/** Elementary cycles among actors (excluding self-loops through @clock), each reported once from its smallest name. */
function findCycles(m: Manifest): string[][] {
  // A self-route carrying an effect's declared result is the designed way back from an external wait.
  const results = new Set(m.effects.map((e) => e.result).filter(Boolean));
  const edges = new Map<string, Set<string>>();
  for (const r of m.routes) {
    if (r.from.startsWith("@") || (r.from === r.to && results.has(r.message))) continue;
    edges.set(r.from, (edges.get(r.from) ?? new Set()).add(r.to));
  }
  const cycles: string[][] = [];
  const names = [...edges.keys()].sort();
  for (const start of names) {
    const stack: string[] = [start];
    const walk = (node: string) => {
      for (const next of [...(edges.get(node) ?? [])].sort()) {
        if (next === start) cycles.push([...stack, start]);
        else if (next > start && !stack.includes(next)) {
          stack.push(next);
          walk(next);
          stack.pop();
        }
      }
    };
    walk(start);
  }
  return cycles;
}

function sortDiagnostics(d: Diagnostic[]): Diagnostic[] {
  const rank = (x: Diagnostic) => (x.severity === "error" ? 0 : 1);
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return d.sort((a, b) => rank(a) - rank(b) || cmp(a.code, b.code) || cmp(a.subject ?? "", b.subject ?? "") || cmp(a.message, b.message));
}


const CLEF_MODELS = ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"];
const CLAIRIC_MODEL = "@cf/cloudflare/clairic";
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$/;
const FIELD_TYPES = ["text", "number", "date", "time", "datetime", "duration", "list", "estimate", "forecast"];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A problem with one decision question, or null when it is valid. */
function questionProblem(id: string, q: unknown): string | null {
  if (!QUESTION_ID.test(id)) return `question id "${id}" doesn't match ${QUESTION_ID.source}`;
  if (!isObject(q)) return `question ${id} isn't an object`;
  if (typeof q.instructions !== "string" || q.instructions.trim() === "") return `question ${id} has no instructions`;
  if (q.type === "noul") return null;
  if (q.type === "choice") {
    const n = isObject(q.criteria) ? Object.keys(q.criteria).length : 0;
    return n >= 2 && n <= 255 ? null : `choice question ${id} has ${n} options; Clef takes 2 to 255`;
  }
  if (q.type === "score") {
    const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
    return n >= 2 && n <= 10 ? null : `score question ${id} has ${n} levels; Clef takes 2 to 10`;
  }
  return `question ${id} has type ${JSON.stringify(q.type)}; use noul, choice or score`;
}

/** A problem with one extraction field, or null when it is valid. */
function fieldProblem(name: string, f: unknown): string | null {
  if (!FIELD_NAME.test(name)) return `field name "${name}" doesn't match ${FIELD_NAME.source}`;
  if (!isObject(f) || typeof f.type !== "string" || !FIELD_TYPES.includes(f.type)) return `field ${name} has type ${JSON.stringify(isObject(f) ? f.type : f)}; use ${FIELD_TYPES.join(", ")}`;
  if (f.type === "list" && !["text", "number", "date"].includes(f.items as string)) return `list field ${name} needs items: "text", "number" or "date"`;
  if ((f.type === "estimate" || f.type === "forecast") && (f.min === undefined || f.max === undefined)) return `${f.type} field ${name} needs both min and max`;
  if (f.decimals !== undefined && !(Number.isInteger(f.decimals) && (f.decimals as number) >= 0 && (f.decimals as number) <= 6)) return `field ${name} has decimals ${String(f.decimals)}; use 0 to 6`;
  if (f.null_threshold !== undefined && !(typeof f.null_threshold === "number" && f.null_threshold > 0 && f.null_threshold <= 1)) return `field ${name} has null_threshold ${String(f.null_threshold)}; use a number above 0 and at most 1`;
  if (f.horizon !== undefined && !(Number.isInteger(f.horizon) && (f.horizon as number) >= 1 && (f.horizon as number) <= 64)) return `field ${name} has horizon ${String(f.horizon)}; use 1 to 64`;
  return null;
}

/** The checks of a decision (Clef) or extraction (Clairic) effect: declared well, a pure read, and heard from. */
function checkDecisionEffect(e: ManifestEffect, add: AddFn) {
  const decision = e.kind === "decision";
  const label = decision ? "decision" : "extraction";
  if (decision ? e.model === null || !CLEF_MODELS.includes(e.model) : e.model !== CLAIRIC_MODEL)
    add("error", "DECISION_MODEL_UNKNOWN", e.name, `${e.name} is a ${label} with model ${e.model === null ? "none" : `"${e.model}"`}`, `Use model: ${decision ? CLEF_MODELS.map((x) => `"${x}"`).join(" or ") : `"${CLAIRIC_MODEL}"`}.`);
  if (decision) {
    const entries = e.questions === null ? [] : Object.entries(e.questions);
    const problem = e.questions === null ? "it declares no questions" : entries.length < 1 || entries.length > 64 ? `it declares ${entries.length} questions; Clef takes 1 to 64` : entries.map(([id, q]) => questionProblem(id, q)).find((p) => p !== null);
    if (problem) add("error", "DECISION_QUESTIONS_INVALID", e.name, `${e.name}: ${problem}`, `Declare 1 to 64 questions, each noul, choice (2 to 255 options) or score (2 to 10 levels), with instructions.`);
    if (e.mode === "shadow" && e.result)
      add("error", "DECISION_SHADOW_RESULT", e.name, `${e.name} is a shadow decision but delivers ${e.result}; a shadow answer is recorded for the scorecard and never delivered`, `Remove result, or set mode: "act".`);
    if (e.mode !== "shadow" && !e.result)
      add("warning", "DECISION_RESULT_MISSING", e.name, `${e.name} is an act-mode decision with no result, so the actor would never see the answer`, `Add result: "<message>", or set mode: "shadow" to only record it.`);
    if (e.fields !== null) add("error", "DECISION_FIELD_MISPLACED", e.name, `${e.name} is a decision but declares fields, which only an extraction uses`, `Use questions, or make it an extraction.`);
  } else {
    const entries = e.fields === null ? [] : Object.entries(e.fields);
    const problem = entries.length < 1 ? "it declares no fields" : entries.map(([n, f]) => fieldProblem(n, f)).find((p) => p !== null);
    if (problem) add("error", "EXTRACTION_FIELDS_INVALID", e.name, `${e.name}: ${problem}`, `Declare at least one field; see the Clairic field types and limits.`);
    if (!e.result) add("warning", "DECISION_RESULT_MISSING", e.name, `${e.name} is an extraction with no result, so the actor would never see what it extracted`, `Add result: "<message>".`);
    for (const f of ["questions", "mode"] as const)
      if (e[f] !== null) add("error", "DECISION_FIELD_MISPLACED", e.name, `${e.name} is an extraction but declares ${f}, which only a decision uses`, `Remove ${f}, or make it a decision.`);
  }
  for (const f of ["deadline", "probe", "completes"] as const)
    if (e[f] !== null) add("error", "DECISION_FIELD_MISPLACED", e.name, `${e.name} is a ${label} but declares ${f}, which only a job uses`, `Remove ${f}: a ${label} is answered within one request.`);
  if (e.publishes === true) add("error", "DECISION_PUBLISHES", e.name, `${e.name} is a ${label} and publishes; it only reads, so nothing public can come from it`, `Remove publishes: true.`);
  if (e.idempotency === "none") add("warning", "DECISION_IDEMPOTENCY_NONE", e.name, `${e.name} declares idempotency: "none", but a ${label} is a deterministic read`, `Use idempotency: "key"; a retry is always safe.`);
}
