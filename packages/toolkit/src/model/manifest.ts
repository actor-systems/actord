// The normalized system model. Every view (check, graph, diff, the Room, eval graders) reads this, never
// system.ts directly. Arrays are sorted and keys ordered so identical input gives identical bytes.
import { sortKeys } from "../cli/output.ts";
import { durationMs, type HarnessSpec, type System } from "../system.ts";

export const MANIFEST_FILE = "actord.manifest.json";
export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestSchedule {
  every: string | null;
  everyMs: number | null;
  cron: string | null;
  message: string;
}

/** "every 15m" or "cron 0 9 * * *": how a schedule reads in the graph and the facts line. */
export function scheduleLabel(s: Pick<ManifestSchedule, "every" | "cron">): string {
  return s.cron !== null ? `cron ${s.cron}` : `every ${s.every}`;
}

export interface ManifestActor {
  name: string;
  binding: string;
  kind: string;
  purpose: string;
  justification: string[];
  schedules: ManifestSchedule[];
  effects: string[];
  budget: { maxAttempts: number | null; timeoutMs: number | null; maxTokens: number | null; usd?: number; turns?: number; wallClock?: string } | null;
  /** The fields below are present only when an agent actor declares them. */
  harness?: HarnessSpec;
  model?: { id: string; reasoning?: string };
  instructions?: string;
  tools?: string[];
  on?: Record<string, string>;
  returns?: string;
  receives: string[];
  sends: string[];
}

export interface ManifestMessage {
  name: string;
  version: number;
  description: string;
  /** JSON Schema (draft 2020-12) of the payload input, or null when the schema library can't export one. */
  payload: Record<string, unknown> | null;
}

export interface ManifestRoute {
  from: string;
  message: string;
  to: string;
}

export interface ManifestEffect {
  name: string;
  description: string;
  idempotency: string;
  reconcile: boolean;
  approval: string;
  /** Present only when the effect declares one: how long an approval waits before it expires. */
  expires?: string;
  result: string | null;
  /** Present only when the effect declares one. */
  budget?: { maxAttempts?: number; timeoutMs?: number };
  /** "call", "job", "decision" or "extraction". */
  kind: string;
  /** A decision's or extraction's model; null for other kinds. */
  model: string | null;
  /** A decision's questions, verbatim; null for other kinds. */
  questions: Record<string, unknown> | null;
  /** An extraction's fields, verbatim; null for other kinds. */
  fields: Record<string, unknown> | null;
  /** A decision's mode ("act" by default); null for other kinds. */
  mode: string | null;
  /** A job's deadline, such as "2h"; null when none is declared. */
  deadline: string | null;
  probe: { every: string } | null;
  /** The message whose handler settles the job with ctx.settleJob. */
  completes: { message: string } | null;
  /** Present only when true: the effect makes something public. */
  publishes?: true;
  /** Present only when declared: JSON Schema of the parameters of the tool an agent sees for this effect. */
  input?: Record<string, unknown> | null;
}

export interface ManifestSource {
  name: string;
  /** "webhook" or "email". */
  kind: string;
  /** A webhook's path; null for email. */
  path: string | null;
  /** A webhook's signature scheme; null for email. */
  verify: string | null;
  /** A webhook's event names and the messages they become. */
  events: Array<{ event: string; message: string }>;
  /** An email source's decision message; null for a webhook. */
  message: string | null;
}

export interface Manifest {
  schemaVersion: number;
  $comment: string;
  system: { name: string; description: string };
  actors: ManifestActor[];
  messages: ManifestMessage[];
  routes: ManifestRoute[];
  effects: ManifestEffect[];
  sources: ManifestSource[];
  /** The effect that tells a person an approval is waiting; null when the system declares none. */
  approvals: { notify: string } | null;
}

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const routeKey = (r: ManifestRoute) => `${r.from}\u0000${r.message}\u0000${r.to}`;

