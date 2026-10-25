import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

function eventsPath(cwd: string, file?: string): { path: string | null; root: string | null } {
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

const NO_EVENTS = "No local events yet. Run the tests (they record through actors-toolkit/vitest) to produce .actors/events.ndjson. Production history isn't available to this command.";

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
        if (!opts.notable) out.write(opts.json ? `${JSON.stringify({ $actors: 1, kind: "log.reset", at: Date.now(), actor: "actors-cli" })}\n` : "── new run ──\n");
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

export interface TraceData extends Trace {
  projectRoot: string | null;
  coverage: { file: string | null; events: number; note: string };
}

export function trace(cwd: string, id: string | undefined, opts: { file?: string }): CommandResult<TraceData> {
  const { path, root } = eventsPath(cwd, opts.file);
  const note = "Local evidence from test and dev runs only. Production history isn't available, and the trace never infers events it didn't record.";
  const empty = (file: string | null, events: number): TraceData => ({ projectRoot: root, found: false, target: id ?? "", correlationId: null, rootCauseUnknown: false, root: null, coverage: { file, events, note } });
  if (!id) return { data: empty(null, 0), text: "usage: actors trace <message-id> [--json] [--file <events.ndjson>]", exitCode: 2 };
  if (!path) return { data: empty(null, 0), text: `No actor project at ${cwd}; pass --file <events.ndjson>.`, exitCode: EXIT_NO_PROJECT };
  const file = root ? relative(root, path) : path;
  const log = readEvents(path);
  if (!log) return { data: empty(file, 0), text: `unknown: ${id}. ${NO_EVENTS}`, exitCode: 1 };
  const t = buildTrace(log, id);
  return { data: { projectRoot: root, ...t, coverage: { file, events: log.events.length, note } }, text: renderTrace(t, file), exitCode: t.found ? 0 : 1 };
}
