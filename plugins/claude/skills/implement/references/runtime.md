# `@actord/toolkit/runtime` and `@actord/toolkit/testing`

## The actor class

An actor is a native Durable Object class. It installs `Lifecycle`, composes `actorRuntime(...)`, and exposes a
public `receive(envelope)`. Lifecycle owns the object's one alarm, so the class defines no `alarm()` (decision 0016).
The declaration the examples on this page use:

```ts
// actord:check system
import { defineSystem, message } from "@actord/toolkit/system";
import { z } from "zod";

// An effect's result message carries { key, status, value?, error?, usage? }.
const Outcome = z.object({
  key: z.string(),
  status: z.enum(["confirmed", "failed", "in_doubt"]),
  value: z.unknown().optional(),
  error: z.string().optional(),
});

export default defineSystem({
  name: "release-radar",
  messages: {
    "release.observed": message({ version: 1, description: "A feed item was seen (possibly again)", payload: z.object({ itemId: z.string().min(1), title: z.string() }) }),
    "release.significant": message({ version: 1, description: "A release seen for the first time", payload: z.object({ itemId: z.string(), title: z.string() }) }),
    "digest.sent": message({ version: 1, description: "The outcome of notify.digest", payload: Outcome }),
  },
  actors: {
    ReleaseLedger: { binding: "RELEASE_LEDGER", kind: "deterministic", purpose: "Owns the record of every release seen", justification: ["state"] },
    DigestWriter: { binding: "DIGEST_WRITER", kind: "deterministic", purpose: "Notifies the owner once per finding", justification: ["state", "isolation"], effects: ["notify.digest"] },
  },
  effects: {
    "notify.digest": { description: "Send one finding through the notification gateway, deduplicated by item id", idempotency: "key", result: "digest.sent" },
  },
  routes: [
    { from: "@ingress", message: "release.observed", to: "ReleaseLedger" },
    { from: "ReleaseLedger", message: "release.significant", to: "DigestWriter" },
    { from: "DigestWriter", message: "digest.sent", to: "DigestWriter" },
  ],
});
```

The class, as `examples/release-radar/src/actors/*.ts` and the starter's `src/actors/` write it:

```ts
// actord:check
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import system from "./system";

export class ReleaseLedger extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS releases (item_id TEXT PRIMARY KEY, title TEXT NOT NULL, first_seen_message TEXT NOT NULL)");
  }

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "ReleaseLedger", {
    // One handler per message routed to ReleaseLedger: a missing or extra one is a type error.
    "release.observed": ({ id, payload }, ctx) => {
      // A redelivered message id never reaches the handler (the inbox drops it). The same item in a new message does.
      if (ctx.sql.exec("SELECT 1 FROM releases WHERE item_id = ?", payload.itemId).toArray().length > 0) {
        return ctx.note("already recorded", { itemId: payload.itemId });
      }
      ctx.sql.exec("INSERT INTO releases (item_id, title, first_seen_message) VALUES (?, ?, ?)", payload.itemId, payload.title, id);
      ctx.send("release.significant", { itemId: payload.itemId, title: payload.title }); // only along declared routes
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  // A public read method runs outside any handler, so it reads storage directly.
  releases(): Array<{ item_id: string; title: string }> {
    return this.ctx.storage.sql.exec<{ item_id: string; title: string }>("SELECT item_id, title FROM releases ORDER BY item_id").toArray();
  }
}
```

- `Lifecycle.install(this)` runs in a field initializer, before `actor`. It installs `alarm` (and `fetch`) unless the
  class defines its own, so don't define `alarm()`.
- Wire it: a binding in `wrangler.jsonc`'s `durable_objects`, an `exports` entry
  `{ "type": "durable-object", "storage": "sqlite" }`, and the class exported from the Worker entry.
- From the Worker's own code: `ingress(env, system, "Actor", "message.type", payload, { key, id })`, on a route from
  `@ingress`. It returns the receipt: `handled`, `duplicate` (the same `id` again), `rejected` with a `reason`, or
  `failed`. `key` picks the instance (default `"main"`).
- `RuntimeOptions` (the fifth argument): `effects` (adapters by name), `maxAttempts` (6), `backoffMs` (1 s doubling,
  capped at 5 minutes), `parkAfterInterruptions` (5), `inboxRetentionMs` (7 days), `defaultKey` (`"main"`).

## Handlers may not await I/O

Each handler runs inside one storage transaction: its `ctx.sql` writes, sends, timers and effect requests commit
together or not at all. **Handlers may not await I/O.** Request it with `ctx.effect(name, input, { key })`, and handle
the effect's declared `result` message.

- **What fails.** A `fetch`, a timer, a container call or a model call. So does any other await that yields to the
  event loop, I/O or not: `setTimeout(0)`, libraries that use timers inside, `storage.sync()`,
  `getCurrentBookmark()`, a nested `storage.transaction()`, and a `Request` or `Response` body read (`text()`,
  `json()`).
