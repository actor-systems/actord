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
| A timer set by a handler is delivered once, after its delay, even across restarts; it is set only if the handler commits | `_actors_timers` row in the handler's transaction; derived id |
| A schedule that was missed while the object slept ticks once, then re-arms from now | Per-message due time in `_actors_meta`; the tick carries the missed time as `payload.at` and a derived id |

Not guaranteed: exactly-once external effects, global ordering, cross-actor transactions, or a route as a
security boundary. Decision 0007 has the details and the platform behavior they rest on.
