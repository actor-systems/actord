// `actord diff`: compare two normalized models and classify every architectural change, then produce a
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
  const findings = comparePayload(b.payload, h.payload);
  if (findings.length === 0) add("message.described", s, "compatible", "Descriptions or defaults changed; validation is unchanged");
  for (const finding of findings) {
    add("message.payload", s, finding.compatibility, finding.compatibility === "breaking" ? `${finding.detail}; keep accepting the old shape, or drain before deploying` : finding.detail);
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

const compatible = (detail: string): PayloadFinding => ({ compatibility: "compatible", detail });
const breaking = (detail: string): PayloadFinding => ({ compatibility: "breaking", detail });
const risky = (detail: string): PayloadFinding => ({ compatibility: "risky", detail });

/** Keywords that describe a value without constraining it: changing them can't refuse a payload. */
const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
/** A lower bound that rises, or an upper bound that falls, refuses values the old schema accepted. */
const LOWER_BOUNDS = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties", "minContains"]);
const UPPER_BOUNDS = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties", "maxContains"]);
/** Restrictions comparable only as added (narrows) or removed (widens); a changed one is undecided. */
const RESTRICTIONS = new Set(["pattern", "format", "multipleOf", "uniqueItems"]);
/** Compared structurally by comparePayload and compareObject. */
const STRUCTURAL = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items"]);

const show = (v: unknown) => JSON.stringify(v);
const list = (vs: unknown[]) => vs.map(show).join(", ");

/**
 * Will the new schema accept every payload the old one accepted? Copies already in flight were written by
 * the old code, so that decides whether they're refused after the deploy. "compatible" is claimed only
 * where that holds by construction, "breaking" names old payloads the new schema refuses, and whatever
 * this can't decide is "risky", never "compatible". One assumption: where an old object schema says
 * nothing about undeclared properties (zod's z.object, which strips them), senders didn't send any.
 */
export function comparePayload(oldS: Schema, newS: Schema, path = "payload"): PayloadFinding[] {
  if (show(oldS) === show(newS)) return [];
  if (!oldS || !newS) return [risky(`${path} schema changed, and one side can't be exported as JSON Schema`)];
  if (constraintKeys(newS).length === 0) return constraintKeys(oldS).length === 0 ? [] : [compatible(`${path} now accepts any value`)];
  const ot = typesOf(oldS);
  const nt = typesOf(newS);
  if (!ot || !nt) {
    const same = show(withoutAnnotations(oldS)) === show(withoutAnnotations(newS));
    return same ? [] : [risky(`${path} changed in a way this can't decide (no single type, such as a union); check that old copies still pass`)];
  }

  const widens = (from: string) => (to: string) => to === from || (from === "integer" && to === "number");
  const lost = ot.filter((t) => !nt.some(widens(t)));
  if (lost.length) return [breaking(`${path} no longer accepts ${lost.join(" or ")} (type ${show(oldS.type)} → ${show(newS.type)})`)];
  const out: PayloadFinding[] = [];
  const gained = nt.filter((t) => !ot.includes(t));
  if (gained.length) out.push(compatible(`${path} also accepts ${gained.join(" or ")}`));

  const ov = fixedValues(oldS);
  const nv = fixedValues(newS);
  if (nv && !ov) out.push(breaking(`${path} is now limited to ${list(nv)}; old copies with any other value are refused`));
  else if (nv && ov) {
    const dropped = ov.filter((v) => !nv.some((w) => show(w) === show(v)));
    const added = nv.filter((v) => !ov.some((w) => show(w) === show(v)));
    if (dropped.length) out.push(breaking(`${path} no longer accepts ${list(dropped)}`));
    else if (added.length) out.push(compatible(`${path} also accepts ${list(added)}`));
  } else if (ov && !nv) out.push(compatible(`${path} is no longer limited to ${list(ov)}`));

  if (ot.includes("object") && nt.includes("object")) out.push(...compareObject(oldS, newS, path));
  if (ot.includes("array") && nt.includes("array")) out.push(...comparePayload((oldS.items ?? {}) as Schema, (newS.items ?? {}) as Schema, `${path}[]`));

  for (const k of [...new Set([...Object.keys(oldS), ...Object.keys(newS)])].sort()) {
    if (ANNOTATIONS.has(k) || STRUCTURAL.has(k)) continue;
    const o = present(oldS, k) ? oldS[k] : undefined;
    const n = present(newS, k) ? newS[k] : undefined;
    if (show(o) === show(n)) continue;
    if ((LOWER_BOUNDS.has(k) || UPPER_BOUNDS.has(k)) && (o === undefined || typeof o === "number") && (n === undefined || typeof n === "number")) {
      if (n === undefined) out.push(compatible(`${path} drops ${k} ${o}`));
      else if (o === undefined) out.push(breaking(`${path} now has ${k} ${n}`));
      else if (LOWER_BOUNDS.has(k) ? n > o : n < o) out.push(breaking(`${path} ${k} ${o} → ${n}`));
      else out.push(compatible(`${path} ${k} ${o} → ${n}`));
    } else if (RESTRICTIONS.has(k)) {
      if (n === undefined) out.push(compatible(`${path} drops ${k} ${show(o)}`));
      else if (o === undefined) out.push(breaking(`${path} now requires ${k} ${show(n)}`));
      else out.push(risky(`${path} ${k} ${show(o)} → ${show(n)}; check that old values still match`));
    } else out.push(risky(`${path} ${k} changed; check that old copies still pass`));
  }
  return out;
}

/**
 * Undeclared properties: "unstated" (absent: zod's z.object, which strips them), "closed" (false:
 * z.strictObject), "any" (true or {}: z.looseObject), or "schema" (a catchall or record value schema).
 */
type Extras = "unstated" | "closed" | "any" | "schema";
function extrasOf(ap: unknown): Extras {
  if (ap === undefined) return "unstated";
  if (ap === false) return "closed";
  if (ap === true || (typeof ap === "object" && ap !== null && constraintKeys(ap as Record<string, unknown>).length === 0)) return "any";
  return "schema";
}

function compareObject(oldS: Record<string, unknown>, newS: Record<string, unknown>, path: string): PayloadFinding[] {
  const out: PayloadFinding[] = [];
  const op = (oldS.properties ?? {}) as Record<string, Schema>;
  const np = (newS.properties ?? {}) as Record<string, Schema>;
  const oreq = new Set((oldS.required as string[] | undefined) ?? []);
  const nreq = new Set((newS.required as string[] | undefined) ?? []);
  const oAP = oldS.additionalProperties as Schema | boolean | undefined;
  const nAP = newS.additionalProperties as Schema | boolean | undefined;
  const oExtras = extrasOf(oAP);
  const nExtras = extrasOf(nAP);

  for (const k of Object.keys(np).sort()) {
    const at = `${path}.${k}`;
    if (k in op) {
      if (!oreq.has(k) && nreq.has(k)) out.push(breaking(`${at} became required`));
      if (oreq.has(k) && !nreq.has(k)) out.push(compatible(`${at} became optional`));
      out.push(...comparePayload(op[k] ?? null, np[k] ?? null, at));
    } else if (nreq.has(k)) out.push(breaking(`${at} is a new required property`));
    else if (oExtras === "unstated" || oExtras === "closed") out.push(compatible(`${at} is a new optional property`));
    else if (oExtras === "any") out.push(risky(`${at} is a new optional property, but ${path} accepted undeclared properties, so old copies may already carry ${k} in another shape`));
    else {
      const f = comparePayload(oAP as Schema, np[k] ?? null, at);
      out.push(...(f.length ? f : [compatible(`${at} is a new optional property`)]));
    }
  }

  for (const k of Object.keys(op).sort()) {
    if (k in np) continue;
    const at = `${path}.${k}`;
    if (nExtras === "closed") {
      out.push(breaking(`${at} was removed and ${path} rejects undeclared properties: ${oreq.has(k) ? "every old copy carries it" : "old copies that set it are refused"}`));
    } else if (nExtras === "schema") {
      const f = comparePayload(op[k] ?? null, nAP as Schema, at);
      out.push(...(f.length ? f.map((x) => ({ ...x, detail: `${at} was removed and now falls under ${path}'s additionalProperties: ${x.detail}` })) : [compatible(`${at} was removed; old values still match additionalProperties`)]));
    } else out.push(compatible(`${at} was removed (old copies still pass; the field is ignored)`));
  }

  if (oExtras !== nExtras || (oExtras === "schema" && show(oAP) !== show(nAP))) {
    if (nExtras === "closed") {
      out.push(
        oExtras === "unstated"
          ? risky(`${path} now rejects undeclared properties; old copies that carried extra fields (ignored until now) are refused`)
          : breaking(`${path} now rejects undeclared properties, which the old schema accepted`),
      );
    } else if (nExtras === "schema") {
      if (oExtras === "closed") out.push(compatible(`${path} now accepts undeclared properties that match a schema`));
      else if (oExtras === "unstated") out.push(risky(`${path} now constrains undeclared properties; old copies that carried extra fields (ignored until now) must match`));
      else if (oExtras === "any") out.push(breaking(`${path} now constrains undeclared properties, which the old schema accepted in any shape`));
      else out.push(...comparePayload(oAP as Schema, nAP as Schema, `${path}.*`));
    } else out.push(compatible(`${path} now accepts undeclared properties`));
  }
  return out;
}

function typesOf(s: Record<string, unknown>): string[] | null {
  if (typeof s.type === "string") return [s.type];
  if (Array.isArray(s.type) && s.type.every((t) => typeof t === "string")) return s.type as string[];
  return null;
}

function fixedValues(s: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(s.enum)) return s.enum;
  if ("const" in s) return [s.const];
  return null;
}

