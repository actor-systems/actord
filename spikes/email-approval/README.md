# Spike 6: an email approval through real Gmail

This spike checks one thing against the real services: an approval request emailed by Cloudflare reaches Gmail, and
the owner's Gmail reply comes back through Email Routing and approves the parked effect. It also records what
decision 0021 left open: the `Authentication-Results` header Cloudflare writes and its authserv-id, whether that
header is the topmost one, whether the subject token survives the reply, the envelope sender of a Gmail message,
the reply's `In-Reply-To`, and whether the send binding lets a Worker set `Message-ID`.

## What it is

There is one actor, `Desk`, with one instance, `main`. It asks for `spike.act`, a harmless effect that only records
that it ran. The effect needs a person's approval (`approval: "human"`). It is not declared `publishes: true`,
because the email source deliberately has no `authserv`: every reply is `"unknown"`, so the owner's `approve` must
be allowed to go through.

1. The system's `approvals.notify` effect uses the toolkit's `approvalEmail` adapter. It emails
   `jaredcolin@gmail.com` from `approvals@actord.dev`, with the subject `Approve spike.act? [actord:<token>]`.
2. An Email Routing rule hands mail for `approvals@actord.dev` to this Worker's `email()` handler.
3. Before calling `handleEmail`, the handler stores in `Desk`'s SQLite:
   - the envelope sender and recipient;
   - every raw header line, in order. `DKIM-Signature` is kept by name only.
4. It then stores `handleEmail`'s outcome and the `source.*` (and other actord) events written while it ran.
5. Every send is recorded with what the binding returned, which is `{ messageId }`. That covers the approval
   request, any reply `handleEmail` sends, and the probe.

Every endpoint needs `Authorization: Bearer <SPIKE_TOKEN>`; anything else gets `401`.

| Request | What it does |
| --- | --- |
| `GET /spike` | Returns everything stored: inbound headers, outbound sends, decisions, outcomes, the outbox |
| `POST /spike/ask[?key=…]` | Parks a new approval, which emails the owner once |
| `POST /spike/message-id-probe` | Tries one send with its own `Message-ID` header and records the answer (optional) |

The spike imports the built toolkit (`@actord/toolkit/*`), as an app would. `packages/toolkit/dist/` must be current.
If it is missing, run `npm run build -w @actord/toolkit` first.

## Before you start: what was checked (read-only, 2026-10-26)

- **`actord.dev` has no MX records, and no TXT, A or `_dmarc` records either.** Its nameservers are Cloudflare's
  (`lochlan`, `nancy`). Email Routing on the zone is `unconfigured`.
  - **Warning:** enabling Email Routing adds and locks MX records, an SPF TXT record and a DKIM record. On a domain
    that already received mail, that would replace its mail setup. `actord.dev` has none today, so nothing is
    lost. Check again with `dig MX actord.dev +short` if time has passed.
- **`jaredcolin@gmail.com` is already a verified Email Routing destination address** on this account (verified
  2026-10-23). Destination addresses are account-wide, so there's no verification step. Teardown must not delete it,
  because it predates the spike and other zones' routing may use it.
- `npx wrangler whoami` shows the `email_routing (write)` scope, so no new login is needed.

## Sending path: Email Routing's `send_email` binding to a verified destination

The other option was Email Sending, which means onboarding `actord.dev` as a sending domain. That adds `cf-bounce`
records and a DMARC record, and it needs Workers Paid. The binding path needs neither.

- Cloudflare's docs say a Worker's `send_email` binding can send to verified destination addresses even when only
  Email Routing is configured. It must send from a routing domain. These sends are free on every plan, and they
  don't count toward any quota or daily limit.
- The binding in `wrangler.jsonc` is restricted with `allowed_destination_addresses: ["jaredcolin@gmail.com"]`. The
  Worker can email nobody else.
- The binding's `send()` takes the structured form that `approvalEmail` uses, and it returns `{ messageId }`.
- **Message-ID can't be set.** Email Service documents `Message-ID` as platform-controlled. A send that sets it fails
  as a whole with `E_HEADER_NOT_ALLOWED`. The probe endpoint checks this once.
- `In-Reply-To`, `Auto-Submitted` and `X-*` headers are allowed.

## The owner's commands, in order

Run them from the worktree root (`.claude/worktrees/plan2-sources`). Each line is typed into Claude Code with `!`.
If any command says you're not logged in, run `! npx wrangler login` first.

