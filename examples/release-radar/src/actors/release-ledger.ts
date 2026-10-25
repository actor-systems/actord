import { DurableObject } from "cloudflare:workers";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import system from "../../system.ts";
import { classify, compareVersions } from "../classify.ts";

/**
 * The single owner of release history. Delivery duplicates (the same message id) are dropped by the
 * runtime's inbox; seeing the same item again in a later poll is a business duplicate, handled here.
 */
export class ReleaseLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS releases (
      item_id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, version TEXT NOT NULL, title TEXT NOT NULL,
      severity TEXT, reason TEXT NOT NULL, first_seen_message TEXT NOT NULL)`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS latest (feed_id TEXT PRIMARY KEY, version TEXT NOT NULL)");
  }

  actor = actorRuntime({ ctx: this.ctx, env: this.env }, system, "ReleaseLedger", {
    "release.observed": ({ id, payload }, ctx) => {
      const seen = ctx.sql.exec("SELECT 1 FROM releases WHERE item_id = ?", payload.itemId).toArray().length > 0;
      if (seen) return ctx.note("already recorded", { itemId: payload.itemId });
      const c = classify(payload);
      ctx.sql.exec(
        "INSERT INTO releases (item_id, feed_id, version, title, severity, reason, first_seen_message) VALUES (?, ?, ?, ?, ?, ?, ?)",
        payload.itemId,
        payload.feedId,
        payload.version,
        payload.title,
        c.severity,
        c.reason,
        id,
      );
      // Out-of-order delivery is normal: the latest-version pointer only moves forward.
      const latest = ctx.sql.exec<{ version: string }>("SELECT version FROM latest WHERE feed_id = ?", payload.feedId).toArray()[0];
      if (!latest || compareVersions(payload.version, latest.version) > 0) {
        ctx.sql.exec(
          "INSERT INTO latest (feed_id, version) VALUES (?, ?) ON CONFLICT (feed_id) DO UPDATE SET version = excluded.version",
          payload.feedId,
          payload.version,
        );
      }
      if (c.severity) {
        ctx.send("release.significant", {
          feedId: payload.feedId,
          itemId: payload.itemId,
          title: payload.title,
          version: payload.version,
          severity: c.severity,
          reason: c.reason,
        });
      }
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  alarm() {
    return this.actor.alarm();
  }

  releases(): Array<{ item_id: string; version: string; severity: string | null }> {
    return this.ctx.storage.sql
      .exec<{ item_id: string; version: string; severity: string | null }>("SELECT item_id, version, severity FROM releases ORDER BY item_id")
      .toArray();
  }

  latest(feedId: string): string | null {
    return this.ctx.storage.sql.exec<{ version: string }>("SELECT version FROM latest WHERE feed_id = ?", feedId).toArray()[0]?.version ?? null;
  }
}
