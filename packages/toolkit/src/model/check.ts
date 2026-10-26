// `actord check`: what the type system can't express. Hard errors fail the check; warnings are advice.
// Every diagnostic has a stable code so tests, hooks, and graders can match on it.
import { parseCronExpression } from "cron-schedule";
import type { Project } from "./load.ts";
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
const EXTERNAL = new Set(["@clock", "@ingress", "@timer"]);

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
    if (r.from.startsWith("@") && !EXTERNAL.has(r.from)) add("error", "ROUTE_INVALID_SENDER", label, `${r.from} isn't a sender; use @clock, @ingress, @timer, or an actor`);
    else if (!r.from.startsWith("@") && !actors.has(r.from)) add("error", "ROUTE_UNKNOWN_ACTOR", label, `Route sender ${r.from} isn't a declared actor`);
    if (!actors.has(r.to)) add("error", "ROUTE_UNKNOWN_ACTOR", label, `Route receiver ${r.to} isn't a declared actor`);
    if (!messages.has(r.message)) add("error", "ROUTE_UNKNOWN_MESSAGE", label, `Route message ${r.message} isn't declared`);
    if (r.from === "@clock" && !actors.get(r.to)?.schedules.some((s) => s.message === r.message))
      add("error", "CLOCK_ROUTE_WITHOUT_SCHEDULE", label, `@clock delivers ${r.message} to ${r.to}, but ${r.to} has no schedule for it`);
  }
  for (const e of m.effects) {
    if (e.result) {
      if (!messages.has(e.result)) add("error", "EFFECT_RESULT_UNKNOWN_MESSAGE", e.name, `${e.name} delivers its outcome as ${e.result}, which isn't a declared message`);
      for (const a of m.actors.filter((a) => a.effects.includes(e.name)))
        if (!m.routes.some((r) => r.from === a.name && r.to === a.name && r.message === e.result))
          add("error", "EFFECT_RESULT_ROUTE_MISSING", `${a.name} → ${e.name}`, `${a.name} requests ${e.name}, whose outcome arrives as ${e.result}, but no route delivers ${e.result} from ${a.name} to itself`, `Add { from: "${a.name}", message: "${e.result}", to: "${a.name}" }.`);
    }
    if (!m.actors.some((a) => a.effects.includes(e.name))) add("warning", "EFFECT_UNUSED", e.name, `Effect ${e.name} is declared but no actor may request it`);
    if (e.idempotency === "none" && !e.reconcile)
      add("warning", "EFFECT_IN_DOUBT", e.name, `${e.name} has no idempotency key and no reconciliation: an attempt whose acknowledgment is lost is in doubt and must be reported as in_doubt, never retried blindly or reported as delivered`);
  }
  for (const cycle of findCycles(m)) add("warning", "ROUTE_CYCLE", cycle.join(" → "), `Messages can loop: ${cycle.join(" → ")}. Make sure handlers terminate and dedupe redeliveries.`);

  checkConfig(project, m, add);
  checkManifest(project, m, add);
  return sortDiagnostics(out);
}

function checkConfig(project: Project, m: Manifest, add: (s: Severity, c: string, subj: string | null, msg: string, fix?: string | null) => void) {
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

function checkManifest(project: Project, m: Manifest, add: (s: Severity, c: string, subj: string | null, msg: string, fix?: string | null) => void) {
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

