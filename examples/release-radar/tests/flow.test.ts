import { env } from "cloudflare:workers";
import { ingress } from "@actord/toolkit/runtime";
import { resetSeams, settle, tick } from "@actord/toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "../system.ts";
import { FEED_URL, useFixtures } from "./helpers.ts";

afterEach(() => resetSeams());

it("polls a feed, records each release once, and notifies once per significant release", async () => {
  const notified = useFixtures();
  const watch = await ingress(env, system, "FeedPoller", "feed.watch", { feedId: "workers-sdk", url: FEED_URL }, { key: "workers-sdk", id: "watch-workers-sdk" });
  expect(watch).toEqual({ status: "handled", messageId: "watch-workers-sdk" });

  expect(await tick(env, system, "FeedPoller", "workers-sdk")).toBe(true);
  await settle(env, system);

  expect(await env.RELEASE_LEDGER.getByName("main").releases()).toEqual([
    { item_id: "wsdk-4.150.0", version: "4.150.0", severity: null },
    { item_id: "wsdk-4.151.0-rc.1", version: "4.151.0-rc.1", severity: null },
    { item_id: "wsdk-4.151.1", version: "4.151.1", severity: "security" },
    { item_id: "wsdk-5.0.0", version: "5.0.0", severity: "major" },
  ]);
  expect((await env.DIGEST_WRITER.getByName("main").findings()).map((f) => f.item_id)).toEqual(["wsdk-4.151.1", "wsdk-5.0.0"]);
  expect(notified.sort()).toEqual(["wsdk-4.151.1", "wsdk-5.0.0"]);
  expect(await env.RELEASE_LEDGER.getByName("main").latest("workers-sdk")).toBe("5.0.0");
});
