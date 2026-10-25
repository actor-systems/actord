import { DurableObject } from "cloudflare:workers";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import system from "../../system.ts";

/** Records submissions and routes each new item, once, to the analyst instance named by its id. */
export class Intake extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS submissions (item_id TEXT PRIMARY KEY, source TEXT NOT NULL, first_message TEXT NOT NULL)");
  }

  actor = actorRuntime({ ctx: this.ctx, env: this.env }, system, "Intake", {
    "item.submitted": ({ id, payload }, ctx) => {
      const seen = ctx.sql.exec("SELECT 1 FROM submissions WHERE item_id = ?", payload.itemId).toArray().length > 0;
      if (seen) return ctx.note("item already submitted; not routing it again", { itemId: payload.itemId });
      ctx.sql.exec("INSERT INTO submissions (item_id, source, first_message) VALUES (?, ?, ?)", payload.itemId, payload.source, id);
      ctx.send("item.routed", payload, { key: payload.itemId });
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  alarm() {
    return this.actor.alarm();
  }
}
