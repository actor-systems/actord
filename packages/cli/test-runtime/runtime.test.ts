import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { deriveId, ingress } from "../src/runtime/index.ts";
import { overrideEffect, resetSeams, settle } from "../src/testing.ts";
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

it("derived message ids are deterministic and position-sensitive", () => {
  expect(deriveId("m-1", "send", 0, "a.b", "X", "main")).toBe(deriveId("m-1", "send", 0, "a.b", "X", "main"));
  expect(deriveId("m-1", "send", 0, "a.b", "X", "main")).not.toBe(deriveId("m-1", "send", 1, "a.b", "X", "main"));
});
