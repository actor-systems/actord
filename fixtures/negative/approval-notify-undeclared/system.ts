import { defineSystem, inboundEmail, webhook } from "@actord/toolkit/system";
import { ApprovalDecided, IssueOpened, PublishRequested } from "./src/messages/index.ts";

export default defineSystem({
  name: "approval-notify-undeclared",
  description: "approvals.notify is set, but the actor with a gated effect doesn't list it",
  messages: { "approval.decided": ApprovalDecided, "publish.requested": PublishRequested },
  actors: {
    Triage: { binding: "TRIAGE", kind: "deterministic", purpose: "Publishes after a person approves", justification: ["permissions"], effects: ["publish"] },
  },
  effects: {
    notify: { description: "Tell a person an approval is waiting", idempotency: "key" },
    publish: { description: "Publish a release note", idempotency: "key", approval: "human", publishes: true },
  },
  approvals: { notify: "notify" },
  sources: {
    email: inboundEmail({ secret: "APPROVAL_SECRET", owner: "OWNER_ADDRESS", from: "FROM_ADDRESS", send: "SEND_EMAIL", message: "approval.decided" }),
  },
  routes: [
    { from: "@email", message: "approval.decided", to: "Triage" },
    { from: "@ingress", message: "publish.requested", to: "Triage" },
  ],
});
