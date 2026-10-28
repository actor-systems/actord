import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildTrace, EVENTS_FILE, formatEvent, type LoggedEvent, NOTABLE, parseEvents, readEvents, renderTrace, type Trace } from "../../model/events.ts";
import type { CommandResult } from "../output.ts";
import { findProjectRoot } from "../project.ts";
import { EXIT_NO_PROJECT } from "./model.ts";

export interface EventFilter {
  notable?: boolean;
  actor?: string;
  kind?: string;
  correlation?: string;
}

export function eventsPath(cwd: string, file?: string): { path: string | null; root: string | null } {
  if (file) return { path: resolve(cwd, file), root: findProjectRoot(cwd) };
  const root = findProjectRoot(cwd);
  return { path: root ? join(root, EVENTS_FILE) : null, root };
}

function keep(e: LoggedEvent, f: EventFilter): boolean {
  if (f.notable && !NOTABLE.has(e.kind)) return false;
  if (f.actor && !e.actor.startsWith(f.actor) && !(e.to ?? "").startsWith(f.actor)) return false;
  if (f.kind && e.kind !== f.kind) return false;
  if (f.correlation && e.correlationId !== f.correlation) return false;
  return true;
}

const NO_EVENTS = "No local events yet. Run the tests (they record through @actord/toolkit/vitest) to produce .actord/events.ndjson. Production history isn't available to this command.";

export interface EventsData {
  projectRoot: string | null;
  file: string | null;
  count: number;
  unparseable: number;
  events: LoggedEvent[];
}

export function events(cwd: string, opts: EventFilter & { file?: string }): CommandResult<EventsData> {
  const { path, root } = eventsPath(cwd, opts.file);
  if (!path) return { data: { projectRoot: null, file: null, count: 0, unparseable: 0, events: [] }, text: `No actor project at ${cwd}; pass --file <events.ndjson>.`, exitCode: EXIT_NO_PROJECT };
  const log = readEvents(path);
  const file = root ? relative(root, path) : path;
  if (!log) return { data: { projectRoot: root, file, count: 0, unparseable: 0, events: [] }, text: NO_EVENTS, exitCode: 0 };
  const selected = log.events.filter((e) => keep(e, opts));
  return {
    data: { projectRoot: root, file, count: selected.length, unparseable: log.unparseable, events: selected },
    text: selected.length ? selected.map(formatEvent).join("\n") : "No matching events.",
    exitCode: 0,
  };
}

/** Print matching events as they're appended (NDJSON with json=true), surviving truncation by a new test run. Never returns. */
export async function followEvents(cwd: string, opts: EventFilter & { file?: string; json: boolean }, out: NodeJS.WritableStream): Promise<number> {
  const { path } = eventsPath(cwd, opts.file);
  if (!path) {
    out.write(`No actor project at ${cwd}; pass --file <events.ndjson>.\n`);
    return EXIT_NO_PROJECT;
  }
  let offset = 0;
  let partial = "";
  const print = (e: LoggedEvent) => out.write(opts.json ? `${JSON.stringify(e)}\n` : `${formatEvent(e)}\n`);
  for (;;) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size < offset) {
        // A new run truncated the log.
        offset = 0;
        partial = "";
        if (!opts.notable) out.write(opts.json ? `${JSON.stringify({ $actord: 1, kind: "log.reset", at: Date.now(), actor: "actord-cli" })}\n` : "── new run ──\n");
      }
      if (size > offset) {
        const fd = openSync(path, "r");
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        const text = partial + buf.toString("utf8");
        const cut = text.lastIndexOf("\n");
        partial = text.slice(cut + 1);
        for (const e of parseEvents(text.slice(0, cut + 1)).events) if (keep(e, opts)) print(e);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The plugin's monitor is declared once per skill that starts it (inspect, reliability), so a session can
 * start it twice. The first follower per Claude Code session and project claims a lock; later ones exit
 * quietly. Returns false when another live follower holds it.
 */
export function claimMonitor(cwd: string): boolean {
  const root = findProjectRoot(cwd);
  if (!root) return true; // followEvents reports the missing project
  const lock = join(root, ".actord", `monitor-${sessionPid()}.pid`);
  if (!acquireLock(lock, process.pid)) return false;
  process.on("exit", () => releaseLock(lock, process.pid));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
  return true;
}

/** Create the lock holding `pid`, taking it over from a holder that is no longer alive. */
export function acquireLock(lock: string, pid: number): boolean {
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(pid), { flag: "wx" });
      return true;
    } catch {
      const holder = Number(readFileSync(lock, "utf8"));
      if (holder && isAlive(holder)) return false;
      rmSync(lock, { force: true }); // a follower that died without releasing
    }
  }
  return false;
}

export function releaseLock(lock: string, pid: number): void {
  try {
    if (Number(readFileSync(lock, "utf8")) === pid) rmSync(lock);
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The nearest ancestor process that is Claude Code (a shell or the launcher may sit between), else the parent. */
export function sessionPid(): number {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const m = r.status === 0 ? /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim()) : null;
    if (!m) break;
    if (/claude/i.test(m[2]!)) return pid;
    pid = Number(m[1]);
  }
  return process.ppid;
}

export interface TraceData extends Trace {
  projectRoot: string | null;
  coverage: { file: string | null; events: number; note: string };
}

export function trace(cwd: string, id: string | undefined, opts: { file?: string }): CommandResult<TraceData> {
  const { path, root } = eventsPath(cwd, opts.file);
  const note = "Local evidence from test and dev runs only. Production history isn't available, and the trace never infers events it didn't record.";
  const empty = (file: string | null, events: number): TraceData => ({ projectRoot: root, found: false, target: id ?? "", correlationId: null, rootCauseUnknown: false, root: null, coverage: { file, events, note } });
  if (!id) return { data: empty(null, 0), text: "usage: actord trace <message-id> [--json] [--file <events.ndjson>]", exitCode: 2 };
  if (!path) return { data: empty(null, 0), text: `No actor project at ${cwd}; pass --file <events.ndjson>.`, exitCode: EXIT_NO_PROJECT };
  const file = root ? relative(root, path) : path;
  const log = readEvents(path);
  if (!log) return { data: empty(file, 0), text: `unknown: ${id}. ${NO_EVENTS}`, exitCode: 1 };
  const t = buildTrace(log, id);
  return { data: { projectRoot: root, ...t, coverage: { file, events: log.events.length, note } }, text: renderTrace(t, file), exitCode: t.found ? 0 : 1 };
}
