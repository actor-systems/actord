import { DurableObject } from "cloudflare:workers";
import { actorRuntime, type Envelope, type HandlerContext } from "@actord/toolkit/runtime";
import system from "../../system.ts";
import { webhookGateway } from "../gateway.ts";
import type { BriefingStatus } from "../messages/index.ts";
import { Analysis, anthropicModel } from "../model.ts";

interface Item {
  item_id: string;
  title: string;
  body: string;
  status: BriefingStatus;
  generation: number;
  category: string | null;
  priority: string | null;
  summary: string | null;
}

type Ctx = HandlerContext<typeof system, "Analyst">;

/**
 * One instance per item. The model call is an effect, so it runs outside the handler's transaction and a
 * cancellation can arrive while it's in flight. Each analysis request carries the item's generation; a
 * result for an older generation, or for an item no longer being analyzed, is stale and ignored.
 */
export class Analyst extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS item (
      item_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL,
      category TEXT, priority TEXT, summary TEXT)`);
  }

  actor = actorRuntime(
    { ctx: this.ctx, env: this.env },
    system,
    "Analyst",
    {
      "item.routed": ({ payload }, ctx) => {
        if (load(ctx)) return ctx.note("already analyzing this item");
        ctx.sql.exec("INSERT INTO item (item_id, title, body, status, generation) VALUES (?, ?, ?, 'analyzing', 1)", payload.itemId, payload.title, payload.body);
        ctx.effect("model.analyze", { title: payload.title, body: payload.body }, { key: `${payload.itemId}:g1` });
        update(ctx, { status: "analyzing" });
      },
      "item.cancelled": ({ payload }, ctx) => {
        const item = load(ctx);
        if (!item || !["analyzing", "awaiting_approval"].includes(item.status)) return ctx.note(`nothing to cancel (status ${item?.status ?? "unknown"})`);
        if (item.status === "awaiting_approval") ctx.deny("notify.brief", item.item_id, `cancelled: ${payload.reason}`);
        ctx.sql.exec("UPDATE item SET status = 'cancelled', generation = generation + 1");
        update(ctx, { status: "cancelled", reason: payload.reason });
      },
      "analysis.completed": ({ payload }, ctx) => {
        const item = load(ctx);
        const generation = Number(payload.key.split(":g")[1]);
        if (!item || item.status !== "analyzing" || generation !== item.generation) {
          return ctx.note(`stale analysis ignored (item ${item?.status ?? "missing"}, generation ${generation} vs ${item?.generation ?? "?"})`);
        }
        if (payload.status !== "confirmed") return needsHuman(ctx, `model ${payload.status}: ${payload.error ?? "no detail"}`);
        const parsed = Analysis.safeParse(payload.value);
        if (!parsed.success) return needsHuman(ctx, `model output failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
        const a = parsed.data;
        const status: BriefingStatus = a.category === "noise" ? "dismissed" : a.priority === "high" ? "awaiting_approval" : "filed";
        ctx.sql.exec("UPDATE item SET status = ?, category = ?, priority = ?, summary = ?", status, a.category, a.priority, a.summary);
        if (status === "awaiting_approval") ctx.effect("notify.brief", { itemId: item.item_id, title: item.title, summary: a.summary }, { key: item.item_id });
        update(ctx, { status, category: a.category, priority: a.priority, summary: a.summary, reason: a.rationale });
      },
      "briefing.decided": ({ payload }, ctx) => {
        const item = load(ctx);
        if (item?.status !== "awaiting_approval") return ctx.note(`no briefing awaiting approval (status ${item?.status ?? "unknown"})`);
        if (payload.decision === "approve") {
          ctx.approve("notify.brief", item.item_id);
          ctx.sql.exec("UPDATE item SET status = 'sending'");
          update(ctx, { status: "sending", reason: `approved by ${payload.by}` });
        } else {
          ctx.deny("notify.brief", item.item_id, `refused by ${payload.by}`);
          ctx.sql.exec("UPDATE item SET status = 'denied'");
          update(ctx, { status: "denied", reason: `refused by ${payload.by}` });
        }
      },
      "briefing.delivery": ({ payload }, ctx) => {
        // in_doubt: the gateway may or may not have delivered. Say so; never claim "sent" or resend blindly.
        const status: BriefingStatus = payload.status === "confirmed" ? "sent" : payload.status === "in_doubt" ? "in_doubt" : "needs_human";
        ctx.sql.exec("UPDATE item SET status = ?", status);
        update(ctx, { status, ...(payload.error ? { reason: payload.error } : {}) });
      },
    },
    {
      effects: {
        "model.analyze": anthropicModel(this.env, system.actors.Analyst.budget.maxTokens),
        "notify.brief": webhookGateway(this.env),
      },
    },
  );

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  alarm() {
    return this.actor.alarm();
  }

  item(): Item | null {
    return this.ctx.storage.sql.exec<Item & Record<string, string | number | null>>("SELECT * FROM item").toArray()[0] ?? null;
  }
}

function load(ctx: Ctx): Item | null {
  return ctx.sql.exec<Item & Record<string, string | number | null>>("SELECT * FROM item").toArray()[0] ?? null;
}

function needsHuman(ctx: Ctx, reason: string): void {
  ctx.sql.exec("UPDATE item SET status = 'needs_human'");
  update(ctx, { status: "needs_human", reason });
}

function update(ctx: Ctx, fields: { status: BriefingStatus; category?: string; priority?: string; summary?: string; reason?: string }): void {
  const item = load(ctx);
  ctx.send("briefing.updated", { itemId: item?.item_id ?? ctx.key, title: item?.title ?? "", ...fields });
}