- **How it fails.** Just before the handler runs, actord queues a no-op canary transaction first inside the handler's
  transaction. At the handler's first yield the canary runs and throws
  `<Actor>.<type>: handlers may not await I/O; use ctx.effect`. The transaction rolls back, and the delivery fails like
  any other. A message from another actor is retried with backoff and dead-lettered after 6 attempts; a timer is
  dropped with `retry.exhausted`; `ingress` returns `failed` to its caller, and a webhook answers `500`. It fails on
  every attempt, so the handler never succeeds.
- **The canary in the log.** A `failed` event whose reason ends `handlers may not await I/O; use ctx.effect`. After
  it, every `ctx` method throws `<Actor>.<type>: this handler's delivery has ended; its ctx can't be used`,
  `ctx.sql.exec` included; `self`, `key` and `now` stay readable.
- **The abandoned handler** keeps running once its await returns: a nested transaction it awaited, its
  `this.actor.requestEffect` calls (their effects run), and its direct `this.ctx.storage` writes all still land, on
  every attempt. See Limitations, "An abandoned handler can still write".
- **What a handler may await.** Microtasks, and these storage calls: `get`, `put`, `list`, `delete`, the alarm calls,
  `ctx.sql`, `kv`, `transactionSync` and Lifecycle's `jobs.push`. None of them yields (`[storage-awaits-allowed]`).
  A synchronous handler is still the default.
- `this.actor.requestEffect(...)` is for code outside handlers, such as an agent's tools. Called while a handler
  runs, it throws; after an await that yields, the delivery has already failed and the call is accepted
  (Limitations). It is never a way around the rule.

## The handler's `ctx`

| Member | What it does |
| --- | --- |
| `sql` | Native SQLite. Writes are part of the handler's transaction. |
| `send(type, payload, { to?, key? })` | Queues a message along a declared route; delivered after commit. `to` is needed when the message has more than one route from this actor; `key` defaults to `"main"`. |
| `effect(name, input, { key })` | Queues an effect the actor lists; runs after commit, outside the transaction. A key already used records `effect.duplicate` and runs nothing. |
| `approve(name, key, { by }?)`, `deny(name, key, reason, { by }?)` | Release or refuse an effect parked for a person. `false` when none is waiting (already decided, expired, never parked). |
| `after(delay, type, payload, { key })`, `at(epochMs, …)`, `cancelTimer(key)` | Timers to this instance: `timers-and-jobs.md`. |
| `settleJob(name, key, outcome)`, `cancelJob(name, key)` | Job effects: `timers-and-jobs.md`. |
| `acted(decisionId, action)`, `outcome(decisionId, actual)` | Label a recorded decision: `decisions.md`. |
| `note(text, detail?)` | A structured `note` event, for inspection only. |
| `now()`, `self`, `key` | The clock; `"Actor:key"`; the instance key. |

## Effects

```ts
// actord:check
import { EffectNotDelivered, EffectRejected, type EffectAdapter } from "@actord/toolkit/runtime";

// For "notify.digest", declared idempotency: "key": the gateway deduplicates by the key, so a retry is safe.
export const gateway: EffectAdapter<{ title: string }, { id: string }> = {
  async run(input, { key, signal, reportUsage }) {
    const res = await fetch("https://notify.example/send", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(input),
      signal, // honor it: each attempt has a timeout (30 s unless the budget says otherwise)
    });
    if (res.status === 429) throw new EffectNotDelivered("refused before processing; safe to retry");
    if (res.status === 400 || res.status === 422) throw new EffectRejected(`refused: ${res.status}`); // never retried
    if (!res.ok) throw new Error(`gateway ${res.status}`); // ambiguous: retried, because the effect is keyed
    reportUsage({ costUsd: 0.0001 });
    return (await res.json()) as { id: string };
  },
};

// For an effect declared idempotency: "none", reconcile: true: looked up once an attempt's outcome is unknown.
export const chat: EffectAdapter<{ text: string }, { ts: string }> = {
  async run(input, { key, signal }) {
    const res = await fetch("https://chat.example/post", { method: "POST", body: JSON.stringify({ ...input, client_id: key }), signal });
    if (!res.ok) throw new Error(`chat ${res.status}`);
    return (await res.json()) as { ts: string };
  },
  async reconcile(key) {
    const res = await fetch(`https://chat.example/messages?client_id=${encodeURIComponent(key)}`);
    if (res.status === 404) return { delivered: false };
    return res.ok ? { delivered: true, value: (await res.json()) as { ts: string } } : undefined; // undefined: in_doubt
  },
};
```

- `EffectRejected`: a definitive refusal. Settles `failed`, never retried.
- `EffectNotDelivered`: the request provably never arrived. Retried; `failed` once the attempts run out.
- Any other error, or a timeout, is ambiguous. With `idempotency: "key"` it is retried, and `in_doubt` once the
  attempts run out. With `"none"`, the adapter's `reconcile(key)` decides if the effect declares `reconcile: true`
  (`delivered: true` → `confirmed`, `delivered: false` → `failed`, `undefined` → `in_doubt`); otherwise it is
  `in_doubt` at once. Never treat `in_doubt` as done.
- `reportUsage({ inputTokens, outputTokens, costUsd, containerSeconds })` adds to the effect's usage. It's best
  effort: usage reported after the attempt ended is dropped.
- With `result: "<message>"` declared, the outcome `{ key, status, value?, error?, usage? }` arrives as that message,
  on a route from the actor to itself.
- An effect key names one effect for the actor's lifetime. New work at the same logical step needs a new key, for
  example one with an attempt or generation number.
- `approval: "human"` parks the effect until `ctx.approve` or `ctx.deny`, or its expiry (`timers-and-jobs.md`).

## Stale results and cancellation

Store a generation per item. Put it in the effect key (`${id}:g${generation}`), bump it on cancel, and in the result
handler ignore any key whose generation isn't current. Effects run outside the transaction, so a cancel can arrive
while the call is in flight.

## Testing (in workerd, `@cloudflare/vitest-plugin`)

```ts
// actord:check
import { env } from "cloudflare:workers";
import { ingress } from "@actord/toolkit/runtime";
import { captureEvents, injectFault, overrideEffect, resetSeams, settle } from "@actord/toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "./system";

