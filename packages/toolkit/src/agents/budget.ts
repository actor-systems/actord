// An agent session's budget: its turns and what they cost. pi has no budgets, and a hook can't stop a run (its throw
// is only reported), so actord watches the session's events and aborts it from outside the run once a limit is
// reached. The overshoot is at most the request in flight when the abort lands. The watcher lives in memory: the
// agent runtime watches each waiting session again when pi opens, before pi resumes its runs, and the session's job
// probe reads both again from what pi recorded (spentBy).
import { PiHarness } from "agents/harness/pi";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentEventStream, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type SnapshotEvent, UsageDoc, type UsageState, watchEvents } from "@earendil-works/pi-durable";

/** The limits a watcher enforces; Infinity for one the actor doesn't declare. */
export interface SessionBudget {
  usd: number;
  turns: number;
}

/** What a session has spent: its turns, and its tokens and dollars over its models and tools. */
export interface Spent {
  turns: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

/** A turn is one model response, which pi records as an assistant entry whatever its stop reason. */
const turnsIn = (entries: readonly EntryRecord[]) => entries.filter((e) => e.kind === "pi.assistant").length;

/** A session's tokens and cost, summed over its models and tools (pi's UsageDoc). Cached tokens are input tokens. */
function usageOf(state: Readonly<UsageState> | undefined): Spent["usage"] {
  const total = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const u of [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})]) {
    total.inputTokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    total.outputTokens += u.output ?? 0;
    total.costUsd += u.cost?.total ?? 0;
  }
  return total;
}

/** The first limit `turns` and `costUsd` have reached, turns first; null while neither has. */
export function reachedLimit(budget: SessionBudget, turns: number, costUsd: number): "turns" | "usd" | null {
  if (turns >= budget.turns) return "turns";
  if (costUsd >= budget.usd) return "usd";
  return null;
}

/** An open pi, from the harness or as its factory has just opened it. */
const piOf = async (harness: PiHarness | Harness): Promise<Harness> => (harness instanceof PiHarness ? harness.pi() : harness);

/**
 * The session's turns: every assistant entry in its whole transcript (not the model's context, which a compaction
 * shortens), up to `upTo` when given.
 */
async function turnsOf(pi: Harness, session: string, upTo?: EntryId): Promise<number> {
  const conversation = await pi.conversation(Number(session) as ConversationId, BACKGROUND_CONTEXT);
  if (!conversation) throw new Error(`pi has no session ${session}`);
  let turns = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries(upTo === undefined ? {} : { maxEntryId: upTo }, 500, cursor, BACKGROUND_CONTEXT);
    turns += turnsIn(page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return turns;
}

/** What a session has spent, from what pi recorded: its turns, and its UsageDoc. */
export async function spentBy(harness: PiHarness, session: string): Promise<Spent> {
  const pi = await harness.pi();
  const usage = await pi.snapshot(UsageDoc, Number(session) as ConversationId, BACKGROUND_CONTEXT);
  return { turns: await turnsOf(pi, session), usage: usageOf(usage) };
}

/** The turns a snapshot of the session's events stands for: its transcript's, up to the snapshot's newest entry. */
async function turnsAt(pi: Harness, session: string, snapshot: SnapshotEvent): Promise<number> {
  // A snapshot's entries are the model's context, oldest first: its last is the transcript's newest entry.
  const newest = snapshot.entries.at(-1)?.id;
  return newest === undefined ? 0 : turnsOf(pi, session, newest);
}

/**
 * Watch a session's events; abort it from outside the run once turns or cost reach the budget. Returns a stop
 * function, whose `ready` resolves once the watcher counts (or has failed, or was stopped first).
 * - Turns are counted from the transcript as the watch attaches, then from turn_end events. Cost is the session's
 *   UsageDoc, which the attach's snapshot and each usage_changed carry.
 * - `harness` may be the pi a harness factory has just opened, so a session is watched before pi resumes its run.
 * - `onError` hears of a watch that couldn't attach or ended on its own, and of an `onExhausted` that failed. The
 *   watcher is gone then, and nothing enforces the budget early until the session is watched again.
 */
export function watchBudget(
  harness: PiHarness | Harness,
  session: string,
  budget: { usd: number; turns: number },
  onExhausted: (which: "usd" | "turns") => Promise<void>,
  onError: (err: unknown) => void = () => undefined,
): (() => void) & { readonly ready: Promise<void> } {
  let stopped = false;
  let stream: AgentEventStream | undefined;
  const stop = () => {
    stopped = true;
    void stream?.stop();
  };
  if (!Number.isFinite(budget.usd) && !Number.isFinite(budget.turns)) return Object.assign(stop, { ready: Promise.resolve() });
  const fail = (err: unknown) => {
    if (stopped) return;
    stop();
    onError(err);
  };
  const ready = (async () => {
    const pi = await piOf(harness);
    const events = await watchEvents(pi, Number(session) as ConversationId, BACKGROUND_CONTEXT);
    stream = events;
    if (stopped) return stop();
    void events.closed.then((end) => fail(new Error(`the watch ended: ${end.reason}`)));
    // Batches wait for start(), so none is missed or counted twice while the transcript is read.
    let turns = await turnsAt(pi, session, events.snapshot);
    let costUsd = usageOf(events.snapshot.usage).costUsd;
    const check = () => {
      const which = stopped ? null : reachedLimit(budget, turns, costUsd);
      if (!which) return;
      stop();
      // Not awaited: the listener must return for pi's later batches, and the abort waits on the run.
      onExhausted(which).catch(onError);
    };
    if (stopped) return;
    events.start(async (batch) => {
      for (const e of batch) {
        if (e.type === "turn_end") turns++;
        else if (e.type === "usage_changed") costUsd = usageOf(e.usage).costUsd;
        else if (e.type === "snapshot") {
          // Batches overflowed into one snapshot: count again from it.
          turns = await turnsAt(pi, session, e);
          costUsd = usageOf(e.usage).costUsd;
        }
      }
      check();
    });
    check();
  })().catch(fail);
  return Object.assign(stop, { ready });
}
