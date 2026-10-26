import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { deriveId, EffectRejected, ingress } from "../src/runtime/index.ts";
import { migrateLegacy, nextDue, scheduleKey } from "../src/runtime/schedules.ts";
import { captureEvents, expireApprovals, expireJobs, fireTimers, overrideBudget, overrideEffect, overrideEffectBudget, resetSeams, settle, tick } from "../src/testing.ts";
import { system } from "./src/index.ts";

afterEach(() => resetSeams());
const probe = (key: string) => env.PROBE.getByName(key);
const send = (key: string, effect: "gateway.reconcilable" | "gateway.plain" | "gateway.approval" | "gateway.keyed" | "gateway.budgeted" | "gateway.job-plain" | "gateway.job-approval") =>
  ingress(env, system, "Probe", "probe.effect", { effect, key }, { key });

it("[denied-capability] an effect the actor didn't declare is refused and nothing is queued", async () => {
  const r = await ingress(env, system, "Probe", "probe.misbehave", {}, { key: "deny" });
  expect(r).toMatchObject({ status: "failed" });
  expect((r as { error: string }).error).toMatch(/may not request effect gateway\.undeclared/);
  const rows = await runInDurableObject(probe("deny"), (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox").one().n);
  expect(rows).toBe(0);
});

it("[lost-ack-reconciled] without a key, a lost acknowledgment is resolved by looking the outcome up", async () => {
  let calls = 0;
  overrideEffect("gateway.reconcilable", {
    run: async () => {
      calls++;
      throw new Error("connection dropped after send");
    },
    reconcile: async () => ({ delivered: true, value: { receipt: "r-1" } }),
  });
  await send("rec-1", "gateway.reconcilable");
  await settle(env, system);
  expect(calls).toBe(1);
  expect(await probe("rec-1").outcomes()).toEqual([{ key: "rec-1", status: "confirmed", error: null }]);
});

it("[lost-ack-in-doubt] when the lookup can't tell, the outcome is in doubt, not delivered", async () => {
  overrideEffect("gateway.reconcilable", {
    run: async () => {
      throw new Error("connection dropped after send");
    },
    reconcile: async () => undefined,
  });
  await send("rec-2", "gateway.reconcilable");
  await settle(env, system);
  expect(await probe("rec-2").outcomes()).toMatchObject([{ key: "rec-2", status: "in_doubt" }]);
});

it("[approval-required] decide() releases or refuses a parked effect", async () => {
  let runs = 0;
  overrideEffect("gateway.approval", { run: async () => ++runs });
  await send("ap-yes", "gateway.approval");
  await send("ap-no", "gateway.approval");
  await settle(env, system);
  expect(runs).toBe(0);
  expect(await probe("ap-yes").decide("ap-yes", "approve")).toMatchObject({ status: "confirmed", value: 1 });
  expect(await probe("ap-no").decide("ap-no", "deny")).toMatchObject({ status: "denied" });
  expect(await probe("ap-no").decide("ap-no", "approve")).toMatchObject({ status: "denied", error: "no effect awaiting approval with that key" });
  expect(runs).toBe(1);
});

it("[restart-mid-effect] an attempt orphaned by a restart is in doubt without a key, and retried with one", async () => {
  for (const [key, effect] of [["orph-plain", "gateway.plain"], ["orph-keyed", "gateway.keyed"]] as const) {
    overrideEffect(effect, { run: () => new Promise(() => {}) }); // hangs until the crash below
    await send(key, effect);
  }
  await abortAllDurableObjects(); // a crash: in-memory state, including the in-flight attempts, is gone
  let keyedRuns = 0;
  overrideEffect("gateway.keyed", { run: async () => ++keyedRuns });
  overrideEffect("gateway.plain", { run: async () => "should not run again" });
  // Any activity on the new instance recovers orphans.
  await ingress(env, system, "Probe", "probe.misbehave", {}, { key: "orph-plain" }).catch(() => {});
  await ingress(env, system, "Probe", "probe.misbehave", {}, { key: "orph-keyed" }).catch(() => {});
  await settle(env, system);
  expect(await probe("orph-plain").outcomes()).toMatchObject([{ key: "orph-plain", status: "in_doubt" }]);
  expect(await probe("orph-keyed").outcomes()).toMatchObject([{ key: "orph-keyed", status: "confirmed" }]);
  expect(keyedRuns).toBe(1);
});

it("[heartbeat-armed] while an effect runs, actord keeps a wake at most 30 s away", async () => {
  overrideEffect("gateway.keyed", { run: () => new Promise(() => {}) });
  await send("hb", "gateway.keyed");
  const due = await runInDurableObject(probe("hb"), (_i, s) => Number(s.storage.sql.exec("SELECT time FROM cf_agents_jobs WHERE capability = 'actord'").one().time));
  expect(due).toBeLessThanOrEqual(Date.now() + 30_000);
});

it("[crash-loop-parked] a keyed effect interrupted 5 times is parked in doubt and not run again", async () => {
  let runs = 0;
  // Count only this key: an earlier test's hung instance shares the override and is recovered by the aborts too.
  overrideEffect("gateway.keyed", { run: (_input, c) => { if (c.key === "park") runs++; return new Promise(() => {}); } });
  await send("park", "gateway.keyed");
  for (let i = 0; i < 5; i++) { await abortAllDurableObjects(); await settle(env, system, { rounds: 2 }); }
  expect(await probe("park").outcomes()).toMatchObject([{ key: "park", status: "in_doubt", error: "parked: interrupted 5 times without settling" }]);
  expect(runs).toBe(5);
  await abortAllDurableObjects(); // parked is final: another restart does not run it again
  await settle(env, system, { rounds: 2 });
  expect(runs).toBe(5);
  expect(await probe("park").outcomes()).toMatchObject([{ key: "park", status: "in_doubt", error: "parked: interrupted 5 times without settling" }]);
});

it("[job-parked-with-early-outcome] a job start interrupted 5 times settles by the completion kept for it, not parked", async () => {
  overrideEffect("gateway.job", { start: (_i, c) => (c.key === "jpe" ? new Promise(() => {}) : Promise.resolve({ runId: "other" })) });
  await ingress(env, system, "Probe", "probe.job.start", { key: "jpe" }, { key: "jpe" });
  await ingress(env, system, "Probe", "probe.job.done", { key: "jpe", ok: true }, { key: "jpe" });
  for (let i = 0; i < 5; i++) { await abortAllDurableObjects(); await settle(env, system, { rounds: 2 }); }
  expect(await probe("jpe").outcomes()).toMatchObject([{ key: "jpe", status: "confirmed" }]);
  expect(await jobRow("jpe")).toMatchObject({ status: "confirmed", body: { settledBy: "message" } });
});

it("[lifecycle-shared-alarm] actord and another Lifecycle capability share the object's one alarm", async () => {
  let runs = 0;
  overrideEffect("gateway.keyed", { run: async () => { if (++runs === 1) throw new Error("transient"); return "ok"; } });
  await send("shared", "gateway.keyed");        // first attempt fails, so a retry is pending in 40 ms
  await probe("shared").pingAt(Date.now() + 20); // the Pinger capability's own job
  const owners = await runInDurableObject(probe("shared"), (_i, s) =>
    s.storage.sql.exec<{ capability: string }>("SELECT capability FROM cf_agents_jobs ORDER BY capability").toArray().map((r) => r.capability));
  expect(owners).toEqual(["actord", "pinger"]);
  await new Promise((r) => setTimeout(r, 60));
  await runDurableObjectAlarm(probe("shared"));
  await settle(env, system, { deliver: false }); // only waits, so the retry can only have come from the alarm
  expect(runs).toBe(2);
  await settle(env, system);
  expect(await probe("shared").pings()).toBe(1);
  expect(await probe("shared").outcomes()).toEqual([{ key: "shared", status: "confirmed", error: null }]);
});

it("derived message ids are deterministic and position-sensitive", () => {
  expect(deriveId("m-1", "send", 0, "a.b", "X", "main")).toBe(deriveId("m-1", "send", 0, "a.b", "X", "main"));
  expect(deriveId("m-1", "send", 0, "a.b", "X", "main")).not.toBe(deriveId("m-1", "send", 1, "a.b", "X", "main"));
});

const setTimer = (key: string, tk: string, delayMs: number, fail = false, extra: { label?: string } = {}) =>
  ingress(env, system, "Probe", "probe.timer.set", { key: tk, delayMs, ...(fail ? { fail } : {}), ...extra }, { key });

it("[timer-fires] a timer set in a handler arrives later as a message from @timer", async () => {
  await setTimer("tm", "t1", 20);
  expect(await probe("tm").fired()).toEqual([]);
  await new Promise((r) => setTimeout(r, 30));
  await settle(env, system);
  expect(await probe("tm").fired()).toEqual(["t1"]);
});

it("[timer-survives-restart] a pending timer fires after the object restarts", async () => {
  await setTimer("tm2", "t2", 20);
  await abortAllDurableObjects();
  await new Promise((r) => setTimeout(r, 30));
  await settle(env, system);
  expect(await probe("tm2").fired()).toEqual(["t2"]);
});

it("[timer-duplicate-fire] a timer delivered twice is handled once", async () => {
  await setTimer("tm3", "t3", 60_000);
  expect(await fireTimers(env, system, "Probe", "tm3")).toBe(1);
  // Same key and due_at, so the same derived id: the inbox must absorb it.
  await runInDurableObject(probe("tm3"), (_i, s) => {
    s.storage.sql.exec("INSERT INTO _actors_timers (key, type, payload, due_at, attempts, causation_id, correlation_id) VALUES ('t3', 'probe.timer.fired', '{\"key\":\"t3\"}', 0, 0, NULL, 'c')");
  });
  expect(await fireTimers(env, system, "Probe", "tm3")).toBe(1);
  expect(await probe("tm3").fired()).toEqual(["t3"]);
});

it("[timer-cancel] a cancelled timer never fires", async () => {
  await setTimer("tm4", "t4", 60_000);
  await ingress(env, system, "Probe", "probe.timer.cancel", { key: "t4" }, { key: "tm4" });
  expect(await fireTimers(env, system, "Probe", "tm4")).toBe(0);
  expect(await probe("tm4").fired()).toEqual([]);
});

it("[timer-replace] setting the same key again replaces the pending timer: the new one fires, the old one never does", async () => {
  const before = Date.now();
  await setTimer("tm5", "t5", 60_000, false, { label: "t5-old" });
  await setTimer("tm5", "t5", 90_000, false, { label: "t5-new" });
  const rows = await timerRows("tm5");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.due_at).toBeGreaterThanOrEqual(before + 90_000);
  expect(await fireTimers(env, system, "Probe", "tm5")).toBe(1);
  expect(await probe("tm5").fired()).toEqual(["t5-new"]);
  expect(await timerRows("tm5")).toEqual([]);
});

it("[timer-cancelled-by-earlier-timer] a timer cancelled by the handler of a timer that fired just before it, in the same drive, never fires", async () => {
  await setTimer("tm9", "kill-zz", 60_000);
  await setTimer("tm9", "zz", 60_000);
  expect(await fireTimers(env, system, "Probe", "tm9")).toBe(2); // both due in one drive; kill-zz is delivered first
  expect(await probe("tm9").fired()).toEqual(["kill-zz"]);
  expect(await timerRows("tm9")).toEqual([]);
});

it("[timer-replaced-by-earlier-timer] a timer replaced by the handler of a timer that fired just before it, in the same drive, fires once, as the replacement", async () => {
  await setTimer("tm10", "reset-zz", 60_000);
  await setTimer("tm10", "zz", 60_000);
  expect(await fireTimers(env, system, "Probe", "tm10")).toBe(2); // both due in one drive; reset-zz sets zz again first
  expect(await probe("tm10").fired()).toEqual(["reset-zz"]);
  expect(await timerRows("tm10")).toMatchObject([{ key: "zz", attempts: 0 }]);
  expect(await fireTimers(env, system, "Probe", "tm10")).toBe(1);
  expect(await probe("tm10").fired()).toEqual(["reset-zz", "zz-new"]);
});

it("[timer-atomic] a handler that sets a timer and then throws leaves no timer", async () => {
  const r = await setTimer("tm6", "t6", 0, true);
  expect(r.status).toBe("failed");
  expect(await runInDurableObject(probe("tm6"), (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_timers").one().n)).toBe(0);
});

const timerRows = (key: string) =>
  runInDurableObject(probe(key), (_i, s) => s.storage.sql.exec<{ key: string; attempts: number; due_at: number }>("SELECT key, attempts, due_at FROM _actors_timers").toArray());

it("[timer-delivery-retry] a timer whose handler fails is retried with backoff, then dropped when attempts run out", async () => {
  await setTimer("tm7", "bad1", 60_000);
  const before = Date.now();
  await fireTimers(env, system, "Probe", "tm7");
  const after = Date.now();
  const [row] = await timerRows("tm7");
  expect(row).toMatchObject({ key: "bad1", attempts: 1 });
  // fireTimers made it due at 0; the failure pushed it out by Probe's backoff of 40 ms.
  expect(row!.due_at).toBeGreaterThanOrEqual(before + 40);
  expect(row!.due_at).toBeLessThanOrEqual(after + 40);
  for (let i = 0; i < 4; i++) await fireTimers(env, system, "Probe", "tm7"); // attempts 2..5
  expect(await timerRows("tm7")).toMatchObject([{ key: "bad1", attempts: 5 }]); // still retrying one short of the default maxAttempts of 6
  await fireTimers(env, system, "Probe", "tm7"); // attempt 6 exhausts it
  expect(await timerRows("tm7")).toEqual([]);
  expect(await probe("tm7").fired()).toEqual([]);
});

it("[timer-arms-alarm] a timer wakes the object through its alarm, with no driver call", async () => {
  await setTimer("tm8", "t8", 20);
  const jobs = await runInDurableObject(probe("tm8"), (_i, s) =>
    s.storage.sql.exec<{ time: number }>("SELECT time FROM cf_agents_jobs WHERE capability = 'actord'").toArray());
  const [timer] = await timerRows("tm8");
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.time).toBeLessThanOrEqual(timer!.due_at);
  await new Promise((r) => setTimeout(r, 40));
  await runDurableObjectAlarm(probe("tm8"));
  expect(await probe("tm8").fired()).toEqual(["t8"]);
});

it("[schedules-independent] each schedule ticks on its own message", async () => {
  await tick(env, system, "Probe", "sch", "probe.tick.hourly");
  await tick(env, system, "Probe", "sch", "probe.tick.daily");
  expect(await probe("sch").ticks()).toEqual(["probe.tick.daily", "probe.tick.hourly"]);
});

it("[schedule-late-wake] an object that wakes long after its due time ticks once and re-arms from now", async () => {
  const due = Date.now() - 5 * 3_600_000; // five hourly periods missed
  await runInDurableObject(probe("late"), async (_i, s) => {
    s.storage.sql.exec("INSERT INTO _actors_meta (k, v) VALUES ('schedule.next:probe.tick.hourly', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(due));
  });
  await settle(env, system);
  expect(await probe("late").ticks()).toEqual(["probe.tick.hourly"]);
  expect(await probe("late").tickAts()).toEqual([due]); // the missed due time, not "now"
  const next = await runInDurableObject(probe("late"), (_i, s) => Number(s.storage.sql.exec("SELECT v FROM _actors_meta WHERE k = 'schedule.next:probe.tick.hourly'").one().v));
  expect(next).toBeGreaterThan(Date.now() + 3_500_000);
});

it("[schedule-cron-next] nextDue follows the cron expression", () => {
  const from = Date.UTC(2026, 9, 25, 10, 0, 0);
  expect(new Date(nextDue({ cron: "0 9 * * *", message: "m" }, from)).toISOString()).toBe("2026-10-26T09:00:00.000Z");
});

it("[schedule-stale-meta] a removed schedule's due time and the legacy key are not wake sources", async () => {
  await runInDurableObject(probe("stale"), async (_i, s) => {
    s.storage.sql.exec("INSERT INTO _actors_meta (k, v) VALUES ('schedule.next:gone.message', '1'), ('schedule.next', '1') ON CONFLICT (k) DO NOTHING");
  });
  await tick(env, system, "Probe", "stale", "probe.tick.hourly"); // drives; two schedules, so the legacy key is ignored
  expect(await probe("stale").ticks()).toEqual(["probe.tick.hourly"]);
  const time = await runInDurableObject(probe("stale"), (_i, s) =>
    s.storage.sql.exec<{ time: number }>("SELECT time FROM cf_agents_jobs WHERE capability = 'actord'").toArray()[0]?.time);
  expect(time).toBeGreaterThan(Date.now());
});

it("[schedule-legacy-migrated] a single schedule inherits the old schedule.next value, and the legacy key goes", () => {
  const store = new Map<string, string>([["schedule.next", "12345"]]);
  const spec = { every: "1h", message: "m" } as const;
  migrateLegacy((k) => store.get(k) ?? null, (k, v) => void store.set(k, v), [spec], (k) => void store.delete(k));
  expect(store.get(scheduleKey("m"))).toBe("12345");
  expect(store.has("schedule.next")).toBe(false);
});

it("[effect-budget] an effect's own timeout overrides its actor's", async () => {
  overrideBudget("Probe", { timeoutMs: 5_000 });
  overrideEffectBudget("gateway.plain", { timeoutMs: 20 });
  overrideEffect("gateway.plain", { run: () => new Promise(() => {}) });
  await send("eb", "gateway.plain");
  await settle(env, system);
  expect(await probe("eb").outcomes()).toMatchObject([{ key: "eb", status: "in_doubt", error: "effect timed out after 20ms" }]);
});

it("[effect-usage] usage reported by an adapter arrives with the result", async () => {
  overrideEffect("gateway.keyed", { run: async (_i, c) => { c.reportUsage({ inputTokens: 10, costUsd: 0.01 }); c.reportUsage({ inputTokens: 5, outputTokens: 2 }); return "ok"; } });
  await send("eu", "gateway.keyed");
  await settle(env, system);
  expect((await probe("eu").outcomes())[0]).toMatchObject({ status: "confirmed", usage: { inputTokens: 15, outputTokens: 2, costUsd: 0.01 } });
});

it("[effect-usage-attempts] usage is summed across retried attempts", async () => {
  let n = 0;
  overrideEffect("gateway.keyed", { run: async (_i, c) => { c.reportUsage({ inputTokens: 10 }); if (++n < 2) throw new Error("flaky"); return "ok"; } });
  await send("eua", "gateway.keyed");
  await settle(env, system);
  expect((await probe("eua").outcomes())[0]).toMatchObject({ status: "confirmed", usage: { inputTokens: 20 } });
});

it("[effect-usage-nonfinite] usage values that aren't finite numbers at or above 0 are ignored, and the result still arrives", async () => {
  overrideEffect("gateway.keyed", {
    run: async (_i, c) => {
      c.reportUsage({ inputTokens: 3, costUsd: Number.NaN });
      c.reportUsage({ outputTokens: Number.POSITIVE_INFINITY, containerSeconds: -1 });
      c.reportUsage({ inputTokens: 2, costUsd: Number.NEGATIVE_INFINITY });
      return "ok";
    },
  });
  await send("eunf", "gateway.keyed");
  await settle(env, system);
  const [outcome] = await probe("eunf").outcomes();
  expect(outcome).toMatchObject({ key: "eunf", status: "confirmed" });
  expect(outcome!.usage).toEqual({ inputTokens: 5 });
  const dead = await runInDurableObject(probe("eunf"), (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox WHERE status = 'dead'").one().n);
  expect(dead).toBe(0);
});

it("[effect-usage-absent] no usage field when an adapter reported none", async () => {
  overrideEffect("gateway.keyed", { run: async () => "ok" });
  await send("eun", "gateway.keyed");
  await settle(env, system);
  expect((await probe("eun").outcomes())[0]).not.toHaveProperty("usage");
});

const hang = (counter: { n: number }) => ({ run: () => { counter.n++; return new Promise<never>(() => {}); } });

it("[effect-budget-declared] a declared effect budget beats its actor's, and maxAttempts above the runtime's 6 is honoured", async () => {
  overrideBudget("Probe", { timeoutMs: 5_000, maxAttempts: 2 });
  const c = { n: 0 };
  overrideEffect("gateway.budgeted", hang(c));
  await send("ebd", "gateway.budgeted");
  await settle(env, system);
  expect(c.n).toBe(8);
  expect(await probe("ebd").outcomes()).toMatchObject([{ key: "ebd", status: "in_doubt", error: "effect timed out after 15ms" }]);
});

it("[effect-budget-seam-over-declared] the effect seam beats the declared budget, and a field it omits falls through", async () => {
  overrideEffectBudget("gateway.budgeted", { timeoutMs: 25 });
  const c = { n: 0 };
  overrideEffect("gateway.budgeted", hang(c));
  await send("ebs", "gateway.budgeted");
  await settle(env, system);
  expect(c.n).toBe(8); // maxAttempts inherited from the declared budget
  expect(await probe("ebs").outcomes()).toMatchObject([{ status: "in_doubt", error: "effect timed out after 25ms" }]);
});

it("[effect-budget-attempts] maxAttempts from the effect seam bounds retries; timeout falls through to the declared 15ms", async () => {
  overrideEffectBudget("gateway.budgeted", { maxAttempts: 2 });
  const c = { n: 0 };
  overrideEffect("gateway.budgeted", hang(c));
  await send("eba", "gateway.budgeted");
  await settle(env, system);
  expect(c.n).toBe(2);
  expect(await probe("eba").outcomes()).toMatchObject([{ status: "in_doubt", error: "effect timed out after 15ms" }]);
});

it("[effect-budget-above-runtime] an effect may retry past the runtime-wide limit and still ends with a result message", async () => {
  overrideEffectBudget("gateway.budgeted", { timeoutMs: 1_000, maxAttempts: 9 });
  let n = 0;
  overrideEffect("gateway.budgeted", { run: async () => { n++; throw new Error("boom"); } });
  await send("ebu", "gateway.budgeted");
  await settle(env, system);
  expect(n).toBe(9);
  expect(await probe("ebu").outcomes()).toMatchObject([{ key: "ebu", status: "in_doubt", error: "boom" }]);
});

it("[effect-usage-failed] usage reported before a rejection arrives with the failed result", async () => {
  overrideEffect("gateway.plain", { run: async (_i, c) => { c.reportUsage({ costUsd: 0.5 }); throw new EffectRejected("refused"); } });
  await send("euf", "gateway.plain");
  await settle(env, system);
  expect((await probe("euf").outcomes())[0]).toMatchObject({ status: "failed", usage: { costUsd: 0.5 } });
});

it("[effect-usage-timeout] usage reported before a timeout is kept; a later report is dropped", async () => {
  overrideEffectBudget("gateway.plain", { timeoutMs: 20 });
  overrideEffect("gateway.plain", {
    run: async (_i, c) => {
      c.reportUsage({ inputTokens: 3 });
      await new Promise((r) => setTimeout(r, 80));
      c.reportUsage({ inputTokens: 100 });
      return "late";
    },
  });
  await send("eut", "gateway.plain");
  await settle(env, system);
  await new Promise((r) => setTimeout(r, 150));
  expect((await probe("eut").outcomes())[0]).toMatchObject({ status: "in_doubt", usage: { inputTokens: 3 } });
  const body = await runInDurableObject(probe("eut"), (_i, s) => s.storage.sql.exec<{ body: string }>("SELECT body FROM _actors_outbox WHERE kind = 'effect'").one().body);
  expect(JSON.parse(body).usage).toEqual({ inputTokens: 3 });
});

it("[effect-usage-event] the effect event carries detail.usage", async () => {
  const log = vi.spyOn(console, "log");
  overrideEffect("gateway.keyed", { run: async (_i, c) => { c.reportUsage({ outputTokens: 7 }); return "ok"; } });
  await send("eue", "gateway.keyed");
  await settle(env, system);
  const events = log.mock.calls.flatMap(([l]) => { try { return [JSON.parse(String(l))]; } catch { return []; } });
  log.mockRestore();
  expect(events.find((e) => e.kind === "effect.confirmed" && e.effectKey === "eue")).toMatchObject({ detail: { usage: { outputTokens: 7 } } });
});

// ---- Job effects ----

const startJob = (key: string) => ingress(env, system, "Probe", "probe.job.start", { key }, { key });
const jobDone = (key: string, ok = true) => ingress(env, system, "Probe", "probe.job.done", { key, ok }, { key });
const cancelJob = (key: string) => ingress(env, system, "Probe", "probe.job.cancel", { key }, { key });
const jobRow = (key: string, effect = "gateway.job") =>
  runInDurableObject(probe(key), (_i, s) => {
    const r = s.storage.sql.exec<{ status: string; next_at: number; body: string }>("SELECT status, next_at, body FROM _actors_outbox WHERE id = ?", `fx:${effect}:${key}`).toArray()[0];
    return r ? { status: r.status, nextAt: r.next_at, body: JSON.parse(r.body) as Record<string, unknown> } : null;
  });
/** Make an instance's probes due now, the way its job would fire a period later. settle() never does this. */
const probeDue = (key: string) => runInDurableObject(probe(key), (_i, s) => void s.storage.sql.exec("UPDATE _actors_outbox SET next_at = 0 WHERE status = 'awaiting_job'"));
const logged = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.flatMap(([l]) => { try { return [JSON.parse(String(l)) as Record<string, unknown>]; } catch { return []; } });

it("[job-settled-by-message] a job finishes when its completion message settles it", async () => {
  let starts = 0;
  overrideEffect("gateway.job", { start: async () => ({ runId: `r-${++starts}` }) });
  const before = Date.now();
  await startJob("j1");
  await settle(env, system);
  const after = Date.now();
  expect(await probe("j1").outcomes()).toEqual([]);
  const waiting = await jobRow("j1");
  expect(waiting).toMatchObject({ status: "awaiting_job", body: { handle: { runId: "r-1" } } });
  // The deadline is 1h from the start, and the next look is one probe period (1m) away, the nearer of the two.
  expect(waiting!.body.deadlineAt).toBeGreaterThanOrEqual(before + 3_600_000);
  expect(waiting!.body.deadlineAt).toBeLessThanOrEqual(after + 3_600_000);
  expect(waiting!.nextAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(waiting!.nextAt).toBeLessThanOrEqual(after + 60_000);
  await jobDone("j1");
  await settle(env, system);
  expect(await probe("j1").outcomes()).toMatchObject([{ key: "j1", status: "confirmed" }]);
  expect(await probe("j1").settled()).toEqual([{ key: "j1", ok: true }]);
  expect(await jobRow("j1")).toMatchObject({ status: "confirmed", body: { settledBy: "message", outcome: { finished: true } } });
  expect(starts).toBe(1);
  // A second completion (a redelivered webhook, say) finds the job settled: false, and no second result.
  await jobDone("j1", false);
  await settle(env, system);
  expect(await probe("j1").settled()).toEqual([{ key: "j1", ok: true }, { key: "j1", ok: false }]);
  expect(await probe("j1").outcomes()).toMatchObject([{ key: "j1", status: "confirmed" }]);
});

it("[job-settled-by-probe] a probe that reports done settles the job", async () => {
  const handles: unknown[] = [];
  overrideEffect("gateway.job", {
    start: async (_i, c) => {
      c.reportUsage({ inputTokens: 1 });
      return { runId: "p-1" };
    },
    probe: async (h, c) => {
      handles.push(h);
      c.reportUsage({ inputTokens: 2 });
      return handles.length === 1 ? { done: false } : { done: true, status: "confirmed", value: 1 };
    },
  });
  await startJob("j2");
  await settle(env, system);
  expect(handles).toEqual([]); // settle() doesn't make a probe due
  await probeDue("j2");
  const before = Date.now();
  await settle(env, system);
  expect(handles).toEqual([{ runId: "p-1" }]);
  const row = await jobRow("j2");
  expect(row).toMatchObject({ status: "awaiting_job" });
  expect(row!.nextAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(await probe("j2").outcomes()).toEqual([]);
  await probeDue("j2");
  await settle(env, system);
  expect(handles).toHaveLength(2);
  // Usage from the start and from both probes arrives with the result.
  expect(await probe("j2").outcomes()).toMatchObject([{ key: "j2", status: "confirmed", usage: { inputTokens: 5 } }]);
  expect(await jobRow("j2")).toMatchObject({ status: "confirmed", body: { settledBy: "probe", outcome: 1 } });
});

it("[job-deadline-in-doubt] a job that outlives its deadline is in doubt", async () => {
  overrideEffect("gateway.job", { start: async () => ({ runId: "d-1" }) });
  await startJob("j3");
  await settle(env, system);
  expect(await probe("j3").outcomes()).toEqual([]);
  expect(await expireJobs(env, system, "Probe", "j3")).toBe(1);
  await settle(env, system);
  expect(await probe("j3").outcomes()).toMatchObject([{ key: "j3", status: "in_doubt", error: "deadline passed" }]);
  expect(await jobRow("j3")).toMatchObject({ status: "in_doubt", body: { settledBy: "deadline" } });
});

it("[job-cancel-honest] a confirmed cancel fails the job, an unconfirmed one is in doubt", async () => {
  const cancelled: unknown[] = [];
  overrideEffect("gateway.job", {
    start: async (input) => ({ runId: (input as { key: string }).key }),
    cancel: async (h) => {
      cancelled.push(h);
      const id = (h as { runId: string }).runId;
      if (id === "jc-throw") throw new Error("gateway down");
      return id === "jc-yes";
    },
  });
  const keys = ["jc-yes", "jc-no", "jc-throw"];
  for (const k of keys) await startJob(k);
  await settle(env, system);
  for (const k of keys) await cancelJob(k);
  await settle(env, system);
  expect(cancelled).toEqual(keys.map((runId) => ({ runId })));
  expect(await probe("jc-yes").outcomes()).toMatchObject([{ key: "jc-yes", status: "failed", error: "cancelled" }]);
  expect(await probe("jc-no").outcomes()).toMatchObject([{ key: "jc-no", status: "in_doubt", error: "cancel not confirmed" }]);
  expect(await probe("jc-throw").outcomes()).toMatchObject([{ key: "jc-throw", status: "in_doubt", error: "cancel not confirmed" }]);
  expect(await jobRow("jc-yes")).toMatchObject({ status: "failed", body: { settledBy: "cancel" } });
  // An adapter with no cancel can't confirm one either.
  overrideEffect("gateway.job", { start: async () => ({ runId: "none" }) });
  await startJob("jc-none");
  await settle(env, system);
  await cancelJob("jc-none");
  await settle(env, system);
  expect(await probe("jc-none").outcomes()).toMatchObject([{ key: "jc-none", status: "in_doubt", error: "cancel not confirmed" }]);
});

it("[job-restart-awaiting] a restart while waiting neither re-starts the job nor loses it", async () => {
  let starts = 0;
  overrideEffect("gateway.job", { start: async () => ({ runId: `r-${++starts}` }) });
  await startJob("j5");
  await settle(env, system);
  await abortAllDurableObjects(); // a crash while the job runs elsewhere
  expect(await jobRow("j5")).toMatchObject({ status: "awaiting_job", body: { handle: { runId: "r-1" } } });
  await jobDone("j5");
  await settle(env, system);
  expect(await probe("j5").outcomes()).toMatchObject([{ key: "j5", status: "confirmed" }]);
  expect(starts).toBe(1);
});

it("[job-late-settle] a completion after the deadline changes nothing and adds no second result", async () => {
  overrideEffect("gateway.job", { start: async () => ({ runId: "late" }) });
  await ingress(env, system, "Probe", "probe.job.start", { key: "j6" }, { key: "j6" });
  await settle(env, system);
  await expireJobs(env, system, "Probe", "j6");
  await ingress(env, system, "Probe", "probe.job.done", { key: "j6", ok: true }, { key: "j6" });
  await settle(env, system);
  expect(await probe("j6").outcomes()).toMatchObject([{ key: "j6", status: "in_doubt", error: "deadline passed" }]);
  expect(await probe("j6").settled()).toEqual([{ key: "j6", ok: false }]);
  const results = await runInDurableObject(probe("j6"), (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox WHERE kind = 'message' AND body LIKE '%probe.outcome%'").one().n);
  expect(results).toBe(1);
});

it("[job-start-failure] a failed start follows the call rules: retried with a key, in doubt without", async () => {
  let keyed = 0;
  overrideEffect("gateway.job", {
    start: async () => {
      if (++keyed === 1) throw new Error("gateway flaked");
      return { runId: "k" };
    },
  });
  let plain = 0;
  overrideEffect("gateway.job-plain", {
    start: async () => {
      plain++;
      throw new Error("gateway flaked");
    },
  });
  await startJob("js-keyed");
  await send("js-plain", "gateway.job-plain");
  await settle(env, system);
  expect(keyed).toBe(2);
  expect(await jobRow("js-keyed")).toMatchObject({ status: "awaiting_job", body: { handle: { runId: "k" } } });
  expect(await probe("js-keyed").outcomes()).toEqual([]);
  expect(plain).toBe(1);
  expect(await probe("js-plain").outcomes()).toMatchObject([{ key: "js-plain", status: "in_doubt", error: "gateway flaked" }]);
});

it("[job-probe-timeout] a probe that hangs is cut off at the effect's timeout, and the job keeps waiting", async () => {
  overrideEffectBudget("gateway.job", { timeoutMs: 20 });
  overrideEffect("gateway.job", { start: async () => ({ runId: "slow" }), probe: () => new Promise(() => {}) });
  await startJob("jt");
  await settle(env, system);
  await probeDue("jt");
  const log = vi.spyOn(console, "log");
  const before = Date.now();
  await settle(env, system);
  const events = logged(log);
  log.mockRestore();
  expect(events.find((e) => e.kind === "job.probed" && e.effectKey === "jt")).toMatchObject({ reason: "probe timed out after 20ms" });
  const row = await jobRow("jt");
  expect(row).toMatchObject({ status: "awaiting_job" });
  expect(row!.nextAt).toBeGreaterThanOrEqual(before + 60_000);
});

it("[job-cancel-restart] a cancel cut off by a restart is issued again", async () => {
  let cancels = 0;
  overrideEffect("gateway.job", { start: async () => ({ runId: "c" }), cancel: () => { cancels++; return new Promise<boolean>(() => {}); } });
  await startJob("jcr");
  await settle(env, system);
  await cancelJob("jcr"); // the cancel hangs until the crash below
  expect(await jobRow("jcr")).toMatchObject({ status: "cancelling" });
  await abortAllDurableObjects();
  overrideEffect("gateway.job", { start: async () => ({ runId: "c" }), cancel: async () => { cancels++; return true; } });
  await settle(env, system);
  expect(cancels).toBe(2);
  expect(await probe("jcr").outcomes()).toMatchObject([{ key: "jcr", status: "failed", error: "cancelled" }]);
});

it("[job-events] job.started carries the handle, and the settling event says what settled it", async () => {
  const log = vi.spyOn(console, "log");
  overrideEffect("gateway.job", { start: async () => ({ runId: "ev" }) });
  await startJob("jev");
  await settle(env, system);
  await jobDone("jev");
  await settle(env, system);
  const events = logged(log);
  log.mockRestore();
  expect(events.find((e) => e.kind === "job.started" && e.effectKey === "jev")).toMatchObject({ effect: "gateway.job", detail: { handle: { runId: "ev" } } });
  expect(events.find((e) => e.kind === "effect.confirmed" && e.effectKey === "jev")).toMatchObject({ detail: { settledBy: "message" } });
});

it("[job-arms-alarm] a waiting job holds actord's wake at its next look", async () => {
  overrideEffect("gateway.job", { start: async () => ({ runId: "w" }) });
  await startJob("jw");
  await settle(env, system);
  const row = await jobRow("jw");
  const wake = await runInDurableObject(probe("jw"), (_i, s) => s.storage.sql.exec<{ time: number }>("SELECT time FROM cf_agents_jobs WHERE capability = 'actord'").toArray()[0]?.time);
  // The probe period (1m) is nearer than the deadline (1h) and the hourly schedule, so it sets the wake.
  expect(wake).toBe(row!.nextAt);
});

it("[job-probe-in-flight] a look that comes due while a probe still runs books the next one, not an immediate wake", async () => {
  overrideEffectBudget("gateway.job", { timeoutMs: 150 });
  let probes = 0;
  overrideEffect("gateway.job", { start: async () => ({ runId: "busy" }), probe: () => { probes++; return new Promise(() => {}); } });
  await startJob("jpf");
  await settle(env, system);
  await probeDue("jpf");
  await settle(env, system, { rounds: 1 }); // the probe starts, and hangs
  await probeDue("jpf"); // its next look is due while it still runs
  const before = Date.now();
  await settle(env, system, { rounds: 1 });
  expect(probes).toBe(1);
  // Left in the past, next_at would hold actord's wake there and re-fire the alarm until the probe ends.
  expect((await jobRow("jpf"))!.nextAt).toBeGreaterThanOrEqual(before + 60_000);
  await settle(env, system); // let the hung probe reach its timeout
});

it("[job-cancel-during-probe] a cancel asked for while a probe runs is still issued", async () => {
  overrideEffectBudget("gateway.job", { timeoutMs: 150 });
  let cancels = 0;
  overrideEffect("gateway.job", { start: async () => ({ runId: "cp" }), probe: () => new Promise(() => {}), cancel: async () => { cancels++; return true; } });
  await startJob("jcp");
  await settle(env, system);
  await probeDue("jcp");
  await settle(env, system, { rounds: 1 }); // the probe starts, and hangs
  await cancelJob("jcp");
  await settle(env, system);
  expect(cancels).toBe(1);
  expect(await probe("jcp").outcomes()).toMatchObject([{ key: "jcp", status: "failed", error: "cancelled" }]);
});

/** Hold a failed attempt's retry back until settle() releases it: the real alarm would otherwise retry in 40 ms. */
const holdRetries = () => {
  (globalThis as { __probeBackoffMs?: number }).__probeBackoffMs = 3_600_000;
  return () => void delete (globalThis as { __probeBackoffMs?: number }).__probeBackoffMs;
};
const resultRows = (key: string) =>
  runInDurableObject(probe(key), (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox WHERE kind = 'message' AND body LIKE '%probe.outcome%'").one().n);

it("[job-early-completion] a completion that arrives while the start waits to be retried settles the job once it starts", async () => {
  const release = holdRetries();
  try {
    let starts = 0;
    let probes = 0;
    overrideEffect("gateway.job", {
      start: async () => {
        if (++starts === 1) throw new Error("acknowledgment lost");
        return { runId: "early" };
      },
      probe: async () => {
        probes++;
        return { done: false };
      },
    });
    await startJob("je");
    await settle(env, system, { deliver: false }); // the first start fails; the key makes a retry safe, later
    expect(await jobRow("je")).toMatchObject({ status: "pending" });
    await jobDone("je");
    await jobDone("je", false); // a second completion: the first one recorded wins
    expect(await probe("je").settled()).toEqual([{ key: "je", ok: true }, { key: "je", ok: false }]);
    expect(await probe("je").outcomes()).toEqual([]);
    await settle(env, system); // the retried start succeeds, and the recorded completion settles the job at once
    expect(starts).toBe(2);
    expect(probes).toBe(0);
    expect(await probe("je").outcomes()).toMatchObject([{ key: "je", status: "confirmed" }]);
    expect(await jobRow("je")).toMatchObject({ status: "confirmed", body: { settledBy: "message", handle: { runId: "early" }, outcome: { finished: true } } });
    expect(await resultRows("je")).toBe(1);
  } finally {
    release();
  }
});

it("[job-early-completion-wins] a completion recorded while the start runs wins over that start failing, or being retried", async () => {
  const release = holdRetries();
  try {
    let openA!: () => void;
    let openB!: () => void;
    const gateA = new Promise<void>((r) => (openA = r));
    const gateB = new Promise<void>((r) => (openB = r));
    let startsB = 0;
    overrideEffect("gateway.job", {
      start: async (input, c) => {
        if ((input as { key: string }).key === "jea") {
          await gateA;
          throw new EffectRejected("refused after all");
        }
        if (++startsB === 1) {
          c.reportUsage({ inputTokens: 4 }); // so the retry rewrites the row body
          await gateB;
          throw new Error("acknowledgment lost");
        }
        return { runId: "b" };
      },
    });
    await startJob("jea");
    await startJob("jeb");
    await jobDone("jea");
    await jobDone("jeb");
    expect(await probe("jea").settled()).toEqual([{ key: "jea", ok: true }]);
    expect(await probe("jeb").settled()).toEqual([{ key: "jeb", ok: true }]);
    openA();
    openB();
    await settle(env, system);
    // A: the start was refused, but the completion message is direct evidence the work ran.
    expect(await probe("jea").outcomes()).toMatchObject([{ key: "jea", status: "confirmed" }]);
    expect(await jobRow("jea")).toMatchObject({ status: "confirmed", body: { settledBy: "message" } });
    // B: the recorded completion survived the retry and settled the job when the second start succeeded.
    expect(startsB).toBe(2);
    expect(await probe("jeb").outcomes()).toMatchObject([{ key: "jeb", status: "confirmed", usage: { inputTokens: 4 } }]);
    expect(await resultRows("jeb")).toBe(1);
  } finally {
    release();
  }
});

it("[job-settle-while-cancelling] a completion that arrives while a cancel is pending settles the job, and the cancel's answer is dropped", async () => {
  // Made here, in the test's context: a promise made inside the adapter belongs to the Durable Object, and resolving it from the test is refused as cross-object I/O.
  let answer!: (confirmed: boolean) => void;
  const reply = new Promise<boolean>((r) => (answer = r));
  let cancels = 0;
  overrideEffect("gateway.job", {
    start: async () => ({ runId: "sc" }),
    cancel: () => {
      cancels++;
      return reply;
    },
  });
  await startJob("jsc");
  await settle(env, system);
  await cancelJob("jsc");
  await jobDone("jsc");
  expect(await probe("jsc").settled()).toEqual([{ key: "jsc", ok: true }]);
  expect(await jobRow("jsc")).toMatchObject({ status: "confirmed", body: { settledBy: "message" } });
  answer(true); // the cancel confirms, after the job already settled
  await settle(env, system); // waits until the cancel's answer has been handled (settle counts it in flight)
  expect(cancels).toBe(1);
  expect(await jobRow("jsc")).toMatchObject({ status: "confirmed", body: { settledBy: "message" } });
  expect(await probe("jsc").outcomes()).toMatchObject([{ key: "jsc", status: "confirmed" }]);
  expect(await resultRows("jsc")).toBe(1);
});

it("[job-early-completion-approval] a completion that arrives while the job awaits approval settles it once it is approved and starts", async () => {
  let starts = 0;
  overrideEffect("gateway.job-approval", {
    start: async () => {
      starts++;
      return { runId: "ap" };
    },
  });
  await send("jap", "gateway.job-approval");
  await settle(env, system);
  expect(await jobRow("jap", "gateway.job-approval")).toMatchObject({ status: "awaiting_approval" });
  await ingress(env, system, "Probe", "probe.job.done", { key: "jap", ok: true, effect: "gateway.job-approval" }, { key: "jap" });
  expect(await probe("jap").settled()).toEqual([{ key: "jap", ok: true }]);
  expect(starts).toBe(0); // kept, not run: a person still has to approve it
  expect(await probe("jap").decide("jap", "approve")).toMatchObject({ status: "confirmed", value: { finished: true } });
  await settle(env, system);
  expect(starts).toBe(1);
  expect(await probe("jap").outcomes()).toMatchObject([{ key: "jap", status: "confirmed" }]);
  expect(await jobRow("jap", "gateway.job-approval")).toMatchObject({ status: "confirmed", body: { settledBy: "message", handle: { runId: "ap" } } });
  expect(await resultRows("jap")).toBe(1);
});

it("[job-early-completion-denied] a denial overrides a completion kept while the job awaited approval", async () => {
  let starts = 0;
  overrideEffect("gateway.job-approval", {
    start: async () => {
      starts++;
      return { runId: "dn" };
    },
  });
  await send("jdn", "gateway.job-approval");
  await settle(env, system);
  await ingress(env, system, "Probe", "probe.job.done", { key: "jdn", ok: true, effect: "gateway.job-approval" }, { key: "jdn" });
  expect(await probe("jdn").settled()).toEqual([{ key: "jdn", ok: true }]);
  expect(await probe("jdn").decide("jdn", "deny")).toMatchObject({ status: "denied" });
  await settle(env, system);
  expect(starts).toBe(0);
  expect(await jobRow("jdn", "gateway.job-approval")).toMatchObject({ status: "denied", body: { earlyOutcome: { status: "confirmed" } } });
  expect(await probe("jdn").outcomes()).toEqual([]); // a denied effect sends no result, kept completion or not
  expect(await resultRows("jdn")).toBe(0);
});

it("[job-early-completion-orphan] an unkeyed start cut off by a restart settles by the completion kept for it, not in doubt", async () => {
  let starts = 0;
  overrideEffect("gateway.job-plain", { start: () => { starts++; return new Promise(() => {}); } }); // hangs until the crash below
  await send("jeo", "gateway.job-plain");
  await ingress(env, system, "Probe", "probe.job.done", { key: "jeo", ok: true, effect: "gateway.job-plain" }, { key: "jeo" });
  expect(await probe("jeo").settled()).toEqual([{ key: "jeo", ok: true }]);
  await abortAllDurableObjects();
  await settle(env, system); // the new instance recovers the orphaned start
  expect(starts).toBe(1);
  expect(await probe("jeo").outcomes()).toMatchObject([{ key: "jeo", status: "confirmed" }]);
  expect(await jobRow("jeo", "gateway.job-plain")).toMatchObject({ status: "confirmed", body: { settledBy: "message" } });
});

it("[effect-key-reuse] a reused key runs the effect once and records a duplicate request", async () => {
  const events = captureEvents();
  let runs = 0;
  overrideEffect("gateway.keyed", { run: async () => ++runs });
  await send("reuse", "gateway.keyed");
  await settle(env, system);
  await ingress(env, system, "Probe", "probe.effect", { effect: "gateway.keyed", key: "reuse" }, { key: "reuse" });
  await settle(env, system);
  expect(runs).toBe(1);
  expect(events.filter((e) => e.kind === "effect.requested" && e.effectKey === "reuse")).toHaveLength(1);
  const dup = events.filter((e) => e.kind === "effect.duplicate" && e.effectKey === "reuse");
  expect(dup).toMatchObject([{ effect: "gateway.keyed", detail: { existingStatus: "confirmed" } }]);
  const first = events.find((e) => e.kind === "effect.requested" && e.effectKey === "reuse")!;
  expect(dup[0]!.detail?.firstCausationId).toBe(first.causationId);
  expect(dup[0]!.causationId).not.toBe(first.causationId);
});

it("[effect-key-reuse-after-settled] a key whose effect ended in doubt is still a duplicate", async () => {
  const events = captureEvents();
  let runs = 0;
  overrideEffect("gateway.plain", {
    run: async () => {
      runs++;
      throw new Error("connection dropped after send");
    },
  });
  await send("reuse-doubt", "gateway.plain");
  await settle(env, system);
  expect(await probe("reuse-doubt").outcomes()).toMatchObject([{ key: "reuse-doubt", status: "in_doubt" }]);
  await send("reuse-doubt", "gateway.plain");
  await settle(env, system);
  expect(runs).toBe(1);
  expect(events.filter((e) => e.kind === "effect.duplicate" && e.effectKey === "reuse-doubt")).toMatchObject([{ detail: { existingStatus: "in_doubt" } }]);
  expect(events.filter((e) => e.kind === "effect.requested" && e.effectKey === "reuse-doubt")).toHaveLength(1);
});

it("[effect-key-reuse-same-handler] two requests for one key in one handler run once and record one duplicate", async () => {
  const events = captureEvents();
  let runs = 0;
  overrideEffect("gateway.keyed", { run: async () => ++runs });
  await ingress(env, system, "Probe", "probe.effect", { effect: "gateway.keyed", key: "twice", twice: true }, { key: "twice" });
  await settle(env, system);
  expect(runs).toBe(1);
  expect(events.filter((e) => e.kind === "effect.requested" && e.effectKey === "twice")).toHaveLength(1);
  expect(events.filter((e) => e.kind === "effect.duplicate" && e.effectKey === "twice")).toMatchObject([{ detail: { existingStatus: "pending" } }]);
});

it("[effect-key-reuse-rollback] a handler that requests a used key and then throws leaves no duplicate event", async () => {
  const events = captureEvents();
  overrideEffect("gateway.keyed", { run: async () => 1 });
  await send("rb", "gateway.keyed");
  await settle(env, system);
  const rows = () => runInDurableObject(probe("rb"), (_i, s) => s.storage.sql.exec("SELECT id, status FROM _actors_outbox ORDER BY id").toArray());
  const before = await rows();
  const r = await ingress(env, system, "Probe", "probe.effect", { effect: "gateway.keyed", key: "rb", fail: true }, { key: "rb" });
  expect(r).toMatchObject({ status: "failed" });
  await settle(env, system);
  expect(events.filter((e) => e.kind === "effect.duplicate" && e.effectKey === "rb")).toHaveLength(0);
  expect(await rows()).toEqual(before);
});

it("[effect-key-reuse-job] a job key requested again is a duplicate attributed to the message that started it", async () => {
  const events = captureEvents();
  let starts = 0;
  overrideEffect("gateway.job", { start: async () => ({ runId: `r-${++starts}` }) });
  await ingress(env, system, "Probe", "probe.job.start", { key: "jdup" }, { key: "jdup", id: "job-first" });
  await settle(env, system);
  expect(await jobRow("jdup")).toMatchObject({ status: "awaiting_job" });
  await ingress(env, system, "Probe", "probe.job.start", { key: "jdup" }, { key: "jdup", id: "job-second" });
  await settle(env, system);
  expect(starts).toBe(1);
  expect(events.filter((e) => e.kind === "effect.requested" && e.effectKey === "jdup")).toHaveLength(1);
  expect(events.filter((e) => e.kind === "effect.duplicate" && e.effectKey === "jdup")).toMatchObject([{ causationId: "job-second", detail: { existingStatus: "awaiting_job", firstCausationId: "job-first" } }]);
});

it("[approval-expiry] an approval nobody answers expires and the actor hears it failed", async () => {
  const events = captureEvents();
  overrideEffect("gateway.approval", { run: async () => "ran" });
  await send("exp", "gateway.approval");
  await settle(env, system);
  await expireApprovals(env, system, "Probe", "exp");
  await settle(env, system);
  expect(await probe("exp").outcomes()).toMatchObject([{ key: "exp", status: "failed", error: "approval expired" }]);
  expect(events.find((e) => e.kind === "effect.denied" && e.effectKey === "exp")).toMatchObject({ reason: "approval expired" });
});

it("[approval-expiry-wake] a parked approval holds the alarm until it expires, and an unexpired one is left alone", async () => {
  overrideEffect("gateway.approval", { run: async () => "ran" });
  await send("wake", "gateway.approval");
  await settle(env, system);
  const row = await runInDurableObject(probe("wake"), (_i, s) => s.storage.sql.exec("SELECT status, next_at FROM _actors_outbox WHERE id LIKE 'fx:%:wake'").one());
  expect(row.status).toBe("awaiting_approval");
  expect(Number(row.next_at) - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
  const alarm = await runInDurableObject(probe("wake"), (_i, s) => s.storage.getAlarm());
  expect(alarm).not.toBeNull();
  expect(alarm!).toBeLessThanOrEqual(Number(row.next_at));
  await settle(env, system);
  expect(await probe("wake").outcomes()).toEqual([]);
});

it("[approval-identity] an approval records who approved and through which sender", async () => {
  const events = captureEvents();
  overrideEffect("gateway.approval", { run: async () => "ran" });
  await send("who", "gateway.approval");
  await settle(env, system);
  await ingress(env, system, "Probe", "probe.approve", { key: "who", by: "owner@example.com" }, { key: "who" });
  await settle(env, system);
  expect(events.find((e) => e.kind === "note" && e.effectKey === "who")).toMatchObject({ detail: { by: "owner@example.com", via: "@ingress" } });
  const body = await runInDurableObject(probe("who"), (_i, s) => JSON.parse(String(s.storage.sql.exec("SELECT body FROM _actors_outbox WHERE id LIKE 'fx:%:who'").one().body)));
  expect(body.approvedBy).toMatchObject({ from: "@ingress", by: "owner@example.com" });
  expect(typeof body.approvedBy.messageId).toBe("string");
});

it("[denial-identity] a denial records who denied and through which sender", async () => {
  const events = captureEvents();
  overrideEffect("gateway.approval", { run: async () => "ran" });
  await send("nay", "gateway.approval");
  await settle(env, system);
  await ingress(env, system, "Probe", "probe.deny", { key: "nay", by: "owner@example.com" }, { key: "nay" });
  await settle(env, system);
  expect(events.find((e) => e.kind === "effect.denied" && e.effectKey === "nay")).toMatchObject({ reason: "not today", detail: { by: "owner@example.com", via: "@ingress" } });
});

it("[approval-identity-rpc] decide() records the person through the RPC sender", async () => {
  const events = captureEvents();
  overrideEffect("gateway.approval", { run: async () => "ran" });
  await send("rpc-ap", "gateway.approval");
  await send("rpc-no", "gateway.approval");
  await settle(env, system);
  await probe("rpc-ap").decide("rpc-ap", "approve");
  await probe("rpc-no").decide("rpc-no", "deny");
  expect(events.find((e) => e.kind === "note" && e.effectKey === "rpc-ap")).toMatchObject({ detail: { via: "@rpc" } });
  expect(events.find((e) => e.kind === "effect.denied" && e.effectKey === "rpc-no")).toMatchObject({ detail: { via: "@rpc" } });
});

it("[approve-after-expiry] approving after expiry does nothing and the effect never runs", async () => {
  let runs = 0;
  overrideEffect("gateway.approval", { run: async () => ++runs });
  await send("late-ap", "gateway.approval");
  await settle(env, system);
  await expireApprovals(env, system, "Probe", "late-ap");
  await ingress(env, system, "Probe", "probe.approve", { key: "late-ap", by: "owner@example.com" }, { key: "late-ap" });
  await settle(env, system);
  expect(await probe("late-ap").approvals()).toEqual([{ key: "late-ap", ok: false }]);
  expect(runs).toBe(0);
});

it("[approval-expiry-job] an expired job approval is a denial even when a completion was kept", async () => {
  let starts = 0;
  overrideEffect("gateway.job-approval", { run: async () => ({ handle: `h${++starts}` }) } as never);
  await send("job-exp", "gateway.job-approval");
  await settle(env, system);
  await ingress(env, system, "Probe", "probe.job.done", { key: "job-exp", ok: true, effect: "gateway.job-approval" }, { key: "job-exp" });
  await expireApprovals(env, system, "Probe", "job-exp");
  await settle(env, system);
  expect(starts).toBe(0);
  expect(await probe("job-exp").outcomes()).toMatchObject([{ key: "job-exp", status: "failed", error: "approval expired" }]);
});

it("[decide-cold] decide() on a freshly aborted instance recovers orphans first", async () => {
  let runs = 0;
  overrideEffect("gateway.approval", { run: async () => ++runs });
  overrideEffect("gateway.keyed", { run: () => new Promise(() => {}) }); // hangs until the crash below
  await send("cold", "gateway.approval");
  await send("cold", "gateway.keyed");
  await settle(env, system, { rounds: 2 });
  await abortAllDurableObjects(); // a crash: the keyed attempt is orphaned on a cold instance
  let keyedRuns = 0;
  overrideEffect("gateway.keyed", { run: async () => ++keyedRuns });
  // The first call the new instance gets is decide(), not a message.
  expect(await probe("cold").decide("cold", "approve")).toMatchObject({ status: "confirmed", value: 1 });
  // Before anything else drives the instance: decide() itself recovered the orphan and its drain re-ran it.
  expect(runs).toBe(1);
  expect(keyedRuns).toBe(1);
});

it("[approve-before-alarm] a late approval or decision is refused even before the alarm expires the request", async () => {
  let runs = 0;
  overrideEffect("gateway.approval", { run: async () => ++runs });
  for (const k of ["early-ap", "early-rpc"]) {
    await send(k, "gateway.approval");
    await settle(env, system);
    await runInDurableObject(probe(k), (_i, s) => { s.storage.sql.exec("UPDATE _actors_outbox SET next_at = ? WHERE status = 'awaiting_approval'", Date.now() - 1000); });
  }
  await ingress(env, system, "Probe", "probe.approve", { key: "early-ap", by: "owner@example.com" }, { key: "early-ap" });
  expect(await probe("early-rpc").decide("early-rpc", "approve")).toMatchObject({ status: "denied", error: "approval expired" });
  await expireApprovals(env, system, "Probe", "early-ap");
  await settle(env, system);
  expect(await probe("early-ap").approvals()).toEqual([{ key: "early-ap", ok: false }]);
  expect(runs).toBe(0);
  expect(await probe("early-ap").outcomes()).toMatchObject([{ key: "early-ap", status: "failed", error: "approval expired" }]);
  expect(await probe("early-rpc").outcomes()).toMatchObject([{ key: "early-rpc", status: "failed", error: "approval expired" }]);
});
