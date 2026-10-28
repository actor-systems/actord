# Progress — Actor-Native Cloudflare Toolkit v0.1

Read this file and `docs/decisions/` before doing anything else when resuming.
Authoritative intent: `docs/charter.md`. Platform facts: `docs/ground-truth.md`.
Gate evidence: `npm run verify` → `verify-report.json` + `docs/verification-report.md`.

## Current gate
**v0.2.0 published; every gate passes.** Public at https://github.com/actor-systems/actord (CI green), with
the wiki generated from `docs/wiki/` (decision 0015); `@actord/toolkit` 0.2.0 is on npm, the same bytes the
plugins ship. `packages/toolkit`, `plugins/claude/`, and `plugins/codex/` share version 0.2.0 and the tag
`actord--v0.2.0` (`0020f21`); `actord--v0.1.0` marks `623c6ac`, the last commit of the old layout. The
Codex plugin moved in on `codex-plugin` (its own agent; relicensed Apache-2.0; reference templates ship only in
its distribution) and was merged by the owner. Release runs L and M were the Claude plugin's eval record until plan 5 superseded them
(`docs/evidence/evals/README.md`; owner-approved spend $145.02 in eight rounds); the Codex plugin has none yet.
Report: `docs/implementation-report.md`.

**Plan 1 (actord on Lifecycle) is built on `plan1/lifecycle-foundation`, not yet released.** actord is now a
Lifecycle capability (decision 0016): timers, cron `schedules`, per-effect budgets and usage, job effects
(decision 0018), a heartbeat with crash-loop parking, reused effect keys recorded as `effect.duplicate`
(fixes issue #2), and approvals that expire and record who approved. The plugin skills still teach the old
style.

**Plan 2 (sources and email approvals) is delivered on `plan2/sources-email`, not yet released.** Sources (GitHub
webhook and inbound email), approval tokens, auto-notify, and email approvals, verified with real Gmail in spike 6;
verified from a plain clone at `2be563e`: 61 pass, 0 fail, 0 blocked.

**Plan 3 (agent actors) is delivered on `plan3/agent-actors`, not yet released.** An actor declared `kind: "agent"`
runs a Pi session in its own Durable Object, as the job effect `agent.session`: `on` messages start, steer and stop
it, the effects it lists are its tools, `finish` returns the typed `returns` message, and actord enforces `usd`,
`turns` and `wallClock` (decision 0019). Its workspace is Computer's, in the object's SQLite, with commands in a
Cloudflare Container, registry-read egress through the toolkit's gateway, and clone and push from the object
(decision 0022). Spikes 2, 4 and 5 ran on a real container and pushed to GitHub (`docs/evidence/spike-2-computer.md`,
`spike-4-long-run.md`, `spike-5-push.md`). Verified from a plain clone at `b413bbb`, after the final review's fixes:
60 pass, 0 fail, 1 blocked (`g6.mod.typecheck`: this machine has no mod declarations for its Claude Code, 2.1.312).
The setup skills still name Node 22.18, as `actord doctor` accepts, and the plugin skills still teach the old style:
both are plan 5's.

**Plan 4 (decisions and extractions) is delivered on `plan4/decisions`, not yet released.** Any actor can declare a
`kind: "decision"` effect, which asks Clef or Clef-flash typed questions and gets a probability for every allowed
answer, or a `kind: "extraction"` effect, which asks Clairic for typed values with confidence. `decisionAdapters`, from
the new `@actord/toolkit/decisions`, runs them over the Workers AI binding. Every answer is recorded in
`_actors_decisions`, `ctx.acted` and `ctx.outcome` label it, and the new `actord scorecard` reports calibration from the
local event log. A shadow decision is recorded and never delivered, and a decision's result can't approve or deny
(decision 0020). Spike 7 read both models' schemas and called them live (`docs/evidence/spike-7-clef-clairic.md`).
Verified, after the final review's fixes and R10 (a forecast's value is a list), from a plain clone at `273692a`:
60 pass, 0 fail, 1 blocked (`g6.mod.typecheck`: this machine has no mod declarations for its Claude Code, 2.1.312).
Every project regenerates its manifest once (`actord graph --write`). The plugin skills still teach the old style
(plan 5). Plan 5 (the plugin skills, templates and eval scaffolds) follows.

