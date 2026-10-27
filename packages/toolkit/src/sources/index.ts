// @actord/toolkit/sources: the Worker's handlers for the sources a system declares in system.ts (spec §6).
// Each handler verifies a request, maps it to the system's own message and delivers it under the
// source's sender name ("@<source>"), as `ingress` does; actors never subscribe.
export { handleWebhook } from "./webhook.ts";
export { type ForwardableEmailLike, handleEmail } from "./email.ts";
export { type ApprovalClaims, SUBJECT_TAG, signApprovalToken, type VerifiedApproval, verifyApprovalToken } from "./token.ts";
export { type ApprovalDecided, type ApprovalRequest, type SendEmailLike, applyDecision, approvalDecided, approvalEmail } from "./approval-email.ts";
