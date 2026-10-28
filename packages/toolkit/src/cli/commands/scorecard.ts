import { relative } from "node:path";
import { readEvents } from "../../model/events.ts";
import { renderScorecard, type Scorecard, scorecard as compute } from "../../model/scorecard.ts";
import type { CommandResult } from "../output.ts";
import { eventsPath } from "./events.ts";
import { EXIT_NO_PROJECT } from "./model.ts";

export interface ScorecardData extends Scorecard {
  projectRoot: string | null;
  file: string | null;
}

/** Calibration of decision effects from the local event log (the same source as `actord trace`). */
export function scorecard(cwd: string, opts: { effect?: string; file?: string }): CommandResult<ScorecardData> {
  const { path, root } = eventsPath(cwd, opts.file);
  if (!path) return { data: { projectRoot: null, file: null, effects: [] }, text: `No actor project at ${cwd}; pass --file <events.ndjson>.`, exitCode: EXIT_NO_PROJECT };
  const file = root ? relative(root, path) : path;
  const log = readEvents(path);
  if (!log) return { data: { projectRoot: root, file, effects: [] }, text: "No decisions recorded: no local events yet. Run the tests to produce .actord/events.ndjson.", exitCode: 0 };
  const card = compute(log.events, { effect: opts.effect });
  return { data: { projectRoot: root, file, ...card }, text: renderScorecard(card), exitCode: 0 };
}
