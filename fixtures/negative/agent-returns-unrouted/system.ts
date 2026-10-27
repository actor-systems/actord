import { defineSystem, pi } from "@actord/toolkit/system";
import { z } from "zod";
import { AgentExhausted, AgentFailed, TaskDone, TaskRequested } from "./src/messages/index.ts";

export default defineSystem({
  name: "agent-returns-unrouted",
  description: "An agent whose returns message has no route back to itself",
  messages: { "task.requested": TaskRequested, "task.done": TaskDone, "agent.failed": AgentFailed, "agent.exhausted": AgentExhausted },
  actors: {
    Coder: {
      binding: "CODER",
      kind: "agent",
      purpose: "Works a task and returns the result",
      justification: ["state", "lifecycle"],
      harness: pi(),
      model: { id: "claude-opus-5-5" },
      instructions: "CODER.md",
      tools: ["open-pr"],
      on: { "task.requested": "start" },
      returns: "task.done",
      budget: { usd: 5, turns: 40, wallClock: "30m" },
      effects: ["open-pr"],
    },
  },
  effects: {
    "open-pr": { description: "Open a pull request", idempotency: "key", input: z.object({ title: z.string() }) },
  },
  routes: [
    { from: "@ingress", message: "task.requested", to: "Coder" },
    { from: "Coder", message: "agent.failed", to: "Coder" },
    { from: "Coder", message: "agent.exhausted", to: "Coder" },
  ],
});
