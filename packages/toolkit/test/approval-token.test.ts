// Approval tokens: HMAC-signed, expiring, carried in a subject as [actord:<token>].
import { describe, expect, it } from "vitest";
import { type ApprovalClaims, SUBJECT_TAG, signApprovalToken, verifyApprovalToken } from "../src/sources/token.ts";

const claims: ApprovalClaims = { actor: "Brief", key: "daily", effect: "notify.brief", effectKey: "k1", exp: 2_000_000 };

describe("approval tokens", () => {
  it("round-trips claims", async () => {
    const token = await signApprovalToken("s3cret", claims);
    expect(await verifyApprovalToken("s3cret", token, 1_000_000)).toEqual({ ok: true, claims });
  });

  it("a changed claim fails with bad_signature", async () => {
    const token = await signApprovalToken("s3cret", claims);
    const flipped = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(await verifyApprovalToken("s3cret", flipped, 1_000_000)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("a token past exp fails with expired", async () => {
    const token = await signApprovalToken("s3cret", claims);
    expect(await verifyApprovalToken("s3cret", token, 2_000_001)).toEqual({ ok: false, reason: "expired" });
  });

  it("garbage is malformed", async () => {
    for (const bad of ["", "nodot", "a.b.c", "!!.??", "."]) {
      expect(await verifyApprovalToken("s3cret", bad, 0)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("a token from a different secret fails", async () => {
    const token = await signApprovalToken("other", claims);
    expect(await verifyApprovalToken("s3cret", token, 1_000_000)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("the subject tag finds the token inside a Re: subject", async () => {
    const token = await signApprovalToken("s3cret", claims);
    expect(SUBJECT_TAG.exec(`Re: Approve notify.brief? [actord:${token}]`)?.[1]).toBe(token);
    expect(SUBJECT_TAG.exec("Re: Approve notify.brief? [actord:abc.def]")?.[1]).toBe("abc.def");
  });
});
