// `actors diff`: compare two normalized models and classify every architectural change, then produce a
// deploy plan. All actors in one Worker deploy atomically, so the compatibility question for messages is
// whether the new code accepts what is already in flight (outboxes, alarms) when the deploy lands.
import type { Manifest, ManifestActor, ManifestEffect, ManifestMessage } from "./manifest.ts";

export type Compatibility = "compatible" | "breaking" | "risky";

export interface Change {
  kind: string;
  subject: string;
  compatibility: Compatibility;
  requiresApproval: boolean;
  irreversible: boolean;
  detail: string;
}

export interface PlanStep {
  kind: "verify" | "config" | "irreversible" | "drain" | "approval" | "schedule" | "lifecycle" | "deploy";
  text: string;
}

export interface DiffResult {
  changes: Change[];
  summary: { total: number; breaking: number; risky: number; requiresApproval: boolean; irreversible: boolean };
  plan: PlanStep[];
}

export const EMPTY_MANIFEST: Manifest = {
  schemaVersion: 1,
  $comment: "",
  system: { name: "", description: "" },
  actors: [],
  messages: [],
  routes: [],
  effects: [],
};

export function diffManifests(base: Manifest, head: Manifest): DiffResult {
  const changes: Change[] = [];
  const add = (kind: string, subject: string, compatibility: Compatibility, detail: string, opts: { approval?: boolean; irreversible?: boolean } = {}) =>
    changes.push({ kind, subject, compatibility, requiresApproval: opts.approval ?? false, irreversible: opts.irreversible ?? false, detail });

  diffKeyed(base.actors, head.actors, {
    added: (a) => add("actor.added", a.name, "compatible", `New actor ${a.name} (${a.kind}); its namespace is provisioned on the next deploy`),
    removed: (a) =>
      add("actor.removed", a.name, "breaking", `Removing ${a.name} retires its Durable Object class: a deleted export destroys all its stored data permanently`, {
        approval: true,
        irreversible: true,
      }),
    changed: (b, h) => diffActor(b, h, add),
  });
  diffKeyed(base.messages, head.messages, {
    added: (m) => add("message.added", m.name, "compatible", `New message ${m.name}@${m.version}`),
    removed: (m) => add("message.removed", m.name, "breaking", `${m.name} is gone; copies already in flight will be rejected after the deploy`),
    changed: (b, h) => diffMessage(b, h, add),
  });
  const key = (r: { from: string; message: string; to: string }) => `${r.from} → ${r.message} → ${r.to}`;
  const baseRoutes = new Set(base.routes.map(key));
  const headRoutes = new Set(head.routes.map(key));
  for (const r of head.routes) if (!baseRoutes.has(key(r))) add("route.added", key(r), "compatible", `New route ${key(r)}`);
  for (const r of base.routes)
    if (!headRoutes.has(key(r))) add("route.removed", key(r), "breaking", `Route removed; in-flight ${r.message} from ${r.from} to ${r.to} will be refused as unauthorized after the deploy`);
  diffKeyed(base.effects, head.effects, {
    added: (e) => add("effect.added", e.name, "risky", `New external effect ${e.name} (idempotency: ${e.idempotency}); a person must approve the new capability`, { approval: true }),
    removed: (e) => add("effect.removed", e.name, "compatible", `Effect ${e.name} removed`),
    changed: (b, h) => diffEffect(b, h, add),
  });
  if (base.system.name && base.system.name !== head.system.name) add("system.renamed", head.system.name, "risky", `System renamed from ${base.system.name}`);

  const order = (c: Change) => `${c.kind}\u0000${c.subject}\u0000${c.detail}`;
  changes.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return {
    changes,
    summary: {
      total: changes.length,
      breaking: changes.filter((c) => c.compatibility === "breaking").length,
      risky: changes.filter((c) => c.compatibility === "risky").length,
      requiresApproval: changes.some((c) => c.requiresApproval || c.irreversible),
      irreversible: changes.some((c) => c.irreversible),
    },
    plan: plan(changes, head),
  };
}

type Add = (kind: string, subject: string, compatibility: Compatibility, detail: string, opts?: { approval?: boolean; irreversible?: boolean }) => void;

function diffKeyed<T extends { name: string }>(base: T[], head: T[], on: { added: (x: T) => void; removed: (x: T) => void; changed: (b: T, h: T) => void }) {
  const b = new Map(base.map((x) => [x.name, x]));
  const h = new Map(head.map((x) => [x.name, x]));
  for (const [name, x] of h) {
    const old = b.get(name);
    if (!old) on.added(x);
    else if (JSON.stringify(old) !== JSON.stringify(x)) on.changed(old, x);
  }
  for (const [name, x] of b) if (!h.has(name)) on.removed(x);
}

