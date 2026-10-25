// Reading the structured event log and reconstructing causal paths from it. The log is local evidence
// (tests, wrangler dev); nothing here can see production, and nothing here invents history.
import { existsSync, readFileSync } from "node:fs";

export const EVENTS_FILE = ".actors/events.ndjson";

export interface LoggedEvent {
  seq?: number;
  $actors: 1;
  kind: string;
  at: number;
  actor: string;
  messageId?: string;
  type?: string;
  version?: number;
  from?: string;
  to?: string;
  correlationId?: string;
  causationId?: string | null;
  attempt?: number;
  effect?: string;
  effectKey?: string;
  reason?: string;
  detail?: Record<string, unknown>;
}

export const NOTABLE = new Set(["rejected", "failed", "retry.exhausted", "undeliverable", "effect.in_doubt", "effect.denied", "effect.failed"]);

export interface EventLog {
  events: LoggedEvent[];
  unparseable: number;
}

export function readEvents(file: string): EventLog | null {
  if (!existsSync(file)) return null;
  return parseEvents(readFileSync(file, "utf8"));
}

export function parseEvents(text: string): EventLog {
  const events: LoggedEvent[] = [];
  let unparseable = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LoggedEvent;
      if (e.$actors === 1 && typeof e.kind === "string") events.push(e);
      else unparseable++;
    } catch {
      unparseable++;
    }
  }
  return { events, unparseable };
}

/** One human line per event, for terminals and monitor notifications. */
export function formatEvent(e: LoggedEvent): string {
  const route = e.from && e.to ? `${e.from} → ${e.to}` : e.actor;
  const what = e.effect ? `effect ${e.effect}${e.effectKey ? ` [${e.effectKey}]` : ""}` : `${e.type ?? ""}${e.version ? `@${e.version}` : ""}`;
  const attempt = e.attempt && e.attempt > 1 ? ` attempt ${e.attempt}` : "";
  return `${e.kind.padEnd(16)} ${what.padEnd(28)} ${route}${e.messageId ? ` (${e.messageId})` : ""}${attempt}${e.reason ? `: ${e.reason}` : ""}`;
}

export type Outcome = "handled" | "duplicate" | "rejected" | "failed" | "undeliverable" | "retry.exhausted" | "in-flight" | "unknown";

/** A message's outcome from the events recorded for its id, in precedence order. */
export function outcomeOf(evs: LoggedEvent[]): Outcome {
  const kinds = new Set(evs.map((e) => e.kind));
  if (kinds.has("handled")) return "handled";
  if (kinds.has("rejected")) return "rejected";
  if (kinds.has("undeliverable")) return "undeliverable";
  if (kinds.has("retry.exhausted")) return "retry.exhausted";
  if (kinds.has("duplicate")) return "duplicate";
  if (kinds.has("failed")) return "failed";
  if (kinds.has("sent") || kinds.has("retry.scheduled")) return "in-flight";
  return "unknown";
}

export const OUTCOME_MARK: Record<Outcome, string> = { handled: "✓", duplicate: "≡", rejected: "✗", failed: "✗", undeliverable: "✗", "retry.exhausted": "✗", "in-flight": "…", unknown: "?" };

export interface TraceEffect {
  effect: string;
  key: string;
  outcome: string;
  attempts: number;
  reason: string | null;
  result: TraceNode | null;
}

export interface TraceNode {
  messageId: string;
  type: string | null;
  from: string | null;
  to: string | null;
  outcome: Outcome;
  attempts: number;
  failures: string[];
  rejectedReason: string | null;
  notes: string[];
  effects: TraceEffect[];
  children: TraceNode[];
}

export interface Trace {
  found: boolean;
  target: string;
  correlationId: string | null;
  /** True when the root's cause isn't in the log: the path starts outside recorded coverage. */
  rootCauseUnknown: boolean;
  root: TraceNode | null;
}

