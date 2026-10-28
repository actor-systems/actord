import { relative } from "node:path";
import { readEvents } from "../../model/events.ts";
import { renderScorecard, type Scorecard, scorecard as compute } from "../../model/scorecard.ts";
import type { CommandResult } from "../output.ts";
import { eventsPath } from "./events.ts";
import { EXIT_NO_PROJECT } from "./model.ts";

export interface ScorecardData extends Scorecard {
  projectRoot: string | null;
  file: string | null;
  /** Lines of the log that aren't events (a torn write, say): any decision.recorded among them is lost. */
  unparseable: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Calibration of decision effects from the local event log (the same source as `actord trace`). */
export function scorecard(cwd: string, opts: { effect?: string; file?: string }): CommandResult<ScorecardData> {
  const { path, root } = eventsPath(cwd, opts.file);
  if (!path) return { data: { projectRoot: null, file: null, unparseable: 0, effects: [], orphanLabels: 0 }, text: `No actor project at ${cwd}; pass --file <events.ndjson>.`, exitCode: EXIT_NO_PROJECT };
  const file = root ? relative(root, path) : path;
  const log = readEvents(path);
  if (!log) return { data: { projectRoot: root, file, unparseable: 0, effects: [], orphanLabels: 0 }, text: "No decisions recorded: no local events yet. Run the tests to produce .actord/events.ndjson.", exitCode: 0 };
  const card = compute(log.events, { effect: opts.effect });
  const table = card.effects.length === 0 && opts.effect ? `No decisions or extractions recorded for effect ${opts.effect}.` : renderScorecard(card);
  // What the cards can't count: a lost line may have held a record, and a label whose record is missing is dropped.
  const gaps = [
    ...(log.unparseable > 0 ? [`${plural(log.unparseable, "line", "lines")} of the log couldn't be read`] : []),
    ...(card.orphanLabels > 0 ? [`${plural(card.orphanLabels, "label has", "labels have")} no decision.recorded in this log`] : []),
  ];
  const text = gaps.length > 0 ? `${table}\n\n${gaps.join("; ")}.` : table;
  return { data: { projectRoot: root, file, unparseable: log.unparseable, ...card }, text, exitCode: 0 };
}
