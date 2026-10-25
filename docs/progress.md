# Progress — Actor-Native Cloudflare Toolkit v0.1

Read this file and `docs/decisions/` before doing anything else when resuming.
Authoritative intent: `docs/charter.md`. Platform facts: `docs/ground-truth.md`.
Gate evidence: `npm run verify` → `verify-report.json` + `docs/verification-report.md`.

## Current gate
**G5 — Agent-guided development** (next). G0, G2–G4 passed; G1 offline-complete (`g1.start-session` blocked on eval approval).

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

## Next (G5 plan, in order)
1. CLI `actors verify` (typecheck → check → workerd tests w/ JSON reporter → claims classification:
   proved-locally / stub-only / not-guaranteed / blocked(sandbox EPERM) → `.actors/evidence.json` +
   `--out`), `actors test [--profile extended]`, `actors init [dir] [--adopt]` (template: minimal 2-actor
   project + `.claude/skills/verify/SKILL.md` + `.claude/settings.json` ask rules from EFFECT_PATTERNS +
   ≤10-line CLAUDE.md; never overwrite `.claude/`), `actors hook check-on-edit|evidence-gate`.
2. Plugin: hooks/hooks.json (PostToolUse Write|Edit, Stop), userConfig (check_on_edit, strict_evidence,
   fault_profile options), 6 more skills (setup, design, implement, reliability, inspect, evolve) with
   dynamic context injection + exact allowed-tools, agents boundary-critic + delivery-auditor (Read/Grep/Glob).
   Load skill-creator / create-subagents / create-hooks guidance when writing them. Keep always-on ≤1000 tok.
3. Examples: run `actors init --adopt` so each ships verify skill, settings, CLAUDE.md.
4. Eval suite `plugin/evals/` (≥12 cases incl. start-orients, 2 adversarial, deploy, 2 negative-trigger,
   co-installed); scaffold copies examples + node_modules (APFS `cp -c` clone) into workspace; graders on
   `.actors/evidence.json` + tool_used/tool_order + short llm. Then ASK OWNER for eval approval
   (budget $50 total, --max-cost-usd each run, --no-publish, pinned --model/--judge-model).
5. Optional workflow design-review: skip unless evals justify (decision record).

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
