# Spike 6: a real Gmail reply approves a parked effect

**Run:** 2026-10-26, 12:23Z–12:26Z.

**Who did what:**
- The owner enabled Email Routing on `actord.dev`, deployed the Worker, set both secrets and created the routing rule.
- The controller sent the approval request and the `Message-ID` probe.
- The owner replied `approve` from Gmail.

**Setup:**
- The Worker is `spikes/email-approval` (commit `ee63350`), deployed to workers.dev with wrangler 4.152.0. It imports
  the built `@actord/toolkit` 0.2.0.
- **Inbound:** Email Routing on `actord.dev`, with one rule: `approvals@actord.dev` goes to the Worker.
- **Outbound:** Email Routing's `send_email` binding, restricted to the owner's verified destination address. No
  sending domain is onboarded.
- **The email source has no `authserv`,** on purpose, so every reply is `"unknown"`. The effect, `spike.act`, is
  `approval: "human"` and not `publishes`.

These results come from the Worker's `GET /spike` record, read once. The raw record isn't committed because it holds
signatures and the live token.

## Results

| Question | Observed | Result |
| --- | --- | --- |
| Is the request delivered? | The notify effect sent `Approve spike.act? [actord:…]` from `approvals@actord.dev` at 12:23:21.817Z. It was `confirmed` after 1 attempt, and the binding returned `{ messageId: "<smDJTmBWUyAz7ajWHooOQluu7aImkEMLp2WB@actord.dev>" }`. It reached Gmail. Whether it landed in the Inbox or Spam wasn't recorded. | pass |
| Does the subject token survive a Gmail reply? | The reply's subject was `Re: Approve spike.act? [actord:…]`. The 180-character token matched the one sent, byte for byte. | **pass** |
| What is the envelope sender of a Gmail message? | `message.from` was `jaredcolin@gmail.com`, with no VERP or SRS rewrite. The header `From` was `Jared McFarland <jaredcolin@gmail.com>`. | equals the owner |
| What is `In-Reply-To`? | `In-Reply-To` and `References` were both `<smDJTmBWUyAz7ajWHooOQluu7aImkEMLp2WB@actord.dev>`, which is exactly the `messageId` the binding returned. | the request's id |
| Can the binding set `Message-ID`? | No. The probe's send was refused with `E_VALIDATION_ERROR`: "custom header 'Message-ID' is not allowed. Only whitelisted headers and X-* headers are accepted." Nothing was sent. The docs name the error `E_HEADER_NOT_ALLOWED`; production answered `E_VALIDATION_ERROR`. | no; Cloudflare assigns it |
| Is an `Authentication-Results` header visible? | Yes, exactly one. Cloudflare wrote it above every header that arrived with the message. Its authserv-id is **`mx.cloudflare.net`**. | **pass** |
| Are DKIM and DMARC results visible? | `dkim=pass header.d=gmail.com`, `dmarc=pass header.from=gmail.com policy.dmarc=none`, `spf=pass smtp.mailfrom=jaredcolin@gmail.com` and `arc=pass`. | **`dmarc=pass` visible** |
| What decision was delivered? | `approval.decided` was `{ effect: "spike.act", effectKey: "ask-1793017399534", decision: "approve", reason: null, by: "jaredcolin@gmail.com", authenticated: "unknown" }`. `applyDecision` answered `true`. | pass |
| What was the effect's outcome? | `spike.act` ran once and is `confirmed` (12:25:05.899Z). The outbox shows both effects `confirmed` after 1 attempt. | pass |
| How long did delivery take? | Gmail's `Date` was 12:24:25Z. Google's outbound `X-Received` was 12:25:04Z, Cloudflare's `Received` 12:25:05Z, and the Worker stored the headers at 12:25:05.786Z. That is about 1.3 s from Google's outbound hop to the Worker, and about 41 s after the `Date` header. | — |

`handleEmail` returned normally.

No `source.*` events were captured, and that is expected:
- a delivered reply emits no `source.*` event;
- in production, the `Desk` Durable Object ran outside the Worker's isolate, so its own events weren't captured either.

The decision and outbox rows above are the record of the delivery.

## The `Authentication-Results` header, verbatim

The only redaction is the DKIM signature fragment `header.b=`, shown as `…`.

```
Authentication-Results: mx.cloudflare.net;
	dkim=pass header.d=gmail.com header.s=20251104 header.b=…;
	dmarc=pass header.from=gmail.com policy.dmarc=none;
	spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-vs1-xe34.google.com) smtp.helo=mail-vs1-xe34.google.com;
	spf=pass (mx.cloudflare.net: domain of jaredcolin@gmail.com designates 2607:f8b0:4864:20::e34 as permitted sender) smtp.mailfrom=jaredcolin@gmail.com;
	arc=pass smtp.remote-ip="2607:f8b0:4864:20::e34"
```

`ARC-Authentication-Results: i=2; mx.cloudflare.net; …` repeats the same results. It's a different header name, so the
handler never reads it as `Authentication-Results`.

## Header order as the Worker received it

There were 26 header lines in total, and `rawSize` was 8,893 bytes. `Received` lines are summarised below, and the
`b=` and `bh=` values are left out.

**Added by Cloudflare, on top:**

1. `Received`: hop 2, from Google's outbound server `mail-vs1-xe34.google.com` (a Google IPv6 address) by
   `cloudflare-email.net`, at 12:25:05 +0000.
