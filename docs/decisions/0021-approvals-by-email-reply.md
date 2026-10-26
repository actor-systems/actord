# 0021 — Approvals by email: reply, never link, matched by a signed subject token

- **Date:** 2026-10-26 · **Gate:** plan 2 (sources and email approvals) · **Status:** accepted · **Reversibility:**
  moderate (the token's place and the owner rules are internal; the `approval.decided` message is the contract)

## Context
A parked effect waits for a human (spec §8). Email is the first channel. Two things shaped it: mail scanners
open every link in a message, so an approve link would approve by itself; and the spec's reply matching does not
work for a person replying from a mail client.

## A design correction to the spec
Spec §8.2 matched replies with "HMAC-signed routing headers" via the Agents SDK's `createSecureReplyEmailResolver`.
That resolver reads custom `X-Agent-*` headers on the **incoming** message. A person replying from Gmail sends a
new message that does not carry the original's custom headers, so it cannot match a human reply. (It suits an
agent replying to an agent.) The spec is amended (§8.2, §4) to say so.

## Decisions
1. **Reply, never link.** The email asks the owner to reply `approve`, or `deny` followed by a reason, on the first
   line. No approve or deny URL is ever sent.
2. **The token travels in the subject, as `[actord:<token>]`.** Mail clients keep the subject when replying
   ("Re: …"). A token is `base64url(JSON claims) . base64url(HMAC-SHA256)`, with claims `actor`, `key`, `effect`,
   `effectKey` and `exp`. The signature is checked, in constant time, before the claims are read. An edited subject
   fails. A token is live while `now < exp`, where `exp` is the parked effect's own approval expiry, so a reply
   after the request expired is told so and does nothing. The same token is also set as an `X-Actord-Approval`
   header, but nothing relies on it.
3. **Parsed by plain code, never by a model.** The decision is the first non-empty line the owner wrote, above any
   quoted text: `approve` (any case), or `deny` and an optional reason. Anything else gets one reply asking again.
4. **The order of checks matters; the first that fails ends it:**
   1. *Sender.* The envelope sender **and** the header `From` must both be the owner's address
      (`env[owner]`), compared case-insensitively. Otherwise there is no reply at all, so a stranger cannot make
      the system email the owner, or learn whether a token is good. Recorded as `source.rejected`.
   2. *DMARC.* `dmarc=fail` in any `Authentication-Results` header refuses the reply.
   3. *Auto-replies.* Mail with an `Auto-Submitted` header other than `no` is ignored without a reply, so an
      out-of-office answer and a re-ask cannot loop. Every reply the handler sends is itself marked
      `Auto-Submitted: auto-replied` and carries `In-Reply-To`, which is left out when the incoming Message-ID is absent or unsafe to repeat in a header.
   4. *Token, then decision.* A missing or edited token gets one generic reply that doesn't tell the two apart; an expired token and an unparsable decision each get a reply saying so.
5. **Authentication is trusted only from a configured server.** A sender can write their own
   `Authentication-Results: …; dmarc=pass` header. So the reply is `authenticated: "pass"` only when the **topmost**
   `Authentication-Results` header's authserv-id equals the value in `env[authserv]` and its `dmarc` result, read
   outside comments and quoted strings, is `pass`. Everything else is `"unknown"`, including when the source has no
   `authserv`. `by` is the verified sender address.
6. **The publishes guard.** With `"unknown"`, an email cannot approve an effect declared `publishes: true` (or one the
   system no longer declares); the sender is told to approve it in GitHub. A deny always goes through. Approving
   mid-run tool calls by email is allowed on a valid token from the owner, with that limit written in Limitations.
7. **One notification per parked effect.** When an effect parks, the runtime queues the system's `approvals.notify`
   effect with the row id `fx:<notify>:approval:<effect>:<effectKey>`, so parking it again after a recovery sends
   nothing new. The notify is an effect of its own: if it fails, the parked effect stays parked and still expires.
   Declare it with `idempotency: "none"`. With `"key"`, a notify still retrying after the decision could still send.
8. **The default email shows the effect's input as JSON.** An app whose inputs are sensitive supplies `describe()`.
9. **Delivery.** The reply becomes `approval.decided` for the actor and instance in the token, from `@<source>`, with
   an id derived from the reply's `Message-ID`; the same email handled twice is delivered once. A second, different
   reply is delivered too, and `ctx.approve`/`ctx.deny` answers `false` because nothing is waiting.

## Spike 6 (2026-10-26, `docs/evidence/spike-6-email.md`)
A real Gmail reply through Cloudflare Email Routing approved a parked effect.
- **Confirmed:**
  - Cloudflare writes `Authentication-Results: mx.cloudflare.net; …` above the message's own headers, so it is the
    topmost header, and the only one in that message.
  - The owner's Gmail reply carried `dmarc=pass header.from=gmail.com` in it.
  - The subject token survived the reply byte for byte.
  - The envelope sender was the owner's address.
  - The `send_email` binding can't set `Message-ID` (the send is refused), so replies thread on the id Cloudflare
    assigns.
- **So an app may set `authserv`** to an env entry holding `mx.cloudflare.net`. A reply that passes is then
  `authenticated: "pass"`, and email can approve an effect declared `publishes: true`. Without `authserv`, every reply
  stays `"unknown"`.
- **`gmail.com` publishes `p=none`.** So Cloudflare doesn't reject mail at SMTP time that forges the owner's Gmail
  address. Such mail arrives with Cloudflare's `dmarc=fail`, and rule 4.2 refuses it.
- **Still unverified:** whether Cloudflare always adds its own header, and whether it strips an inbound one claiming
  `mx.cloudflare.net` (RFC 8601 §5). Only the topmost header is read, and Cloudflare's sat above everything inbound,
  so a forged header could win only on a path where Cloudflare adds none. That rests on one sample.
- **Hardening first.** Before the factory turns `authserv` on, three checks land:
  - every `dmarc` result in the trusted header must be `pass`;
  - `header.from` must equal the owner's domain;
  - the authserv-id is compared case-insensitively.

  They are deferred to plan 2's final fix wave. Whether the factory turns `authserv` on is the owner's decision at
  factory design time.

## Known edges
- Old auto-responders that set only `Precedence` or `X-Autoreply` are not detected; they get one re-ask.
- Strict envelope equality refuses an owner whose provider rewrites MAIL FROM (VERP or SRS). It fails closed.
