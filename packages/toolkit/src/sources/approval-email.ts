// Asking for approval by email, and applying the answer (spec §8.1, §8.2).
//
// - Out: when an effect parks for approval, the runtime queues the system's `approvals.notify` effect with an
//   ApprovalRequest. approvalEmail is that effect's adapter: one plain-text email to the owner, whose subject
//   carries a signed token ("[actord:<token>]", expiring with the request) naming the parked effect. It sends
//   no approve or deny links, because mail scanners open links to check them.
// - Back: the owner's reply becomes an `approval.decided` message (ApprovalDecided, validated by the
//   hand-written approvalDecided schema), and the actor's handler passes it to applyDecision.
import { EffectRejected, type ApprovalRequest, type EffectAdapter } from "../runtime/index.ts";
import type { ApprovalDecided } from "../payloads.ts";
import { signApprovalToken } from "./token.ts";

export type { ApprovalRequest } from "../runtime/index.ts";
export { type ApprovalDecided, approvalDecided } from "../payloads.ts";

/**
 * The part of a send_email binding (Cloudflare Email Service) that approvalEmail and the email source's replies use:
 * exactly the message they send, so workerd's SendEmail (whose builder takes wider fields) is assignable to it.
 */
export interface SendEmailLike {
  send(message: { from: string; to: string; subject: string; text: string; headers?: Record<string, string> }): Promise<unknown>;
}

/** The effect adapter that emails an approval request to the owner. */
export function approvalEmail(config: {
  send: SendEmailLike;
  from: string;
  to: string;
  secret: string;
  /** What the email says the action is and why it's needed, with an optional link (an issue or PR). */
  describe?: (request: ApprovalRequest) => { action: string; why: string; link?: string };
}): EffectAdapter<ApprovalRequest, { sentAt: number }> {
  return {
    async run(request) {
      // A missing binding or setting can't succeed on any retry: refuse at once, before anything is sent.
      if (typeof config.send?.send !== "function") throw new EffectRejected("approvalEmail: no send binding");
      if (typeof config.secret !== "string" || config.secret === "") throw new EffectRejected("approvalEmail: no signing secret");
      if (!config.from || !config.to) throw new EffectRejected("approvalEmail: no from or to address");
      let token: string;
      let parts: string[];
      try {
        token = await signApprovalToken(config.secret, { actor: request.actorName, key: request.key, effect: request.effect, effectKey: request.effectKey, exp: request.expiresAt });
        const said = config.describe?.(request);
        parts = [
          said?.action ?? `${request.description}\n\n${indent(JSON.stringify(request.input, null, 2) ?? "(no input)")}`,
          `Why: ${said?.why ?? `${request.actor} asked for ${request.effect} (key ${request.effectKey}).`}`,
          ...(said?.link ? [`Link: ${said.link}`] : []),
          "If you deny it: the actor is told it was denied and the effect never runs.",
          `This request expires at ${new Date(request.expiresAt).toISOString()}.`,
          "Reply with approve, or deny followed by a reason, on the first line.",
        ];
      } catch (err) {
        // Nothing was sent, and the same request would fail the same way again: not in doubt, refused.
        throw new EffectRejected(`approvalEmail: couldn't write the request: ${(err as { message?: string } | null)?.message ?? String(err)}`);
      }
      // Only the send itself can leave the outcome unknown (the effect declares idempotency "none").
      await config.send.send({
        from: config.from,
        to: config.to,
        subject: `Approve ${request.effect}? [actord:${token}]`,
        text: `${parts.join("\n\n")}\n`,
        // Informational: the reply is matched by the subject's token, which mail clients keep.
        headers: { "X-Actord-Approval": token },
      });
      return { sentAt: Date.now() };
    },
  };
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/**
 * Apply an approval.decided payload inside the actor's handler: approve or deny the effect it names, as the
 * person who decided. Returns what ctx.approve or ctx.deny returned: false when nothing was waiting (already
 * decided, expired, or never parked).
 */
export function applyDecision(
  ctx: { approve(name: never, key: string, identity?: { by: string }): boolean; deny(name: never, key: string, reason: string, identity?: { by: string }): boolean },
  decided: ApprovalDecided,
): boolean {
  const name = decided.effect as never;
  const identity = { by: decided.by };
  return decided.decision === "approve" ? ctx.approve(name, decided.effectKey, identity) : ctx.deny(name, decided.effectKey, decided.reason ?? "denied by a person", identity);
}
