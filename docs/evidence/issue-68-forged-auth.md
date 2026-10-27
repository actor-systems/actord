# Issue #68: a forged `Authentication-Results` header through Cloudflare Email Routing

**Run:** 2026-10-27, 00:40Z–00:47Z.

**Question:** spike 6 left two things unverified (`docs/evidence/spike-6-email.md`):
- does Cloudflare always add its own `Authentication-Results` header?
- does it strip an inbound one that claims its authserv-id, `mx.cloudflare.net`, as RFC 8601 §5 asks?

**Who did what:**
- The controller sent four messages over SMTP and read the Worker's record.
- The owner generated and uploaded a new bearer token for the spike, because the first one was deleted together with
  the plan 2 worktree.

**Setup:**
- **The receiver:** the spike 6 Worker and its routing rule (`spikes/email-approval`), unchanged. The Worker stores
  every header line before `handleEmail` runs. Its email source has no `authserv`.
- **The sender:** Python's `smtplib` on a residential IPv4 connection, talking straight to Cloudflare's MX hosts
  with STARTTLS.
  - The sending IP isn't in any SPF record for the sender's domain, and the messages carry no DKIM signature.
  - Each message's first header is a forged `Authentication-Results`.
  - None carries an approval token, so nothing could be approved.

| Case | MX host | Envelope sender and `From` | Forged first header |
| --- | --- | --- | --- |
| m1 | `route1.mx.cloudflare.net` | the owner, `jaredcolin@gmail.com` | `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=gmail.com` |
| m2 | `route1.mx.cloudflare.net` | the owner | `Authentication-Results: MX.CLOUDFLARE.NET; dmarc=pass header.from=gmail.com` |
| m3 | `route2.mx.cloudflare.net` | `issue68-test@actord.dev` | `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=actord.dev` |
| m4 | `route3.mx.cloudflare.net` | `issue68-test@actord.dev` | the same as m3 |

m3 and m4 aren't from the owner, so `handleEmail` drops them without a reply. They check the other two MX hosts
without sending the owner anything.

## Results

| Question | Observed | Result |
| --- | --- | --- |
| Does Cloudflare accept mail that passes neither SPF nor DKIM? | Yes. All four got `250` at `MAIL`, at `RCPT` and after `DATA`, and reached the Worker within 2 s. | **accepted** |
| Does Cloudflare add its own header? | Yes, in all four, above everything that arrived with the message. | **pass** |
| Does Cloudflare strip a forged header that claims `mx.cloudflare.net`? | No, in either spelling. The forged line arrived unchanged, directly below Cloudflare's own. | **not stripped** |
| What does Cloudflare's header say? | `dmarc=none … policy.dmarc=none` for both `gmail.com` and `actord.dev`, with `spf=softfail` for the envelope sender. | `none`, not `fail` |
| What did `handleEmail` do? | m1 and m2 passed the sender check, were recorded as `source.ignored` (`no_token`), and each got the generic missing-token reply, sent to the owner. m3 and m4 were recorded as `source.rejected` (`not_owner`), with no reply. | see below |

**Accepted without authentication.** Cloudflare's Postmaster page says Email Routing rejects mail that passes neither
SPF nor DKIM. Its 2025-06-30 changelog scopes that requirement to forwarding, and warns Worker users that `forward()`
may fail. Mail routed to a Worker is delivered even when it is unauthenticated.

## Header order as the Worker received it (m1)

**Added by Cloudflare, on top:**

1. `Received: from <HELO name> (<test IP>) by cloudflare-email.net (cloudflare) id … for <approvals@actord.dev>`.
2. `ARC-Seal: i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none`.
3. `ARC-Message-Signature: i=1; … d=cloudflare-email.net …`.
4. `ARC-Authentication-Results: i=1; mx.cloudflare.net; …` (the same results as line 6).
5. `Received-SPF: softfail (mx.cloudflare.net: …) receiver=mx.cloudflare.net; … envelope-from="jaredcolin@gmail.com"`.
6. **`Authentication-Results: mx.cloudflare.net; …`**: Cloudflare's own, the topmost.
7. `X-CF-SpamH-Score: 1`.

