import { DurableObject } from "cloudflare:workers";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import system from "../../system.ts";
import { httpFeedSource } from "../feeds.ts";

/** One instance per feed id. Polls on its schedule; the fetch is an effect, so it runs outside the handler's transaction. */
export class FeedPoller extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY CHECK (id = 1), feed_id TEXT NOT NULL, url TEXT NOT NULL)");
  }

  actor = actorRuntime(
    { ctx: this.ctx, env: this.env },
    system,
    "FeedPoller",
    {
      "feed.watch": ({ payload }, ctx) => {
        ctx.sql.exec(
          "INSERT INTO feed (id, feed_id, url) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET feed_id = excluded.feed_id, url = excluded.url",
          payload.feedId,
          payload.url,
        );
      },
      "feed.poll.due": ({ payload }, ctx) => {
        const feed = ctx.sql.exec<{ url: string }>("SELECT url FROM feed WHERE id = 1").toArray()[0];
        if (!feed) return ctx.note("not watching any feed yet");
        ctx.effect("feed.fetch", { url: feed.url }, { key: `poll-${payload.at}` });
      },
      "feed.fetched": ({ payload }, ctx) => {
        if (payload.status !== "confirmed" || !payload.value) {
          return ctx.note(`fetch ${payload.status}: ${payload.error ?? ""}; the next poll tries again`);
        }
        const feedId = ctx.sql.exec<{ feed_id: string }>("SELECT feed_id FROM feed WHERE id = 1").toArray()[0]?.feed_id ?? ctx.key;
        for (const item of payload.value.items) ctx.send("release.observed", { ...item, feedId });
      },
    },
    { effects: { "feed.fetch": httpFeedSource } },
  );

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  alarm() {
    return this.actor.alarm();
  }
}
