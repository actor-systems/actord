import { env } from "cloudflare:workers";
import { resetSeams, settle } from "@actord/toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "../system.ts";
import { analysis, board, decide, gateway, scriptedModel, submit } from "./helpers.ts";

afterEach(() => resetSeams());

it("[end-to-end] briefs the urgent item only after approval, files the routine one, and dismisses noise", async () => {
  const calls = scriptedModel({
    "Checkout API returning 500s": analysis("incident", "high", "Checkout has failed for 10 minutes."),
    "Quarterly report draft": analysis("fyi", "normal"),
    "50% off conference passes": analysis("noise", "low"),
  });
  const sent = gateway("accept");

  for (const [id, title] of [
    ["inc-1", "Checkout API returning 500s"],
    ["fyi-1", "Quarterly report draft"],
    ["spam-1", "50% off conference passes"],
  ] as const) {
    expect((await submit(id, title)).status).toBe("handled");
  }
  await settle(env, system);

  expect(calls.sort()).toEqual(["50% off conference passes", "Checkout API returning 500s", "Quarterly report draft"]);
  expect((await board()).map((r) => [r.item_id, r.status])).toEqual([
    ["fyi-1", "filed"],
    ["inc-1", "awaiting_approval"],
    ["spam-1", "dismissed"],
  ]);
  expect(sent).toEqual([]); // nothing leaves without a person's approval

  expect((await decide("inc-1", "approve")).status).toBe("handled");
  await settle(env, system);
  expect(sent).toEqual(["inc-1"]);
  const inc = (await board()).find((r) => r.item_id === "inc-1");
  expect(inc).toMatchObject({ status: "sent", category: "incident", priority: "high", summary: "Checkout has failed for 10 minutes." });
});

it("[duplicate-submission] the same item submitted twice is analyzed once", async () => {
  const calls = scriptedModel({ "Disk 91% full on db-2": analysis("incident", "normal") });
  await submit("dup-1", "Disk 91% full on db-2");
  await submit("dup-1", "Disk 91% full on db-2");
  await settle(env, system);
  expect(calls).toEqual(["Disk 91% full on db-2"]);
});