**Plan 5 (plugin skills) is delivered on `plan5/skills`, not yet released.** Every Claude and Codex skill and both
agents now teach plans 1 to 4 (decision 0023), with no new skills: sources, timers, agents and decisions are
references under `implement`, the declaration is under `design`. Every `// actord:check` code block in a skill is
typechecked against the built toolkit (gate `g5.skills.snippets`), a test pins the Codex `workflow.md` copies, and
`actord doctor` requires Node 22.19. Plan 5 fixed a toolkit bug it found: `approvalDecided`, `agentFailed` and
`agentExhausted` moved to the Node-safe `@actord/toolkit/system`, because a `system.ts` importing them failed
`actord check`. The starter guidance and the examples' copies carry the no-await rule. The eval scaffolds were
hardened (9 of 13 had been broken since `d4103b5`; gate `g5.evals.scaffolds`), three cases were added (the suite is
15), and the host re-run needs no Cloudflare credentials. Runs L and M are superseded (decision 0023, option A), so
`g5.evals.run`, `g5.evals.host` and `g1.start-session` are **blocked** until the owner approves two full runs after
merge (about $25, $14-a-run ceiling). Issues filed: #89 (`actord check` doesn't flag misspelled fields) and #90 (CLI
`--notable` and `trace` gaps). Verified from a plain clone at `f270061`: 59 pass, 0 fail, 4 blocked (`g6.mod.typecheck`: no mod declarations on this machine; the three eval gates, per decision 0023).

**#80 (handler I/O) is merged, and #82 replaces its timer with an exact canary on `fix/82-canary-detector`.
Neither is released yet.**

- **Breaking.** A handler that awaits I/O now fails its delivery with "handlers may not await I/O; use ctx.effect".
  - Each such message fails on every attempt and dead-letters after 6, or, for a timer, is dropped with
    `retry.exhausted`.
  - The I/O the handler started still runs on each attempt.
  - Any await that yields to the event loop fails the delivery, I/O or not: `setTimeout(0)`, libraries that use
    timers internally, and since #82 `sync()`, `getCurrentBookmark()`, a nested `transaction()` and body reads.
- **How.** Just before each handler runs, inside its transaction, the runtime requests a no-op canary transaction.
  It runs at the handler's first yield, ahead of any other writer, and fails the delivery (#82). Writers waiting
  beside the handler then run after the rollback, and commit. Once a delivery ends, its `ctx` refuses every call.
- **What a handler may await.** Microtasks, and `get`, `put`, `list` and `delete`, the alarm calls, `ctx.sql`, `kv`,
  `transactionSync` and Lifecycle's `jobs.push`.
- **What remains.** The abandoned handler can still write outside its failed delivery: a nested `transaction()` it
  was awaiting, its `this.actor.requestEffect` calls and its direct `this.ctx.storage` writes. Limitations has it.

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

- **G5 offline-complete** (verify 2026-10-24): 7 skills (always-on ~675 tok at G5; ~740 after the eval fixes),
  2 read-only critics, hooks (check-on-edit, evidence-gate), userConfig, `actord init/verify/test/hook`, claims
  classification, examples adopted, 12-case eval suite + offline scaffolds (lint-tested), starter smoke,
  verify-blocked.

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
- ASK OWNER before any model-backed eval run (either plugin), before moving a pushed tag, before publishing
  a new npm version, and before submitting to either plugin directory.
- `init.ts` line 22: its comment still says the vendored tarball lasts "until @actord/toolkit is on npm"
  ([#1](https://github.com/actor-systems/actord/issues/1)). esbuild strips it, so fixing it changes no shipped file.
- A later release: consider Pele (obsidianmd/pele) to draw the Room's topology from `actord graph --format
  mermaid` once a topology outgrows the layered layout; edge labels need a background the Room can't know yet.

## Open issues
- #89: `actord check` doesn't flag a misspelled optional field, and a misspelled `publishes` skips
  `PUBLISHES_WITHOUT_APPROVAL`.
- #90: `actord events --notable` lacks `effect.parked`, and `trace` shows source refusals as unknown and draws no
  `decision.*` events.
- #79: Computer 0.8.0's push drops `corsProxy`, so `gitPushEffect` refuses a push when `.git/config` sets one; the
  fix belongs upstream.
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
