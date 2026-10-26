# Progress — Actor-Native Cloudflare Toolkit v0.1

Read this file and `docs/decisions/` before doing anything else when resuming.
Authoritative intent: `docs/charter.md`. Platform facts: `docs/ground-truth.md`.
Gate evidence: `npm run verify` → `verify-report.json` + `docs/verification-report.md`.

## Current gate
**One repository (decision 0014); the next release is 0.2.0.** `actord--v0.1.0` marks `623c6ac`, the last commit
of the old layout. Since then: `plugin/` is `plugins/claude/`, `packages/cli` is `packages/toolkit`, the toolkit
and both plugins share version 0.2.0, and `plugins/codex/` waits for the Codex plugin, which its own agent
moves in (with `.agents/plugins/marketplace.json`, relicensed Apache-2.0). Release runs L and M are the eval
record (`docs/evidence/evals/README.md`; owner-approved spend $145.02 in eight rounds). Report:
`docs/implementation-report.md`.

## Done
- Guardrails: `.claude/settings.json` deny/ask rules, probed in-session (decision 0001).
- **G0 passed** (verify run 2026-10-24): versions, guardrail rules test, DO messaging spike
  (types, typecheck, workerd runtime), sandbox spike reproduced with srt. Decisions 0002–0005.

- **G1 offline-complete** (verify 2026-10-24): `@actord/toolkit` CLI (`doctor`, effect pattern table) bundled
  to `plugins/claude/dist/actord.mjs`; `bin/actord` launcher (prefers project pin); `start` skill; marketplace
  `@actord/toolkit`; README trust section + test; strict validation; isolated install/uninstall smoke;
  always-on ~66 tok. `g1.start-session` = eval case `start-orients` (blocked until evals approved).

- **G2 passed** (verify 2026-10-24): `@actord/toolkit/system` (`defineSystem`, `message`; compile-time route,
  effect, schedule, payload contracts), normalized `actord.manifest.json`, `check` (stable codes),
  `graph`, `diff` + deploy plan; DO lifecycle via wrangler `exports` (decision 0006); fixtures 2 valid +
  12 negative; tests run the shipped `plugins/claude/dist/actord.mjs`.

- **G3 passed** (verify 2026-10-24): `@actord/toolkit/runtime` (transactional handlers, outbox, effects after
  commit w/ idempotency/in-doubt/approval/result messages), `/testing`, `/vitest`; Release Radar (3 actors,
  20 workerd tests, 13 fault tags); `actord events` (+follow/notable/NDJSON), `actord trace`; decision 0007.

- **G4 passed** (verify 2026-10-24): Briefing Desk (Intake, model-assisted Analyst w/ budget + validated
  output + stale-after-cancel, Desk; approval; in-doubt gateway; optional live Anthropic adapter, SDK 1.3.0);
  runtime: background effects (fixed head-of-line blocking), orphan recovery, ctx.approve/deny;
  `packages/toolkit/test-runtime` probe tests; `actord.claims.json` per example drives required test tags.

- **G5 offline-complete** (verify 2026-10-24): 7 skills (always-on ~675 tok at G5; ~740 after the eval fixes), 2 read-only critics, hooks
  (check-on-edit, evidence-gate), userConfig, `actord init/verify/test/hook`, claims classification,
  examples adopted, 12-case eval suite + offline scaffolds (lint-tested), starter smoke, verify-blocked.

- **G6 offline-complete** (verify 2026-10-24): the Room (`plugins/claude/hooks/room.tsx`, `types/index.d.ts`):
  `/actord-room` pane (Topology text/SVG, Mailboxes + trace, Contracts, Evidence; hotkeys 1–4, r), status
  line, effect guard (prefilter on a generated copy of the pattern table, `actord guard` decides, Refuse
  default, every failure denies). CLI `actord room [--follow]`, `actord guard`, `events --exclusive`,
  evidence fingerprint. Monitor (2 entries, one follower per session). 18 mod tests (+ guard mutation
  checks), fixture schema pin, mod typecheck, no-hooks smoke, acceptance run 9/11 recorded. Decision 0009.

- **G7 passed** (verify 2026-10-25): README release sections (update/uninstall, the Room, limitations),
  `docs/architecture.md`, CI workflow (offline lane), `scripts/clean-checkout.sh` (fresh clone verifies),
  `scripts/container-install.sh` (clean Linux container installs from the marketplace, starter verifies),
  release evidence (`docs/evidence/`), tag dry run. Release lanes found and fixed: non-reproducible build
  (CLI file mode), absolute path in a snapshot, skipped checks counted as passing, machine paths in reports.

## Next
- After the Codex plugin moves in: one `npm run verify` covering both plugins, then ASK OWNER before tagging
  0.2.0, before any further model-backed eval run, and before pushing anything.
- A later release: consider Pele (obsidianmd/pele) to draw the Room's topology from `actord graph --format
  mermaid` once a topology outgrows the layered layout; edge labels need a background the Room can't know yet.

## Open issues
- Eval runs deny the loopback port workerd needs (decision 0004), so agents in evals can't run their own
  workerd tests; kept workspaces are re-run on the host (`scripts/rerun-eval-workspaces.sh`).
- The Desktop app's first `/actord-room` in a session can be flagged "isn't a command here"; it runs anyway.
- Claude Code fills `${user_config.*}` in skill text only once an option is saved; skills state defaults beside
  placeholders.

## Owner approvals
- 2026-10-25: eval lane approved: Sonnet 5.5 agent (`claude-sonnet-5-5`), Haiku 5.5 judge
  (`claude-haiku-5-5`), $50 total ceiling: calibration (≤ $2) first, then the full suite twice; stop if the
  projection exceeds the ceiling. Acceptance step A9 (one model turn) approved.

- 2026-10-25: second round approved ("approved." to the proposal): fix skill evidence injection and the
  deploy-plan step, then two more release runs; ceiling $25 for the round (~$20 expected), Sonnet 5.5 agent,
  Haiku 5.5 judge, `--max-cost-usd` on every run.
- 2026-10-25, later rounds, each approved before it ran with `--max-cost-usd` per run: run F (~$10), run G and
  start-skill probes (~$20), runs H and I (~$22), runs J and K (~$21), run L (~$10), run M (~$10). Full list
  and spend in `docs/evidence/evals/README.md`.
- 2026-10-25: G5 gates on host re-runs ("no worse than baseline", one run of slack; decision 0010); runs
  measuring a changed plugin move to `superseded/` (J and K, after L and M).
- 2026-10-25: rename to `actord` everywhere (CLI, plugin, marketplace; npm `@actord/toolkit`), leaving no
  record of the old name in the current files (git history unchanged). The Codex adapter repository is
  Codex's to change: hand it a list, don't edit it.

## Standing constraints (from the owner)
- Ask before: any deploy, real credentials, publishing/submitting, contacting external services
  (beyond reading docs and installing npm packages), and any model-backed `claude plugin eval` run.
- Eval spend: each round needs the owner's approval first; `--max-cost-usd` on every run, always
  `--no-publish`.
- Blocked ≠ passed. Evidence = commands actually run, recorded in the verification report.
- Session sandbox stays off for development (npm + workerd need it off). `.claude/settings.local.json`
  is local only.
