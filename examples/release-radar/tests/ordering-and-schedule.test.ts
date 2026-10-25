import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { ingress } from "@actord/toolkit/runtime";
import { resetSeams, settle, tick } from "@actord/toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "../system.ts";
import type { FeedItem } from "../src/messages/index.ts";
import { useFixtures } from "./helpers.ts";

afterEach(() => resetSeams());

const item = (feed: string, version: string): FeedItem => ({
  itemId: `${feed}-${version}`,
  title: `${feed} ${version}`,
  version,
  url: `https://example.test/${feed}/${version}`,
  publishedAt: "2026-10-20T00:00:00Z",
});

async function poll(feed: string, items: FeedItem[]) {
  const url = `https://feeds.example.test/${feed}.json`;
  useFixtures({ [url]: items });
  await ingress(env, system, "FeedPoller", "feed.watch", { feedId: feed, url }, { key: feed });
  await tick(env, system, "FeedPoller", feed);
  await settle(env, system);
}

it("[out-of-order] a late older release never moves the latest-version pointer backwards", async () => {
  await poll("ooo", [item("ooo", "6.1.0"), item("ooo", "6.0.1")]);
  const ledger = env.RELEASE_LEDGER.getByName("main");
  expect(await ledger.latest("ooo")).toBe("6.1.0");
  expect((await ledger.releases()).filter((r) => r.item_id.startsWith("ooo-")).map((r) => r.version)).toEqual(["6.0.1", "6.1.0"]);
});

it("[out-of-order] classification doesn't depend on arrival order", async () => {
  const versions = ["7.0.0", "7.0.1", "7.1.0-beta.1", "8.0.0"];
  await poll("asc", versions.map((v) => item("asc", v)));
  await poll("desc", [...versions].reverse().map((v) => item("desc", v)));
  const rows = await env.RELEASE_LEDGER.getByName("main").releases();
  const severities = (feed: string) => rows.filter((r) => r.item_id.startsWith(`${feed}-`)).map((r) => `${r.version}:${r.severity}`);
  expect(severities("asc")).toEqual(severities("desc"));
});

it("[scheduled-wake] watching a feed arms the poll alarm about 15 minutes ahead, and a wake re-arms it", async () => {
  useFixtures({});
  await ingress(env, system, "FeedPoller", "feed.watch", { feedId: "sched", url: "https://feeds.example.test/empty.json" }, { key: "sched" });
  const stub = env.FEED_POLLER.getByName("sched");
  const armed = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
  expect(armed).not.toBeNull();
  expect((armed as number) - Date.now()).toBeGreaterThan(14 * 60_000);
  await tick(env, system, "FeedPoller", "sched");
  const rearmed = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
  expect(rearmed).not.toBeNull();
});

it("[scheduled-wake] a forced wake is due now, as when the alarm fires on schedule, and each wake is distinct", async () => {
  const url = "https://feeds.example.test/now.json";
  useFixtures({ [url]: [] });
  await ingress(env, system, "FeedPoller", "feed.watch", { feedId: "now", url }, { key: "now" });
  const before = Date.now();
  await tick(env, system, "FeedPoller", "now");
  await tick(env, system, "FeedPoller", "now");
  // The poller keys each fetch by its wake's payload.at.
  const wakes = await runInDurableObject(env.FEED_POLLER.getByName("now"), (_i, s) =>
    s.storage.sql
      .exec<{ id: string }>("SELECT id FROM _actors_outbox WHERE id LIKE 'fx:feed.fetch:poll-%' ORDER BY seq")
      .toArray()
      .map((r) => Number(r.id.split("poll-")[1])),
  );
  expect(wakes).toHaveLength(2);
  expect(wakes[0]).toBeGreaterThanOrEqual(before);
  expect(wakes[1]).toBeGreaterThan(wakes[0]!);
});

it("[scheduled-wake] a wake before any feed is watched is a recorded no-op", async () => {
  useFixtures({});
  // A watched poller arms its schedule; force a wake on one that has a schedule but no feed row.
  const stub = env.FEED_POLLER.getByName("unwatched");
  await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT 1"));
  expect(await tick(env, system, "FeedPoller", "unwatched")).toBe(true);
  const effects = await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox").one().n);
  expect(effects).toBe(0);
});
