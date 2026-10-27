import { defineSystem, pi } from "@actord/toolkit/system";
import { AgentExhausted, AgentFailed, TaskDone, TaskRequested } from "./src/messages/index.ts";

export default defineSystem({
  name: "agent-tool-input-missing",
  description: "An agent tool effect that declares no input",
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
    "open-pr": { description: "Open a pull request", idempotency: "key" },
  },
  routes: [
    { from: "@ingress", message: "task.requested", to: "Coder" },
    { from: "Coder", message: "task.done", to: "Coder" },
    { from: "Coder", message: "agent.failed", to: "Coder" },
    { from: "Coder", message: "agent.exhausted", to: "Coder" },
  ],
});
