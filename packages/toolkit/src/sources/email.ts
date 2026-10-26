// The Worker's handler for an email source (spec §8.2): the owner answers a parked effect's approval request
// by replying to the email that asked.
//
// A reply counts only if all of these hold. Plain code checks them, never a model, in this order, and the
// first that fails ends it:
// 1. Sender. The envelope sender and the one From address are both the owner's (env[owner]), compared
//    case-insensitively, and no Authentication-Results header says dmarc=fail. Mail that fails this gets no
//    reply at all, so nobody but the owner can make the Worker send mail or learn whether a token is good.
//    That is why the sender is checked before the token. Mail an auto-responder sent (Auto-Submitted, other
//    than "no") is then ignored without a reply, so an out-of-office answer and a re-ask can't loop.
// 2. Token. The subject's "[actord:<token>]" verifies against env[secret] and hasn't expired. A missing,
//    edited or expired token gets a reply saying so.
// 3. Decision. The first non-empty line the owner wrote, above any quoted text, is "approve", or "deny" and
//    an optional reason. Anything else gets a reply asking again.
// 4. Publishes guard. Without dmarc=pass, an effect declared publishes: true can't be approved by email, and
//    the reply says to approve it in GitHub. A deny still goes through.
// Then the source's message (approval.decided) goes to the actor and instance the token names, under the
// sender "@<source>", with an envelope id derived from the reply's Message-ID, so the same email handled twice
// is delivered once. A second, different reply is delivered too; the actor's ctx.approve or ctx.deny then
// answers false, because nothing is waiting any more.
// A delivery that throws, or whose handler fails, is tried twice more under the same envelope id, which the
// actor deduplicates. The owner then gets one reply: "Received: …" once the actor has the answer (handled, or
// a duplicate of one it already handled), saying that a request already decided or expired is unchanged; that
// the answer couldn't be recorded, and to reply again, if every attempt failed; or that it couldn't be applied,
// and why, if the actor refused it.
// Every outcome other than a delivery is recorded as a source.* event. Every reply goes to the owner through
// env[send], from env[from], marked Auto-Submitted: auto-replied, with In-Reply-To set to the reply's Message-ID.
// Authentication: a sender can write Authentication-Results headers of their own, below the one the receiving
// server adds on top. So a reply is "pass" only when the topmost header comes from the trusted authserv-id
// (env[authserv]) and its dmarc result, read outside comments, is pass. Anything else is "unknown", including
// a source with no authserv configured. A dmarc=fail anywhere refuses the reply.
import PostalMime, { addressParser, type Email } from "postal-mime";
import { type ActorEvent, type EventKind, type Receipt, deliverExternal, deriveId, emit } from "../runtime/index.ts";
import type { EmailSourceSpec, System } from "../system.ts";
import type { ApprovalDecided, SendEmailLike } from "./approval-email.ts";
import { claimsOf, SUBJECT_TAG, verifyApprovalToken } from "./token.ts";

/** The parts of the Workers runtime's ForwardableEmailMessage that handleEmail reads. */
export interface ForwardableEmailLike {
  /** The envelope sender (MAIL FROM). */
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
}

const NOT_A_REPLY = "this address only accepts replies to actord approval requests";
const ASK_AGAIN = "reply with approve, or deny followed by a reason, on the first line";
const APPROVE_IN_GITHUB = "this effect publishes; approve it in GitHub";
const expiredAt = (exp: number) => `this request expired at ${new Date(exp).toISOString()}; nothing was approved`;
type Answer = { decision: "approve" | "deny"; effect: string; effectKey: string };
const what = (a: Answer) => `${a.decision} for ${a.effect} (${a.effectKey})`;
const RECEIVED = (a: Answer) => `Received: ${what(a)}. If it had already been decided or had expired, this changed nothing.`;
const NOT_RECORDED = (a: Answer) => `Your ${what(a)} couldn't be recorded. Please reply again with your answer on the first line.`;
const NOT_APPLIED = (a: Answer, why: string) => `Your ${what(a)} couldn't be applied: ${why}. Nothing was approved or denied.`;
/** The first delivery and up to two retries, all under one envelope id. */
const ATTEMPTS = 3;

const DMARC_FAIL = /\bdmarc\s*=\s*fail\b/i;
/** A resinfo's method and result, such as "dmarc=pass" or "dmarc/1 = pass" (RFC 8601). */
const DMARC_RESULT = /^dmarc\s*(?:\/\s*\d+\s*)?=\s*([A-Za-z0-9_-]+)/i;
const QUOTE_INTRO = /^On .+wrote:$/;
const APPROVE = /^approve$/i;
const DENY = /^deny\b\s*(.*)$/i;
/** A Message-ID that is safe to repeat in a header of the reply. */
const MESSAGE_ID = /^<[^<>\s]+>$/;
/** Values recorded before they are trusted are cut to this length. */
const UNTRUSTED_MAX = 200;

