// Asking for approval by email (approvalEmail), the approval.decided payload (a hand-written Standard Schema,
// so apps need no zod), and applyDecision, which turns it into the handler's ctx.approve or ctx.deny.
import { describe, expect, it } from "vitest";
import { EffectRejected } from "../src/runtime/index.ts";
import { type ApprovalDecided, type ApprovalRequest, applyDecision, approvalDecided, approvalEmail, SUBJECT_TAG, verifyApprovalToken } from "../src/sources/index.ts";

describe("approvalEmail", () => {
  const request: ApprovalRequest = { actor: "Brief:daily", actorName: "Brief", key: "daily", effect: "github.comment", effectKey: "c1", description: "Comment on an issue", input: { body: "hi" }, expiresAt: 1_900_000_000_000 };
  const attempt = { key: "approval:github.comment:c1", attempt: 1, signal: new AbortController().signal, reportUsage: () => {} };
  type Sent = { from: unknown; to: unknown; subject: string; text: string; headers?: Record<string, string> };
  const capture = (sent: Sent[]) => ({ send: async (m: Sent) => void sent.push(m) });

  it("says what describe() returns, in order, and signs a token that expires with the request", async () => {
    const sent: Sent[] = [];
    const adapter = approvalEmail({
      send: capture(sent),
      from: "actord@example.com",
      to: "owner@example.com",
      secret: "s3cret",
      describe: (r) => ({ action: `Post "${(r.input as { body: string }).body}" on issue #12`, why: "The owner asked for a weekly summary.", link: "https://github.com/o/r/issues/12" }),
    });
    expect(await adapter.run(request, attempt)).toEqual({ sentAt: expect.any(Number) });
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail).toMatchObject({ from: "actord@example.com", to: "owner@example.com" });
    const lines = [
      'Post "hi" on issue #12',
      "Why: The owner asked for a weekly summary.",
      "Link: https://github.com/o/r/issues/12",
      "If you deny it: the actor is told it was denied and the effect never runs.",
      "This request expires at 2030-03-17T17:46:40.000Z.",
      "Reply with approve, or deny followed by a reason, on the first line.",
    ];
    const at = lines.map((l) => mail.text.indexOf(l));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(mail.text).not.toContain("Comment on an issue"); // describe() replaces the default action
    const token = SUBJECT_TAG.exec(mail.subject)?.[1];
    expect(mail.subject).toBe(`Approve github.comment? [actord:${token}]`);
    expect(mail.headers).toEqual({ "X-Actord-Approval": token });
    expect(await verifyApprovalToken("s3cret", token!, request.expiresAt - 1)).toEqual({ ok: true, claims: { actor: "Brief", key: "daily", effect: "github.comment", effectKey: "c1", exp: request.expiresAt } });
    expect(await verifyApprovalToken("s3cret", token!, request.expiresAt)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses at once, sending nothing, when its send binding, secret or addresses are missing, or describe() throws", async () => {
    const sent: Sent[] = [];
    const base = { send: capture(sent), from: "actord@example.com", to: "owner@example.com", secret: "s3cret" };
    const broken = () => {
      throw new Error("no issue number");
    };
    for (const config of [{ ...base, send: undefined as never }, { ...base, secret: "" }, { ...base, to: "" }, { ...base, describe: broken }]) {
      await expect(approvalEmail(config).run(request, attempt)).rejects.toBeInstanceOf(EffectRejected);
    }
    expect(sent).toEqual([]);
  });
});

const valid: ApprovalDecided = { effect: "notify.brief", effectKey: "k1", decision: "approve", reason: null, by: "owner@example.com", authenticated: "pass" };
const validate = async (value: unknown) => approvalDecided["~standard"].validate(value);

describe("approvalDecided", () => {
  it("accepts a valid approve and a valid deny with a reason", async () => {
    expect(await validate(valid)).toEqual({ value: valid });
    const deny = { ...valid, decision: "deny", reason: "not now", authenticated: "unknown" };
    expect(await validate(deny)).toEqual({ value: deny });
  });

  it("rejects a decision that is neither approve nor deny", async () => {
    const r = await validate({ ...valid, decision: "maybe" });
    expect(r.issues?.map((i) => i.path)).toEqual([["decision"]]);
  });

  it("rejects a payload missing a field, or with a mistyped one", async () => {
    const { by: _, ...missing } = valid;
    expect((await validate(missing)).issues?.map((i) => i.path)).toEqual([["by"]]);
    expect((await validate({ ...valid, reason: undefined })).issues?.map((i) => i.path)).toEqual([["reason"]]);
    expect((await validate({ ...valid, authenticated: "fail" })).issues?.map((i) => i.path)).toEqual([["authenticated"]]);
    expect((await validate({ ...valid, effectKey: "" })).issues?.map((i) => i.path)).toEqual([["effectKey"]]);
    expect((await validate(null)).issues).toHaveLength(1);
    expect((await validate([])).issues).toHaveLength(1);
  });

  it("keeps only the declared fields", async () => {
    expect(await validate({ ...valid, extra: 1 })).toEqual({ value: valid });
  });

  it("describes itself as JSON Schema for the manifest", () => {
    const schema = approvalDecided["~standard"].jsonSchema?.input({ target: "draft-2020-12" });
    expect(schema).toMatchObject({ type: "object", required: ["effect", "effectKey", "decision", "reason", "by", "authenticated"], additionalProperties: false });
  });
});

describe("applyDecision", () => {
  /** A handler context that records what it was asked and answers `answer`. */
  function recorder(answer: boolean) {
    const calls: unknown[][] = [];
    return {
      calls,
      ctx: {
        approve: (...args: unknown[]) => (calls.push(["approve", ...args]), answer),
        deny: (...args: unknown[]) => (calls.push(["deny", ...args]), answer),
      },
    };
  }

  it("approves the named effect, as the sender who decided", () => {
    const { calls, ctx } = recorder(true);
    expect(applyDecision(ctx, valid)).toBe(true);
    expect(calls).toEqual([["approve", "notify.brief", "k1", { by: "owner@example.com" }]]);
  });

  it("denies it with the reason, or a default when there is none", () => {
    const { calls, ctx } = recorder(true);
    applyDecision(ctx, { ...valid, decision: "deny", reason: "not now" });
    applyDecision(ctx, { ...valid, decision: "deny", reason: null });
    expect(calls).toEqual([
      ["deny", "notify.brief", "k1", "not now", { by: "owner@example.com" }],
      ["deny", "notify.brief", "k1", "denied by a person", { by: "owner@example.com" }],
    ]);
  });

  it("answers what the context answered: false when nothing was waiting", () => {
    const { ctx } = recorder(false);
    expect(applyDecision(ctx, valid)).toBe(false);
    expect(applyDecision(ctx, { ...valid, decision: "deny" })).toBe(false);
  });
});
