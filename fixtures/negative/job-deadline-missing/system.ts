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
      purpose: "Records each ping exactly once and runs CI for it",
      justification: ["state"],
      effects: ["ci.run"],
    },
  },
  effects: {
    // A job with no deadline: if CI never reports back, the run would wait forever.
    "ci.run": { description: "Run CI for a ping", kind: "job", idempotency: "key", completes: { message: "ci.finished" } },
  },
  routes: [
    { from: "@ingress", message: "ping.kicked", to: "Pinger" },
    { from: "@clock", message: "ping.due", to: "Pinger" },
    { from: "Pinger", message: "ping.sent", to: "Ponger" },
    { from: "@ingress", message: "ci.finished", to: "Ponger" },
  ],
});
