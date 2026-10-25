# 0006 — The system declaration, the normalized manifest, and Durable Object `exports`

- **Date:** 2026-10-24 · **Gate:** G2 · **Status:** accepted · **Reversibility:** moderate (it's the
  core convention, versioned by `schemaVersion`)

## Decisions
1. **`system.ts` default-exports `defineSystem({...})` from `actors-toolkit/system`.** It declares
   `messages` (versioned Standard Schema payloads), `actors` (binding, kind, purpose, justification,
   optional schedule, effects, and budget), `effects` (idempotency, reconcile, approval), and `routes`
   (`from`, `message`, `to`; senders may be `@clock` or `@ingress`). **Routes are the single source of who
   sends and receives what.** Per-actor `receives` and `sends` are derived, never hand-maintained.
2. **The compiler is the first critic.** `defineSystem` uses `const` type parameters with `NoInfer`, so
   these are TypeScript errors: an undeclared actor or message in a route, an undeclared effect on an
   actor, an undeclared schedule message, and a payload that doesn't match its schema. Contract tests:
   `packages/cli/test/types/system.types.ts` (`@ts-expect-error`) and `scripts/typecheck-fixtures.mjs`.
3. **Payload schemas are Standard Schema; the toolkit never imports zod.** Validation uses
   `~standard.validate`; the manifest's payload JSON Schema comes from `~standard.jsonSchema.input()`
   (Standard JSON Schema), which zod 4.6 implements. Any compliant library works; a library without
   JSON Schema export gives `PAYLOAD_SCHEMA_OPAQUE` and diffs report its changes as "risky".
4. **The CLI loads `system.ts` with Node's native type stripping** (Node ≥ 22.18; verified on 24.22).
   Consequences, all checked by `actors doctor` or `actors check`: projects need `"type": "module"`,
   relative imports use explicit `.ts` extensions, and `system.ts` uses erasable syntax only
   (`erasableSyntaxOnly`). The declaration must be free of side effects: it's evaluated by every check.
5. **`actors.manifest.json` is the derived, committed architecture metadata.** It holds sorted arrays and
   keys and a `$comment` saying it's derived. `actors graph --write` produces it, `actors check` fails
   with `MANIFEST_STALE` when it drifts, and `actors diff` uses the copy committed at a git ref (default
   `HEAD`) as its base, so "changes since the last commit" needs no second evaluation of old code.
6. **Durable Object classes are declared through wrangler's `exports` map, not `migrations`.**
   Cloudflare's docs (updated 2026-09-28) make `exports` the declarative lifecycle flow. `migrations`
   is "legacy" and the two are mutually exclusive. Verified locally on wrangler 4.152: `wrangler types`,
   `@cloudflare/vitest-plugin` (3/3), and `wrangler dev` all accept `exports`. `actors check` requires a live
   `exports.<Actor>` with `storage: "sqlite"`; it accepts legacy migrations with the warning
   `CONFIG_LEGACY_MIGRATIONS`.
7. **Deploy plans encode platform facts that make changes irreversible:** a `deleted` export destroys data
   with no trash; renames keep data only via `state: "renamed"`; lifecycle changes apply only through
   `wrangler deploy`, can't be rolled back past, and can't be deployed gradually.
8. **Stable exit statuses:** 0 ok, 1 hard errors, 2 usage, 3 not in an actor project (hooks skip quietly).
   Every `--json` document carries `schemaVersion`, `command`, `toolkitVersion`, and `volatile` (the fields
   that legitimately vary by machine, such as `projectRoot`).

## Rejected
- A YAML or JSON declaration: a second representation the compiler can't check.
- Deriving `sends`/`receives` on actors *and* routes: two sources of truth.
- Evaluating `system.ts` with esbuild or the TS compiler API: a native dependency that the single-file
  bundled CLI can't carry, and TS 7 has no stable JS API.
- Rewriting `wrangler.jsonc` automatically: `check` reports drift with the exact fix instead.
