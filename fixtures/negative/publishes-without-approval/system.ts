import { defineSystem, inboundEmail, webhook } from "@actord/toolkit/system";
import { ApprovalDecided, IssueOpened, PublishRequested } from "./src/messages/index.ts";

export default defineSystem({
  name: "publishes-without-approval",
  description: "An effect that publishes needs no approval",
  messages: { "publish.requested": PublishRequested },
  actors: {
    Triage: { binding: "TRIAGE", kind: "deterministic", purpose: "Publishes release notes", justification: ["permissions"], effects: ["publish"] },
  },
  effects: {
    publish: { description: "Publish a release note", idempotency: "key", publishes: true },
  },
  routes: [{ from: "@ingress", message: "publish.requested", to: "Triage" }],
});
