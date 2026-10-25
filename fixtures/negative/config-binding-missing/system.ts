import { defineSystem } from "@actord/toolkit/system";
import { Kick, Ping, PingDue } from "./src/messages/index.ts";

export default defineSystem({
  name: "minimal",
  description: "Two actors: a scheduled pinger and a ponger that records pings",
  messages: { "ping.due": PingDue, "ping.sent": Ping, "ping.kicked": Kick },
  actors: {
    Pinger: {
      binding: "PINGER",
      kind: "deterministic",
      purpose: "Sends a numbered ping on a schedule or on request",
      justification: ["scheduling", "state"],
      schedule: { every: "5m", message: "ping.due" },
    },
    Ponger: {
      binding: "PONGER",
      kind: "deterministic",
      purpose: "Records each ping exactly once",
      justification: ["state"],
    },
  },
  routes: [
    { from: "@clock", message: "ping.due", to: "Pinger" },
    { from: "@ingress", message: "ping.kicked", to: "Pinger" },
    { from: "Pinger", message: "ping.sent", to: "Ponger" },
  ],
});