/** Handle one email sent to the system's email source: an owner's answer to an approval request, or not. */
export async function handleEmail(message: ForwardableEmailLike, env: unknown, system: System): Promise<void> {
  const found = Object.entries(system.sources ?? {}).filter(([, s]) => s.kind === "email") as Array<[string, EmailSourceSpec]>;
  if (found.length !== 1) throw new Error(`actord: handleEmail needs exactly one email source in system.sources, found ${found.length}`);
  const [name, source] = found[0]!;
  const sender = `@${name}` as const;
  const vars = (env ?? {}) as Record<string, unknown>;
  const record = (kind: EventKind, reason: string, fields: Pick<ActorEvent, "messageId" | "effect" | "effectKey"> = {}, detail: Record<string, unknown> = {}) =>
    emit({ kind, at: Date.now(), actor: sender, ...fields, reason, detail: { source: name, ...detail } });

  const secret = vars[source.secret];
  const owner = vars[source.owner];
  if (typeof secret !== "string" || secret === "") return record("source.rejected", "secret_missing", {}, { secret: source.secret });
  if (typeof owner !== "string" || owner === "") return record("source.rejected", "owner_missing", {}, { owner: source.owner });

  let email: Email;
  try {
    email = await PostalMime.parse(message.raw);
  } catch (err) {
    return record("source.invalid", "unparsable", {}, { error: messageOf(err) });
  }
  const messageId = email.messageId?.trim() || null;
  const seen = { messageIdHeader: untrusted(messageId) };

  // 1. Sender: nothing below this replies, so only the owner ever hears back.
  const author = authorOf(email);
  if (!sameAddress(message.from, owner) || !sameAddress(author, owner)) return record("source.rejected", "not_owner", {}, { ...seen, from: untrusted(message.from), author: untrusted(author) });
  const results = email.headers.filter((h) => h.key === "authentication-results").map((h) => h.value);
  if (results.some((r) => DMARC_FAIL.test(r))) return record("source.rejected", "dmarc_fail", {}, seen);
  const authenticated = authenticationOf(results, source.authserv === undefined ? undefined : vars[source.authserv]);
  const auto = email.headers.filter((h) => h.key === "auto-submitted").map((h) => fields(h.value)[0]!.trim().toLowerCase());
  if (auto.some((v) => v !== "no")) return record("source.ignored", "auto_submitted", {}, { ...seen, autoSubmitted: untrusted(auto.join(", ")) });

  // Decoded, a subject can hold line breaks; the reply repeats it in a header, so they become spaces.
  const subject = (email.subject ?? "").replace(/[\r\n]+/g, " ");
  const reply = async (text: string) => {
    const send = vars[source.send] as Partial<SendEmailLike> | undefined;
    const from = vars[source.from];
    try {
      if (typeof send?.send !== "function") throw new Error(`no send_email binding ${source.send}`);
      if (typeof from !== "string" || from === "") throw new Error(`no from address in ${source.from}`);
      // Auto-Submitted (RFC 3834) tells the owner's own auto-responder not to answer this one.
      const headers: Record<string, string> = { "Auto-Submitted": "auto-replied", ...(messageId !== null && MESSAGE_ID.test(messageId) ? { "In-Reply-To": messageId } : {}) };
      await send.send({ from, to: owner, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text, headers });
    } catch (err) {
      record("source.failed", "reply_failed", {}, { ...seen, error: messageOf(err) });
    }
  };

  // 2. Token.
  const token = SUBJECT_TAG.exec(subject)?.[1];
  if (!token) {
    record("source.ignored", "no_token", {}, seen);
    return reply(NOT_A_REPLY);
  }
  const verified = await verifyApprovalToken(secret, token, Date.now());
  if (!verified.ok) {
    if (verified.reason === "expired") {
      // The signature verified before the expiry was read, so these claims are the system's own.
      const claims = claimsOf(token)!;
      record("source.rejected", "expired", { effect: claims.effect, effectKey: claims.effectKey }, { ...seen, exp: claims.exp });
      return reply(expiredAt(claims.exp));
    }
    record("source.rejected", verified.reason, {}, seen);
    return reply(NOT_A_REPLY);
  }
  const { claims } = verified;
  const about = { effect: claims.effect, effectKey: claims.effectKey };

  // 3. Decision.
  const decided = firstLineDecision(email.text);
  if (!decided) {
    record("source.ignored", "unparsed", about, seen);
    return reply(ASK_AGAIN);
  }

  // 4. Publishes guard. An effect this system no longer declares is treated as one that publishes.
  const effects = system.effects ?? {};
  const effect = Object.hasOwn(effects, claims.effect) ? effects[claims.effect] : undefined;
  if (decided.decision === "approve" && authenticated !== "pass" && (effect === undefined || effect.publishes === true)) {
    record("source.rejected", "publishes_unauthenticated", about, seen);
    return reply(APPROVE_IN_GITHUB);
  }

  const by = message.from.trim();
  const payload: ApprovalDecided = { effect: claims.effect, effectKey: claims.effectKey, decision: decided.decision, reason: decided.reason, by, authenticated };
  // RFC 5322 says only that a message SHOULD carry a Message-ID. Without one, the id comes from what the reply
  // says instead, so the same answer to the same request from the same sender is still delivered once.
  const id = messageId !== null ? deriveId("email", messageId) : deriveId("email", token, decided.decision, by);
  const at = { messageId: id, ...about };
  const answer: Answer = { decision: decided.decision, ...about };
  // A throw or a failed handler may be passing, so try again; the same id means a delivery that did land, and
  // only lost its receipt, comes back as a duplicate rather than being handled twice. A refusal is final.
  let receipt: Receipt | null = null;
  let thrown: string | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      receipt = await deliverExternal(env, system, sender, claims.actor, source.message, payload, { key: claims.key, id });
      thrown = null;
    } catch (err) {
      receipt = null;
      thrown = messageOf(err);
      continue;
    }
    if (receipt.status !== "failed") break;
  }
  if (receipt === null) {
    record("source.failed", "delivery_failed", at, { ...seen, error: thrown, attempts: ATTEMPTS });
    return reply(NOT_RECORDED(answer));
  }
  if (receipt.status === "failed") {
    record("source.failed", "handler_failed", at, { ...seen, error: receipt.error, attempts: ATTEMPTS });
    return reply(NOT_RECORDED(answer));
  }
  if (receipt.status === "rejected") {
    record("source.invalid", receipt.reason, at, { ...seen, ...(receipt.detail ? { error: receipt.detail } : {}) });
    return reply(NOT_APPLIED(answer, receipt.detail ? `${receipt.reason} (${receipt.detail})` : receipt.reason));
  }
  // Handled, or a duplicate of an answer already handled. Whether it changed anything (applyDecision's answer)
  // stays inside the actor, so the reply says what was received, not what it did.
  return reply(RECEIVED(answer));
}

