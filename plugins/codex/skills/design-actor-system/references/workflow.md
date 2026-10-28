# Shared API and evidence conventions

The single core is `@actord/toolkit`, built from this repository’s `packages/toolkit`. Both hosts run the same declaration, runtime, checks and event/claim model. Import declarations from `@actord/toolkit/system`, runtime helpers from `@actord/toolkit/runtime`, test seams from `@actord/toolkit/testing`, and event capture from `@actord/toolkit/vitest`.

Commands run from the project directory: `actord doctor`, `check`, `graph --write`, `diff --base-file <manifest>`, `events --notable`, `trace <message-id> --file <events.ndjson>`, `test --profile extended`, and `verify`; use `--json` for machine output. The adapter supports `init <dir> --template release-radar|briefing-desk`. The shared starter is plain `init <dir>`.

Use `actord graph --format mermaid` for a topology flowchart suitable for documentation. Adding `--json` includes a `mermaid` field alongside the manifest; default graph JSON has no such field. Unknown formats exit 2. Graph rendering does not update the manifest unless `--write` is also supplied.

`actord.manifest.json` is derived from `system.ts`; capture diffs before rewriting it. `.actord/events.ndjson` contains local causal events, `.actord/last-check.json` records check freshness, and `.actord/evidence.json` contains the verification verdict and claim classifications. A successful CLI exit is not enough: read the verdict; `blocked` establishes no pass. `diff` exits 0 when analysis succeeds even if it finds breaking changes; inspect `summary` and `changes`. An unknown trace exits 1.

Declare the topology in `system.ts`:

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

Handlers may not await I/O. Each handler runs in one storage transaction, so it is synchronous: a `fetch`, timer, container or model call, or any await that yields, fails the delivery with `handlers may not await I/O; use ctx.effect`. Request the work with `ctx.effect(name, input, { key })` and handle the effect's declared result message. `ctx.sql`, `ctx.send` and the storage calls `get`, `put`, `list` and `delete` are fine.

## Capabilities

The toolkit docs (`docs/wiki/Runtime.md` and the other pages in the toolkit repository's `docs/wiki`) cover each in full; name them rather than guessing an API.

- **Timers and jobs.** `ctx.after(delay, type, payload, { key })`, `ctx.at(epochMs, …)` and `ctx.cancelTimer(key)` wake the same instance with a declared message; a `schedule` in `system.ts` delivers `{ at }` ticks on a cron. Long external work is a job effect, settled with `ctx.settleJob` and cancelled with `ctx.cancelJob`.
- **Sources.** A webhook or inbound email enters through `sources` in `system.ts`; its name is a route sender such as `@github`. Declare it there and route its messages like any other. Import `inboundEmail`, `webhook` and `approvalDecided` from `@actord/toolkit/system`.
- **Agent actors.** An actor declared `kind: "agent"` runs Pi sessions in its own Durable Object, with an optional container workspace. Its failure and budget messages, `agentFailed` and `agentExhausted`, come from `@actord/toolkit/system`; the runtime is `@actord/toolkit/agents`.
- **Decisions.** A decision or extraction is an effect (adapters in `@actord/toolkit/decisions`) that returns typed answers with probabilities or confidences. Confirmed answers are recorded for `actord scorecard`; label them later with `ctx.acted` and `ctx.outcome`.

For incompatible changes, retain old message contracts under separately named declarations/routes until queued messages drain; the shared declaration has one current version per message key. Prove acceptance of representative old payloads rather than relying only on the schema comparator. No command establishes exactly-once external delivery, arbitrary-code sandboxing or production history.
