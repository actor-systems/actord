import { defineSystem } from "actors-toolkit/system";
import { FeedFetched, FeedPollDue, FeedWatch, ReleaseObserved, ReleaseSignificant } from "./src/messages/index.ts";

export default defineSystem({
  name: "release-radar",
  description: "Polls release feeds, records what it has seen, and notifies the owner once per significant release",
  messages: {
    "feed.watch": FeedWatch,
    "feed.poll.due": FeedPollDue,
    "feed.fetched": FeedFetched,
    "release.observed": ReleaseObserved,
    "release.significant": ReleaseSignificant,
  },
  actors: {
    FeedPoller: {
      binding: "FEED_POLLER",
      kind: "deterministic",
      purpose: "Watches one feed (one instance per feed id) and reports every item it sees",
      justification: ["identity", "scheduling"],
      schedule: { every: "15m", message: "feed.poll.due" },
      effects: ["feed.fetch"],
    },
    ReleaseLedger: {
      binding: "RELEASE_LEDGER",
      kind: "deterministic",
      purpose: "Owns the record of every release seen; deduplicates and classifies new ones by rule",
      justification: ["state"],
    },
    DigestWriter: {
      binding: "DIGEST_WRITER",
      kind: "deterministic",
      purpose: "Records significant findings and notifies the owner once per finding",
      justification: ["state", "isolation"],
      effects: ["notify.digest"],
    },
  },
  effects: {
    "feed.fetch": {
      description: "Read a feed over HTTP (a read: safe to retry)",
      idempotency: "key",
      result: "feed.fetched",
    },
    "notify.digest": {
      description: "Send one finding to the owner through the notification gateway, deduplicated by item id",
      idempotency: "key",
    },
  },
  routes: [
    { from: "@ingress", message: "feed.watch", to: "FeedPoller" },
    { from: "@clock", message: "feed.poll.due", to: "FeedPoller" },
    { from: "FeedPoller", message: "feed.fetched", to: "FeedPoller" },
    { from: "FeedPoller", message: "release.observed", to: "ReleaseLedger" },
    { from: "ReleaseLedger", message: "release.significant", to: "DigestWriter" },
  ],
});
