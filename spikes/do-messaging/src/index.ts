import { DurableObject } from "cloudflare:workers";

export interface Envelope {
  id: string;
  type: string;
  from: string;
  to: string;
  correlationId: string;
  causationId: string | null;
  payload: unknown;
}

export class Sender extends DurableObject<Env> {
  async send(payload: unknown, id = crypto.randomUUID()): Promise<{ accepted: boolean }> {
    const envelope: Envelope = {
      id,
      type: "spike.ping@1",
      from: "Sender",
      to: "Receiver",
      correlationId: id,
      causationId: null,
      payload,
    };
    return this.env.RECEIVER.getByName("only").receive(envelope);
  }

  async scheduleWake(delayMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  async alarm(): Promise<void> {
    await this.send({ wakeAt: Date.now() }, "wake-1");
  }
}

export class Receiver extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, body TEXT NOT NULL)",
    );
  }

  async receive(envelope: Envelope): Promise<{ accepted: boolean }> {
    // rowsWritten also counts index writes, so ask SQLite which row it actually inserted.
    const inserted = this.ctx.storage.sql
      .exec(
        "INSERT INTO inbox (id, type, body) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id",
        envelope.id,
        envelope.type,
        JSON.stringify(envelope),
      )
      .toArray();
    return { accepted: inserted.length === 1 };
  }

  async count(): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM inbox").one().n;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("spike");
  },
} satisfies ExportedHandler<Env>;