function present(s: Record<string, unknown>, k: string): boolean {
  return s[k] !== undefined && !(k === "uniqueItems" && s[k] === false);
}

function withoutAnnotations(s: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(s).filter(([k]) => !ANNOTATIONS.has(k)));
}

function constraintKeys(s: Record<string, unknown>): string[] {
  return Object.keys(s).filter((k) => !ANNOTATIONS.has(k) && present(s, k));
}

function plan(changes: Change[], head: Manifest): PlanStep[] {
  const steps: PlanStep[] = [{ kind: "verify", text: "Run `actord check` and `npm run verify`; deploy nothing unless both pass." }];
  for (const c of changes.filter((c) => c.kind === "actor.added")) {
    const a = head.actors.find((x) => x.name === c.subject);
    steps.push({
      kind: "config",
      text: `Declare ${c.subject} in wrangler.jsonc: binding { "name": "${a?.binding}", "class_name": "${c.subject}" } and exports.${c.subject} = { "type": "durable-object", "storage": "sqlite" } (\`actord check\` confirms both).`,
    });
  }
  for (const c of changes.filter((c) => c.kind === "actor.removed")) {
    steps.push({
      kind: "irreversible",
      text: `IRREVERSIBLE: retiring ${c.subject} means exports.${c.subject}.state = "deleted", which destroys all its stored data with no trash. Export anything worth keeping first. If this is a rename, use state "renamed" with renamed_to instead, which keeps the data. Needs explicit approval.`,
    });
  }
  // Only one version of a message is accepted at a time, so a version bump refuses every old copy, and a
  // risky payload change may refuse some: both drain like a breaking one unless a test shows otherwise.
  const drains = [...new Set(changes.filter((c) => c.compatibility !== "compatible" && (c.kind.startsWith("message") || c.kind === "route.removed")).map((c) => c.subject))];
  if (drains.length)
    steps.push({
      kind: "drain",
      text: `Drain first: ${drains.join(", ")} may refuse copies already in flight. Deploy when outboxes are empty, or avoid the drain: make the new schema accept the old shape too, or add a new message beside the old one and retire the old one in a later deploy. A risky change needs no drain once a test shows old copies still pass.`,
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
