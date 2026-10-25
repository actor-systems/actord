// `actors room` and `actors guard`: the view model the Room mod draws and the decision its effect guard
// shows. The mod computes nothing; everything it renders or asks comes from here, so the same answers are
// available as text with mods turned off.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVENTS_FILE, type LoggedEvent, NOTABLE, OUTCOME_MARK, type Outcome, outcomeOf, readEvents } from "../../model/events.ts";
import { fingerprint } from "../../model/fingerprint.ts";
import { loadProject } from "../../model/load.ts";
import type { Manifest } from "../../model/manifest.ts";
import { type Topology, topologySvg, topologyWithChanges } from "../../model/svg.ts";
import { matchEffect } from "../../patterns.ts";
import type { CommandResult } from "../output.ts";
import { findProjectRoot, readJson } from "../project.ts";
import { diff, EXIT_NO_PROJECT, LAST_CHECK_FILE } from "./model.ts";

const EVIDENCE_FILE = ".actors/evidence.json";
const MAILBOX_DEPTH = 12;

export type Freshness = "pass" | "fail" | "stale" | "none";

export interface MailboxEntry {
  messageId: string;
  type: string | null;
  from: string | null;
  /** The receiving instance, for example FeedPoller:workers-sdk. */
  to: string;
  outcome: Outcome;
  mark: string;
  attempts: number;
  reason: string | null;
}