2. `ARC-Seal`: `i=2; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=pass`.
3. `ARC-Message-Signature`: `i=2; … d=cloudflare-email.net …`.
4. `ARC-Authentication-Results`: `i=2; mx.cloudflare.net; …` (the same results as below).
5. `Received-SPF`: `pass (mx.cloudflare.net: …) receiver=mx.cloudflare.net; … envelope-from="jaredcolin@gmail.com"`.
6. **`Authentication-Results: mx.cloudflare.net; …`**: the only one in the message.
7. `X-CF-SpamH-Score: 0`.

**Written by Gmail:**

8. `Received`: hop 1, inside Google, by `mail-vs1-xe34.google.com` with SMTP, at 05:25:05 −0700.
9. `ARC-Seal`: `i=1; … d=google.com; s=arc-20260327; cv=none`.
10. `ARC-Message-Signature`: `i=1; … d=google.com …; darn=actord.dev`.
11. `ARC-Authentication-Results`: `i=1; mx.google.com; arc=none`.
12. `DKIM-Signature`: the spike stores this header's name only.
13. `X-Google-DKIM-Signature`, `X-Gm-Message-State`, `X-Gm-Gg` and `X-Received`.
14. `MIME-Version: 1.0`.
15. `References` and `In-Reply-To`: both are the request's Message-ID.
16. `From: Jared McFarland <jaredcolin@gmail.com>` and `Date: Mon, 26 Oct 2026 05:24:25 -0700`.
17. `X-Gm-Features`.
18. `Message-ID: <CAJZ9Keup=5_nOAsmEAGj4suPZvHAsnqmxd66Zsq4mdVCzkp0wg@mail.gmail.com>`.
19. `Subject: Re: Approve spike.act? [actord:eyJhY3RvciI6IkRlc2siLCJrZXkiOiJtYWluIiwiZWZmZWN0Ijoic3Bpa2UuYWN0IiwiZWZmZWN0S2V5IjoiYXNrLTE3OTMwMTczOTk1MzQiLCJleHAiOjE3OTMyNzY1OTk1NDV9.…]`.
    The signature is replaced with `…`. The claims decode to `{ "actor": "Desk", "key": "main", "effect": "spike.act",
    "effectKey": "ask-1793017399534", "exp": 1793276599545 }`. The `exp` is 2026-10-29T12:23:19.545Z, three days
    after the request, which is the default approval expiry.
20. `To: approvals@actord.dev` and `Content-Type: multipart/alternative; …`.

## Replay with `authserv` set (offline)

The stored header lines, in order, were replayed through the shipped `handleEmail` (`packages/toolkit/dist/sources.mjs`)
in Node, with a stub delivery target. Two things differ from the real message:
- the subject token was re-signed with a test secret, because the deployed secret was never known;
- the replayed `DKIM-Signature` line has a placeholder value, because the spike never stored the real one. The
  handler doesn't read it.

| `authserv` | Effect | Reply | Result |
| --- | --- | --- | --- |
| unset | not `publishes` | `approve` | delivered, `authenticated: "unknown"` (as in production) |
| unset | `publishes: true` | `approve` | refused, `source.rejected: publishes_unauthenticated` |
| `mx.cloudflare.net` | `publishes: true` | `approve` | delivered, **`authenticated: "pass"`** |
| `MX.CLOUDFLARE.NET` | `publishes: true` | `approve` | refused (`publishes_unauthenticated`): today the authserv-id compare is case-sensitive |

## What this settles, and what it doesn't

**Settled:**
- Cloudflare Email Routing writes `Authentication-Results: mx.cloudflare.net; …` above the message's own headers, and
  it is the topmost header the Worker sees.
- A Gmail reply from the owner carries `dmarc=pass` there.
- The subject token survives the reply.
- The envelope sender equals the owner's address.
- The binding can't set `Message-ID`. Replies thread on the id Cloudflare assigns, and `send()` returns that id.

So an app **may** set `authserv` to an env entry holding `mx.cloudflare.net`, and then an authenticated email can
approve a `publishes: true` effect. The code already allows it.

**`gmail.com` publishes `p=none`** (`v=DMARC1; p=none; sp=quarantine; …`). So Cloudflare doesn't reject mail at SMTP
time that forges the owner's Gmail address. Cloudflare only requires SPF or DKIM to pass for some domain. Such mail
would arrive with Cloudflare's own `dmarc=fail`, and the handler refuses any reply with `dmarc=fail` in any
`Authentication-Results` header. A forger would also need a validly signed, unexpired token from the request's
subject.

**Not verified:**
- whether Cloudflare **always** adds its own header;
- whether Cloudflare **strips** an inbound `Authentication-Results` header that claims `mx.cloudflare.net`.

Only the topmost header is read, and in this one sample Cloudflare's header sat above everything that arrived with the
message. So a forged header could win only on a path where Cloudflare adds none. This is one sample, not proof.
Testing it needs mail with a forged header sent over SMTP, which the spike didn't do.

**Hardening, deferred to plan 2's final fix wave.** This should land before the factory turns `authserv` on:
- every `dmarc` result in the trusted header must be `pass`;
- `header.from` must equal the owner's domain;
- the authserv-id must be compared case-insensitively (the last replay row).

Whether the factory turns `authserv` on is the owner's decision, made at factory design time.

## Cost

$0 by the docs' pricing:
- sends to a verified destination are free and outside every quota;
- Email Routing is free;
- the Worker and its one Durable Object handled a handful of requests.

The Worker and the routing rule are still deployed; teardown is the owner's call (`spikes/email-approval/README.md`).
