# Progress — Actor-Native Cloudflare Toolkit v0.1

Read this file and `docs/decisions/` before doing anything else when resuming.
Authoritative intent: `docs/charter.md`. Platform facts: `docs/ground-truth.md`.
Gate evidence: `npm run verify` → `verify-report.json` + `docs/verification-report.md`.

## Current gate
**Release candidate, with two open items.** Eval lane done (owner-approved, $41.56 of $50): release runs B
and C on the final plugin, `docs/evidence/evals/README.md`. Open: `g5.evals.run` fails as written (run C:
`safety-deploy-request` 0.92, one run without the `actors diff` plan; no deploy ever ran); acceptance A10
(Desktop app) is the owner's. Candidate next fixes, unmeasured: skill injection via
`${CLAUDE_PLUGIN_ROOT}/bin/actors` (bare `actors` isn't on PATH in eval runs), a reliable plan step for deploy
requests. Report: `docs/implementation-report.md`.

## Done
- Guardrails: `.claude/settings.json` deny/ask rules, probed in-session (decision 0001).
- **G0 passed** (verify run 2026-10-24): versions, guardrail rules test, DO messaging spike
  (types, typecheck, workerd runtime), sandbox spike reproduced with srt. Decisions 0002–0005.

- **G1 offline-complete** (verify 2026-10-24): `actors-toolkit` CLI (`doctor`, effect pattern table) bundled
  to `plugin/dist/actors.mjs`; `bin/actors` launcher (prefers project pin); `start` skill; marketplace
  `actors-toolkit`; README trust section + test; strict validation; isolated install/uninstall smoke;
  always-on ~66 tok. `g1.start-session` = eval case `start-orients` (blocked until evals approved).

- **G2 passed** (verify 2026-10-24): `actors-toolkit/system` (`defineSystem`, `message`; compile-time route,
  effect, schedule, payload contracts), normalized `actors.manifest.json`, `check` (stable codes),
  `graph`, `diff` + deploy plan; DO lifecycle via wrangler `exports` (decision 0006); fixtures 2 valid +
  12 negative; tests run the shipped `plugin/dist/actors.mjs`.

- **G3 passed** (verify 2026-10-24): `actors-toolkit/runtime` (transactional handlers, outbox, effects after
  commit w/ idempotency/in-doubt/approval/result messages), `/testing`, `/vitest`; Release Radar (3 actors,
  20 workerd tests, 13 fault tags); `actors events` (+follow/notable/NDJSON), `actors trace`; decision 0007.

- **G4 passed** (verify 2026-10-24): Briefing Desk (Intake, model-assisted Analyst w/ budget + validated
  output + stale-after-cancel, Desk; approval; in-doubt gateway; optional live Anthropic adapter, SDK 1.3.0);
  runtime: background effects (fixed head-of-line blocking), orphan recovery, ctx.approve/deny;
  `packages/cli/test-runtime` probe tests; `actors.claims.json` per example drives required test tags.

- **G5 offline-complete** (verify 2026-10-24): 7 skills (always-on ~675 tok at G5; ~740 after the eval fixes), 2 read-only critics, hooks
  (check-on-edit, evidence-gate), userConfig, `actors init/verify/test/hook`, claims classification,
  examples adopted, 12-case eval suite + offline scaffolds (lint-tested), starter smoke, verify-blocked.

- **G6 offline-complete** (verify 2026-10-24): the Room (`plugin/hooks/room.tsx`, `types/index.d.ts`):
  `/actors-room` pane (Topology text/SVG, Mailboxes + trace, Contracts, Evidence; hotkeys 1–4, r), status
  line, effect guard (prefilter on a generated copy of the pattern table, `actors guard` decides, Refuse
  default, every failure denies). CLI `actors room [--follow]`, `actors guard`, `events --exclusive`,
  evidence fingerprint. Monitor (2 entries, one follower per session). 18 mod tests (+ guard mutation
  checks), fixture schema pin, mod typecheck, no-hooks smoke, acceptance run 9/11 recorded. Decision 0009.

- **G7 passed** (verify 2026-10-25): README release sections (update/uninstall, the Room, limitations),
  `docs/architecture.md`, CI workflow (offline lane), `scripts/clean-checkout.sh` (fresh clone verifies),
  `scripts/container-install.sh` (clean Linux container installs from the marketplace, starter verifies),
  release evidence (`docs/evidence/`), tag dry run. Release lanes found and fixed: non-reproducible build
  (CLI file mode), absolute path in a snapshot, skipped checks counted as passing, machine paths in reports.

## Next
- Then ASK OWNER: eval lane approval (calibration run ≤$2, then full suite ×2 within $50), and the two
  Room acceptance steps only a person can run (A9: one model turn holding a deploy; A10: Desktop app).

## Open issues
- Eval runs and local port binding are unverified until the first approved eval run (decision 0004).
- "`start` works in a fresh session" (G1) and every eval need model calls, so ask the owner before running.

## Owner approvals
- 2026-10-25: eval lane approved: Sonnet 5.5 agent (`claude-sonnet-5-5`), Haiku 5.5 judge
  (`claude-haiku-5-5`), $50 total ceiling: calibration (≤ $2) first, then the full suite twice; stop if the
  projection exceeds the ceiling. Acceptance step A9 (one model turn) approved.

- 2026-10-25: second round approved ("approved." to the proposal): fix skill evidence injection and the
  deploy-plan step, then two more release runs; ceiling $25 for the round (~$20 expected), Sonnet 5.5 agent,
  Haiku 5.5 judge, `--max-cost-usd` on every run.

## Standing constraints (from the owner)
- Ask before: any deploy, real credentials, publishing/submitting, contacting external services
  (beyond reading docs and installing npm packages), and any model-backed `claude plugin eval` run.
- Eval budget: total ceiling $50, `--max-cost-usd` on every run, always `--no-publish`.
- Blocked ≠ passed. Evidence = commands actually run, recorded in the verification report.
- Session sandbox stays off for development (npm + workerd need it off). `.claude/settings.local.json`
  is local only.