export interface RoomData {
  projectRoot: string | null;
  system: string | null;
  /** The one status line, for example "3 actors · 6 routes · check ✓". */
  status: string | null;
  error: string | null;
  topology: (Topology & { base: string; lines: string[]; svg: string; alt: string; changes: number }) | null;
  contracts: {
    messages: Array<{ name: string; version: number; description: string; routes: string[] }>;
    check: { state: Freshness; errors: number; warnings: number; codes: string[]; checkedAt: string | null };
  } | null;
  mailboxes: {
    file: string;
    events: number;
    actors: Array<{ name: string; received: number; messages: MailboxEntry[] }>;
    notable: string[];
  };
  evidence: {
    state: Freshness | "blocked";
    generatedAt: string | null;
    profile: string | null;
    groups: Array<{ status: string; label: string; claims: Array<{ id: string; statement: string; why: string | null }> }>;
  };
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export async function room(cwd: string, opts: { baseFile?: string } = {}): Promise<CommandResult<RoomData>> {
  const root = findProjectRoot(cwd);
  const empty: RoomData = {
    projectRoot: null,
    system: null,
    status: null,
    error: null,
    topology: null,
    contracts: null,
    mailboxes: { file: EVENTS_FILE, events: 0, actors: [], notable: [] },
    evidence: { state: "none", generatedAt: null, profile: null, groups: [] },
  };
  if (!root) return { data: empty, text: `No actor project at ${cwd} (no system.ts with a package.json here or above).`, exitCode: EXIT_NO_PROJECT };

  const print = fingerprint(root);
  const check = readCheck(root, print);
  const mailboxes = readMailboxes(root);
  const evidence = readEvidence(root, print);
  const project = await loadProject(root);
  const d = await diff(cwd, { baseFile: opts.baseFile });
  if (!project.manifest || d.exitCode !== 0) {
    const error = project.loadError ?? d.data.notes[0] ?? "the declaration doesn't load";
    const data = { ...empty, projectRoot: root, error, status: "declaration doesn't load", mailboxes, evidence };
    return { data, text: `✗ ${error}`, exitCode: 1 };
  }
  const head = project.manifest;
  const base = d.data.base.source === "none" ? null : baseManifest(root, d.data.base.source, cwd);
  const t = topologyWithChanges(base, head);
  const changes = d.data.changes.length;
  const sign = (c: string | null) => (c === "added" ? "+ " : c === "removed" ? "- " : "  ");
  const lines = [
    ...t.routes.map((r) => `${sign(r.change)}${r.from} ──${r.message}──▶ ${r.to}`),
    "",
    ...t.actors.map((a) => `${sign(a.change)}${a.name} (${a.kind})${a.change ? ` · ${a.change}` : ""}`),
  ];
  const checkMark = { pass: "check ✓", fail: `check ✗ ${check.errors}`, stale: "check stale", none: "check –" }[check.state];
  const status = [plural(head.actors.length, "actor"), plural(head.routes.length, "route"), checkMark, changes ? `${plural(changes, "change")} vs ${d.data.base.source.replace(/^git:/, "")}` : null]
    .filter(Boolean)
    .join(" · ");
  const data: RoomData = {
    projectRoot: root,
    system: head.system.name,
    status,
    error: null,
    topology: {
      ...t,
      base: d.data.base.source,
      lines,
      svg: topologySvg(t),
      alt: `${head.system.name}: ${plural(t.actors.length, "actor")}, ${plural(t.routes.length, "route")}${changes ? `, ${plural(changes, "change")} against ${d.data.base.source}` : ""}`,
      changes,
    },
    contracts: {
      messages: head.messages.map((m) => ({
        name: m.name,
        version: m.version,
        description: m.description,
        routes: head.routes.filter((r) => r.message === m.name).map((r) => `${r.from} → ${r.to}`),
      })),
      check,
    },
    mailboxes,
    evidence,
  };
  const text = [
    `${head.system.name} · ${status}`,
    "",
    "Topology",
    ...lines.map((l) => `  ${l}`),
    "",
    "Mailboxes",
    ...(mailboxes.actors.length
      ? mailboxes.actors.flatMap((a) => [`  ${a.name} (${a.received})`, ...a.messages.map((m) => `    ${m.mark} ${m.type ?? "?"} ${m.from ?? "?"} → ${m.to} (${m.messageId})`)])
      : ["  no local events yet"]),
    "",
    `Evidence: ${evidence.state}${evidence.generatedAt ? ` (${evidence.generatedAt})` : ""}`,
    ...evidence.groups.flatMap((g) => g.claims.map((c) => `  ${g.label}: ${c.id}`)),
  ].join("\n");
  return { data, text, exitCode: 0 };
}

function baseManifest(root: string, source: string, cwd: string): Manifest | null {
  if (source.startsWith("file:")) return readJson<Manifest>(resolve(cwd, source.slice(5)));
  if (!source.startsWith("git:")) return null;
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return null;
  const rel = join(root, "actors.manifest.json").slice(top.stdout.trim().length + 1);
  const r = spawnSync("git", ["-C", root, "show", `${source.slice(4)}:${rel}`], { encoding: "utf8" });
  try {
    return r.status === 0 ? (JSON.parse(r.stdout) as Manifest) : null;
  } catch {
    return null;
  }
}

function readCheck(root: string, print: string): NonNullable<RoomData["contracts"]>["check"] {
  const last = readJson<{ ok?: boolean; errors?: number; warnings?: number; codes?: string[]; fingerprint?: string; checkedAt?: string }>(join(root, LAST_CHECK_FILE));
  if (!last) return { state: "none", errors: 0, warnings: 0, codes: [], checkedAt: null };
  const state: Freshness = last.fingerprint !== print ? "stale" : last.ok ? "pass" : "fail";
  return { state, errors: last.errors ?? 0, warnings: last.warnings ?? 0, codes: last.codes ?? [], checkedAt: last.checkedAt ?? null };
}

function readMailboxes(root: string): RoomData["mailboxes"] {
  const log = readEvents(join(root, EVENTS_FILE));
  if (!log) return { file: EVENTS_FILE, events: 0, actors: [], notable: [] };
  const byMessage = new Map<string, LoggedEvent[]>();
  for (const e of log.events) if (e.messageId && e.to) byMessage.set(e.messageId, [...(byMessage.get(e.messageId) ?? []), e]);
  const boxes = new Map<string, MailboxEntry[]>();
  for (const [id, evs] of byMessage) {
    const first = evs.find((e) => e.type) ?? evs[0]!;
    const outcome = outcomeOf(evs);
    const to = first.to!;
    const entry: MailboxEntry = {
      messageId: id,
      type: first.type ?? null,
      from: first.from ?? null,
      to,
      outcome,
      mark: OUTCOME_MARK[outcome],
      attempts: Math.max(1, ...evs.map((e) => e.attempt ?? 1)),
      reason: evs.find((e) => e.reason && (NOTABLE.has(e.kind) || e.kind === "retry.scheduled"))?.reason ?? null,
    };
    // One mailbox per actor class; each entry names the instance that received it.
    const actor = to.split(":")[0]!;
    boxes.set(actor, [...(boxes.get(actor) ?? []), entry]);
  }
  const actors = [...boxes.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, messages]) => ({ name, received: messages.length, messages: messages.slice(-MAILBOX_DEPTH) }));
  const notable = log.events.filter((e) => NOTABLE.has(e.kind)).map((e) => `${e.kind} ${e.type ?? e.effect ?? ""} at ${e.to ?? e.actor}${e.reason ? `: ${e.reason}` : ""}`);
  return { file: EVENTS_FILE, events: log.events.length, actors, notable: notable.slice(-MAILBOX_DEPTH) };
}

const GROUPS: Array<[string, string]> = [
  ["proved-locally", "Proved locally"],
  ["stub-only", "Stub only"],
  ["not-guaranteed", "Not guaranteed"],
  ["blocked", "Blocked"],
  ["failing", "Failing"],
  ["untested", "Untested"],
];

