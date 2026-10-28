// Decision (Clef) and extraction (Clairic) records: what each delivered answer was, and the labels the actor adds
// later with ctx.acted and ctx.outcome, which the scorecard compares. One row per decision id, `${effect}:${key}`, in
// the actor's own SQLite, written in the transaction that settles the effect. The runtime reads an adapter's value
// structurally and never imports the adapters, so they stay out of the runtime bundle.
import type { ClairicField, ClefQuestion, EffectSpec } from "../system.ts";
import type { SqlStorageLike } from "./index.ts";

export const DECISIONS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS _actors_decisions (id TEXT PRIMARY KEY, effect TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, model TEXT, mode TEXT NOT NULL, input_digest TEXT, input_ref TEXT, truncated INTEGER, usage TEXT, answers TEXT NOT NULL, created_at INTEGER NOT NULL, action TEXT, acted_at INTEGER, outcome TEXT, outcome_at INTEGER)",
];

/** The detail of a decision.recorded event. An extraction's answers carry no values: they may be personal data. */
export interface DecisionRecorded {
  decision: string;
  effect: string;
  key: string;
  kind: "decision" | "extraction";
  model: string | null;
  mode: "act" | "shadow";
  inputDigest: string | null;
  inputRef: string | null;
  truncated: boolean | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  answers: Record<string, Record<string, unknown>>;
}

/** The record a label names, as ctx.acted and ctx.outcome put it in their events. */
export interface Labelled {
  effect: string;
  key: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const only = <T>(record: Readonly<Record<string, T>>, name: string): T | undefined => (Object.hasOwn(record, name) ? record[name] : undefined);

/** A decision or an extraction: the effects whose answers are recorded. */
export const isDecisionKind = (fx: EffectSpec | undefined): fx is EffectSpec & { kind: "decision" | "extraction" } => fx?.kind === "decision" || fx?.kind === "extraction";

/**
 * "act" only when the effect says "act" or nothing. Any other mode, including one `actord check` refuses
 * (DECISION_MODE_INVALID), is shadow: recorded, and never delivered.
 */
export function decisionMode(fx: EffectSpec): "act" | "shadow" {
  return fx.mode === undefined || fx.mode === "act" ? "act" : "shadow";
}

/** True when an effect's answer must never reach the actor: no result message is queued for it, whatever its spec says. */
export const isShadow = (fx: EffectSpec | undefined): boolean => isDecisionKind(fx) && decisionMode(fx) === "shadow";

/** Each declared question's answer, or each declared field's confidence and whether it is null (never its value). */
function summarize(fx: EffectSpec, answers: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const answer = (name: string): Record<string, unknown> => {
    const a = only(answers, name);
    return isRecord(a) ? a : {};
  };
  if (fx.kind === "decision") {
    for (const [id, q] of Object.entries(fx.questions ?? {})) {
      const a = answer(id);
      const probabilities = isRecord(a.probabilities) && Object.values(a.probabilities).every(finite) ? { probabilities: { ...a.probabilities } } : {};
      const picked = q.type === "choice" ? (typeof a.choice === "string" ? { choice: a.choice } : {}) : finite(a[q.type]) ? { [q.type]: a[q.type] } : {};
      out[id] = { type: q.type, ...picked, ...probabilities, ...(finite(a.confidence) ? { confidence: a.confidence } : {}) };
    }
  } else {
    for (const [name, f] of Object.entries(fx.fields ?? {})) {
      const a = answer(name);
      out[name] = { type: f.type, isNull: a.value === null || a.value === undefined, ...(finite(a.confidence) ? { confidence: a.confidence } : {}), ...(finite(a.p_null) ? { p_null: a.p_null } : {}) };
    }
  }
  return out;
}

/**
 * Record a delivered decision or extraction, in the transaction that settles its effect. `value` is the adapter's
 * DecisionValue, read structurally: a part it lacks is recorded as null, so this never throws over a value. Returns
 * the decision.recorded detail, or null when the id is already recorded (an effect key settles once, so it never is).
 */
export function recordDecision(sql: SqlStorageLike, at: number, effect: string, key: string, fx: EffectSpec & { kind: "decision" | "extraction" }, value: unknown): DecisionRecorded | null {
  const v = isRecord(value) ? value : {};
  const answers = isRecord(v.answers) ? v.answers : {};
  const usage = isRecord(v.usage) && finite(v.usage.inputTokens) ? { inputTokens: v.usage.inputTokens, outputTokens: finite(v.usage.outputTokens) ? v.usage.outputTokens : 0 } : null;
  const detail: DecisionRecorded = {
    decision: `${effect}:${key}`,
    effect,
    key,
    kind: fx.kind,
    model: typeof v.model === "string" ? v.model : (fx.model ?? null),
    mode: decisionMode(fx),
    inputDigest: typeof v.inputDigest === "string" ? v.inputDigest : null,
    inputRef: typeof v.inputRef === "string" ? v.inputRef : null,
    truncated: typeof v.truncated === "boolean" ? v.truncated : null,
    usage,
    answers: summarize(fx, answers),
  };
  const inserted = sql
    .exec(
      "INSERT INTO _actors_decisions (id, effect, key, kind, model, mode, input_digest, input_ref, truncated, usage, answers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id",
      detail.decision,
      effect,
      key,
      detail.kind,
      detail.model,
      detail.mode,
      detail.inputDigest,
      detail.inputRef,
      detail.truncated === null ? null : detail.truncated ? 1 : 0,
      usage === null ? null : JSON.stringify(usage),
      JSON.stringify(answers),
      at,
    )
    .toArray();
  return inserted.length > 0 ? detail : null;
}

function recorded(sql: SqlStorageLike, id: unknown): Labelled & { kind: string; outcome: string | null } {
  const row = typeof id === "string" ? sql.exec<{ effect: string; key: string; kind: string; outcome: string | null }>("SELECT effect, key, kind, outcome FROM _actors_decisions WHERE id = ?", id).toArray()[0] : undefined;
  if (!row) throw new Error(`no decision or extraction is recorded as ${JSON.stringify(id)}`);
  return row;
}

/** ctx.acted: what the actor did with a recorded decision; a later call replaces it. Throws for an unknown id or an empty action. */
export function labelAction(sql: SqlStorageLike, at: number, id: string, action: unknown): Labelled {
  const row = recorded(sql, id);
  if (typeof action !== "string" || action === "") throw new Error(`${id}: an action must be a non-empty string`);
  sql.exec("UPDATE _actors_decisions SET action = ?, acted_at = ? WHERE id = ?", action, at, id);
  return { effect: row.effect, key: row.key };
}

const described = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : `a ${typeof v}`);

