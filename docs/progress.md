# Progress — Actor-Native Cloudflare Toolkit v0.1

Read this file and `docs/decisions/` before doing anything else when resuming.
Authoritative intent: `docs/charter.md`. Platform facts: `docs/ground-truth.md`.
Gate evidence: `npm run verify` → `verify-report.json` + `docs/verification-report.md`.

## Current gate
**G2 — Model and CLI** (next). G1 offline-complete; `g1.start-session` blocked on eval approval.

## Done
- Guardrails: `.claude/settings.json` deny/ask rules, probed in-session (decision 0001).
- **G0 passed** (verify run 2026-10-24): versions, guardrail rules test, DO messaging spike
  (types, typecheck, workerd runtime), sandbox spike reproduced with srt. Decisions 0002–0005.

- **G1 offline-complete** (verify 2026-10-24): `actors-toolkit` CLI (`doctor`, effect pattern table) bundled
  to `plugin/dist/actors.mjs`; `bin/actors` launcher (prefers project pin); `start` skill; marketplace
  `actors-toolkit`; README trust section + test; strict validation; isolated install/uninstall smoke;
  always-on ~66 tok. `g1.start-session` = eval case `start-orients` (blocked until evals approved).

## Next
- G2: `system.ts` convention (`defineSystem`/`actor`/`message`, zod 4 payloads), normalized manifest,
  `check/graph/diff`, valid + negative fixtures, CLI snapshots.

## Open issues
- Eval runs and local port binding are unverified until the first approved eval run (decision 0004).
- "`start` works in a fresh session" (G1) and every eval need model calls, so ask the owner before running.

## Standing constraints (from the owner)
- Ask before: any deploy, real credentials, publishing/submitting, contacting external services
  (beyond reading docs and installing npm packages), and any model-backed `claude plugin eval` run.
- Eval budget: total ceiling $50, `--max-cost-usd` on every run, always `--no-publish`.
- Blocked ≠ passed. Evidence = commands actually run, recorded in the verification report.
- Session sandbox stays off for development (npm + workerd need it off). `.claude/settings.local.json`
  is local only.
