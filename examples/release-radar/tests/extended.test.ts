import { env } from "cloudflare:workers";
import type { Envelope } from "@actord/toolkit/runtime";
import { expect, it } from "vitest";

it("[extended][duplicate-delivery] fifty redeliveries of one message, concurrently, are handled once", async () => {
  const ledger = env.RELEASE_LEDGER.getByName("main");
  const envelope: Envelope = {
    v: 1,
    id: "storm-1",
    type: "release.observed",
    version: 1,
    from: "FeedPoller:storm",
    to: "ReleaseLedger:main",
    correlationId: "storm-1",
    causationId: null,
    attempt: 1,
    sentAt: 0,
    payload: { feedId: "storm", itemId: "storm-2.3.4", title: "storm 2.3.4", version: "2.3.4", url: "https://example.test/storm", publishedAt: "2026-10-01T00:00:00Z" },
  };
  const receipts = await Promise.all(Array.from({ length: 50 }, (_, i) => ledger.receive({ ...envelope, attempt: i + 1 })));
  expect(receipts.filter((r) => r.status === "handled")).toHaveLength(1);
  expect(receipts.filter((r) => r.status === "duplicate")).toHaveLength(49);
  expect((await ledger.releases()).filter((r) => r.item_id === "storm-2.3.4")).toHaveLength(1);
});
