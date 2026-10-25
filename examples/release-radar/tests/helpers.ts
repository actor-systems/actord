import { overrideEffect } from "actors-toolkit/testing";
import feed from "../fixtures/feeds/workers-sdk.json";
import type { FeedItem } from "../src/messages/index.ts";

export const FEED_URL = "https://feeds.example.test/workers-sdk.json";
export const items: FeedItem[] = feed.items;

/** Serve feeds from fixtures and record notifications instead of sending them. Returns the notification log. */
export function useFixtures(feeds: Record<string, FeedItem[]> = { [FEED_URL]: items }): string[] {
  const notified: string[] = [];
  overrideEffect("feed.fetch", {
    async run(input) {
      return { items: feeds[(input as { url: string }).url] ?? [] };
    },
  });
  overrideEffect("notify.digest", {
    async run(_input, { key }) {
      notified.push(key);
      return { accepted: true };
    },
  });
  return notified;
}