function checkQuestion(id: string, effect: string, questions: Readonly<Record<string, ClefQuestion>>, name: string, label: unknown): void {
  const q = only(questions, name);
  if (!q) throw new Error(`${id}: ${JSON.stringify(name)} is not a question of ${effect} (${Object.keys(questions).join(", ")})`);
  if (q.type === "choice") {
    if (typeof label !== "string" || !Object.hasOwn(q.criteria, label)) throw new Error(`${id}: question ${name}'s label must be one of its options (${Object.keys(q.criteria).join(", ")})`);
  } else if (q.type === "noul") {
    if (typeof label !== "boolean") throw new Error(`${id}: question ${name} is noul; label it true or false`);
  } else if (!Number.isInteger(label) || (label as number) < 0 || (label as number) > q.criteria.length - 1) {
    throw new Error(`${id}: question ${name}'s label must be a level from 0 to ${q.criteria.length - 1}`);
  }
}

function checkField(id: string, effect: string, fields: Readonly<Record<string, ClairicField>>, name: string, label: unknown): void {
  if (!only(fields, name)) throw new Error(`${id}: ${JSON.stringify(name)} is not a field of ${effect} (${Object.keys(fields).join(", ")})`);
  // The wrong label isn't echoed: in an extraction it may be an extracted value, and the error reaches the log.
  if (typeof label !== "boolean") throw new Error(`${id}: field ${name}'s label must be true (correct) or false (wrong), not ${described(label)}`);
}

/**
 * ctx.outcome: what really was so, merged into the record's outcome (a question or field labelled again takes the
 * newer label). A decision's labels name declared questions: an option for choice, a boolean for noul, a level index
 * for score. An extraction's name declared fields: true (correct) or false (wrong). Anything else throws, so a
 * labelling bug fails its handler instead of skewing the scorecard. Returns the merged outcome, as written to the
 * row, which decision.outcome carries: the latest event per decision matches the table.
 */
export function labelOutcome(sql: SqlStorageLike, at: number, id: string, actual: unknown, specOf: (effect: string) => EffectSpec | undefined): Labelled & { outcome: Record<string, unknown> } {
  const row = recorded(sql, id);
  const fx = specOf(row.effect);
  if (fx?.kind !== row.kind) throw new Error(`${id}: ${row.effect} is no longer declared as a ${row.kind}, so its labels can't be checked`);
  const decision = row.kind === "decision";
  const entries = isRecord(actual) ? Object.entries(actual) : [];
  if (entries.length === 0) throw new Error(`${id}: an outcome must label at least one ${decision ? "question" : "field"}`);
  for (const [name, label] of entries) {
    if (decision) checkQuestion(id, row.effect, fx.questions ?? {}, name, label);
    else checkField(id, row.effect, fx.fields ?? {}, name, label);
  }
  const outcome = { ...(row.outcome === null ? {} : (JSON.parse(row.outcome) as Record<string, unknown>)), ...(actual as Record<string, unknown>) };
  sql.exec("UPDATE _actors_decisions SET outcome = ?, outcome_at = ? WHERE id = ?", JSON.stringify(outcome), at, id);
  return { effect: row.effect, key: row.key, outcome };
}
