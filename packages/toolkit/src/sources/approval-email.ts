// Asking for approval by email, and applying the answer (spec §8.1, §8.2).
//
// - Out: when an effect parks for approval, the runtime queues the system's `approvals.notify` effect with an
//   ApprovalRequest. approvalEmail is that effect's adapter: one plain-text email to the owner, whose subject
//   carries a signed token ("[actord:<token>]", expiring with the request) naming the parked effect. It sends
//   no approve or deny links, because mail scanners open links to check them.
// - Back: the owner's reply becomes an `approval.decided` message (ApprovalDecided, validated by the
//   hand-written approvalDecided schema), and the actor's handler passes it to applyDecision.
import { EffectRejected, type ApprovalRequest, type EffectAdapter } from "../runtime/index.ts";
import type { StandardResult, StandardSchemaV1 } from "../system.ts";
import { signApprovalToken } from "./token.ts";

export type { ApprovalRequest } from "../runtime/index.ts";

/** The part of a send_email binding (Cloudflare Email Service) that approvalEmail uses. */
export interface SendEmailLike {
  send(message: { from: string | { email: string; name?: string }; to: string | string[]; subject: string; text: string; headers?: Record<string, string> }): Promise<unknown>;
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

/** The payload of `approval.decided`: a person's answer to an approval request, from a source such as @email. */
export interface ApprovalDecided {
  effect: string;
  effectKey: string;
  decision: "approve" | "deny";
  /** A denial's reason; null when none was given. */
  reason: string | null;
  /** Who decided: for email, the verified sender address. */
  by: string;
  /** "pass": the reply passed DMARC. "unknown": the reply carried no authentication result. */
  authenticated: "pass" | "unknown";
}

type Issue = { message: string; path: [string] | [] };
const FIELDS = ["effect", "effectKey", "decision", "reason", "by", "authenticated"] as const;

function validateDecided(value: unknown): StandardResult<ApprovalDecided> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { issues: [{ message: "expected an object", path: [] }] };
  const v = value as Record<string, unknown>;
  const issues: Issue[] = [];
  const nonEmpty = (k: "effect" | "effectKey" | "by") => {
    if (typeof v[k] !== "string" || v[k] === "") issues.push({ message: `${k}: expected a non-empty string`, path: [k] });
  };
  nonEmpty("effect");
  nonEmpty("effectKey");
  if (v.decision !== "approve" && v.decision !== "deny") issues.push({ message: 'decision: expected "approve" or "deny"', path: ["decision"] });
  if (v.reason !== null && typeof v.reason !== "string") issues.push({ message: "reason: expected a string or null", path: ["reason"] });
  nonEmpty("by");
  if (v.authenticated !== "pass" && v.authenticated !== "unknown") issues.push({ message: 'authenticated: expected "pass" or "unknown"', path: ["authenticated"] });
  if (issues.length > 0) return { issues };
  // Only the declared fields go on, as a schema library's object parser would.
  return { value: Object.fromEntries(FIELDS.map((k) => [k, v[k]])) as unknown as ApprovalDecided };
}

/** A fresh copy each call, so a caller that edits it can't change the next one. */
const decidedJsonSchema = (): Record<string, unknown> => ({
  type: "object",
  properties: {
    effect: { type: "string", minLength: 1 },
    effectKey: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["approve", "deny"] },
    reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    by: { type: "string", minLength: 1 },
    authenticated: { type: "string", enum: ["pass", "unknown"] },
  },
  required: [...FIELDS],
  additionalProperties: false,
});

/** The Standard Schema for `approval.decided`'s payload, written by hand so apps need no schema library. */
export const approvalDecided: StandardSchemaV1<ApprovalDecided> = {
  "~standard": {
    version: 1,
    vendor: "actord",
    validate: validateDecided,
    jsonSchema: { input: decidedJsonSchema },
  },
};

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