/**
 * The decision on the first non-empty line the owner wrote: the text part is cut at the first line that
 * introduces or starts quoted text, so an "approve" in the quoted request never counts. Null if there's none.
 */
function firstLineDecision(text: string | undefined): { decision: "approve" | "deny"; reason: string | null } | null {
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (QUOTE_INTRO.test(line) || line.startsWith(">")) return null;
    if (line === "") continue;
    if (APPROVE.test(line)) return { decision: "approve", reason: null };
    const deny = DENY.exec(line);
    return deny ? { decision: "deny", reason: deny[1]!.trim() || null } : null;
  }
  return null;
}

/**
 * "pass" only when the topmost Authentication-Results header (results[0], the receiving server's) names the
 * trusted authserv-id as its first token and has a dmarc result of pass outside comments. A header lower down
 * may have come from the sender, so it never counts; with no trusted id configured, nothing does.
 */
function authenticationOf(results: string[], trusted: unknown): ApprovalDecided["authenticated"] {
  const top = results[0];
  if (top === undefined || typeof trusted !== "string" || trusted === "") return "unknown";
  const [id, ...resinfo] = fields(top);
  if (resinfo.length === 0 || id!.trim().split(/\s+/)[0] !== trusted) return "unknown";
  return resinfo.some((r) => DMARC_RESULT.exec(r.trim())?.[1]?.toLowerCase() === "pass") ? "pass" : "unknown";
}

/**
 * A structured header value's ";"-separated parts, with comments taken out (RFC 5322: nested, with quoted
 * pairs). A ";" or "(" inside a quoted string doesn't count, so text a sender chose, quoted by the server that
 * wrote the header, can't add a part. An unclosed comment or quote swallows the rest of the value.
 */
function fields(value: string): string[] {
  const out: string[] = [];
  let part = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\") {
      if (depth === 0) part += ch + (value[i + 1] ?? "");
      i++;
    } else if (depth > 0) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    } else if (quoted) {
      part += ch;
      if (ch === '"') quoted = false;
    } else if (ch === '"') {
      part += ch;
      quoted = true;
    } else if (ch === "(") {
      depth = 1;
      part += " ";
    } else if (ch === ";") {
      out.push(part);
      part = "";
    } else part += ch;
  }
  out.push(part);
  return out;
}

/** The one address in the one From header; null when there are several headers, several addresses, or a group. */
function authorOf(email: Email): string | null {
  const froms = email.headers.filter((h) => h.key === "from");
  if (froms.length !== 1) return null;
  const list = addressParser(froms[0]!.value);
  return list.length === 1 && typeof list[0]!.address === "string" ? list[0]!.address : null;
}

const sameAddress = (a: string | null, b: string) => a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
const untrusted = (value: string | null) => (value === null ? null : value.slice(0, UNTRUSTED_MAX));
const messageOf = (err: unknown) => (err as { message?: string } | null)?.message ?? String(err);