**As sent:**

8. **`Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=gmail.com`**: the forged one, unchanged.
9. `From`, `To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` and `Content-Type`.

m2, m3 and m4 had the same layout. m2's forged line kept its upper-case `MX.CLOUDFLARE.NET`.

Cloudflare's header on m1, verbatim except for the sending IP:

```
Authentication-Results: mx.cloudflare.net;
	dmarc=none header.from=gmail.com policy.dmarc=none;
	spf=none (mx.cloudflare.net: no SPF records found for postmaster@216.50.168.192.in-addr.arpa) smtp.helo=216.50.168.192.in-addr.arpa;
	spf=softfail (mx.cloudflare.net: domain of jaredcolin@gmail.com reports soft fail for <test IP>) smtp.mailfrom=jaredcolin@gmail.com;
	arc=none smtp.remote-ip=<test IP>
```

The HELO name is what Python offered by default: the reverse-DNS name of the machine's private LAN address.

## What this settles, and what it doesn't

**Settled:**
- **Cloudflare's header was topmost on every path tried.** That is five messages:
  - spike 6's Gmail reply: DKIM-signed, over IPv6, through `route1`;
  - these four: unauthenticated, over IPv4, through each of `route1`, `route2` and `route3`.
- **Cloudflare doesn't strip a forged header that claims its authserv-id.** RFC 8601 §5 says it should. So the
  forged line is always there for a reader that takes the wrong header; reading only the topmost one is what keeps it
  out.
- **With `authserv` set to `mx.cloudflare.net`, m1 would be `"unknown"`.** The topmost header is Cloudflare's and says
  `dmarc=none`, so a forged `dmarc=pass` below it doesn't count. That is exactly the runtime test
  `[email-forged-auth] (em-forged-b)`: a trusted header without `dmarc=pass` on top, and a forged `pass` with the same
  authserv-id below. The test asserted then that the reply is `"unknown"` and can't approve a `publishes: true`
  effect. Since #69, with `authserv` set, such a reply is refused without an answer.

**New finding: Cloudflare writes `dmarc=none` where RFC 7489 says `fail`.**
- `gmail.com` publishes a DMARC record (`p=none`), and m1 wasn't aligned, yet Cloudflare reported `dmarc=none`.
  Mail that fails a stricter policy is rejected at SMTP, according to Cloudflare's docs. So, under Cloudflare, the
  handler's "`dmarc=fail` refuses the reply" rule may never fire on Cloudflare's own verdict.
- **Consequence:** m1 and m2 passed the sender check on forged addresses, and the Worker emailed the owner. Decision
  0021 says a stranger can't make the system email the owner; a stranger who forges the owner's address can.
- The reply still goes to the owner, not the forger, and nothing is approved without a valid token.
- **Filed as #69**, ruling first.

**Not verified:**
- "Always" rests on five messages, not proof. No path was found on which Cloudflare adds no header.
- Mail DKIM-signed by a third domain wasn't tried, because it needs a DNS record for a signing key.

## The factory's choice about `authserv`

The ruling on #68 decided in advance: if Cloudflare's header is topmost on forged mail, and the forged one is removed
or stays below it, the factory may set `authserv` to `mx.cloudflare.net`. The forged header stayed below, so:
**the factory sets `authserv` to `mx.cloudflare.net`.**

Two risks remain:
- the factory relies on Cloudflare always writing its header first;
- if that ever changes, a forged header could be the one on top.

That is why the factory still needs the subject token, which only the owner's mailbox has. The factory's own
design can revisit this choice.

## Cost

$0:
- four inbound messages to Email Routing, which is free;
- two replies to the owner's verified destination address, which are free and outside every quota;
- a handful of Worker and Durable Object requests.

The spike Worker and its routing rule are still deployed; teardown is the owner's call
(`spikes/email-approval/README.md`).
