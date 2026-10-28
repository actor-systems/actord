# Shared API and evidence conventions

The single core is `@actord/toolkit`, built from the actord repository’s `packages/toolkit`. Both hosts run the same declaration, runtime, checks and event/claim model. Import declarations from `@actord/toolkit/system`, runtime helpers from `@actord/toolkit/runtime`, test seams from `@actord/toolkit/testing`, and event capture from `@actord/toolkit/vitest`.

Commands run from the project directory: `actord doctor`, `check`, `graph --write`, `diff --base-file <manifest>`, `events --notable`, `trace <message-id> --file <events.ndjson>`, `test --profile extended`, and `verify`; use `--json` for machine output. The adapter supports `init <dir> --template release-radar|briefing-desk`. The shared starter is plain `init <dir>`.

`actord.manifest.json` is derived from `system.ts`; capture diffs before rewriting it. `.actord/events.ndjson` contains local causal events, `.actord/last-check.json` records check freshness, and `.actord/evidence.json` contains the verification verdict and claim classifications. A successful CLI exit is not enough: read the verdict; `blocked` establishes no pass. `diff` exits 0 when analysis succeeds even if it finds breaking changes; inspect `summary` and `changes`. An unknown trace exits 1.

An actor is a native Durable Object class that installs `Lifecycle` and composes `actorRuntime({ ctx, env, lifecycle }, system, "ActorName", handlers, { effects })`. Handlers use `ctx.send(type, payload, { to, key })`, `ctx.effect(name, input, { key })`, `ctx.approve/deny` and `ctx.note`. Export the class from the Worker entry and declare its binding in Wrangler configuration. A model/effect outcome returns on an explicit self-route. Both test and live adapters obey the declared budget and effect policy.

```ts
// actord:check system
import { defineSystem, message } from "@actord/toolkit/system";
import { z } from "zod";

export default defineSystem({
  name: "release-radar",
  messages: {
    "release.observed": message({
      version: 1,
      description: "A feed item was seen (possibly again)",
      payload: z.object({ itemId: z.string().min(1), title: z.string() }),
    }),
  },
  actors: {
    ReleaseLedger: {
      binding: "RELEASE_LEDGER",
      kind: "deterministic",
      purpose: "Owns the record of every release seen",
      justification: ["state"],
    },
  },
  routes: [
    { from: "@ingress", message: "release.observed", to: "ReleaseLedger" },
  ],
});
```

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
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS releases (item_id TEXT PRIMARY KEY, title TEXT NOT NULL)",
    );
  }

  actor = actorRuntime(
    { lifecycle: this.lifecycle, ctx: this.ctx, env: this.env },
    system,
    "ReleaseLedger",
    {
      // One handler per message routed to ReleaseLedger: a missing or extra one is a type error.
      "release.observed": ({ payload }, ctx) => {
        ctx.sql.exec(
          "INSERT OR IGNORE INTO releases (item_id, title) VALUES (?, ?)",
          payload.itemId,
          payload.title,
        );
      },
    },
  );

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
}
```

`Lifecycle.install(this)` runs in a field initializer before `actor` and installs `alarm`, so don't define `alarm()`.

Handlers may not await I/O. Each handler runs in one storage transaction, so it is synchronous: a `fetch`, timer, container or model call, or any await that yields, fails the delivery with `handlers may not await I/O; use ctx.effect`. Request the work with `ctx.effect(name, input, { key })` and handle the effect's declared result message. `ctx.sql`, `ctx.send` and the storage calls `get`, `put`, `list` and `delete` are fine.

In the supplied workerd test setup, Durable Object storage persists across tests in one file; each file starts empty. Use distinct instance keys, message IDs and effect keys for independent tests. A shared instance such as `main` retains earlier tests' state, so assert on what the current test added. A later `overrideEffect` for the same effect replaces the earlier adapter; use the latest fixture call's returned log. `tick()` delivers a scheduled wake due now, with the current time in `payload.at`; each call is a distinct wake.

## Capabilities

The toolkit's wiki (<https://github.com/actor-systems/actord/wiki>: Runtime, Limitations and the other pages) covers each in full; name them rather than guessing an API.

- **Timers and jobs.** `ctx.after(delay, type, payload, { key })`, `ctx.at(epochMs, …)` and `ctx.cancelTimer(key)` wake the same instance with a declared message; an actor's `schedules` (`every` or `cron`, UTC) deliver `{ at }` ticks from `@clock`. Long external work is a job effect, settled with `ctx.settleJob` and cancelled with `ctx.cancelJob`.
- **Sources.** A webhook or inbound email enters through `sources` in `system.ts`; its name is a route sender such as `@github`. Declare it there and route its messages like any other. Import `inboundEmail`, `webhook` and `approvalDecided` from `@actord/toolkit/system`.
- **Agent actors.** An actor declared `kind: "agent"` runs Pi sessions in its own Durable Object, with an optional container workspace. Its failure and budget messages, `agentFailed` and `agentExhausted`, come from `@actord/toolkit/system`; the runtime is `@actord/toolkit/agents`.
- **Decisions.** A decision or extraction is an effect (adapters in `@actord/toolkit/decisions`) that returns typed answers with probabilities or confidences. Confirmed answers are recorded for `actord scorecard`; label them later with `ctx.acted` and `ctx.outcome`.

For incompatible changes, retain old message contracts under separately named declarations/routes until queued messages drain; the shared declaration has one current version per message key. Prove acceptance of representative old payloads rather than relying only on the schema comparator. No command establishes exactly-once external delivery, arbitrary-code sandboxing or production history.
