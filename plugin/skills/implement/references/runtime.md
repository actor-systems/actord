# `@actord/toolkit/runtime` and `@actord/toolkit/testing`

## An actor class

```ts
import { DurableObject } from "cloudflare:workers";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import system from "../../system.ts";

export class Ledger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS seen (item_id TEXT PRIMARY KEY, version TEXT NOT NULL)");
  }

  actor = actorRuntime({ ctx: this.ctx, env: this.env }, system, "Ledger", {
    // One handler per message routed to Ledger; a missing or extra handler is a type error.
    "release.observed": ({ id, payload }, ctx) => {
      if (ctx.sql.exec("SELECT 1 FROM seen WHERE item_id = ?", payload.itemId).toArray().length) return ctx.note("already seen");
      ctx.sql.exec("INSERT INTO seen (item_id, version) VALUES (?, ?)", payload.itemId, payload.version);
      ctx.send("release.significant", { itemId: payload.itemId }); // only along declared routes
    },
  }, { effects: { /* name: adapter */ } });

  receive(envelope: Envelope) { return this.actor.receive(envelope); }
  alarm() { return this.actor.alarm(); }
}
```

Handler context (`ctx`): `sql` (native SQLite, inside the handler's transaction), `send(type, payload,
{ to?, key? })` (instance key defaults to `"main"`), `effect(name, input, { key })`, `approve(name, key)` and
`deny(name, key, reason)` for effects parked for a person, `note(text)` (a structured event), `now()`,
`self`, `key`.

From the Worker's own code: `ingress(env, system, "Actor", "message.type", payload, { key, id })`.

## Effects

```ts
const gateway: EffectAdapter<Input, Output> = {
  async run(input, { key, attempt, signal }) { /* call out; honor signal */ },
  async reconcile(key) { /* optional: { delivered: true, value } | { delivered: false } | undefined */ },
};
```

Throw `EffectNotDelivered` when the request provably never left (safe to retry), and `EffectRejected` for a
definitive refusal (never retried). Any other error is ambiguous: retried with `idempotency: "key"`,
otherwise reconciled or reported `in_doubt`. With `result: "<message>"` declared, the outcome
`{ key, status: "confirmed" | "failed" | "in_doubt", value?, error? }` arrives as that message.

## Stale results and cancellation

Store a generation per item. Put it in the effect key (`${id}:g${generation}`), bump it on cancel, and in
the result handler ignore any key whose generation isn't current. Effects run outside the transaction, so
the cancel can arrive while the model call is in flight.

## Testing (in workerd, `@cloudflare/vitest-plugin`)

```ts
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { injectFault, overrideBudget, overrideEffect, resetSeams, settle, tick } from "@actord/toolkit/testing";
```

- `settle(env, system)` delivers everything pending and waits for running effects, fast-forwarding backoff.
- `tick(env, system, "Actor", key)` simulates a scheduled wake.
- `injectFault({ actor, type, at: "before-handler" | "after-handler" | "deliver", times })`.
- `overrideEffect(name, adapter)` and `overrideBudget(actor, { timeoutMs, maxAttempts })`; call `resetSeams()`
  in `afterEach`.
- `vitest.config.ts` adds `actorEvents()` from `@actord/toolkit/vitest`, so events land in
  `.actord/events.ndjson` for `actord trace`.
- Name tests with claim tags (`it("[crash-after-mutation] …")`). Tests tagged `[extended]` run only under
  `actord test --profile extended`.