function diffActor(b: ManifestActor, h: ManifestActor, add: Add) {
  const s = h.name;
  if (b.binding !== h.binding) add("actor.binding", s, "breaking", `Binding renamed ${b.binding} → ${h.binding}; wrangler.jsonc and every env reference must change together`);
  if (b.kind !== h.kind) add("actor.kind", s, "risky", `Kind ${b.kind} → ${h.kind}${h.kind !== "deterministic" ? ": its output is no longer deterministic" : ""}`);
  if (JSON.stringify(b.schedule) !== JSON.stringify(h.schedule))
    add("actor.schedule", s, "risky", `Schedule ${b.schedule ? `${b.schedule.message} every ${b.schedule.every}` : "none"} → ${h.schedule ? `${h.schedule.message} every ${h.schedule.every}` : "none"}`);
  for (const e of h.effects.filter((e) => !b.effects.includes(e))) add("actor.effect.added", `${s} → ${e}`, "risky", `${s} may now request external effect ${e}`, { approval: true });
  for (const e of b.effects.filter((e) => !h.effects.includes(e))) add("actor.effect.removed", `${s} → ${e}`, "compatible", `${s} no longer requests ${e}`);
  if (JSON.stringify(b.budget) !== JSON.stringify(h.budget)) add("actor.budget", s, "risky", `Model budget ${JSON.stringify(b.budget)} → ${JSON.stringify(h.budget)}`);
  if (b.purpose !== h.purpose || JSON.stringify(b.justification) !== JSON.stringify(h.justification))
    add("actor.described", s, "compatible", "Purpose or justification changed");
}

function diffMessage(b: ManifestMessage, h: ManifestMessage, add: Add) {
  const s = h.name;
  if (b.version !== h.version) {
    add("message.version", s, "risky", `${s} version ${b.version} → ${h.version}: copies of v${b.version} in flight will be refused unless outboxes drain before the deploy`);
    return;
  }
  if (b.description !== h.description && JSON.stringify(b.payload) === JSON.stringify(h.payload)) {
    add("message.described", s, "compatible", "Description changed");
    return;
  }
  for (const finding of comparePayload(b.payload, h.payload)) {
    add("message.payload", s, finding.compatibility, finding.compatibility === "breaking" ? `${finding.detail}; bump the version or keep accepting the old shape` : finding.detail);
  }
}

function diffEffect(b: ManifestEffect, h: ManifestEffect, add: Add) {
  const s = h.name;
  if (b.idempotency !== h.idempotency)
    add("effect.idempotency", s, "risky", `Idempotency ${b.idempotency} → ${h.idempotency}${h.idempotency === "none" ? ": unacknowledged attempts become in doubt" : ""}`);
  if (b.approval !== h.approval) add("effect.approval", s, "risky", `Approval ${b.approval} → ${h.approval}`, { approval: h.approval === "none" });
  if (b.reconcile !== h.reconcile) add("effect.reconcile", s, "risky", `Reconciliation ${b.reconcile} → ${h.reconcile}`);
  if ((b.result ?? null) !== (h.result ?? null)) add("effect.result", s, "risky", `Outcome message ${b.result ?? "none"} → ${h.result ?? "none"}; in-flight outcomes use the old message`);
}

type Schema = Record<string, unknown> | null;
interface PayloadFinding {
  compatibility: Compatibility;
  detail: string;
}

