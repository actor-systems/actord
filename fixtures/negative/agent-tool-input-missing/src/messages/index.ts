import { message } from "@actord/toolkit/system";
import { z } from "zod";

const Empty = z.object({});

export const TaskRequested = message({ version: 1, description: "Someone asked for a task", payload: Empty });
export const TaskDone = message({ version: 1, description: "The agent finished", payload: Empty });
export const AgentFailed = message({ version: 1, description: "The agent failed", payload: Empty });
export const AgentExhausted = message({ version: 1, description: "The agent ran out of budget", payload: Empty });
