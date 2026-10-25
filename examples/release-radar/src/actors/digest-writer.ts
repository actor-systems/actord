import { DurableObject } from "cloudflare:workers";
import { actorRuntime, type EffectAdapter, type Envelope } from "actors-toolkit/runtime";
import system from "../../system.ts";

/** Stand-in notification gateway: logs instead of sending. A real one must honor the idempotency key. */
const logGateway: EffectAdapter<{ title: string; severity: string }, { accepted: true }> = {
  async run(input, { key }) {
    console.log(`notify.digest ${key}: [${input.severity}] ${input.title}`);
    return { accepted: true };
  },
};

/** Keeps the findings and notifies once per finding. Separate from the ledger so notification retries never hold up ingest. */
export class DigestWriter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS findings (item_id TEXT PRIMARY KEY, title TEXT NOT NULL, version TEXT NOT NULL, severity TEXT NOT NULL, reason TEXT NOT NULL)",
    );
  }

  actor = actorRuntime(
    { ctx: this.ctx, env: this.env },
    system,
    "DigestWriter",
    {
      "release.significant": ({ payload }, ctx) => {
        ctx.sql.exec(
          "INSERT INTO findings (item_id, title, version, severity, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_id) DO NOTHING",
          payload.itemId,
          payload.title,
          payload.version,
          payload.severity,
          payload.reason,
        );
        ctx.effect("notify.digest", { title: payload.title, severity: payload.severity }, { key: payload.itemId });
      },
    },
    { effects: { "notify.digest": logGateway } },
  );

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  alarm() {
    return this.actor.alarm();
  }

  findings(): Array<{ item_id: string; severity: string; title: string }> {
    return this.ctx.storage.sql
      .exec<{ item_id: string; severity: string; title: string }>("SELECT item_id, severity, title FROM findings ORDER BY item_id")
      .toArray();
  }
}
