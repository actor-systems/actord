// The Worker's handler for an email source (spec §8.2): the owner answers a parked effect's approval request
// by replying to the email that asked.
//
// A reply counts only if all of these hold. Plain code checks them, never a model, in this order, and the
// first that fails ends it:
// 1. Sender. The envelope sender and the one From address are both the owner's (env[owner]), compared
//    case-insensitively, and no Authentication-Results header says dmarc=fail. Mail that fails this gets no
//    reply at all, so nobody but the owner can make the Worker send mail or learn whether a token is good.
//    That is why the sender is checked before the token.
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
// Every outcome other than a delivery is recorded as a source.* event. Every reply goes to the owner through
// env[send], from env[from], with In-Reply-To set to the reply's Message-ID.
// Not guaranteed: until spike 6 shows which Authentication-Results reach the Worker, dmarc=pass is read from
// any such header, whoever wrote it. Only a dmarc=fail in any of them is decisive.
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

const DMARC_FAIL = /\bdmarc\s*=\s*fail\b/i;
const DMARC_PASS = /\bdmarc\s*=\s*pass\b/i;
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
  const authenticated: ApprovalDecided["authenticated"] = results.some((r) => DMARC_PASS.test(r)) ? "pass" : "unknown";

  // Decoded, a subject can hold line breaks; the reply repeats it in a header, so they become spaces.
  const subject = (email.subject ?? "").replace(/[\r\n]+/g, " ");
  const reply = async (text: string) => {
    const send = vars[source.send] as Partial<SendEmailLike> | undefined;
    const from = vars[source.from];
    try {
      if (typeof send?.send !== "function") throw new Error(`no send_email binding ${source.send}`);
      if (typeof from !== "string" || from === "") throw new Error(`no from address in ${source.from}`);
      const inReplyTo = messageId !== null && MESSAGE_ID.test(messageId) ? { headers: { "In-Reply-To": messageId } } : {};
      await send.send({ from, to: owner, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text, ...inReplyTo });
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
  let receipt: Receipt;
  try {
    receipt = await deliverExternal(env, system, sender, claims.actor, source.message, payload, { key: claims.key, id });
  } catch (err) {
    return record("source.failed", "delivery_failed", at, { ...seen, error: messageOf(err) });
  }
  if (receipt.status === "rejected") record("source.invalid", receipt.reason, at, { ...seen, ...(receipt.detail ? { error: receipt.detail } : {}) });
  else if (receipt.status === "failed") record("source.failed", "handler_failed", at, { ...seen, error: receipt.error });
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

/** The one address in the one From header; null when there are several headers, several addresses, or a group. */
function authorOf(email: Email): string | null {
  const fields = email.headers.filter((h) => h.key === "from");
  if (fields.length !== 1) return null;
  const list = addressParser(fields[0]!.value);
  return list.length === 1 && typeof list[0]!.address === "string" ? list[0]!.address : null;
}

const sameAddress = (a: string | null, b: string) => a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
const untrusted = (value: string | null) => (value === null ? null : value.slice(0, UNTRUSTED_MAX));
const messageOf = (err: unknown) => (err as { message?: string } | null)?.message ?? String(err);
