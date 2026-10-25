import { message } from "actors-toolkit/system";
import { z } from "zod";

const ItemId = z.string().min(1).max(128);
const Outcome = z.enum(["confirmed", "failed", "in_doubt"]);

export const ItemSubmitted = message({
  version: 1,
  description: "Someone submitted an item for triage (from the Worker's HTTP entry point)",
  payload: z.object({ itemId: ItemId, source: z.string(), title: z.string().min(1).max(300), body: z.string().max(20_000) }),
});

export const ItemRouted = message({
  version: 1,
  description: "Intake hands a new item to its analyst",
  payload: z.object({ itemId: ItemId, source: z.string(), title: z.string(), body: z.string() }),
});

export const ItemCancelled = message({
  version: 1,
  description: "The submitter withdrew the item; any analysis in flight is now stale",
  payload: z.object({ itemId: ItemId, reason: z.string() }),
});

export const AnalysisCompleted = message({
  version: 1,
  description: "Outcome of the model.analyze effect, delivered back to the analyst (value is untrusted model output)",
  payload: z.object({ key: z.string(), status: Outcome, value: z.unknown().optional(), error: z.string().optional() }),
});

export const BriefingDecided = message({
  version: 1,
  description: "A person approved or refused sending a briefing",
  payload: z.object({ itemId: ItemId, decision: z.enum(["approve", "deny"]), by: z.string().min(1) }),
});

export const BriefingDelivery = message({
  version: 1,
  description: "Outcome of the notify.brief effect, delivered back to the analyst",
  payload: z.object({ key: z.string(), status: Outcome, value: z.unknown().optional(), error: z.string().optional() }),
});

export const BriefingStatus = z.enum(["analyzing", "cancelled", "needs_human", "dismissed", "filed", "awaiting_approval", "sending", "sent", "in_doubt", "denied"]);
export type BriefingStatus = z.infer<typeof BriefingStatus>;

export const BriefingUpdated = message({
  version: 1,
  description: "The latest status of one item, for the board",
  payload: z.object({
    itemId: ItemId,
    title: z.string(),
    status: BriefingStatus,
    category: z.string().optional(),
    priority: z.string().optional(),
    summary: z.string().optional(),
    reason: z.string().optional(),
  }),
});
