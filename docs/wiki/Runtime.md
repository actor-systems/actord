# The runtime and its guarantees

Actors stay native Durable Object classes that install `Lifecycle` and compose `actorRuntime(...)`. What it
guarantees, each backed by tests in workerd (see `examples/release-radar/tests/`):

| Guarantee | How |
| --- | --- |
| Refuses malformed, unauthorized-route, wrong-version, and invalid-payload messages | Envelope checks against `system.ts`; Standard Schema validation |
| Handles a message id at most once per actor | SQLite inbox, retained 7 days |
| A handler's writes, its outgoing messages, and its effect intents commit together or not at all | `ctx.storage.transaction()` around each handler |
| Delivers at least once, then dead-letters | SQLite outbox; alarm retries with backoff, up to 6 attempts |
| Never reports an unacknowledged external effect as delivered | Retries only with an idempotency key; otherwise `in_doubt` |
| A timer set by a handler is delivered after its delay, even across restarts, and handled at most once; it is set only if the handler commits, and cancelling it or setting its key again before it fires wins. A handler that keeps failing is retried with backoff, and after 6 attempts the timer is dropped (`retry.exhausted`), not delivered | `_actors_timers` row, written in the handler's transaction and removed in the transaction that handles it; id derived from the key, the due time and the message that set it |
| A schedule that was missed while the object slept ticks once, then re-arms from now | Per-message due time in `_actors_meta`; the tick carries the missed time as `payload.at` and a derived id |
| A job is settled once, by its completion message, its probe, its deadline (in_doubt), or a cancel reported honestly | The outbox row waits as `awaiting_job` with its handle and deadline. `ctx.settleJob` returns false only once the job is settled: a completion that arrives before the job is waiting is kept and settles it when its start returns. Decision 0018 |
| An effect interrupted 5 times without settling is parked as in_doubt | A keyed orphan is retried until its 5th interruption (`parkAfterInterruptions`), then marked `in_doubt` with `parked: interrupted N times without settling`, an `effect.parked` event, and never run again. While any attempt runs, actord also keeps a wake 30 s away so a lost instance is noticed |
| An approval request expires (default 3 days); the actor receives a failed result, and a late approval does nothing | A parked effect's `next_at` is its expiry (`expires` on the effect, default `"3d"`) and holds the alarm. When it passes, the row becomes `denied` with `approval expired`, an `effect.denied` event is emitted, and the result message says `failed`, even for a job whose completion arrived early. `ctx.approve` and `ctx.deny` then return false. Approvals and denials record `{ messageId, from, by }`, with `via` the sender (`@rpc` for `decide()`). Approval requests parked by toolkit 0.2.x have no expiry time and are treated as expired on the first wake after upgrading |
| A webhook delivery is verified and delivered once | The HMAC of the raw body is checked first, in constant time. The provider's delivery id is the envelope id, so a redelivery is `duplicate`. Bad signature `401`, unmapped event `204`, invalid `400`, failed `500`; each refusal is a `source.*` event. Decision 0017 |
| An email reply approves only for the owner, by plain code | In order: envelope sender and header `From` are the owner's (else no reply); no `dmarc=fail`; not an auto-reply; then a valid, unexpired subject token and a first line of `approve` or `deny`. With authentication `unknown`, an effect declared `publishes: true` can't be approved by email. Decision 0021 |
| One notification per parked approval | The `approvals.notify` effect is queued with the row id `fx:<notify>:approval:<effect>:<effectKey>`, so parking again sends nothing new. If it fails, the effect stays parked and still expires |

**Effect keys.** An effect key identifies one effect for the actor's lifetime. Requesting it again records `effect.duplicate` and runs nothing. A new attempt at the same logical work needs a new key, for example one that includes an attempt or generation number.

Not guaranteed: exactly-once external effects, global ordering, cross-actor transactions, or a route as a
security boundary. Effect usage is best effort: usage from an attempt that crashed the Durable Object is lost, and usage
reported after an attempt has timed out or ended is dropped. A usage value that isn't a finite number at or above 0 is ignored. Decision 0007 has the details and the platform behavior they rest on.

## Sources

A source is declared in `system.ts` as `sources: { github: webhook({...}), mail: inboundEmail({...}) }`. Its name is
a route sender (`@github`), and routes deliver its messages like any other. Actors never subscribe.

- **`webhook({ path, verify: "github", secret, events })`** names an `env` entry for the secret, never the value.
  `events` maps `<X-GitHub-Event>.<action>` to `{ message, key, map }`: `key` chooses the receiving actor's
  instance, `map` builds the payload, which is validated against the message's schema. Call
  `handleWebhook(request, env, system)` first in `fetch()`; it returns `null` for other paths.
- **`inboundEmail({ secret, owner, from, send, authserv?, message })`** names `env` entries. Call
  `handleEmail(message, env, system)` from `email()`. It accepts only the owner's reply to an approval request.
  `authserv` is optional: the name of the entry holding the trusted authserv-id. Cloudflare Email Routing's is
  `mx.cloudflare.net` (spike 6; see Limitations before setting it). Without it every reply is `"unknown"` and an
  effect that publishes must be approved in GitHub.
- **Approval emails.** Declare `approvals: { notify: "<effect>" }` and give that effect the `approvalEmail`
  adapter, with `idempotency: "none"`. The default email includes the effect's input as JSON; supply `describe()`
  if inputs are sensitive.
- **Finding a missed event.** GitHub doesn't redeliver failed deliveries automatically (a timeout, `4xx` or `5xx` is a failure); they can be redelivered by hand for a limited period. `source.invalid` and
  `source.failed` events carry the delivery id; `actord events` shows them.

Not guaranteed: GitHub signs only the body, so a captured delivery replayed under a new `X-GitHub-Delivery` is
treated as a new event. Keep the secret, use HTTPS, and keep handlers idempotent on business keys.
