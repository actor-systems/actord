import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import system from "../../system.ts";

export interface BoardRow {
  item_id: string;
  title: string;
  status: string;
  category: string | null;
  priority: string | null;
  summary: string | null;
  reason: string | null;
  updates: number;
}

/** The board: the latest status of every item. */
export class Desk extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS board (
      item_id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, category TEXT, priority TEXT, summary TEXT, reason TEXT,
      updates INTEGER NOT NULL)`);
  }

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "Desk", {
    "briefing.updated": ({ payload: p }, ctx) => {
      ctx.sql.exec(
        `INSERT INTO board (item_id, title, status, category, priority, summary, reason, updates) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (item_id) DO UPDATE SET title = excluded.title, status = excluded.status,
           category = COALESCE(excluded.category, board.category), priority = COALESCE(excluded.priority, board.priority),
           summary = COALESCE(excluded.summary, board.summary), reason = COALESCE(excluded.reason, board.reason), updates = board.updates + 1`,
        p.itemId,
        p.title,
        p.status,
        p.category ?? null,
        p.priority ?? null,
        p.summary ?? null,
        p.reason ?? null,
      );
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  board(): BoardRow[] {
    return this.ctx.storage.sql.exec<BoardRow & Record<string, string | number | null>>("SELECT * FROM board ORDER BY item_id").toArray();
  }
}
