// The feed.fetch effect adapter: reads a JSON feed ({ "items": [...] }) over HTTP.
// Tests replace it with fixtures through actors-toolkit/testing's overrideEffect().
import { type EffectAdapter, EffectNotDelivered } from "actors-toolkit/runtime";
import type { FeedItem } from "./messages/index.ts";

export const httpFeedSource: EffectAdapter<{ url: string }, { items: FeedItem[] }> = {
  async run({ url }, { signal }) {
    let res: Response;
    try {
      res = await fetch(url, { signal, headers: { accept: "application/json" } });
    } catch (err) {
      throw new EffectNotDelivered(`fetch ${url} failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new EffectNotDelivered(`fetch ${url}: HTTP ${res.status}`);
    const body = (await res.json()) as { items?: FeedItem[] };
    return { items: body.items ?? [] };
  },
};
