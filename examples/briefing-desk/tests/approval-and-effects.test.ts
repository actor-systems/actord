import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Envelope } from "@actord/toolkit/runtime";
import { resetSeams, settle } from "@actord/toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "../system.ts";
import { analysis, decide, gateway, scriptedModel, status, submit } from "./helpers.ts";

afterEach(() => resetSeams());

async function urgent(itemId: string, title: string) {
  scriptedModel({ [title]: analysis("security", "high", `${title} needs attention`) });
  await submit(itemId, title);
  await settle(env, system);
}

const outbox = (itemId: string) =>
  runInDurableObject(env.ANALYST.getByName(itemId), (_i, s) =>
    s.storage.sql.exec("SELECT status, attempts FROM _actors_outbox WHERE kind = 'effect' AND target = 'notify.brief'").toArray(),
  );

it("[approval-required] an urgent briefing waits for a person; nothing is sent before", async () => {
  const sent = gateway("accept");
  await urgent("ap-1", "Leaked token in public repo");
  expect(await status("ap-1")).toBe("awaiting_approval");
  expect(await outbox("ap-1")).toEqual([{ status: "awaiting_approval", attempts: 0 }]);
  expect(sent).toEqual([]);
});

it("[approval-denied] a refused briefing is never sent", async () => {
  const sent = gateway("accept");
  await urgent("ap-2", "Unusual login from new country");
  await decide("ap-2", "deny", "on-call");
  await settle(env, system);
  expect(await status("ap-2")).toBe("denied");
  expect(await outbox("ap-2")).toEqual([{ status: "denied", attempts: 0 }]);
  expect(sent).toEqual([]);
});

it("[lost-ack-in-doubt] a briefing the gateway accepted but never acknowledged is reported in doubt and not resent", async () => {
  const sent = gateway("lost-ack");
  await urgent("ap-3", "Certificate expires tomorrow");
  await decide("ap-3", "approve");
  await settle(env, system);
  // The gateway has no idempotency key: one attempt, then honesty. Not "sent", not retried.
  expect(sent).toEqual(["ap-3"]);
  expect(await status("ap-3")).toBe("in_doubt");
  expect(await outbox("ap-3")).toEqual([{ status: "in_doubt", attempts: 1 }]);
});

it("[gateway-unreachable] a gateway that provably never received the briefing is retried, then reported failed", async () => {
  const sent = gateway("unreachable");
  await urgent("ap-4", "Backup job failed twice");
  await decide("ap-4", "approve");
  await settle(env, system);
  expect(sent.length).toBe(system.actors.Analyst.budget.maxAttempts);
  expect(await status("ap-4")).toBe("needs_human");
  expect(await outbox("ap-4")).toEqual([{ status: "failed", attempts: 2 }]);
});

it("[approval-required] a cancellation withdraws a briefing that was awaiting approval", async () => {
  const sent = gateway("accept");
  await urgent("ap-5", "Vendor contract renewal");
  const cancel = await env.ANALYST.getByName("ap-5").receive({
    v: 1,
    id: "cancel-ap-5",
    type: "item.cancelled",
    version: 1,
    from: "@ingress",
    to: "Analyst:ap-5",
    correlationId: "cancel-ap-5",
    causationId: null,
    attempt: 1,
    sentAt: 0,
    payload: { itemId: "ap-5", reason: "handled by phone" },
  } satisfies Envelope);
  expect(cancel.status).toBe("handled");
  await decide("ap-5", "approve"); // too late: nothing is awaiting approval any more
  await settle(env, system);
  expect(await status("ap-5")).toBe("cancelled");
  expect(sent).toEqual([]);
});