1. **Enable Email Routing on `actord.dev`.** This adds the MX, SPF and DKIM records:

   ```
   ! npx wrangler email routing enable actord.dev
   ```

   If it fails with a permission error, use the dashboard instead: **Compute → Email Service → Email Routing →
   Onboard Domain → `actord.dev` → Add records and onboard**.

2. **Generate the bearer token** into the git-ignored `.spike-token` file:

   ```
   ! openssl rand -hex 32 > spikes/email-approval/.spike-token
   ```

3. **Deploy the Worker.** The URL it prints is also saved to the git-ignored `.deploy.log`:

   ```
   ! npx wrangler deploy -c spikes/email-approval/wrangler.jsonc 2>&1 | tee spikes/email-approval/.deploy.log
   ```

4. **Set the approval-signing secret.** Nobody needs to know its value:

   ```
   ! openssl rand -hex 32 | npx wrangler secret put SPIKE_APPROVAL_SECRET -c spikes/email-approval/wrangler.jsonc
   ```

5. **Upload the bearer token:**

   ```
   ! npx wrangler secret put SPIKE_TOKEN -c spikes/email-approval/wrangler.jsonc < spikes/email-approval/.spike-token
   ```

6. **Route `approvals@actord.dev` to the Worker:**

   ```
   ! npx wrangler email routing rules create actord.dev --name "spike 6 approvals" --match-type literal --match-field to --match-value approvals@actord.dev --action-type worker --action-value spike-email-approval
   ```

7. **Park an approval.** This emails you once:

   ```
   ! curl -sS -X POST -H "Authorization: Bearer $(cat spikes/email-approval/.spike-token)" "$(grep -o 'https://[a-z0-9.-]*workers\.dev' spikes/email-approval/.deploy.log | head -1)/spike/ask"
   ```

   The answer is `{"key":"ask-…","receipt":{"status":"handled",…}}`.

8. **Reply from Gmail.**
   - Find the email from `approvals@actord.dev` titled `Approve spike.act? [actord:…]`. It may land in Spam, because
     `actord.dev` publishes no DMARC record.
   - Press **Reply**: not Forward, and don't edit the subject.
   - Type `approve` as the first line and send.

Then tell the controller. Reading the results is not a privileged command:

```
curl -sS -H "Authorization: Bearer $(cat spikes/email-approval/.spike-token)" "$(grep -o 'https://[a-z0-9.-]*workers\.dev' spikes/email-approval/.deploy.log | head -1)/spike" | jq
```

**Optional:** the controller can also run the Message-ID probe. If the docs are right it is refused and sends nothing.
Otherwise it sends one email titled `spike 6: Message-ID probe`:

```
curl -sS -X POST -H "Authorization: Bearer $(cat spikes/email-approval/.spike-token)" "$(grep -o 'https://[a-z0-9.-]*workers\.dev' spikes/email-approval/.deploy.log | head -1)/spike/message-id-probe"
```

## Cost

Expected cost is $0.

- Email Routing is free on every plan.
- Sends to a verified destination address are free and outside every quota.
- The Worker and its one SQLite-backed Durable Object handle a few requests and a handful of rows. That is within
  the Workers Free allowances, and a rounding error on Workers Paid.

## Teardown

Run these in this order, from the worktree root.

1. **Find the rule's id.** This step is read-only:

   ```
   npx wrangler email routing rules list actord.dev
   ```

2. **Delete the routing rule:**

   ```
   ! npx wrangler email routing rules delete actord.dev <rule-id> -y
   ```

3. **Delete the Worker and its Durable Object data:**

   ```
   ! npx wrangler delete -c spikes/email-approval/wrangler.jsonc --force
   ```

4. **Optional: turn Email Routing off** on `actord.dev`. This also removes the MX records it added. Keep it on if
   `actord.dev` should keep receiving mail.

   ```
   ! npx wrangler email routing disable actord.dev
   ```

5. **Do not delete the destination address `jaredcolin@gmail.com`.** It was verified before this spike and is shared
   across the account.

6. **Remove the local files:**

   ```
   rm spikes/email-approval/.spike-token spikes/email-approval/.deploy.log
   ```

## Checked locally before handing over

Under `wrangler dev`, with simulated sending and a hand-made reply posted to `/cdn-cgi/handler/email`:

- requests without the token got `401`;
- `POST /spike/ask` parked `spike.act` and sent the approval email, whose result was `{ messageId: "<…@actord.dev>" }`;
- the reply was stored header by header;
- `handleEmail` delivered `approval.decided` with `authenticated: "unknown"`;
- the effect ran and was `confirmed`.

The local simulator also accepted a `Message-ID` header that production is documented to refuse, so only the deployed
probe answers that question.