/** Will the new schema accept payloads valid under the old one? Unknown shapes are reported as risky. */
export function comparePayload(oldS: Schema, newS: Schema, path = "payload"): PayloadFinding[] {
  if (JSON.stringify(oldS) === JSON.stringify(newS)) return [];
  if (!oldS || !newS) return [{ compatibility: "risky", detail: `${path} schema changed, and one side can't be exported as JSON Schema` }];
  const out: PayloadFinding[] = [];
  const ot = oldS.type;
  const nt = newS.type;
  if (JSON.stringify(ot) !== JSON.stringify(nt)) return [{ compatibility: "breaking", detail: `${path} type ${JSON.stringify(ot)} → ${JSON.stringify(nt)}` }];
  if (Array.isArray(oldS.enum) || Array.isArray(newS.enum)) {
    const before = (oldS.enum as unknown[]) ?? [];
    const after = new Set(((newS.enum as unknown[]) ?? []).map((v) => JSON.stringify(v)));
    const lost = before.filter((v) => !after.has(JSON.stringify(v)));
    if (lost.length) out.push({ compatibility: "breaking", detail: `${path} no longer accepts ${lost.map((v) => JSON.stringify(v)).join(", ")}` });
    else out.push({ compatibility: "compatible", detail: `${path} accepts additional values` });
    return out;
  }
  if (ot === "object") {
    const op = (oldS.properties ?? {}) as Record<string, Schema>;
    const np = (newS.properties ?? {}) as Record<string, Schema>;
    const oreq = new Set((oldS.required as string[] | undefined) ?? []);
    const nreq = new Set((newS.required as string[] | undefined) ?? []);
    for (const k of Object.keys(np).sort()) {
      if (!(k in op)) {
        out.push(nreq.has(k) ? { compatibility: "breaking", detail: `${path}.${k} is a new required property` } : { compatibility: "compatible", detail: `${path}.${k} is a new optional property` });
      } else {
        if (!oreq.has(k) && nreq.has(k)) out.push({ compatibility: "breaking", detail: `${path}.${k} became required` });
        if (oreq.has(k) && !nreq.has(k)) out.push({ compatibility: "compatible", detail: `${path}.${k} became optional` });
        out.push(...comparePayload(op[k] ?? null, np[k] ?? null, `${path}.${k}`));
      }
    }
    for (const k of Object.keys(op).sort()) if (!(k in np)) out.push({ compatibility: "compatible", detail: `${path}.${k} was removed (old copies still pass; the field is ignored)` });
    const rest = (s: Record<string, unknown>) => JSON.stringify({ ...s, properties: undefined, required: undefined });
    if (rest(oldS) !== rest(newS)) out.push({ compatibility: "risky", detail: `${path} object constraints changed (for example additionalProperties)` });
    return out;
  }
  return [{ compatibility: "risky", detail: `${path} constraints changed (${JSON.stringify(oldS)} → ${JSON.stringify(newS)})` }];
}

function plan(changes: Change[], head: Manifest): PlanStep[] {
  const steps: PlanStep[] = [{ kind: "verify", text: "Run `actors check` and `npm run verify`; deploy nothing unless both pass." }];
  for (const c of changes.filter((c) => c.kind === "actor.added")) {
    const a = head.actors.find((x) => x.name === c.subject);
    steps.push({
      kind: "config",
      text: `Declare ${c.subject} in wrangler.jsonc: binding { "name": "${a?.binding}", "class_name": "${c.subject}" } and exports.${c.subject} = { "type": "durable-object", "storage": "sqlite" } (\`actors check\` confirms both).`,
    });
  }
  for (const c of changes.filter((c) => c.kind === "actor.removed")) {
    steps.push({
      kind: "irreversible",
      text: `IRREVERSIBLE: retiring ${c.subject} means exports.${c.subject}.state = "deleted", which destroys all its stored data with no trash. Export anything worth keeping first. If this is a rename, use state "renamed" with renamed_to instead, which keeps the data. Needs explicit approval.`,
    });
  }
  const drains = changes.filter((c) => c.compatibility === "breaking" && (c.kind.startsWith("message") || c.kind === "route.removed"));
  if (drains.length)
    steps.push({
      kind: "drain",
      text: `Drain first: changes to ${drains.map((c) => c.subject).join(", ")} affect what in-flight messages may look like or where they may go. Deploy when outboxes are empty, or version the message and accept both shapes.`,
    });
  const approvals = changes.filter((c) => c.requiresApproval && !c.irreversible);
  if (approvals.length) steps.push({ kind: "approval", text: `A person must approve: ${approvals.map((c) => c.detail).join("; ")}.` });
  if (changes.some((c) => c.kind === "actor.schedule")) steps.push({ kind: "schedule", text: "An alarm that is already set keeps its old time until it fires once under the new code." });
  if (changes.some((c) => c.kind === "actor.added" || c.kind === "actor.removed"))
    steps.push({
      kind: "lifecycle",
      text: "Durable Object lifecycle changes apply only through `wrangler deploy` (not `wrangler versions upload`); a later rollback can't cross them, and gradual deployment isn't available for them.",
    });
  steps.push({ kind: "deploy", text: "Deploying is a person's decision. After approval, they run `npx wrangler deploy`; the toolkit never deploys." });
  return steps;
}
