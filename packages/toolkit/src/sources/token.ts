// Approval tokens (plan 2, Task 4): an effect's approval request carries one in its subject as
// "[actord:<token>]", and the owner's reply keeps it. A token is base64url(JSON claims) + "." +
// base64url(HMAC-SHA256 of that first part). Verification checks the shape, then the signature in
// constant time, and only then reads the claims or their expiry.
import { equalConstantTime } from "./webhook.ts";

export interface ApprovalClaims {
  readonly actor: string;
  readonly key: string;
  readonly effect: string;
  readonly effectKey: string;
  /** Epoch milliseconds; the token is live while now < exp and expired from exp on. */
  readonly exp: number;
}

export type VerifiedApproval = { ok: true; claims: ApprovalClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** Finds a token inside a subject such as "Re: Approve notify.brief? [actord:abc.def]". */
export const SUBJECT_TAG = /\[actord:([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\]/;

const SHAPE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const enc = new TextEncoder();

export async function signApprovalToken(secret: string, claims: ApprovalClaims): Promise<string> {
  const payload = toBase64Url(enc.encode(JSON.stringify(claims)));
  return `${payload}.${toBase64Url(await hmac(secret, payload))}`;
}

export async function verifyApprovalToken(secret: string, token: string, now: number): Promise<VerifiedApproval> {
  const parts = SHAPE.exec(token);
  if (!parts) return { ok: false, reason: "malformed" };
  const [, payload, signature] = parts as unknown as [string, string, string];
  const given = fromBase64Url(signature);
  if (!given) return { ok: false, reason: "malformed" };
  if (!equalConstantTime(await hmac(secret, payload), given)) return { ok: false, reason: "bad_signature" };
  const claims = parseClaims(payload);
  if (!claims) return { ok: false, reason: "malformed" };
  if (now >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/**
 * The claims a token carries, read without checking its signature. Only for a token that
 * verifyApprovalToken already found signed but expired, to say when it expired.
 */
export function claimsOf(token: string): ApprovalClaims | null {
  const parts = SHAPE.exec(token);
  return parts ? parseClaims(parts[1]!) : null;
}

function parseClaims(payload: string): ApprovalClaims | null {
  try {
    const bytes = fromBase64Url(payload);
    if (!bytes) return null;
    const c = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof c.actor !== "string" || typeof c.key !== "string" || typeof c.effect !== "string" || typeof c.effectKey !== "string" || typeof c.exp !== "number") return null;
    return { actor: c.actor, key: c.key, effect: c.effect, effectKey: c.effectKey, exp: c.exp };
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}
