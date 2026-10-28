# Fault matrix: how to test each fault in workerd

Helpers come from `@actord/toolkit/testing` or `cloudflare:test`, except `ingress`, `EffectNotDelivered` and
`EffectRejected` (`@actord/toolkit/runtime`), `scriptedModel` (`@actord/toolkit/agents`) and `decisionAdapters`
(`@actord/toolkit/decisions`). Tag each test with its claim. Working test code for each area is
in the implement skill's references: [runtime.md](../../implement/references/runtime.md) (Testing),
[timers-and-jobs.md](../../implement/references/timers-and-jobs.md), [sources.md](../../implement/references/sources.md),
[agents.md](../../implement/references/agents.md) and [decisions.md](../../implement/references/decisions.md).
`settle` delivers what is pending and waits for running effects; it never makes a timer, a probe, a deadline or an
expiry due. Give each test its own instance keys and ids.

## Delivery and handlers

| Fault | Test technique | Expected guarantee |
| --- | --- | --- |
| Duplicate inbound message | `ingress(...)` twice with the same `id` | Second returns `duplicate`; handler ran once |
| Duplicate business input | Same item in two inputs (different message ids) | Handler's own key check records it once |
| Malformed / wrong version / off-route | Hand-built envelopes to `stub.receive`: bad payload, `version: 2`, a `from` with no route | `rejected` with `invalid_payload`, `version_mismatch`, `unauthorized_route`; no state change |
| Delayed / out-of-order | Deliver newer before older | Outcome independent of order (pointers only move forward) |
| Crash before a durable write | `injectFault({ actor: receiver, at: "before-handler" })`, then `settle` | Retried, handled once |
| Crash after a durable write | `injectFault({ actor: receiver, at: "after-handler" })`, then `settle` | Writes rolled back; retry behaves as first attempt (assert a downstream effect that only happens if it did) |
| Delivery retry and restart | `injectFault({ actor: sender, at: "deliver" })`, `evictDurableObject(sender)`, `settle` | Outbox row survives; delivered after the restart |
| Retry exhaustion | `injectFault({ actor: sender, at: "deliver", times: 100 })`, `settle` | Dead after 6 attempts; `retry.exhausted` event |
| Handler awaits I/O (the canary) | Drive the suspect handler (`ingress`, or `settle` for one fed by another actor), with `captureEvents()` | It fails: receipt `failed`, and a `failed` event whose reason ends `handlers may not await I/O; use ctx.effect`; nothing it did through `ctx` commits. From another actor: retried, then `retry.exhausted` after 6 attempts. The fix is `ctx.effect`, never a passing test |
| Message during an in-flight effect | An adapter that waits on a promise the test resolves; send a cancel or control message meanwhile | Control message handled during the wait; the late result ignored as stale (generation in the key) |

Handlers may not await I/O, so no two handlers of one actor ever interleave: interleaving happens only around
effects, which run after commit. Test that, not reentrancy inside a handler. An abandoned handler (one the canary
failed) still lands a nested transaction it awaited, its `this.actor.requestEffect` calls and its direct
`this.ctx.storage` writes, on every attempt (Limitations, "An abandoned handler can still write"). That is a bug to
remove, not a guarantee to claim.

## Effects

