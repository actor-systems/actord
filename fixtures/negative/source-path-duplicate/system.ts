import { defineSystem, inboundEmail, webhook } from "@actord/toolkit/system";
import { ApprovalDecided, IssueOpened, PublishRequested } from "./src/messages/index.ts";

const events = { "issues.opened": { message: "issue.opened", key: (e: { number: number }) => String(e.number), map: (e: { number: number }) => ({ number: e.number }) } };

export default defineSystem({
  name: "source-path-duplicate",
  description: "Two webhook sources listen on one path",
  messages: { "issue.opened": IssueOpened },
  actors: {
    Triage: { binding: "TRIAGE", kind: "deterministic", purpose: "Triages what arrives", justification: ["state"] },
  },
  sources: {
    github: webhook({ path: "/hooks", verify: "github", secret: "GITHUB_WEBHOOK_SECRET", events }),
    mirror: webhook({ path: "/hooks", verify: "github", secret: "GITHUB_WEBHOOK_SECRET", events }),
  },
  routes: [
    { from: "@github", message: "issue.opened", to: "Triage" },
    { from: "@mirror", message: "issue.opened", to: "Triage" },
  ],
});
