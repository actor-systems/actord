# Sources: webhooks and approvals by email reply

A source is where the outside world enters (decision 0017). It is declared in `system.ts` under `sources`, and its
name becomes a route sender: `github` is `@github`, `email` is `@email`. Routes deliver its messages like any
other; actors never subscribe. Import from `@actord/toolkit/sources`, except the `approvalDecided` schema, which
`system.ts` imports from `@actord/toolkit/system` (Node loads `system.ts` for `actord check`, and can't load the
sources entry point).

```ts
// actord:check system
import { approvalDecided, defineSystem, inboundEmail, message, webhook } from "@actord/toolkit/system";
import { z } from "zod";

const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional() });
type Issue = { issue: { number: number; title: string; body: string | null } };

export default defineSystem({
  name: "issue-desk",
  messages: {
    "issue.opened": message({ version: 1, description: "A GitHub issue was opened", payload: z.object({ number: z.number().int(), title: z.string(), body: z.string() }) }),
    "label.applied": message({ version: 1, description: "The outcome of github.label", payload: Outcome }),
    "approval.decided": message({ version: 1, description: "The owner answered an approval request by email", payload: approvalDecided }),
  },
  sources: {
    github: webhook({
      path: "/webhooks/github",
      verify: "github",
      secret: "GITHUB_WEBHOOK_SECRET", // the env entry's name, never the value
      events: {
        // "<X-GitHub-Event>.<action>" (the bare event name when the payload has no action). `key` picks the
        // receiving instance; `map` builds the payload, which is validated against the message's schema.
        "issues.opened": {
          message: "issue.opened",
          key: (e: Issue) => String(e.issue.number),
          map: (e: Issue) => ({ number: e.issue.number, title: e.issue.title, body: e.issue.body ?? "" }),
        },
      },
    }),
    // Each field names an env entry. authserv's holds the trusted authserv-id: "mx.cloudflare.net" for Email Routing.
    email: inboundEmail({ secret: "APPROVAL_SECRET", owner: "OWNER", from: "APPROVAL_FROM", send: "MAIL", authserv: "AUTHSERV", message: "approval.decided" }),
  },
  approvals: { notify: "notify.approval" },
  actors: {
    IssueDesk: {
      binding: "ISSUE_DESK",
      kind: "deterministic",
      purpose: "Triages one issue (one instance per number) and labels it once the owner approves",
      justification: ["identity", "permissions"],
      effects: ["github.label", "notify.approval"],
    },
  },
  effects: {
    "github.label": { description: "Label the issue on GitHub", idempotency: "key", approval: "human", result: "label.applied" },
    // Must not need approval itself. "none": with "key", a notify still retrying after the decision could still send.
    "notify.approval": { description: "Email the owner that an approval is waiting", idempotency: "none" },
  },
  routes: [
    { from: "@github", message: "issue.opened", to: "IssueDesk" },
    { from: "IssueDesk", message: "label.applied", to: "IssueDesk" },
    { from: "@email", message: "approval.decided", to: "IssueDesk" },
  ],
});
```

The actor, and the Worker entry that hands requests and mail to the sources:

```ts
// actord:check
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { actorRuntime, type EffectAdapter, type Envelope } from "@actord/toolkit/runtime";
import { applyDecision, approvalEmail, type ForwardableEmailLike, handleEmail, handleWebhook } from "@actord/toolkit/sources";
import system from "./system";

/** Stand-in: logs instead of labelling. A real adapter calls GitHub with the key (runtime.md, Effects). */
const label: EffectAdapter<{ number: number; label: string }, { labelled: true }> = {
  async run(input, { key }) {
    console.log(`github.label ${key}: #${input.number} ${input.label}`);
    return { labelled: true };
  },
};

