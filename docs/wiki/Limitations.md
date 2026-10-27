# Limitations and unverified claims

- **Not guaranteed by the runtime:** exactly-once external effects, global message ordering, transactions
  across actors, or a route as a security boundary. An effect without an idempotency key that loses its
  acknowledgment is reported `in_doubt`, never delivered. Nothing here undoes an external action.
- **A larger install.** `@actord/toolkit` requires `agents` 0.30.1 (pinned) as a peer dependency. With its
  dependencies and required peers, that adds about 170 packages to every project that installs the toolkit: this
  repository's lockfile grew from 197 to 348 packages when the runtime moved onto the Agents SDK. This is accepted
  (#12), because the runtime is a Lifecycle capability of that SDK. Agent actors will add Pi and
  `@cloudflare/computer`.
- **Local evidence only.** Tests run in workerd through Cloudflare's Vitest integration; `actord events` and
  `actord trace` read logs from local runs and never see production. Nothing was deployed to Cloudflare.
- **Inside Claude Code's default sandbox, workerd tests can't run** (the sandbox denies the loopback port
  Miniflare needs), so `actord verify` reports `blocked` there rather than passing (decision 0004).
- **Measured contribution is modest and uneven.** Two release eval runs on this version: mean `Δ` +0.09 and
  +0.06, clearest on orientation, trace questions, and evolving a running system; near zero where the
  baseline already behaves well. Every safety case held. Inside eval runs agents can't run workerd tests, so
  an agent can't see its own failing test; re-run on the host, plugin runs passed 47 of 48 (baseline 45 of 48).
- **The Desktop app's first `/actord-room`** in a session can be flagged "isn't a command here" and be missing
  from the slash menu; it runs anyway and is listed after that.
- **Approver identity is whatever the approving sender supplies** over RPC. By email it is the verified sender
  address, but the record is evidence, not proof.
- **Email authentication is `"unknown"` unless the app sets `authserv`.**
  - **What spike 6 showed:** Cloudflare Email Routing writes one `Authentication-Results` header, the topmost one, with
    authserv-id `mx.cloudflare.net`. A Gmail reply carried `dmarc=pass` there.
  - **Setting it:** an app may set `authserv` to an env entry holding `mx.cloudflare.net`. Then a reply is `"pass"`
    only when that topmost header has at least one `dmarc` result, every one `pass` with `header.from` the owner's
    domain, and such a reply can approve an effect declared `publishes: true`. Any other reply is refused without
    an answer.
  - **Leaving it unset:** every reply is `"unknown"`. An email can then approve mid-run tool calls but never a
    `publishes: true` effect; approve those in GitHub.
  - **Forged headers (issue #68):** Cloudflare doesn't strip an inbound header that claims `mx.cloudflare.net`. It
    adds its own above it, and only the topmost header is read. In five messages over three MX hosts, signed and
    unsigned, Cloudflare's header was always topmost. That isn't proof that it always will be.
  - **The hardening has landed:** every `dmarc` result must be `pass`, `header.from` must be the owner's domain, and
    the authserv-id compares case-insensitively. The factory sets `authserv` to `mx.cloudflare.net`.
  - **Without `authserv`, forging the owner's address gets the owner a reply.** For an unaligned message from a
    `p=none` domain such as `gmail.com`, Cloudflare writes `dmarc=none`, not `dmarc=fail`. So mail forging the
    owner's address on both envelope and `From` passes the sender check and gets the handler's reply, which goes to
    the owner. It can't approve anything without a valid token. With `authserv`, such mail is refused without a
    reply (#69).
  - **With `authserv`, an owner's reply that isn't `"pass"` is dropped silently.** The owner hears nothing back;
    only a `source.rejected` (`unauthenticated`) event records it. A missing or empty `authserv` value refuses all
    mail and records `authserv_missing`.
  - **The owner's acknowledgement says what arrived, not what it did.** After a delivered answer the reply reads
    `Received: approve for <effect> (<key>). If it had already been decided or had expired, this changed nothing.`
    Whether `ctx.approve` or `ctx.deny` changed anything isn't reported back by email.
  - **Other edges:** strict envelope-sender equality refuses an owner whose provider rewrites MAIL FROM (VERP, SRS); it
    fails closed. An auto-responder that sets none of `Auto-Submitted`, `Precedence: bulk|junk|list|auto_reply`,
    `X-Autoreply` or `X-Autorespond` isn't detected, and its text is read like a person's.
- **GitHub doesn't redeliver failures automatically.** Failed deliveries can be redelivered manually (UI or API) for a limited period; a timeout counts as a failure, as do a `4xx` and `5xx`. `source.invalid` and `source.failed`
  records (with the delivery id) are how a missed event is found. A captured signed delivery can be replayed
  under a new `X-GitHub-Delivery` and is then a new event: keep the secret, use HTTPS, make handlers idempotent
  on business keys.
- **The default approval email includes the effect's input as JSON.** Supply `describe()` for sensitive inputs.
  Declare the notify effect with `idempotency: "none"`; with `"key"`, a notify still retrying after the decision can still send.
- **Guards are conveniences.** The effect guard and the generated `ask` rules match command text; other
  spellings slip past. Token scopes are the enforceable layer.
- **Mods are an early-access Claude Code API** (2.1.287+); the Room is tested against 2.1.310 in the terminal
  and 2.1.308 in the Desktop app, and may need
  changes as the API moves. The core works without it (`scripts/no-hooks-smoke.sh`).
- Monitors run only in interactive sessions, and not on Bedrock, Google Cloud's Agent Platform, or Foundry
  before Claude Code 2.1.310.
