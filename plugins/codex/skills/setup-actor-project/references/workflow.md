# Shared API and evidence conventions

The single core is `@actord/toolkit`, built from this repository’s `packages/toolkit`. Both hosts run the same declaration, runtime, checks and event/claim model. Import declarations from `@actord/toolkit/system`, runtime helpers from `@actord/toolkit/runtime`, test seams from `@actord/toolkit/testing`, and event capture from `@actord/toolkit/vitest`.

Commands run from the project directory: `actord doctor`, `check`, `graph --write`, `diff --base-file <manifest>`, `events --notable`, `trace <message-id> --file <events.ndjson>`, `test --profile extended`, and `verify`; use `--json` for machine output. The adapter supports `init <dir> --template release-radar|briefing-desk`. The shared starter is plain `init <dir>`.

`actord.manifest.json` is derived from `system.ts`; capture diffs before rewriting it. `.actord/events.ndjson` contains local causal events, `.actord/last-check.json` records check freshness, and `.actord/evidence.json` contains the verification verdict and claim classifications. A successful CLI exit is not enough: read the verdict; `blocked` establishes no pass. `diff` exits 0 when analysis succeeds even if it finds breaking changes; inspect `summary` and `changes`. An unknown trace exits 1.

Handlers compose `actorRuntime({ctx, env}, system, "ActorName", handlers, {effects})`. They use `ctx.send(type, payload, {to, key})`, `ctx.effect(name, input, {key})`, `ctx.approve/deny` and `ctx.note`; they keep external awaits out of the storage transaction. Export the native class from the Worker entry and declare its binding and lifecycle in Wrangler configuration. A model/effect outcome returns on an explicit self-route. Both test and live adapters obey the declared budget and effect policy.

For incompatible changes, retain old message contracts under separately named declarations/routes until queued messages drain; the shared declaration has one current version per message key. Prove acceptance of representative old payloads rather than relying only on the schema comparator. No command establishes exactly-once external delivery, arbitrary-code sandboxing or production history.
