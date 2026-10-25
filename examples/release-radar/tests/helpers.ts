import { overrideEffect } from "@actord/toolkit/testing";
import feed from "../fixtures/feeds/workers-sdk.json";
import type { FeedItem } from "../src/messages/index.ts";

// Durable Object storage persists across the tests in one file (each file starts empty), and effects
// dedupe by key per instance: give each test its own instance keys and ids. An instance every test
// shares, such as one at `main`, keeps what earlier tests left: assert only on what this test added.

export const FEED_URL = "https://feeds.example.test/workers-sdk.json";
export const items: FeedItem[] = feed.items;

/**
 * Serve feeds from fixtures and record notifications instead of sending them. Returns the notification log.
 * A later call replaces both, so read the log the last call returned.
 */
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
