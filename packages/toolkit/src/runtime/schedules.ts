// An actor's schedules: when each is next due, and the meta key that remembers it.
import { parseCronExpression } from "cron-schedule";
import { durationMs, type ScheduleSpec } from "../system.ts";

/** A schedule `every` period that doesn't parse falls back to this; `actord check` rejects it first. */
const FALLBACK_EVERY_MS = 3_600_000;

/** The first time after `from` at which the schedule is due. A missed tick is not replayed: callers pass "now". */
export function nextDue(spec: ScheduleSpec, from: number): number {
  if (spec.cron !== undefined) return parseCronExpression(spec.cron).getNextDate(new Date(from)).getTime();
  return from + (durationMs(spec.every) ?? FALLBACK_EVERY_MS);
}

/** The _actors_meta key holding when the schedule that delivers `message` is next due. */
export function scheduleKey(message: string): string {
  return `schedule.next:${message}`;
}

/** Before several schedules, one key held the only schedule's due time. Move it to its per-message key. */
export function migrateLegacy(
  meta: (k: string) => string | null,
  setMeta: (k: string, v: string) => void,
  specs: readonly ScheduleSpec[],
  deleteMeta: (k: string) => void,
): void {
  const legacy = meta("schedule.next");
  if (legacy === null) return;
  if (specs.length === 1 && meta(scheduleKey(specs[0]!.message)) === null) setMeta(scheduleKey(specs[0]!.message), legacy);
  deleteMeta("schedule.next");
}