afterEach(() => resetSeams());

it("[duplicate-delivery] a redelivered message is handled once", async () => {
  const release = { itemId: "dup-1", title: "v2.0.0" };
  const first = await ingress(env, system, "ReleaseLedger", "release.observed", release, { key: "dup", id: "msg-dup-1" });
  const again = await ingress(env, system, "ReleaseLedger", "release.observed", release, { key: "dup", id: "msg-dup-1" });
  expect([first.status, again.status]).toEqual(["handled", "duplicate"]);
});

it("[crash-after-mutation] a crash before commit is retried, and notifies once", async () => {
  const sent: string[] = [];
  overrideEffect("notify.digest", { async run(_input, { key }) { sent.push(key); return { id: key }; } });
  injectFault({ actor: "DigestWriter", type: "release.significant", at: "after-handler" });
  const events = captureEvents();
  await ingress(env, system, "ReleaseLedger", "release.observed", { itemId: "crash-1", title: "v3.0.0" }, { key: "crash" });
  await settle(env, system);
  expect(sent).toEqual(["crash-1"]);
  expect(events.some((e) => e.kind === "failed" && e.type === "release.significant")).toBe(true);
});
```

- `settle(env, system)` delivers everything pending and waits for running effects, probes and cancels,
  fast-forwarding backoff. It doesn't make a job's probe or deadline due.
- `tick(env, system, "Actor", key, message?)` delivers a scheduled wake due now, so its `payload.at` is now.
  `fireTimers(env, system, "Actor", key)` makes pending timers due and fires them. `expireJobs(...)` passes every
  waiting job's deadline (`in_doubt`); `expireApprovals(...)` expires every parked approval (`failed`). Each needs an
  instance that has already received a message.
- `injectFault({ actor, type?, at: "before-handler" | "after-handler" | "deliver", times? })`.
- `overrideEffect(name, adapter)` (a `JobAdapter` for a job), `overrideBudget(actor, { maxAttempts, timeoutMs })`,
  `overrideEffectBudget(effect, { maxAttempts, timeoutMs })`. A later override of the same effect replaces the
  earlier one. `captureEvents()` returns a live array of every event. Call `resetSeams()` in `afterEach`.
- `ingress()` and `receive()` return a receipt for a rejected message rather than throwing (`ingress()` throws only
  for an undeclared actor or a missing binding), so assert `status: "handled"` on each one a test relies on. A
  hand-built envelope's `to` is the instance's address, `"Actor:key"` (such as `"DigestWriter:main"`); a bare actor
  name is rejected as `wrong_recipient`. Prefer `ingress()` on a route from `@ingress`; for a message another actor
  sends, drive that actor and `settle`.
- An effect with no override runs its real adapter. Override every effect a test asserts on, one the change adds
  included: a fixture written for an earlier effect doesn't capture a new one.
- Storage persists across the tests in one file (each file starts empty), and effects dedupe by key per instance, so
  give each test its own instance keys and ids. An instance every test shares, such as `main`, keeps what earlier
  tests left: assert only on what this test added.
- `cloudflare:test` has `runInDurableObject(stub, (instance, state) => …)` for reading an instance's tables, and
  `evictDurableObject(stub)` for a restart.
- `vitest.config.ts` adds `actorEvents()` from `@actord/toolkit/vitest`, so events land in `.actord/events.ndjson` for
  `actord trace`. Name tests with claim tags (`it("[crash-after-mutation] …")`); `[extended]` tests run only under
  `actord test --profile extended`.
