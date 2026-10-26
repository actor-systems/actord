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
| A job is settled once, by its completion message, its probe, its deadline (in_doubt), or a cancel reported honestly | The outbox row waits as `awaiting_job` with its handle and deadline. `ctx.settleJob` returns false only once the job is settled: a completion that arrives before the job is waiting is kept and settles it when its start returns. Decision 0018 |
| An effect interrupted 5 times without settling is parked as in_doubt | A keyed orphan is retried until its 5th interruption (`parkAfterInterruptions`), then marked `in_doubt` with `parked: interrupted N times without settling`, an `effect.parked` event, and never run again. While any attempt runs, actord also keeps a wake 30 s away so a lost instance is noticed |

**Effect keys.** An effect key identifies one effect for the actor's lifetime. Requesting it again records `effect.duplicate` and runs nothing. A new attempt at the same logical work needs a new key, for example one that includes an attempt or generation number.

Not guaranteed: exactly-once external effects, global ordering, cross-actor transactions, or a route as a
security boundary. Effect usage is best effort: usage from an attempt that crashed the Durable Object is lost, and usage
reported after an attempt has timed out or ended is dropped. Decision 0007 has the details and the platform behavior they rest on.
