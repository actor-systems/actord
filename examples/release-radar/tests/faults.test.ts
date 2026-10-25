import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { ingress } from "actors-toolkit/runtime";
import { injectFault, overrideEffect, resetSeams, settle, tick } from "actors-toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "../system.ts";
import type { FeedItem } from "../src/messages/index.ts";
import { useFixtures } from "./helpers.ts";

afterEach(() => resetSeams());

const item = (feed: string, version: string, title = `${feed} ${version}`): FeedItem => ({
  itemId: `${feed}-${version}`,
  title,
  version,
  url: `https://example.test/${feed}/${version}`,
  publishedAt: "2026-10-20T00:00:00Z",
});

async function watchAndPoll(feed: string, items: FeedItem[]) {
  const url = `https://feeds.example.test/${feed}.json`;
  const notified = useFixtures({ [url]: items });
  await ingress(env, system, "FeedPoller", "feed.watch", { feedId: feed, url }, { key: feed });
  await tick(env, system, "FeedPoller", feed);
  return notified;
}

it("[crash-before-mutation] a handler crash before any write is retried and handled once", async () => {
  injectFault({ actor: "ReleaseLedger", type: "release.observed", at: "before-handler", times: 1 });
  const notified = await watchAndPoll("crash-before", [item("crash-before", "2.0.0")]);
  await settle(env, system);
  const rows = (await env.RELEASE_LEDGER.getByName("main").releases()).filter((r) => r.item_id.startsWith("crash-before"));
  expect(rows).toEqual([{ item_id: "crash-before-2.0.0", version: "2.0.0", severity: "major" }]);
  expect(notified).toEqual(["crash-before-2.0.0"]);
});

it("[crash-after-mutation] a crash after the handler's writes rolls them back, so the retry classifies and forwards normally", async () => {
  // If the writes survived the crash, the retry would see "already recorded" and the major release
  // would never reach the digest. A finding and one notification prove the rollback.
  injectFault({ actor: "ReleaseLedger", type: "release.observed", at: "after-handler", times: 1 });
  const notified = await watchAndPoll("crash-after", [item("crash-after", "3.0.0")]);
  await settle(env, system);
  expect((await env.RELEASE_LEDGER.getByName("main").releases()).filter((r) => r.item_id.startsWith("crash-after"))).toHaveLength(1);
  expect((await env.DIGEST_WRITER.getByName("main").findings()).map((f) => f.item_id)).toContain("crash-after-3.0.0");
  expect(notified).toEqual(["crash-after-3.0.0"]);
});

it("[delivery-retry][restart] an undelivered message survives the sender's eviction and is delivered by the alarm", async () => {
  injectFault({ actor: "FeedPoller", type: "release.observed", at: "deliver", times: 1 });
  await watchAndPoll("evicted", [item("evicted", "1.4.0")]);
  await settle(env, system, { deliver: false }); // let the fetch effect finish; don't force the failed delivery
  const poller = env.FEED_POLLER.getByName("evicted");
  const pending = await runInDurableObject(poller, (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox WHERE status = 'pending'").one().n);
  expect(pending).toBe(1);
  await evictDurableObject(poller);
  await settle(env, system);
  expect((await env.RELEASE_LEDGER.getByName("main").releases()).map((r) => r.item_id)).toContain("evicted-1.4.0");
});

it("[retry-exhausted] a message that can't be delivered is dead-lettered after the attempt limit, not retried forever", async () => {
  injectFault({ actor: "ReleaseLedger", type: "release.significant", at: "deliver", times: 100 });
  await watchAndPoll("exhausted", [item("exhausted", "9.0.0")]);
  await settle(env, system);
  const dead = await runInDurableObject(env.RELEASE_LEDGER.getByName("main"), (_i, s) =>
    s.storage.sql.exec("SELECT status, attempts FROM _actors_outbox WHERE status = 'dead'").toArray(),
  );
  expect(dead).toEqual([{ status: "dead", attempts: 6 }]);
  expect((await env.DIGEST_WRITER.getByName("main").findings()).map((f) => f.item_id)).not.toContain("exhausted-9.0.0");
});

it("[lost-ack-idempotent] a notification accepted but unacknowledged is retried with the same key and reaches the owner once", async () => {
  const delivered = new Map<string, number>();
  let calls = 0;
  await watchAndPoll("lost-ack", [item("lost-ack", "7.0.0")]);
  overrideEffect("notify.digest", {
    async run(_input, { key }) {
      calls++;
      delivered.set(key, (delivered.get(key) ?? 0) + 1);
      if (calls === 1) throw new Error("gateway accepted the request, then the connection dropped");
      return { accepted: true };
    },
  });
  // The ledger already recorded the item above; replay the digest step by sending a fresh finding.
  await ingress(env, system, "FeedPoller", "feed.watch", { feedId: "lost-ack-2", url: "https://feeds.example.test/lost-ack-2.json" }, { key: "lost-ack-2" });
  overrideEffect("feed.fetch", { run: async () => ({ items: [item("lost-ack-2", "8.0.0")] }) });
  await tick(env, system, "FeedPoller", "lost-ack-2");
  await settle(env, system);
  // The gateway saw the key twice (the retry); it deduplicates by key, so the owner got one notification.
  expect(delivered.get("lost-ack-2-8.0.0")).toBe(2);
  const status = await runInDurableObject(env.DIGEST_WRITER.getByName("main"), (_i, s) =>
    s.storage.sql.exec("SELECT status FROM _actors_outbox WHERE id = 'fx:notify.digest:lost-ack-2-8.0.0'").one().status,
  );
  expect(status).toBe("confirmed");
});

it("[restart] state survives eviction of the ledger", async () => {
  await watchAndPoll("restart", [item("restart", "1.0.1")]);
  await settle(env, system);
  const ledger = env.RELEASE_LEDGER.getByName("main");
  const before = (await ledger.releases()).length;
  await evictDurableObject(ledger);
  expect((await ledger.releases()).length).toBe(before);
});
