// The normalized system model. Every view (check, graph, diff, the Room, eval graders) reads this, never
// system.ts directly. Arrays are sorted and keys ordered so identical input gives identical bytes.
import { sortKeys } from "../cli/output.ts";
import { durationMs, type System } from "../system.ts";

export const MANIFEST_FILE = "actord.manifest.json";
export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestActor {
  name: string;
  binding: string;
  kind: string;
  purpose: string;
  justification: string[];
  schedule: { every: string; everyMs: number | null; message: string } | null;
  effects: string[];
  budget: { maxAttempts: number; timeoutMs: number; maxTokens: number | null } | null;
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
  result: string | null;
}

export interface Manifest {
  schemaVersion: number;
  $comment: string;
  system: { name: string; description: string };
  actors: ManifestActor[];
  messages: ManifestMessage[];
  routes: ManifestRoute[];
  effects: ManifestEffect[];
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
      schedule: a.schedule ? { every: a.schedule.every, everyMs: durationMs(a.schedule.every), message: a.schedule.message } : null,
      effects: [...(a.effects ?? [])].sort(),
      budget: a.budget ? { maxAttempts: a.budget.maxAttempts, timeoutMs: a.budget.timeoutMs, maxTokens: a.budget.maxTokens ?? null } : null,
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
      result: e.result ?? null,
    }))
    .sort(byName);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    $comment: "Derived from system.ts by `actord graph --write`. Do not edit; `actord check` fails when it is stale.",
    system: { name: system.name, description: system.description ?? "" },
    actors: sortKeys(actors),
    messages: sortKeys(messages),
    routes,
    effects: sortKeys(effects),
  };
}

function jsonSchemaOf(schema: unknown): Record<string, unknown> | null {
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
  const { $comment, schemaVersion, system, actors, messages, routes, effects } = m;
  return `${JSON.stringify({ $comment, schemaVersion, system, actors, messages, routes, effects }, null, 2)}\n`;
}