function readEvidence(root: string, print: string): RoomData["evidence"] {
  const ev = readJson<{ verdict?: string; generatedAt?: string; profile?: string; fingerprint?: string | null; claims?: Array<{ id: string; statement: string; why?: string; status: string }> }>(
    join(root, EVIDENCE_FILE),
  );
  if (!ev) return { state: "none", generatedAt: null, profile: null, groups: [] };
  const stale = ev.fingerprint !== undefined && ev.fingerprint !== null && ev.fingerprint !== print;
  const state = stale ? "stale" : ev.verdict === "pass" ? "pass" : ev.verdict === "blocked" ? "blocked" : "fail";
  const groups = GROUPS.map(([status, label]) => ({
    status,
    label,
    claims: (ev.claims ?? []).filter((c) => c.status === status).map((c) => ({ id: c.id, statement: c.statement, why: c.why ?? null })),
  })).filter((g) => g.claims.length > 0);
  return { state, generatedAt: ev.generatedAt ?? null, profile: ev.profile ?? null, groups };
}

/** The inputs a Room snapshot depends on; a change in any of them means a new snapshot. */
export function roomSignature(root: string): string {
  const stamp = (f: string) => {
    const p = join(root, f);
    return existsSync(p) ? `${statSync(p).size}:${statSync(p).mtimeMs}` : "-";
  };
  return [fingerprint(root), stamp(EVENTS_FILE), stamp(LAST_CHECK_FILE), stamp(EVIDENCE_FILE), stamp("actors.manifest.json")].join("|");
}

/**
 * Print a compact Room snapshot as one NDJSON line now and again whenever its inputs change. Each
 * snapshot comes from a fresh `actors room --json` process, so edits to system.ts are seen (an ES module,
 * once imported, can't be reloaded in place). Never returns.
 */
export async function followRoom(cwd: string, out: NodeJS.WritableStream, entry: string): Promise<number> {
  const root = findProjectRoot(cwd);
  if (!root) {
    out.write(`${JSON.stringify({ projectRoot: null })}\n`);
    return EXIT_NO_PROJECT;
  }
  let last = "";
  for (;;) {
    const sig = roomSignature(root);
    if (sig !== last) {
      last = sig;
      const r = spawnSync(process.execPath, [entry, "room", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      try {
        out.write(`${JSON.stringify(JSON.parse(r.stdout))}\n`);
      } catch {
        out.write(`${JSON.stringify({ projectRoot: root, error: (r.stderr || "actors room failed").trim().slice(0, 500) })}\n`);
      }
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

export interface GuardData {
  projectRoot: string | null;
  command: string;
  matches: Array<{ id: string; kind: string; description: string }>;
  /** True when the Room should hold the call for a person: a matching command inside an actor project. */
  hold: boolean;
  question: string | null;
  refusal: string | null;
}

/**
 * Decide whether the Room holds a Bash command, and what it shows when it does. The question carries the
 * semantic diff summary and the deploy plan; the default answer is to refuse.
 */
export async function guard(cwd: string, command: string): Promise<CommandResult<GuardData>> {
  const matches = matchEffect(command).map((p) => ({ id: p.id, kind: p.kind, description: p.description }));
  const root = findProjectRoot(cwd);
  const none: GuardData = { projectRoot: root, command, matches, hold: false, question: null, refusal: null };
  if (matches.length === 0) return { data: none, text: "No deployment or remote-write pattern matches.", exitCode: 0 };
  if (!root) return { data: none, text: `Matches ${matches.map((m) => m.id).join(", ")}, but ${cwd} isn't an actor project; the Room doesn't hold it.`, exitCode: 0 };
  const d = await diff(root, {});
  const what = [...new Set(matches.map((m) => m.description.charAt(0).toLowerCase() + m.description.slice(1)))].join("; ");
  const summary =
    d.exitCode !== 0
      ? `The declaration doesn't load, so there is no plan: ${d.data.notes[0] ?? "unknown error"}.`
      : d.data.changes.length === 0
        ? `${d.data.head.system}: no architectural changes against ${d.data.base.source}.`
        : `${d.data.head.system}: ${plural(d.data.changes.length, "change")} against ${d.data.base.source} (${d.data.summary.breaking} breaking, ${d.data.summary.risky} risky${d.data.summary.irreversible ? ", IRREVERSIBLE steps" : ""}${d.data.summary.requiresApproval ? ", needs approval" : ""}).`;
  const changes = (d.data.changes ?? []).slice(0, 6).map((c) => `  ${c.kind} ${c.subject} [${c.compatibility}]`);
  const plan = (d.data.plan ?? []).slice(0, 6).map((s, i) => `  ${i + 1}. ${s.text}`);
  const question = [
    `This command would ${what}: ${command.length > 160 ? `${command.slice(0, 157)}...` : command}`,
    summary,
    ...(changes.length ? ["Changes:", ...changes] : []),
    ...(plan.length ? ["Deploy plan:", ...plan] : []),
    "Claude Code's own permission check still runs after this. Run it?",
  ].join("\n");
  const refusal = `The actors Room held \`${command}\` (${what}) and nobody approved it. Don't retry or rephrase it: show the user the deploy plan (\`actors diff\`) and let them run it or approve it themselves.`;
  return { data: { ...none, hold: true, question, refusal }, text: question, exitCode: 0 };
}
