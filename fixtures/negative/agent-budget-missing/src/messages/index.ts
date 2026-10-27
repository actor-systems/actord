import { message } from "@actord/toolkit/system";
import { z } from "zod";

export const PingDue = message({
  version: 1,
  description: "The schedule says it's time to ping",
  payload: z.object({ at: z.number().int() }),
});

export const Ping = message({
  version: 1,
  description: "A ping carrying a sequence number",
  payload: z.object({ seq: z.number().int().nonnegative(), note: z.string().optional() }),
});

export const Kick = message({
  version: 1,
  description: "Someone asked for an immediate ping",
  payload: z.object({ reason: z.string() }),
});

export const AgentFailed = message({ version: 1, description: "The agent failed", payload: z.object({}) });

export const AgentExhausted = message({ version: 1, description: "The agent ran out of budget", payload: z.object({}) });
