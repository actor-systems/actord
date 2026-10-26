import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { deriveId, ingress } from "../src/runtime/index.ts";
import { nextDue } from "../src/runtime/schedules.ts";
import { fireTimers, overrideEffect, resetSeams, settle, tick } from "../src/testing.ts";
import { system } from "./src/index.ts";

afterEach(() => resetSeams());
const probe = (key: string) => env.PROBE.getByName(key);
const send = (key: string, effect: "gateway.reconcilable" | "gateway.plain" | "gateway.approval" | "gateway.keyed") =>
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

const setTimer = (key: string, tk: string, delayMs: number, fail = false) =>
  ingress(env, system, "Probe", "probe.timer.set", { key: tk, delayMs, ...(fail ? { fail } : {}) }, { key });

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

it("[timer-replace] setting the same key again replaces the pending timer", async () => {
  await setTimer("tm5", "t5", 60_000);
  await setTimer("tm5", "t5", 90_000);
  expect(await fireTimers(env, system, "Probe", "tm5")).toBe(1);
  expect(await probe("tm5").fired()).toEqual(["t5"]);
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
