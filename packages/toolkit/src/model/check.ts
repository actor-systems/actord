// `actord check`: what the type system can't express. Hard errors fail the check; warnings are advice.
// Every diagnostic has a stable code so tests, hooks, and graders can match on it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCronExpression } from "cron-schedule";
import type { Project } from "./load.ts";
import { durationMs } from "../system.ts";
import { MANIFEST_FILE, type Manifest, serializeManifest } from "./manifest.ts";

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
      add("error", "ACTOR_BUDGET_MISSING", a.name, `${a.name} is ${a.kind} but declares no budget`, "Add budget: { maxAttempts, timeoutMs } so model work is bounded.");
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
    const mapped = src.kind === "webhook" ? src.events.map((e) => e.message) : src.message ? [src.message] : [];
    for (const msg of [...new Set(mapped)]) {
      const found = routesFrom(src.name, msg);
      if (found.length === 0)
        add("error", "SOURCE_ROUTE_MISSING", `@${src.name}`, `@${src.name} delivers ${msg}, but no route carries it from @${src.name}`, `Add { from: "@${src.name}", message: "${msg}", to: "<actor>" }.`);
      else if (found.length > 1)
        add("error", "SOURCE_ROUTE_AMBIGUOUS", `@${src.name}`, `More than one route from @${src.name} carries ${msg} (to ${found.map((r) => r.to).join(" and ")}), so the source can't tell which actor receives it`, "Keep one route per message from a source.");
    }
    if (src.path !== null) paths.set(src.path, [...(paths.get(src.path) ?? []), src.name]);
  }
  for (const [path, names] of paths)
    if (names.length > 1) add("error", "SOURCE_PATH_DUPLICATE", path, `Sources ${names.join(" and ")} both listen on ${path}`, "Give each webhook source its own path.");

  const declared = declaredEnvNames(project);
  for (const [name, spec] of Object.entries(project.system?.sources ?? {}))
    if (!declared.has(spec.secret))
      add("warning", "SOURCE_SECRET_UNDECLARED", `@${name}`, `@${name} verifies with ${spec.secret}, which is in neither wrangler vars nor .dev.vars.example`, `List ${spec.secret} in .dev.vars.example (and set it with \`wrangler secret put ${spec.secret}\`).`);

  const notify = m.approvals?.notify;
  const gatedActors = m.actors.filter((a) => a.effects.some((e) => m.effects.find((x) => x.name === e)?.approval === "human"));
  if (notify !== undefined) {
    if (m.effects.find((e) => e.name === notify)?.approval === "human")
      add("error", "APPROVAL_NOTIFY_NEEDS_APPROVAL", notify, `${notify} tells a person an approval is waiting, but it needs approval itself, so the request could never be sent`, `Remove approval: "human" from ${notify}.`);
    for (const a of gatedActors)
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

