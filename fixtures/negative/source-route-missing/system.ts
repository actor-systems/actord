import { defineSystem, inboundEmail, webhook } from "@actord/toolkit/system";
import { ApprovalDecided, IssueOpened, PublishRequested } from "./src/messages/index.ts";

export default defineSystem({
  name: "source-route-missing",
  description: "A GitHub source maps issues.opened to issue.opened, but no route carries it from @github",
  messages: { "issue.opened": IssueOpened },
  actors: {
    Triage: { binding: "TRIAGE", kind: "deterministic", purpose: "Triages what arrives", justification: ["state"] },
  },
  sources: {
    github: webhook({
      path: "/hooks/github",
      verify: "github",
      secret: "GITHUB_WEBHOOK_SECRET",
      events: { "issues.opened": { message: "issue.opened", key: (e: { number: number }) => String(e.number), map: (e: { number: number }) => ({ number: e.number }) } },
    }),
  },
  routes: [{ from: "@ingress", message: "issue.opened", to: "Triage" }],
});
