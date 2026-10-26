import { message } from "@actord/toolkit/system";
import { z } from "zod";

export const IssueOpened = message({
  version: 1,
  description: "An issue was opened",
  payload: z.object({ number: z.number().int() }),
});

export const ApprovalDecided = message({
  version: 1,
  description: "A person answered an approval request",
  payload: z.object({ answer: z.string() }),
});

export const PublishRequested = message({
  version: 1,
  description: "Someone asked to publish",
  payload: z.object({ note: z.string() }),
});
