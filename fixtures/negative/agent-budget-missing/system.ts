import { defineSystem, pi } from "@actord/toolkit/system";
import { AgentExhausted, AgentFailed, Kick, Ping, PingDue } from "./src/messages/index.ts";

export default defineSystem({
  name: "minimal",
  description: "Two actors: a scheduled pinger and a ponger that records pings",
  messages: { "ping.due": PingDue, "ping.sent": Ping, "ping.kicked": Kick, "agent.failed": AgentFailed, "agent.exhausted": AgentExhausted },
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
      kind: "agent",
      purpose: "Records each ping exactly once",
      justification: ["state"],
      harness: pi(),
      model: { id: "claude-opus-5-5" },
      instructions: "PONGER.md",
      on: { "ping.sent": "start" },
      returns: "ping.sent",
    },
  },
  routes: [
    { from: "@clock", message: "ping.due", to: "Pinger" },
    { from: "@ingress", message: "ping.kicked", to: "Pinger" },
    { from: "Pinger", message: "ping.sent", to: "Ponger" },
    { from: "Ponger", message: "ping.sent", to: "Ponger" },
    { from: "Ponger", message: "agent.failed", to: "Ponger" },
    { from: "Ponger", message: "agent.exhausted", to: "Ponger" },
  ],
});
