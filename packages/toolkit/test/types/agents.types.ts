// Compile-time contract tests: `tsc --noEmit` fails if any @ts-expect-error stops being an error.
import { z } from "zod";
import { type AgentHandlers, agentExhausted, agentFailed } from "../../src/agents/index.ts";
import { defineSystem, message, pi } from "../../src/system.ts";

const system = defineSystem({
  name: "agent-types",
  messages: {
    "task.started": message({ version: 1, description: "Start", payload: z.object({ topic: z.string() }) }),
    "task.hinted": message({ version: 1, description: "Steer", payload: z.object({ text: z.string() }) }),
    "task.done": message({ version: 1, description: "Result", payload: z.object({ summary: z.string() }) }),
    "agent.failed": message({ version: 1, description: "Failed", payload: agentFailed }),
    "agent.exhausted": message({ version: 1, description: "Exhausted", payload: agentExhausted }),
  },
  actors: {
    Writer: {
      binding: "WRITER",
      kind: "agent",
      purpose: "writes",
      justification: ["state"],
      harness: pi(),
      model: { id: "@cf/x", reasoning: "high" },
      on: { "task.started": "start", "task.hinted": "steer" },
      returns: "task.done",
      budget: { usd: 1, turns: 10, wallClock: "10m" },
    },
  },
  routes: [
    { from: "@ingress", message: "task.started", to: "Writer" },
    { from: "@ingress", message: "task.hinted", to: "Writer" },
    { from: "Writer", message: "task.done", to: "Writer" },
    { from: "Writer", message: "agent.failed", to: "Writer" },
    { from: "Writer", message: "agent.exhausted", to: "Writer" },
  ],
});

// The `on` messages are the agent runtime's: the actor handles the rest, with typed payloads.
const handlers: AgentHandlers<typeof system, "Writer"> = {
  "task.done": ({ payload }) => void payload.summary.toUpperCase(),
  "agent.failed": ({ payload }) => void payload.reason.toUpperCase(),
  "agent.exhausted": ({ payload }) => void (payload.budget satisfies "usd" | "turns" | "wallClock"),
};
// @ts-expect-error agent.failed has no handler
const missing: AgentHandlers<typeof system, "Writer"> = { "task.done": () => {}, "agent.exhausted": () => {} };

void [handlers, missing];
