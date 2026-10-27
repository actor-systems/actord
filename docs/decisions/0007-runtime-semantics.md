# 0007 — Runtime semantics: transactional handlers, effects after commit, events as console JSON

- **Date:** 2026-10-24 · **Gate:** G3 · **Status:** accepted · **Reversibility:** moderate (the guarantees
  are documented and tested; the internals can change behind them)

## Verified platform behavior (probes in `spikes/do-messaging/test/probe.test.ts`, workerd 1.20261019.1)
- While one RPC method awaits an RPC to another DO, a second call to the same DO **interleaves**
  (order `first:start, second, first:end`).
- `ctx.storage.transaction(async …)` on a SQLite DO **rolls back** SQL writes when the closure throws, even
  after an awaited RPC inside it. While it runs it **holds the input gate**: a concurrent call blocked until
  it finished, and that call's write survived the rollback.
- `ctx.id.name` is the name passed to `getByName`, so an actor knows its own key.
- An RPC method named `name` collides with the stub's own property (`stub.name is not a function`).
- Vitest 5 hides console output of passing tests unless `silent: false`. With it, `onConsoleLog` in the
  Node process receives DO `console.log` lines.

## Decisions
1. **A native DO composes `actorRuntime(...)`; there's no base class.** The class exposes `receive(envelope)`
   and forwards `alarm()`. Everything else stays native (`ctx.sql`, extra RPC methods for reads).
2. **Each handler runs in one storage transaction.** Its writes, the inbox mark, its outgoing messages, and
   its effect intents commit together. A throw anywhere, including an injected crash after the writes, rolls
   back everything, and the sender retries. Because the transaction holds the input gate, handlers must
   stay storage-only. Release Radar's `[crash-after-mutation]` test proves the rollback.
3. **External work is an effect that runs after commit, outside any transaction**, so other messages
   (cancel, control) interleave while it waits. An effect may declare `result: "<message>"`. Its outcome
   then comes back as that message on a declared self-route: the await point is an explicit, traceable
   message boundary. That's the charter's "one message at a time without blocking control events".
4. **Effect honesty.** If an attempt fails without proof of non-delivery, it's retried (same key) only when
   the effect declares `idempotency: "key"`. Otherwise it's reconciled if the adapter can, or recorded as
   `in_doubt`, never reported as delivered. An adapter throws `EffectNotDelivered` for a request that
   provably never reached the destination, and `EffectRejected` for a definitive refusal. `approval: "human"`
   parks the effect until `decide(key, "approve" | "deny")`.
5. **Delivery is at least once.** Outbox rows are delivered right after commit (the caller's call returns
   once downstream receivers have committed) and retried from the alarm with exponential backoff, up to 6
   attempts, then dead-lettered with `retry.exhausted`. A receiver whose handler throws returns `failed`,
   not an exception. One drain runs at a time per instance.
6. **Ids are derived from causal position** (FNV-1a of parent id, index, type, target), so a re-executed
   handler produces the same outgoing ids and traces are reproducible.
7. **Events are one JSON `console.log` line each** (`{"$actord":1,…}`), which is what Workers Logs ingests in
   production. Locally, `@actord/toolkit/vitest` appends them to `.actord/events.ndjson`, emptied at the start
   of each run. Payloads aren't logged, only their top-level keys.
8. **Test seams are explicit and inert in production.** `injectFault` (before-handler, after-handler,
   deliver), `overrideEffect`, `settle` (deliver everything, fast-forwarding backoff) and `tick` (a
   distinct scheduled wake) live in `@actord/toolkit/testing` and use a global that only tests set.

## Not guaranteed (and documented as such)
Exactly-once external effects; global or cross-sender ordering; ordering across retries; cross-actor
transactions; dedupe beyond inbox retention (7 days by default); routes as a security boundary (any code
with the binding can call `receive`).

## Amendment (G4): effects run in the background; orphaned attempts are recovered honestly
- **Problem found while writing Briefing Desk's reentrancy test:** effects ran inline in the actor's single
  drain loop, so a slow model call blocked delivery of every later message from that actor. A cancellation's
  update to the Desk would wait for the model (head-of-line blocking).
- **Change:** an effect row is marked `running` and started in the background (`ctx.waitUntil` when
  available); the drain moves on. A finished effect drains again to deliver its result message.
- **Recovery:** a `running` row with no in-memory attempt was orphaned by a restart. On the instance's first
  activity it's retried if the effect has an idempotency key, and otherwise recorded as `in_doubt`
  ("interrupted: the actor restarted while the attempt was in flight"), delivering the declared result
  message. Tested in `packages/toolkit/test-runtime` with `abortAllDurableObjects()`.
- `@actord/toolkit/testing`'s `settle()` waits for running effects; `settle({ deliver: false })` waits without
  forcing deliveries.
- Approval decisions can arrive as messages: `ctx.approve(effect, key)` and `ctx.deny(effect, key, reason)`
  change the parked effect inside the handler's transaction; the approved effect runs after commit.

## Amendment (#80): a handler that awaits I/O fails its delivery
- **Problem:** decision 2 keeps handlers storage-only, but nothing enforced it. A handler whose transaction spans an
  event-loop turn lets transactions started elsewhere in the object run nested in it
  (`[beside-transaction-nested]`). Its rollback then takes their rows: pi's session store, Computer's vfs sync-back,
  Lifecycle's job rows, actord's own drain settlements.
- **Change:**
  - **The sentinel.** The runtime queues a `setTimeout(0)` sentinel before calling the handler, and races the
    handler against it.
  - **When the sentinel fires first.** The transaction closure throws `<Actor>.<type>: handlers may not await I/O;
    use ctx.effect`. The transaction rolls back, and the delivery fails like any other.
  - **When the handler settles first.** The sentinel is cleared.
  - **The closed ctx.** Once the delivery ends, the handler's `ctx` refuses every call, `sql.exec` included, with
    `<Actor>.<type>: this handler's delivery has ended; its ctx can't be used`. `self`, `key` and `now` stay
    readable.
- **Verified in workerd.**
  - **Storage.** No storage await a handler can reach outlasts the sentinel (`[storage-await-no-macrotask]`).
    These also keep a writer waiting beside the handler out of its transaction, so a handler may await them: the
    KV calls (`get`, `put`, `list`, `delete`), the alarm calls, `sql`, `kv`, `transactionSync` and Lifecycle's
    `jobs.push`.
  - **Awaits the sentinel misses.** These let a waiting writer run nested, and still finish before the sentinel: a
    nested `transaction()`, `sync()`, `getCurrentBookmark()`, and `Request` and `Response` body reads (`text()`,
    `json()`). If the handler then throws, the rollback takes that writer's rows, and the delivery fails with the
    handler's own error (`[beside-transaction-nested]`). A handler must not await them. #82 proposes an exact
    detector.
  - **A transaction already requested.** One requested beside the handler runs nested before the sentinel, so the
    failed delivery still rolls it back.
  - **A transaction begun later.** One begun by I/O that arrives after the handler started runs after the rollback,
    and commits. `[sentinel-ordering]` pins both.
- **Breaking:** a handler that awaited I/O used to commit. It now fails its delivery on every attempt.
  - A message dead-letters after 6 attempts.
  - A timer is dropped with `retry.exhausted`.
  - The I/O the handler started still runs on each attempt.
