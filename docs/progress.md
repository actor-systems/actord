# Progress — Actor-Native Cloudflare Toolkit v0.1

Read this file and `docs/decisions/` before doing anything else when resuming.
Authoritative intent: `docs/charter.md`. Platform facts: `docs/ground-truth.md`.
Gate evidence: `npm run verify` → `verify-report.json` + `docs/verification-report.md`.

## Current gate
**G6 — The Room** (next). G0, G2–G4 passed; G1 and G5 offline-complete — only their model-backed eval
checks (`g1.start-session`, `g5.evals.run`) are blocked, awaiting owner approval (ask after G6/G7 so the
suite measures the final plugin).

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

- **G5 offline-complete** (verify 2026-10-24): 7 skills (always-on ~675 tok), 2 read-only critics, hooks
  (check-on-edit, evidence-gate), userConfig, `actors init/verify/test/hook`, claims classification,
  examples adopted, 12-case eval suite + offline scaffolds (lint-tested), starter smoke, verify-blocked.

## Next
- G6: the Room mod (`plugin/hooks/room.ts`, `types/index.d.ts`, `tests/*.test.ts`): `/actors-room` pane with
  Topology / Mailboxes / Contracts / Evidence tabs from CLI JSON via `$.process.run`/`spawn`; status line;
  `tool.call` effect guard on Bash using EFFECT_PATTERNS (needs a CLI `actors guard --json <cmd>` so the mod
  computes nothing); `.catch` refuses; non-interactive → refuse. Monitor `monitors/monitors.json`
  (`actors events --follow --notable`, on-skill-invoke reliability + inspect). Use plugin-authoring skill
  (types saved in scratchpad `plugin-authoring-2.1.310/`; reload skill if gone). Mod tests via
  `claude plugin test plugin`; surfaces terminal + desktop; /clear; guard refusal cases.
- G7: README/docs polish, CI workflow (.github/workflows/verify.yml, offline lane), clean-container install
  (ask owner: needs network/docker), `claude plugin tag --dry-run`, final report.
- Then ASK OWNER: eval lane approval (calibration run ≤$2, then full suite ×2 within $50).

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