export function buildTrace(log: EventLog, id: string): Trace {
  const byMessage = new Map<string, LoggedEvent[]>();
  const children = new Map<string, Set<string>>();
  const effectsBy = new Map<string, LoggedEvent[]>();
  for (const e of log.events) {
    if (e.messageId && e.kind !== "scheduled" && !(e.kind.startsWith("effect.") && !e.messageId)) {
      byMessage.set(e.messageId, [...(byMessage.get(e.messageId) ?? []), e]);
      if (e.causationId) children.set(e.causationId, (children.get(e.causationId) ?? new Set()).add(e.messageId));
    }
    if (e.effect && e.effectKey && e.kind.startsWith("effect.")) {
      const k = `${e.effect}:${e.effectKey}`;
      effectsBy.set(k, [...(effectsBy.get(k) ?? []), e]);
    }
    if (e.kind === "retry.scheduled" && e.effect && e.effectKey) {
      const k = `${e.effect}:${e.effectKey}`;
      effectsBy.set(k, [...(effectsBy.get(k) ?? []), e]);
    }
  }
  if (!byMessage.has(id)) return { found: false, target: id, correlationId: null, rootCauseUnknown: false, root: null };

  // Walk up to the earliest recorded ancestor.
  let rootId = id;
  let rootCauseUnknown = false;
  const seen = new Set<string>();
  for (;;) {
    seen.add(rootId);
    const cause = byMessage.get(rootId)?.find((e) => e.causationId)?.causationId ?? null;
    if (!cause) break;
    if (!byMessage.has(cause) || seen.has(cause)) {
      rootCauseUnknown = !byMessage.has(cause);
      break;
    }
    rootId = cause;
  }

  const resultOf = new Map<string, string>(); // effect:key -> result message id
  for (const [mid, evs] of byMessage) {
    const sent = evs.find((e) => e.kind === "sent" && e.effect && e.effectKey);
    if (sent) resultOf.set(`${sent.effect}:${sent.effectKey}`, mid);
  }
  const resultIds = new Set(resultOf.values());

  const visited = new Set<string>();
  const node = (mid: string): TraceNode => {
    visited.add(mid);
    const evs = byMessage.get(mid) ?? [];
    const first = evs.find((e) => e.type) ?? evs[0];
    const outcome = outcomeOf(evs);
    const effects: TraceEffect[] = [];
    const effectKeys = new Set<string>();
    for (const e of log.events) if (e.kind === "effect.requested" && e.causationId === mid && e.effect && e.effectKey) effectKeys.add(`${e.effect}:${e.effectKey}`);
    for (const k of effectKeys) {
      const evs2 = effectsBy.get(k) ?? [];
      const last = [...evs2].reverse().find((e) => e.kind !== "effect.requested" && e.kind !== "retry.scheduled");
      const [effect, ...rest] = k.split(":");
      const rid = resultOf.get(k);
      effects.push({
        effect: effect!,
        key: rest.join(":"),
        outcome: last ? last.kind.replace("effect.", "") : "pending",
        attempts: Math.max(1, ...evs2.map((e) => e.attempt ?? 1)),
        reason: last?.reason ?? null,
        result: rid && !visited.has(rid) ? node(rid) : null,
      });
    }
    const kids = [...(children.get(mid) ?? [])].filter((c) => !visited.has(c) && !resultIds.has(c));
    return {
      messageId: mid,
      type: first?.type ?? null,
      from: first?.from ?? null,
      to: first?.to ?? null,
      outcome,
      attempts: Math.max(1, ...evs.map((e) => e.attempt ?? 1)),
      failures: [...new Set(evs.filter((e) => e.kind === "failed" || e.kind === "retry.scheduled").map((e) => e.reason ?? e.kind))],
      rejectedReason: evs.find((e) => e.kind === "rejected" || e.kind === "undeliverable")?.reason ?? null,
      notes: evs.filter((e) => e.kind === "note").map((e) => e.reason ?? ""),
      effects,
      children: kids.sort().map((c) => node(c)),
    };
  };
  const root = node(rootId);
  return {
    found: true,
    target: id,
    correlationId: byMessage.get(id)?.find((e) => e.correlationId)?.correlationId ?? null,
    rootCauseUnknown,
    root,
  };
}

export function renderTrace(t: Trace, source: string): string {
  if (!t.found || !t.root) {
    return `unknown: no recorded event has id ${t.target}.\ncoverage: ${source} (local test and dev runs only; production history isn't available here).`;
  }
  const lines = [`trace ${t.target} · correlation ${t.correlationId ?? "?"} · coverage: ${source} (local only)`];
  if (t.rootCauseUnknown) lines.push("  ? earlier cause unknown: outside recorded coverage");
  const walk = (n: TraceNode, prefix: string, last: boolean, top: boolean) => {
    const branch = top ? "" : last ? "└─ " : "├─ ";
    const target = n.messageId === t.target ? "  ◀ target" : "";
    const retry = n.attempts > 1 ? ` after ${n.attempts - 1} retr${n.attempts === 2 ? "y" : "ies"}` : "";
    const why = n.rejectedReason ? `: ${n.rejectedReason}` : "";
    lines.push(`${prefix}${branch}${n.from ?? "?"} → ${n.to ?? "?"}  ${n.type ?? "?"}  ${OUTCOME_MARK[n.outcome]} ${n.outcome}${why}${retry} (${n.messageId})${target}`);
    const inner = prefix + (top ? "" : last ? "   " : "│  ");
    for (const f of n.failures) lines.push(`${inner}  ! ${f}`);
    for (const note of n.notes) lines.push(`${inner}  · ${note}`);
    const items: Array<{ kind: "effect"; e: TraceEffect } | { kind: "node"; n: TraceNode }> = [
      ...n.effects.map((e) => ({ kind: "effect" as const, e })),
      ...n.children.map((c) => ({ kind: "node" as const, n: c })),
    ];
    items.forEach((it, i) => {
      const isLast = i === items.length - 1;
      if (it.kind === "node") walk(it.n, inner, isLast, false);
      else {
        const e = it.e;
        const mark = e.outcome === "confirmed" ? "✓" : e.outcome === "pending" || e.outcome === "awaiting_approval" ? "…" : "✗";
        lines.push(`${inner}${isLast ? "└─ " : "├─ "}effect ${e.effect} [${e.key}]  ${mark} ${e.outcome}${e.attempts > 1 ? ` after ${e.attempts} attempts` : ""}${e.reason ? `: ${e.reason}` : ""}`);
        if (e.result) walk(e.result, inner + (isLast ? "   " : "│  "), true, false);
      }
    });
  };
  walk(t.root, "  ", true, true);
  return lines.join("\n");
}