export function normalize(system: System): Manifest {
  const routes = (system.routes ?? [])
    .map((r) => ({ from: String(r.from), message: String(r.message), to: String(r.to) }))
    .sort((a, b) => (routeKey(a) < routeKey(b) ? -1 : routeKey(a) > routeKey(b) ? 1 : 0));
  const actors = Object.entries(system.actors ?? {})
    .map(([name, a]): ManifestActor => ({
      name,
      binding: a.binding,
      kind: a.kind,
      purpose: a.purpose ?? "",
      justification: [...(a.justification ?? [])].sort(),
      schedules: (a.schedules ?? []).map((s) => ({
        every: s.every ?? null,
        everyMs: s.every === undefined ? null : durationMs(s.every),
        cron: s.cron ?? null,
        message: s.message,
      })),
      effects: [...(a.effects ?? [])].sort(),
      budget: a.budget
        ? {
            maxAttempts: a.budget.maxAttempts ?? null,
            timeoutMs: a.budget.timeoutMs ?? null,
            maxTokens: a.budget.maxTokens ?? null,
            ...(a.budget.usd !== undefined ? { usd: a.budget.usd } : {}),
            ...(a.budget.turns !== undefined ? { turns: a.budget.turns } : {}),
            ...(a.budget.wallClock !== undefined ? { wallClock: a.budget.wallClock } : {}),
          }
        : null,
      ...(a.harness ? { harness: JSON.parse(JSON.stringify(a.harness)) as HarnessSpec } : {}),
      ...(a.model ? { model: { id: a.model.id, ...(a.model.reasoning ? { reasoning: a.model.reasoning } : {}) } } : {}),
      ...(a.instructions !== undefined ? { instructions: a.instructions } : {}),
      ...(a.tools ? { tools: [...a.tools].sort() } : {}),
      ...(a.on ? { on: { ...a.on } } : {}),
      ...(a.returns !== undefined ? { returns: a.returns } : {}),
      receives: [...new Set(routes.filter((r) => r.to === name).map((r) => r.message))].sort(),
      sends: [...new Set(routes.filter((r) => r.from === name).map((r) => r.message))].sort(),
    }))
    .sort(byName);
  const messages = Object.entries(system.messages ?? {})
    .map(([name, m]): ManifestMessage => ({ name, version: m.version, description: m.description ?? "", payload: jsonSchemaOf(m.payload) }))
    .sort(byName);
  const effects = Object.entries(system.effects ?? {})
    .map(([name, e]): ManifestEffect => ({
      name,
      description: e.description ?? "",
      idempotency: e.idempotency,
      reconcile: e.reconcile ?? false,
      approval: e.approval ?? "none",
      ...(e.expires ? { expires: e.expires } : {}),
      result: e.result ?? null,
      ...(e.budget ? { budget: { ...(e.budget.maxAttempts !== undefined ? { maxAttempts: e.budget.maxAttempts } : {}), ...(e.budget.timeoutMs !== undefined ? { timeoutMs: e.budget.timeoutMs } : {}) } } : {}),
      kind: e.kind ?? "call",
      model: e.model ?? null,
      questions: e.questions ? (e.questions as Record<string, unknown>) : null,
      fields: e.fields ? (e.fields as Record<string, unknown>) : null,
      mode: e.kind === "decision" ? (e.mode ?? "act") : (e.mode ?? null),
      deadline: e.deadline ?? null,
      probe: e.probe ? { every: e.probe.every } : null,
      completes: e.completes ? { message: e.completes.message } : null,
      ...(e.publishes === true ? { publishes: true as const } : {}),
      ...(e.input ? { input: jsonSchemaOf(e.input) } : {}),
    }))
    .sort(byName);
  const sources = Object.entries(system.sources ?? {})
    .map(([name, src]): ManifestSource =>
      src.kind === "webhook"
        ? {
            name,
            kind: "webhook",
            path: src.path,
            verify: src.verify,
            events: Object.entries(src.events ?? {})
              .map(([event, spec]) => ({ event, message: spec.message }))
              .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0)),
            message: null,
          }
        : { name, kind: "email", path: null, verify: null, events: [], message: src.message },
    )
    .sort(byName);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    $comment: "Derived from system.ts by `actord graph --write`. Do not edit; `actord check` fails when it is stale.",
    system: { name: system.name, description: system.description ?? "" },
    actors: sortKeys(actors),
    messages: sortKeys(messages),
    routes,
    effects: sortKeys(effects),
    sources: sortKeys(sources),
    approvals: system.approvals ? { notify: system.approvals.notify } : null,
  };
}

/** JSON Schema (draft 2020-12) of a Standard Schema's input, keys sorted; null when the library can't export one. Agent tools' parameters use it too. */
export function jsonSchemaOf(schema: unknown): Record<string, unknown> | null {
  const std = (schema as { "~standard"?: { jsonSchema?: { input: (o: { target: string }) => Record<string, unknown> } } })?.["~standard"];
  if (!std?.jsonSchema) return null;
  try {
    return sortKeys(std.jsonSchema.input({ target: "draft-2020-12" }));
  } catch {
    return null;
  }
}

export function serializeManifest(m: Manifest): string {
  // $comment first for people reading the file; the rest in fixed order.
  const { $comment, schemaVersion, system, actors, messages, routes, effects, sources, approvals } = m;
  return `${JSON.stringify({ $comment, schemaVersion, system, actors, messages, routes, effects, sources, approvals }, null, 2)}\n`;
}