export class IssueDesk extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS issues (number INTEGER PRIMARY KEY, title TEXT NOT NULL, label TEXT)");
  }

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "IssueDesk", {
    // A GitHub redelivery has the same X-GitHub-Delivery, the envelope id, so it is a duplicate and never gets here.
    "issue.opened": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO issues (number, title) VALUES (?, ?) ON CONFLICT (number) DO NOTHING", payload.number, payload.title);
      ctx.effect("github.label", { number: payload.number, label: "triaged" }, { key: String(payload.number) }); // parks; one email
    },
    // The owner's reply, already verified by handleEmail: approve or deny the parked effect it names.
    "approval.decided": ({ payload }, ctx) => {
      if (!applyDecision(ctx, payload)) ctx.note("nothing waiting: already decided, or expired", { effectKey: payload.effectKey });
    },
    "label.applied": ({ payload }, ctx) => {
      ctx.sql.exec("UPDATE issues SET label = ? WHERE number = ?", payload.status, Number(payload.key));
    },
  }, {
    effects: {
      "github.label": label,
      // `to` and `secret` must be the email source's env[owner] and env[secret], byte for byte (don't trim one side):
      // the subject token is signed with one and verified with the other.
      "notify.approval": approvalEmail({ send: this.env.MAIL, from: this.env.APPROVAL_FROM, to: this.env.OWNER, secret: this.env.APPROVAL_SECRET }),
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hooked = await handleWebhook(request, env, system); // first; null for any other path
    if (hooked !== null) return hooked;
    return new Response("not found", { status: 404 });
  },
  email: (message: ForwardableEmailLike, env: Env) => handleEmail(message, env, system),
};
```

In the app, type the Worker as `satisfies ExportedHandler<Env>`; `ForwardableEmailLike` is the part of the runtime's
`ForwardableEmailMessage` that `handleEmail` reads.

## Configuration

Secrets go in `.dev.vars` locally (from `.dev.vars.example`, which names them) and `wrangler secret put` in
production; plain values go in wrangler `vars`. `actord check` warns when a source's entry is in neither `vars` nor
`.dev.vars.example` (`SOURCE_SECRET_UNDECLARED`, `SOURCE_ENV_UNDECLARED`), or `send_email` doesn't declare its `send`
binding (`SOURCE_SEND_UNDECLARED`).

```
# .dev.vars.example
GITHUB_WEBHOOK_SECRET=
APPROVAL_SECRET=
```

```jsonc
// wrangler.jsonc (part)
"vars": { "OWNER": "owner@example.com", "APPROVAL_FROM": "approvals@example.com", "AUTHSERV": "mx.cloudflare.net" },
"send_email": [{ "name": "MAIL", "allowed_destination_addresses": ["owner@example.com"] }]
```

## Webhooks

- `handleWebhook` checks the HMAC of the raw body first, in constant time, then maps the event. The provider's
  delivery id is the envelope id, so a redelivery is `duplicate`.
- Answers: `202` handled or duplicate; `204` unmapped event (`source.ignored`); `400` invalid, such as a payload the
  schema refuses (`source.invalid`); `401` bad signature (`source.rejected`); `405` not `POST`; `500` the secret is
  missing (`source.rejected`) or the delivery failed (`source.failed`).
- GitHub doesn't redeliver failures by itself. `source.invalid` and `source.failed` carry the delivery id:
  `actord events --notable` finds them.
- A captured delivery replayed under a new delivery id is a new event. Keep handlers idempotent on business keys, as
  `issue.opened` is on the issue number.

## Approvals by email reply (decisions 0017 and 0021)

- Declare `approvals: { notify: "<effect>" }`, list that effect in every actor that requests approvals, and give it
  the `approvalEmail` adapter with `idempotency: "none"` (`actord check` warns `EFFECT_IN_DOUBT` on it; that is
  expected: a lost send is reported in doubt, never retried). Parking an effect queues one notification per parked
  approval; parking it again sends nothing new. If the notification fails, the effect stays parked and still expires.
- The email includes the effect's input as JSON. Pass `describe(request)` to `approvalEmail` when inputs are
  sensitive. It returns `{ action, why, link? }`.
- `handleEmail` accepts only the owner's reply with a valid, unexpired subject token and a first line of `approve`
  or `deny <reason>`. It delivers `approval.decided` (`{ effect, effectKey, decision, reason, by, authenticated }`),
  and replies to the owner, saying what arrived, not what it changed.
- With `authserv` set, a reply must authenticate as `"pass"`, or it is dropped without a reply (`source.rejected`,
  `unauthenticated`). Without it, every reply is `"unknown"`, and an effect declared `publishes: true` can't be
  approved by email: approve it in GitHub.
- The order of the checks, the forged-header analysis (#68), and the edges (VERP, auto-responders) are in
  Limitations, "Email authentication is unknown unless the app sets authserv". Read it before relying on email
  approval for anything that publishes.
- An approval expires (`expires`, default `"3d"`): `timers-and-jobs.md`.

## Testing

- A webhook test posts through the Worker's own `fetch` (`SELF.fetch` from `cloudflare:test`), with
  `X-GitHub-Event`, `X-GitHub-Delivery`, and `X-Hub-Signature-256: sha256=<hex HMAC-SHA-256 of the body>`. The test's
  wrangler config gives the secret in `vars`. The same delivery id twice proves the redelivery is a duplicate.
- An email test captures the request with `overrideEffect("notify.approval", approvalEmail({ send: fake, … }))`, then
  builds the owner's reply for `handleEmail`.
- `packages/toolkit/test-runtime/sources.test.ts` has both.
