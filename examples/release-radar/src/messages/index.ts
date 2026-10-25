import { message } from "actors-toolkit/system";
import { z } from "zod";

const FeedItem = z.object({
  itemId: z.string().min(1),
  title: z.string(),
  version: z.string(),
  url: z.string().url(),
  publishedAt: z.string(),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const FeedWatch = message({
  version: 1,
  description: "Start watching a feed (from the Worker's HTTP entry point)",
  payload: z.object({ feedId: z.string().min(1), url: z.string().url() }),
});

export const FeedPollDue = message({
  version: 1,
  description: "The schedule says it's time to poll",
  payload: z.object({ at: z.number() }),
});

export const FeedFetched = message({
  version: 1,
  description: "Outcome of the feed.fetch effect, delivered back to the poller",
  payload: z.object({
    key: z.string(),
    status: z.enum(["confirmed", "failed", "in_doubt"]),
    value: z.object({ items: z.array(FeedItem) }).optional(),
    error: z.string().optional(),
  }),
});

export const ReleaseObserved = message({
  version: 1,
  description: "A feed item was seen (possibly again)",
  payload: FeedItem.extend({ feedId: z.string() }),
});

export const ReleaseSignificant = message({
  version: 1,
  description: "A newly seen release matches a significance rule",
  payload: z.object({
    feedId: z.string(),
    itemId: z.string(),
    title: z.string(),
    version: z.string(),
    severity: z.enum(["major", "security"]),
    reason: z.string(),
  }),
});
