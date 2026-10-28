import { defineSystem } from "@actord/toolkit/system";
import { CiFinished, Kick, Ping, PingDue } from "./src/messages/index.ts";

export default defineSystem({
  name: "minimal",
  description: "Two actors: a scheduled pinger and a ponger that records pings",
  messages: { "ping.due": PingDue, "ping.sent": Ping, "ping.kicked": Kick, "ci.finished": CiFinished },
  actors: {
    Pinger: {
      binding: "PINGER",
      kind: "deterministic",
      purpose: "Sends a numbered ping on a schedule or on request",
      justification: ["scheduling", "state"],
      schedules: [{ every: "5m", message: "ping.due" }],
    },
    Ponger: {
      binding: "PONGER",
      kind: "deterministic",
      purpose: "Records each ping exactly once and asks a model about it",
      justification: ["state"],
      effects: ["ping.judge"],
    },
  },
  effects: {
    // A decision on a model that isn't a Clef model.
    "ping.judge": { description: "Judge a ping", kind: "decision", idempotency: "key", result: "ci.finished", model: "@cf/meta/llama-3.1-8b-instruct", questions: { urgent: { type: "noul", instructions: "Is the ping urgent?" } } },
  },
  routes: [
    { from: "@ingress", message: "ping.kicked", to: "Pinger" },
    { from: "@clock", message: "ping.due", to: "Pinger" },
    { from: "Pinger", message: "ping.sent", to: "Ponger" },
    { from: "Ponger", message: "ci.finished", to: "Ponger" },
  ],
});
