// Calibration of decision and extraction effects, computed from the local event log: decision.recorded
// (what was predicted), decision.acted, and decision.outcome (the labels). Pure over events; nothing here reads a file.
import type { LoggedEvent } from "./events.ts";

export interface Bin {
  from: number;
  to: number;
  n: number;
  meanP: number;
  observed: number;
}
export type QuestionCard =
  | { id: string; type: "choice"; labelled: number; accuracy: number | null; brier: number | null; bins: Bin[]; wrongWhenChosen: Record<string, { chosen: number; wrong: number }> }
  | { id: string; type: "noul"; labelled: number; brier: number | null; bins: Bin[] }
  | { id: string; type: "score"; labelled: number; meanAbsError: number | null }
  | { id: string; type: "field"; labelled: number; correct: number | null; byConfidence: Array<{ from: number; to: number; n: number; correct: number }> };
export interface EffectCard {
  effect: string;
  model: string;
  recorded: number;
  shadow: number;
  labelled: number;
  acted: number;
  questions: QuestionCard[];
}
export interface Scorecard {
  effects: EffectCard[];
}

const EDGES: Array<[number, number]> = [
  [0, 0.5],
  [0.5, 0.7],
  [0.7, 0.9],
  [0.9, 1],
];
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const mean = (xs: number[]) => (xs.length === 0 ? null : round4(xs.reduce((a, b) => a + b, 0) / xs.length));
const binOf = (p: number) => (p >= 0.9 ? 3 : p >= 0.7 ? 2 : p >= 0.5 ? 1 : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Bin (p, hit) pairs: n, mean p, and the share that hit. */
function bins(points: Array<{ p: number; hit: boolean }>): Bin[] {
  return EDGES.map(([from, to], i) => {
    const inBin = points.filter((x) => binOf(x.p) === i);
    return { from, to, n: inBin.length, meanP: mean(inBin.map((x) => x.p)) ?? 0, observed: mean(inBin.map((x) => (x.hit ? 1 : 0))) ?? 0 };
  });
}

interface Decision {
  detail: Record<string, unknown>;
  answers: Record<string, Record<string, unknown>>;
  label: Record<string, unknown> | null;
  acted: boolean;
}

export function scorecard(events: LoggedEvent[], opts: { effect?: string } = {}): Scorecard {
  const decisions = new Map<string, Decision>();
  for (const e of events) {
    const d = e.detail;
    if (!d || typeof d.decision !== "string") continue;
    if (e.kind === "decision.recorded" && !decisions.has(d.decision)) {
      const answers = isRecord(d.answers) ? (d.answers as Record<string, Record<string, unknown>>) : {};
      decisions.set(d.decision, { detail: d, answers, label: null, acted: false });
    } else if (e.kind === "decision.acted") {
      const x = decisions.get(d.decision);
      if (x) x.acted = true;
    } else if (e.kind === "decision.outcome") {
      const x = decisions.get(d.decision);
      // actual is the merged outcome so far: the latest event is the complete label set.
      if (x && isRecord(d.actual)) x.label = d.actual;
    }
  }
  const byEffect = new Map<string, Decision[]>();
  for (const x of decisions.values()) {
    const name = String(x.detail.effect);
    if (opts.effect && name !== opts.effect) continue;
    byEffect.set(name, [...(byEffect.get(name) ?? []), x]);
  }
  const effects = [...byEffect.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([effect, list]): EffectCard => {
      const ids = new Map<string, string>(); // question or field id -> type, in first-seen order
      for (const x of list) for (const [id, a] of Object.entries(x.answers)) if (!ids.has(id) && typeof a.type === "string") ids.set(id, a.type);
      return {
        effect,
        model: String(list.find((x) => typeof x.detail.model === "string")?.detail.model ?? ""),
        recorded: list.length,
        shadow: list.filter((x) => x.detail.mode === "shadow").length,
        labelled: list.filter((x) => x.label !== null).length,
        acted: list.filter((x) => x.acted).length,
        questions: [...ids.entries()].map(([id, type]) => question(id, type, list)),
      };
    });
  return { effects };
}

function question(id: string, type: string, list: Decision[]): QuestionCard {
  // Each labelled decision that has both an answer and a label for this question.
  const pairs = list.flatMap((x) => (x.label && Object.hasOwn(x.label, id) && x.answers[id] ? [{ a: x.answers[id]!, label: x.label[id] }] : []));
  if (type === "choice") {
    const rows = pairs.flatMap(({ a, label }) => {
      const probs = isRecord(a.probabilities) ? Object.entries(a.probabilities).filter((kv): kv is [string, number] => num(kv[1])) : [];
      const top = typeof a.choice === "string" ? a.choice : probs.reduce<[string, number] | null>((best, kv) => (best === null || kv[1] > best[1] ? kv : best), null)?.[0];
      return top === undefined ? [] : [{ probs, top, label }];
    });
    const wrongWhenChosen: Record<string, { chosen: number; wrong: number }> = {};
    for (const r of rows) {
      const w = (wrongWhenChosen[r.top] ??= { chosen: 0, wrong: 0 });
      w.chosen++;
      if (r.top !== r.label) w.wrong++;
    }
    const withP = rows.filter((r) => r.probs.length > 0);
    return {
      id,
      type: "choice",
      labelled: rows.length,
      accuracy: mean(rows.map((r) => (r.top === r.label ? 1 : 0))),
      brier: mean(withP.map((r) => r.probs.reduce((s, [opt, p]) => s + (p - (opt === r.label ? 1 : 0)) ** 2, 0))),
      bins: bins(withP.map((r) => ({ p: r.probs.find(([o]) => o === r.top)?.[1] ?? Math.max(...r.probs.map(([, p]) => p)), hit: r.top === r.label }))),
      wrongWhenChosen,
    };
  }
  if (type === "noul") {
    const rows = pairs.flatMap(({ a, label }) => (num(a.noul) && typeof label === "boolean" ? [{ p: a.noul, y: label }] : []));
    return { id, type: "noul", labelled: rows.length, brier: mean(rows.map((r) => (r.p - (r.y ? 1 : 0)) ** 2)), bins: bins(rows.map((r) => ({ p: r.p, hit: r.y }))) };
  }
  if (type === "score") {
    const rows = pairs.flatMap(({ a, label }) => (num(a.score) && num(label) ? [Math.abs(a.score - label)] : []));
    return { id, type: "score", labelled: rows.length, meanAbsError: mean(rows) };
  }
  // An extraction field: the label says whether the extracted value was right.
  const rows = pairs.flatMap(({ a, label }) => (typeof label === "boolean" ? [{ c: num(a.confidence) ? a.confidence : null, ok: label }] : []));
  return {
    id,
    type: "field",
    labelled: rows.length,
    correct: mean(rows.map((r) => (r.ok ? 1 : 0))),
    byConfidence: EDGES.map(([from, to], i) => {
      const inBin = rows.filter((r) => r.c !== null && binOf(r.c) === i);
      return { from, to, n: inBin.length, correct: inBin.filter((r) => r.ok).length };
    }),
  };
}

const pct = (n: number | null) => (n === null ? "-" : String(n));

/** One table per effect, for terminals. */
export function renderScorecard(card: Scorecard): string {
  if (card.effects.length === 0) return "No decisions or extractions recorded in this log.";
  return card.effects
    .map((e) => {
      const head = `${e.effect} (${e.model || "unknown model"}): ${e.recorded} recorded, ${e.shadow} shadow, ${e.labelled} labelled, ${e.acted} acted`;
      const rows = e.questions.map((x) => {
        if (x.type === "choice") return `  ${x.id.padEnd(14)} choice  n=${x.labelled}  accuracy ${pct(x.accuracy)}  brier ${pct(x.brier)}  wrong when chosen: ${Object.entries(x.wrongWhenChosen).map(([o, w]) => `${o} ${w.wrong}/${w.chosen}`).join(", ") || "-"}`;
        if (x.type === "noul") return `  ${x.id.padEnd(14)} noul    n=${x.labelled}  brier ${pct(x.brier)}`;
        if (x.type === "score") return `  ${x.id.padEnd(14)} score   n=${x.labelled}  mean abs error ${pct(x.meanAbsError)}`;
        return `  ${x.id.padEnd(14)} field   n=${x.labelled}  correct ${pct(x.correct)}  by confidence: ${x.byConfidence.filter((b) => b.n > 0).map((b) => `[${b.from},${b.to}] ${b.correct}/${b.n}`).join(", ") || "-"}`;
      });
      return [head, ...rows].join("\n");
    })
    .join("\n\n");
}
