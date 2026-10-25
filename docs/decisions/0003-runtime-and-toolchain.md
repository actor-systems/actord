# 0003 — Runtime and toolchain: native Durable Objects, vitest-plugin, TS 7, no Agents SDK in v0.1

- **Date:** 2026-10-24 · **Gate:** G0 · **Status:** accepted · **Reversibility:** easy for toolchain,
  moderate for the actor base class

## Decision
- Actors are native `DurableObject` classes from `cloudflare:workers`, with typed RPC methods between
  stubs (`env.X.getByName(id).method()`), SQLite storage (`new_sqlite_classes`), and alarms for scheduling.
- Runtime tests: `vitest@5` + `@cloudflare/vitest-plugin@1` (`cloudflareTest()`), with `runInDurableObject`,
  `runDurableObjectAlarm`, `evictDurableObject` and `abortAllDurableObjects` for fault cases.
- TypeScript 7.0 (`tsc --noEmit`) for typechecks. The CLI never imports a TS compiler API; it bundles
  `system.ts` with esbuild and evaluates it (G2).
- npm workspaces at the repo root; no other package manager required.

## Why not the Agents SDK (agents 0.30.1) now
Release Radar needs one periodic wake (a native alarm). Briefing Desk needs a bounded model call behind an
adapter with retries, a budget, and cancellation, which is ordinary code in a DO. Neither needs
`schedule()`'s multiple schedules, queues, state sync, or chat. The SDK would add a large dependency tree
without improving either reference app (charter conviction 10). Skills point to Cloudflare's
`agents-sdk` skill as the escape hatch, and say when it's the better choice.

## Evidence
`spikes/do-messaging`: RPC between two DOs, SQLite dedupe, state across `evictDurableObject`, alarm via
`runDurableObjectAlarm`. 3/3 tests pass in workerd 1.20261019.1; `tsc --noEmit` passes on TS 7.0.2.