| Fault | Test technique | Expected guarantee |
| --- | --- | --- |
| Unavailable model or tool | Adapter throws `EffectNotDelivered` | At most `budget.maxAttempts` attempts, then `failed` result |
| Definitive refusal | Adapter throws `EffectRejected` | `failed` at once, never retried |
| Model timeout | `overrideBudget(actor, { timeoutMs: 30 })` or `overrideEffectBudget(effect, …)`, and a never-settling adapter | Cut off; retried only if keyed; then `in_doubt`/`failed` result |
| Lost acknowledgment, keyed | Adapter records, then throws on first call | Retried with the same key; destination saw one logical request |
| Lost acknowledgment, no key | Adapter records, then throws | Exactly one attempt; `in_doubt` (or the adapter's `reconcile` answer); never marked done |
| Denied capability | Request an effect the actor didn't declare (a cast in a test-only actor) | Handler fails; nothing queued; `effect.denied` event (`undeclared capability`) |
| Crash mid-effect | `abortAllDurableObjects()` while an adapter hangs, then `settle` | Next activation: keyed → retried; unkeyed → `in_doubt` |
| Crash loop, keyed effect | An adapter that never settles; `abortAllDurableObjects()` then `settle(env, system, { rounds: 2 })`, five times | Retried after each of the first 4 interruptions; at the 5th, `in_doubt` with `parked: interrupted 5 times without settling`, an `effect.parked` event and the result message; never runs again |

## Timers, jobs and approvals

| Fault | Test technique | Expected guarantee |
| --- | --- | --- |
| Scheduled wake | `tick(env, system, "Actor", key, message?)` on an instance that has received a message | Handled once, with `payload.at` the time it was due |
| Timer fires | A handler sets `ctx.after(...)`; `fireTimers(env, system, "Actor", key)` | Returns how many fired; the message arrives once, from `@timer` |
| Timer cancelled or replaced | `ctx.cancelTimer(key)`, or `ctx.after` again with the same key, then `fireTimers` | A cancelled timer never fires; a replaced one fires once, as the replacement |
| Timer across a restart | Set it, `abortAllDurableObjects()`, then `fireTimers` | Fires after the restart, once |
| Timer handler keeps failing | `injectFault({ actor, type, at: "before-handler", times: 100 })`, then `fireTimers` once per attempt, six times | Retried with backoff; the 6th attempt drops it with `retry.exhausted`, never handled |
| Job settled by completion | `overrideEffect(name, jobAdapter)`; `settle`; deliver the `completes` message | `ctx.settleJob` in that handler settles it once; one `result` message; the trace says `settled by message` |
| Job probe | A `JobAdapter` whose `probe` reports done; `runInDurableObject(stub, (i) => i.actor.probeNow(effect, effectKey))`, then `settle` | Settled as the probe reported, once (`settled by probe`) |
| Job deadline | A probe that never reports done; `expireJobs(env, system, "Actor", key)`, then `settle` | `in_doubt`, "deadline passed"; nothing downstream treats it as done |
| Job cancel | `ctx.cancelJob(name, key)` from a handler, with `cancel` returning `true`, then `false` or throwing | `true` → `failed` "cancelled"; anything else → `in_doubt` "cancel not confirmed" (`settled by cancel`) |
| Approval expiry | Park an `approval: "human"` effect; `expireApprovals(env, system, "Actor", key)`, then `settle`; then send the approval | Result `failed` "approval expired", `effect.denied` event; the late `ctx.approve` returns `false`; the effect never runs |

## Sources, agents and decisions

| Fault | Test technique | Expected guarantee |
| --- | --- | --- |
| Webhook signature | `SELF.fetch` to the source's path with a wrong `X-Hub-Signature-256` | `401`, `source.rejected` (`signature`); nothing delivered |
| Webhook redelivery | The same signed body and `X-GitHub-Delivery` twice | `202` both times; handled once (the second is `duplicate`) |
| Webhook replay under a new delivery id | The same signed body with a new `X-GitHub-Delivery` | A new event: the handler's business-key check records it once |
| Agent budget exhaustion | `scriptedModel(...)` in `options.model` that keeps calling tools; `overrideBudget(actor, { turns: 2 })`, or `{ wallClock: "50ms" }`. Set `remoteBindings: false` first (implement's `references/agents.md`, Testing), or the declared `ai` binding opens a remote session | One `agent.exhausted` message whose `payload.budget` names the limit, and an `effect.failed` event on `agent.session` with `exhausted:<limit>`; at most one response past `turns`, two requests past `usd` |
| Shadow decision never delivered | `decisionAdapters(system, { ai: stub })` with a scripted answer; request the shadow effect; `settle` | `decision.recorded` with `mode: "shadow"`; no result message and no `sent` event; `requestEffect` gets `confirmed` with no value |

Classify honestly:
- A workerd test using only the runtime and storage is **proved locally**. "Locally" means the local
  runtime, not production scale or multi-region behavior.
- A test whose guarantee depends on a test double's behavior, such as a gateway that deduplicates by key,
  a scripted model's costs, or a stub AI's answers, is **stub only**. The real destination must be checked
  separately. No container runs in tests (Limitations).
- Exactly-once external delivery is **not guaranteed**. Say what is guaranteed instead.
