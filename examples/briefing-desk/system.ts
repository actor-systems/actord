import { defineSystem } from "@actord/toolkit/system";
import {
  AnalysisCompleted,
  BriefingDecided,
  BriefingDelivery,
  BriefingUpdated,
  ItemCancelled,
  ItemRouted,
  ItemSubmitted,
} from "./src/messages/index.ts";

export default defineSystem({
  name: "briefing-desk",
  description: "Triage incoming items with a model, and brief the owner only on what matters, after a person approves",
  messages: {
    "item.submitted": ItemSubmitted,
    "item.routed": ItemRouted,
    "item.cancelled": ItemCancelled,
    "analysis.completed": AnalysisCompleted,
    "briefing.decided": BriefingDecided,
    "briefing.delivery": BriefingDelivery,
    "briefing.updated": BriefingUpdated,
  },
  actors: {
    Intake: {
      binding: "INTAKE",
      kind: "deterministic",
      purpose: "The only actor the outside world reaches: records submissions, drops repeats, and routes each new item to its analyst",
      justification: ["state", "permissions"],
    },
    Analyst: {
      binding: "ANALYST",
      kind: "model-assisted",
      purpose: "One per item: asks the model to classify and summarize, then decides whether the owner needs a briefing",
      justification: ["identity", "lifecycle", "isolation"],
      effects: ["model.analyze", "notify.brief"],
      budget: { maxAttempts: 2, timeoutMs: 30_000, maxTokens: 2048 },
    },
    Desk: {
      binding: "DESK",
      kind: "deterministic",
      purpose: "Owns the briefing board: the latest status of every item",
      justification: ["state"],
    },
  },
  effects: {
    "model.analyze": {
      description: "Ask the model for a category, priority, and summary (no side effects, so safe to retry)",
      idempotency: "key",
      result: "analysis.completed",
    },
    "notify.brief": {
      description: "Send a briefing to the owner's inbox through the outbound gateway, which accepts no idempotency key",
      idempotency: "none",
      approval: "human",
      result: "briefing.delivery",
    },
  },
  routes: [
    { from: "@ingress", message: "item.submitted", to: "Intake" },
    { from: "Intake", message: "item.routed", to: "Analyst" },
    { from: "@ingress", message: "item.cancelled", to: "Analyst" },
    { from: "@ingress", message: "briefing.decided", to: "Analyst" },
    { from: "Analyst", message: "analysis.completed", to: "Analyst" },
    { from: "Analyst", message: "briefing.delivery", to: "Analyst" },
    { from: "Analyst", message: "briefing.updated", to: "Desk" },
  ],
});
