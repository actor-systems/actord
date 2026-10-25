import { env } from "cloudflare:workers";
import { type Envelope, ingress } from "@actord/toolkit/runtime";
import { resetSeams, settle, tick } from "@actord/toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "../system.ts";
import { FEED_URL, useFixtures } from "./helpers.ts";

afterEach(() => resetSeams());

it("[duplicate-input] a later poll that sees the same items records nothing new and notifies no one again", async () => {
  const notified = useFixtures();
  await ingress(env, system, "FeedPoller", "feed.watch", { feedId: "workers-sdk", url: FEED_URL }, { key: "workers-sdk" });
  await tick(env, system, "FeedPoller", "workers-sdk");
  await settle(env, system);
  await tick(env, system, "FeedPoller", "workers-sdk");
  await settle(env, system);

  expect(await env.RELEASE_LEDGER.getByName("main").releases()).toHaveLength(4);
  expect(notified.sort()).toEqual(["wsdk-4.151.1", "wsdk-5.0.0"]);
});

it("[duplicate-delivery] a redelivered message (same id) is handled once", async () => {
  const ledger = env.RELEASE_LEDGER.getByName("main");
  const envelope: Envelope = {
    v: 1,
    id: "redelivered-1",
    type: "release.observed",
    version: 1,
    from: "FeedPoller:dup-feed",
    to: "ReleaseLedger:main",
    correlationId: "redelivered-1",
    causationId: null,
    attempt: 1,
    sentAt: Date.now(),
    payload: { feedId: "dup-feed", itemId: "dup-1.2.3", title: "dup 1.2.3", version: "1.2.3", url: "https://example.test/dup", publishedAt: "2026-10-01T00:00:00Z" },
  };
  expect(await ledger.receive(envelope)).toEqual({ status: "handled", messageId: "redelivered-1" });
  expect(await ledger.receive({ ...envelope, attempt: 2 })).toEqual({ status: "duplicate", messageId: "redelivered-1" });
  expect((await ledger.releases()).filter((r) => r.item_id === "dup-1.2.3")).toHaveLength(1);
});
