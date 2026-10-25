# Fault matrix: how to test each fault in workerd

All helpers come from `@actord/toolkit/testing` or `cloudflare:test`. Tag each test with its claim.

| Fault | Test technique | Expected guarantee |
| --- | --- | --- |
| Duplicate inbound message | Call `stub.receive(envelope)` twice with the same `id` | Second returns `duplicate`; handler ran once |
| Duplicate business input | Same item in two inputs (different message ids) | Handler's own key check records it once |
| Malformed / wrong version / off-route | Hand-built envelopes: bad payload, `version: 2`, a `from` with no route | `rejected` with `invalid_payload`, `version_mismatch`, `unauthorized_route`; no state change |
| Delayed / out-of-order | Deliver newer before older | Outcome independent of order (pointers only move forward) |
| Crash before a durable write | `injectFault({ at: "before-handler" })`, then `settle` | Retried, handled once |
| Crash after a durable write | `injectFault({ at: "after-handler" })`, then `settle` | Writes rolled back; retry behaves as first attempt (assert a downstream effect that only happens if it did) |
| Delivery retry and restart | `injectFault({ at: "deliver" })`, `evictDurableObject(sender)`, `settle` | Outbox row survives; alarm delivers |
| Retry exhaustion | `injectFault({ at: "deliver", times: 100 })`, `settle` | Dead after 6 attempts; `retry.exhausted` event |
| Scheduled wake | `tick(env, system, "Actor", key)`; `runInDurableObject(… getAlarm())` | Wake handled; alarm re-armed |
| Simultaneous messages around an await | A model double that waits on a promise the test resolves; send a control message meanwhile | Control message handled during the wait; late result ignored as stale |
| Unavailable model or tool | Adapter throws `EffectNotDelivered` | At most `budget.maxAttempts` attempts, then `failed` result |
| Model timeout | `overrideBudget(actor, { timeoutMs: 30 })` and a never-settling adapter | Cut off; retried only if keyed; then `in_doubt`/`failed` result |
| Lost acknowledgment, keyed | Adapter records, then throws on first call | Retried with the same key; destination saw one logical request |
| Lost acknowledgment, no key | Adapter records, then throws | Exactly one attempt; `in_doubt`; never marked done |
| Denied capability | Request an effect the actor didn't declare (a cast in a test-only actor) | Handler fails; nothing queued; `effect.denied` event |
| Crash mid-effect | `abortAllDurableObjects()` while an adapter hangs | Next activation: keyed → retried; unkeyed → `in_doubt` |

Classify honestly:
- A workerd test using only the runtime and storage is **proved locally**. "Locally" means the local
  runtime, not production scale or multi-region behavior.
- A test whose guarantee depends on a test double's behavior, such as a gateway that deduplicates by key,
  is **stub only**. The real destination must be checked separately.
- Exactly-once external delivery is **not guaranteed**. Say what is guaranteed instead.
