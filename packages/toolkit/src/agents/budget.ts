// An agent session's budget: its turns and what they cost. pi has no budgets, and a hook can't stop a run (its throw
// is only reported), so actord watches the session's events and aborts it from outside the run once a limit is
// reached. The overshoot is at most the request in flight when the abort lands. The watcher lives in memory; the
// session's job probe reads both again from what pi recorded (spentBy), so a watcher lost to eviction is covered.
import type { PiHarness } from "agents/harness/pi";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentEventStream, type ConversationId, type Cursor, type EntryRecord, UsageDoc, type UsageState } from "@earendil-works/pi-durable";

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

/** What a session has spent, from what pi recorded: every assistant entry in its transcript, and its UsageDoc. */
export async function spentBy(harness: PiHarness, session: string): Promise<Spent> {
  const pi = await harness.pi();
  const id = Number(session) as ConversationId;
  const conversation = await pi.conversation(id, BACKGROUND_CONTEXT);
  if (!conversation) throw new Error(`pi has no session ${session}`);
  let turns = 0;
  let cursor: Cursor | undefined;
  do {
    // The whole transcript, not the model's context, which a compaction shortens.
    const page = await conversation.entries({}, 500, cursor, BACKGROUND_CONTEXT);
    turns += turnsIn(page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return { turns, usage: usageOf(await pi.snapshot(UsageDoc, id, BACKGROUND_CONTEXT)) };
}

/** Watch a session's events; abort it from outside the run once turns or cost reach the budget. Returns a stop function. */
export function watchBudget(harness: PiHarness, session: string, budget: { usd: number; turns: number }, onExhausted: (which: "usd" | "turns") => Promise<void>): () => void {
  let stopped = false;
  let stream: AgentEventStream | undefined;
  const stop = () => {
    stopped = true;
    void stream?.stop();
  };
  if (!Number.isFinite(budget.usd) && !Number.isFinite(budget.turns)) return stop;
  harness
    .session(session)
    .events()
    .then((events) => {
      stream = events;
      if (stopped) return stop();
      // Counted from the snapshot (the model's context, which a compaction may have shortened: never too many), then
      // one per turn_end. Cost is the session's whole UsageDoc, which each usage_changed carries.
      let turns = turnsIn(events.snapshot.entries);
      let costUsd = usageOf(events.snapshot.usage).costUsd;
      const check = () => {
        const which = stopped ? null : reachedLimit(budget, turns, costUsd);
        if (!which) return;
        stop();
        // Not awaited: the listener must return for pi's later batches, and the abort waits on the run.
        onExhausted(which).catch(() => undefined);
      };
      events.start(async (batch) => {
        for (const e of batch) {
          if (e.type === "turn_end") turns++;
          else if (e.type === "usage_changed") costUsd = usageOf(e.usage).costUsd;
          else if (e.type === "snapshot") {
            // Batches overflowed into one snapshot: count again from it.
            turns = turnsIn(e.entries);
            costUsd = usageOf(e.usage).costUsd;
          }
        }
        check();
      });
      check();
    })
    .catch(() => undefined); // pi closed, or the object went away: the job's probe is the backstop
  return stop;
}
