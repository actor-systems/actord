# 0017 — Sources: system-level senders with generated handlers

- **Date:** 2026-10-26 · **Gate:** plan 2 (sources and email approvals) · **Status:** accepted · **Reversibility:**
  moderate (a new declaration `sources`, new `source.*` events, and a new route sender; existing systems are unchanged)

## Context
Things outside the system start work: GitHub sends webhooks, a person replies to an email. Until now an app wrote
its own `fetch()` and `email()` code for them, each time re-deciding how to verify the sender, what to answer, and
how to make a retry harmless. That is where a missed check becomes a hole. A source should be declared once,
visible to `actord check` and the graph, and handled by code the toolkit owns.

## Decisions
1. **A source is a sender in the system, not an actor.** `sources: { github: webhook({...}), mail: inboundEmail({...}) }`
   in `system.ts`. Its name becomes the route sender `@github` or `@mail`, and routes name it like any other
   (`{ from: "@github", message: "issue.opened", to: "Triage" }`). Receivers need no new concept: a source's message
   is an ordinary message, validated and deduplicated by the receiver's inbox.
2. **Actors never subscribe to a source.** Subscribing would make delivery depend on actors that are running and on
   state outside the declaration. A route is declared, checked, and the only way in. `actord check` requires exactly
   one route from a webhook source for each message it maps, so that message must be declared too, and refuses a
   source named after a sender the runtime uses itself (`clock`, `ingress`, `timer`, `rpc`: `SOURCE_NAME_RESERVED`).
   The secret is only advised: when neither wrangler `vars` nor `.dev.vars.example` names it, the check warns
   (`SOURCE_SECRET_UNDECLARED`) and still passes.
3. **The handler is generated, not hand-written.** `handleWebhook(request, env, system)` returns a `Response`, or
   `null` when the path isn't a source's, so the app's own routes run. `handleEmail(message, env, system)` serves the
   `email()` handler. Both read the declaration and deliver with `deliverExternal`, the same path `ingress` uses, so
   the cost is one `receive()` RPC and the handler never awaits an actor's work beyond it.
4. **The webhook's order is fixed: verify, map, validate, deliver, answer.** The signature
   (`X-Hub-Signature-256`, HMAC-SHA256 of the raw bytes, compared in constant time) is checked before anything is
   parsed. A secret that is not configured is a `500`, never a pass.
5. **Status codes, and what each leaves behind:**

   | Answer | When | Recorded as |
   | --- | --- | --- |
   | `202` | delivered (`handled`), or already delivered (`duplicate`) | the receiver's own events |
   | `204` | no mapping for `<event>.<action>` | `source.ignored` |
   | `400` | missing delivery id or event, bad JSON, `map`/`key` threw, payload fails the message's schema, key not a non-empty string, or the receiver rejected it | `source.invalid` |
   | `401` | signature missing or wrong | `source.rejected` |
   | `405` | not `POST` | none |
   | `500` | secret not configured, no route, unknown message, delivery failed, or the receiver's handler failed | `source.rejected` or `source.failed` |

   Every record has the actor `@<source>`. Once the delivery id is known and the signature passed, it is the record's `messageId`; the `signature`, `secret_missing` and `delivery_id_missing` records carry the delivery id, if any, in `detail` instead.
6. **Ids come from the provider's delivery id.** The envelope id is `X-GitHub-Delivery`, so GitHub redelivering the
   same delivery is `duplicate` (answered `202`) and runs nothing twice. `key` in an event's declaration picks the
   receiving actor's instance; it is not a dedupe id. An email's envelope id is `deriveId("email", <Message-ID>)`.
7. **GitHub does not redeliver failed deliveries automatically; they can be redelivered manually (UI or API) for a limited period. A timeout counts as a failure, as do a `4xx` or `5xx`.** Nobody retries for us. So a failure is never
   silent: `source.invalid` and `source.failed` carry the delivery id, and that record is how a missed event is
   found and redelivered by hand from GitHub's delivery log (`actord events` shows it).
8. **Header values that come from the sender are cut to 200 characters before they are recorded,** and a refusal says
   as little as it can.

## Not guaranteed
GitHub signs the body, not the delivery id or the event header. Someone who captured a signed delivery can send the
same body under a new `X-GitHub-Delivery` (or a new `X-GitHub-Event`); it verifies, and is treated as a new event.
The mitigations are the ones outside this handler: keep the secret secret, use HTTPS, and write receiving handlers
that are idempotent on a business key (the issue number, the commit). The inbox protects against GitHub's
redelivery, not against a replay.

## Consequences
- An app's `fetch()` calls `handleWebhook` first; its `email()` calls `handleEmail`. Nothing else is needed for a source.
- Adding another provider means another `verify` value and another handler; the declaration shape stays.
- Spec §6 is implemented for webhooks and email, as amended in §6.2: no `id` option (the delivery id is fixed), `deliverExternal` rather than `ingress`, and `405`/`500` answers. Other channels are not.
