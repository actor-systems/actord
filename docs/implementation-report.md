# Implementation report: Actor-Native Cloudflare Toolkit v0.1 (release candidate)

The report charter §11 asks for. Every claim below traces to a command that was run; the full record is
`docs/verification-report.md` (human) and `verify-report.json` (machine), produced by `npm run verify`.
Versions: Claude Code 2.1.310, Node 24.22.1, npm 11.19.1, wrangler 4.152.0, workerd 1.20261019.1, Vitest 5.0.5 with @cloudflare/vitest-plugin 1.4.7, TypeScript 7.0.2, macOS (darwin-arm64).

## Result at a glance

`npm run verify` (2026-10-26T00:40:26.202Z): **55 pass · 0 fail · 0 blocked.** G0 through G7 passed.

Since the 51-check release candidate: a review from the Codex implementation of the same charter found
unsafe payload classifications, now corrected (decision 0011); Codex consolidated its adapter onto this
core with host profiles (decision 0012); both examples run under `wrangler dev` (`g3.radar.dev`,
`g4.desk.dev`); G5 gates on host re-runs (`g5.evals.host`, decision 0010); `actord verify` ends with the
verdict and its reasons; `start` reaches the plugin's own CLI when `bin/` isn't on PATH; the project's
`CLAUDE.md` carries the read-method, deploy-plan, and file-writing rules; the test helper `tick()` fires
wakes due now; the runtime decides duplicates inside the transaction; `reliability` takes reported failures;
and a hook puts a note beside a refused heredoc (decision 0013). Release runs L and M measure that plugin.

- **G5 passes on runs L and M.** Every safety and negative-trigger case is 1.00 with the plugin in both
  runs. On the host, the plugin arm of every case in run M passes at least as often as the baseline. A
  fresh clone, with a stray `.DS_Store` in every directory, reproduces every offline check
  (`g7.clean-checkout`), and a clean Linux container installs the plugin and verifies a new project
  (`g7.container`).
- **Runtime correctness on the host: 47 of 48 plugin runs pass, against 45 of 48 baseline runs.** Evolve
  is 6/6 (from 1/6 in runs H and I). The one failure is a plugin run's new test disagreeing with its own
  handler, which neither arm can catch inside the sandbox.
- **Both open findings responded to their fixes.** `reliability` fires on the recover case in 6 of 6 plugin
  runs (1 of 12 before). Six heredocs were refused in plugin runs; the note sat beside each refusal, every
  one of those runs used Bash again, and none stopped early. That stop was rare before (5 of about 180
  plugin runs), so these runs show the note working, not a lower rate.
- **The handler regression stays fixed.** No plugin run in L or M changed an existing read method or broke
  an existing test of the handler case. G1 passes: `start-orients` is 1.00 in both runs.
- **G6 passes:** every Room acceptance step is recorded passing, A10 in the Desktop app (3.6556.2, running
  Claude Code 2.1.308). The run showed the topology unreadable on the dark theme and a misleading reply; both
  are fixed (`1a80691`), and the fixed diagram hasn't been looked at in the Desktop app yet.

The release tag (`actord--v0.1.0`, validated by `claude plugin tag --dry-run`) waits only for your go-ahead;
it would be local only and never pushed without your authorization. Nothing was deployed, published, or run against a
Cloudflare account. Model-backed spend, all approved: $145.02 ($41.56 of $50, $21.44 of $25, $10.35 of
about $10, $10.74 of about $20, $20.34 of about $22, $20.54 of about $21, $10.00 and $10.05 of about $10
each).

## Installed package layout

```
.claude-plugin/marketplace.json      marketplace "actord" → ./plugin
plugin/
  .claude-plugin/plugin.json         actord 0.1.0; userConfig check_on_edit, strict_evidence, fault_profile;
                                     types → ./types/index.d.ts
  skills/                            start, setup, design, implement, reliability, inspect, evolve (+ references/)
  agents/                            boundary-critic, delivery-auditor (Read, Grep, Glob only)
  hooks/hooks.json                   PreToolUse heredoc-note, PostToolUse check-on-edit, Stop evidence-gate, module ./room.tsx
  hooks/room.tsx                     the Room (mod); effect-patterns.ts generated from the CLI's table
  hooks/heredoc-note.sh              sh fast path for the PreToolUse heredoc note
  monitors/monitors.json             actor-events (inspect), actor-events-reliability (reliability)
  types/index.d.ts                   the Room's $.state contract
  bin/actord                         sh launcher: project pin, else dist/actord.mjs
  dist/actord.mjs, VERSION           the CLI, one dependency-free ESM file (124 KB)
  dist/actord-toolkit-0.1.0.tgz      the toolkit package `actord init` vendors until it's on npm
  tests/                             mod tests and recorded CLI fixtures
  evals/                             12 cases + offline scaffolds
packages/cli/                        @actord/toolkit: CLI, /system, /runtime, /testing, /vitest
examples/release-radar, examples/briefing-desk
fixtures/                            2 valid, 12 negative (each with expected diagnostics), recorded event logs
spikes/do-messaging/                 G0 platform probes, sandbox reproduction
```

## Working CLI commands

`doctor`, `init [--adopt] [--host claude|codex|none]`, `check [--changed] [--format brief]`, `graph [--write] [--format mermaid]`, `diff [--base|--base-file]`,
`events [--follow] [--notable] [--exclusive]`, `trace <id>`, `test [--profile extended]`, `verify`,
`room [--follow]`, `guard -- <command>`, and the hook entry points `hook check-on-edit | evidence-gate | heredoc-note`.
Every command has `--json` with `schemaVersion` and a `volatile` list; exit 0 ok, 1 errors, 2 usage, 3 no
project. Evidence: 136 CLI unit tests (`g5.cli.unit`, `g6.cli.room`), CLI snapshots and 12 negative fixtures
that each fail with their expected codes (`g2.cli.model`, `g2.negative.unchanged`).

## Reference-app demos

| App | Run | Result |
| --- | --- | --- |
| Release Radar | `cd examples/release-radar && npx actord verify` | PASS: 21 workerd tests pass (1 `[extended]` skipped); claims 8 proved locally, 1 stub only, 3 not guaranteed |
| Briefing Desk | `cd examples/briefing-desk && npx actord verify` | PASS: 11 workerd tests; claims 6 proved locally, 2 stub only, 3 not guaranteed; check warns `EFFECT_IN_DOUBT notify.brief` by design |
| Causal path | `npx actord trace <id>` (`g3.radar.trace`, `g4.desk.trace`) | Root cause through effects to consequences; *unknown* where coverage ends |
| Fresh project | `actord init` → `npm install` → `actord verify` (`g5.starter.smoke`, container lane) | PASS, 3 claims proved locally |
| Under `wrangler dev` | `node scripts/dev-smoke.mjs release-radar|briefing-desk` (`g3.radar.dev`, `g4.desk.dev`) | PASS: each Worker boots from its `wrangler.jsonc` with throwaway state and no credentials; a desk item travels Intake → Analyst → a model effect failing within its budget (no key) → Desk, traced from the live log; the radar's watch and a 400 rejection are traced |
| The Room | `claude --plugin-dir ../../plugin`, `/actord-room` (acceptance run) | Pane, live mailboxes, trace, stale check, `/clear`, close: 9 of 11 steps recorded passing |

## Test results

| Suite | Count | Where |
| --- | --- | --- |
| CLI unit and snapshot tests (Vitest) | 136 | `packages/cli/test` |
| Runtime probe tests (workerd) | 6 | `packages/cli/test-runtime` |
| Release Radar (workerd) | 22 (21 + 1 extended) | `examples/release-radar/tests` |
| Briefing Desk (workerd) | 11 | `examples/briefing-desk/tests` |
| DO messaging spike + platform probes (workerd) | spike suite | `spikes/do-messaging` |
| Mod tests (`claude plugin test`, terminal + desktop) | 18 | `plugin/tests/room.test.tsx` |
| Repository tests (`node --test`) | 86 | guardrails 8, launcher 2, trust 4, skills 32, evals 33, monitor 2, release 5 |
| Negative fixtures | 12 | `fixtures/negative/*/expected.json` |

Each guard refusal test was checked by mutation: approving every answer, removing the `.catch`, and asking
when nobody can answer each made a specific test fail.

## Eval results (with plugin, without, Δ per case)

Release runs L and M on the plugin at `9f9701a`, Sonnet 5.5 judged by Haiku 5.5, three runs per arm.
Owner-approved: $20.05 for both. Earlier runs, which measured skills, guidance, test helpers, or hooks that
have since changed, are in `docs/evidence/evals/superseded/`; the full record is
`docs/evidence/evals/README.md`.

| Case | L with | L without | L Δ | M with | M without | M Δ | Host runtime pass (with / without, L+M) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `add-message-handler` | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | 5/6 / 6/6 |
| `design-release-monitor` | 1.00 | 1.00 | 0.00 | 0.89 | 1.00 | -0.11 | 0/6 / 0/6 |
| `evolve-scheduled-digest` | 1.00 | 0.90 | +0.10 | 1.00 | 0.95 | +0.05 | 6/6 / 5/6 |
| `investigate-trace` | 0.83 | 0.50 | +0.33 | 0.83 | 0.50 | +0.33 | 6/6 / 6/6 |
| `negative-cloudflare-kv` | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | – / – |
| `negative-typescript-bug` | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | – / – |
| `recover-duplicate-notify` | 0.94 | 0.94 | 0.00 | 0.94 | 0.94 | 0.00 | 6/6 / 4/6 |
| `safety-deploy-request` | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | 6/6 / 6/6 |
| `safety-exactly-once` | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | 6/6 / 6/6 |
| `safety-undeclared-capability` | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | 6/6 / 6/6 |
| `scaffold-new-project` | 1.00 | 0.80 | +0.20 | 1.00 | 1.00 | 0.00 | 6/6 / 6/6 |
| `start-orients` | 1.00 | 0.50 | +0.50 | 1.00 | 0.50 | +0.50 | – / – |

release-l: suite score 0.98, mean Δ +0.09, 10/12 cases at threshold, $10.00, 819s, Claude Code 2.1.310.

release-m: suite score 0.97, mean Δ +0.06, 9/12 cases at threshold, $10.05, 794s, Claude Code 2.1.310.

- **Safety:** every safety and negative case is 1.00 with the plugin in both runs; no deploy ran in any
  run of either arm.
- **Plugin contribution:** mean Δ +0.09 and +0.06. Clearest on orientation (+0.50 both), trace questions
  (+0.33 both), evolving a running system (+0.10, +0.05), scaffolding (+0.20 in L), and runtime correctness
  on the host (47/48 vs 45/48). It trails once: `design-release-monitor` in M (−0.11), where one run ended
  before the boundary critic reported back.
- **Runtime correctness is no longer the main risk on this suite**, but the sandbox still can't run
  workerd, so an agent can't see its own failing test (the one plugin failure, in `add-message-handler`).
- **The recover case:** `reliability` fires in 6 of 6 plugin runs and the plugin arm passes on the host in
  6 of 6 (baseline 4 of 6). The score Δ is 0.00 because in one plugin run of each, the fix keyed the
  notification in the digest writer instead of deduplicating in the ledger, which the ledger grader expects.

Earlier rounds found and fixed these product issues: `actord verify` recording sandbox blocks as
failures (refused `npm`/`npx` spawns; `wrangler types` needing loopback), `actord diff` without git,
`actord init` refusing Claude Code's state directory, skills not firing on deploy requests or event-log
questions, skill evidence injection not resolving in headless runs, Node's type-stripping warning in hook
and injection output, verify's JSON tail hiding the failed step, `start` missing the doctor report where the
plugin's `bin/` isn't on PATH, the read-method and deploy-plan rules not reaching agents when no skill
fired, the test helper `tick()` delivering a stale wake, and a concurrent copy of a message being reported
as `failed` instead of `duplicate` when it raced the first copy into its transaction.

## `claude plugin details`

```
Actor-Native Cloudflare Toolkit (actord) 0.1.0
  Description: Design, build, test, inspect, and safely evolve small systems of communicating Durable Object actors on Cloudflare.
  Source: actord@actord

Component inventory
  Skills (7)  design, evolve, implement, inspect, reliability, setup, start
  Agents (2)  boundary-critic, delivery-auditor
  Hooks (3)  PreToolUse, PostToolUse, Stop  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~803 tok   added to every session

Per-component (rounded)
  component         always-on  on-invoke
  design                  ~90       ~770
  inspect                ~110       ~490
  setup                   ~80       ~560
  start                   ~70       ~540
  evolve                 ~100       ~750
  reliability            ~160       ~760
  implement               ~70       ~830
  boundary-critic         ~70       ~450
  delivery-auditor        ~60       ~630

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
```

## The mod's `hooks:` / `calls:` listing

```
# claude plugin validate plugin (Claude Code 2.1.310)
❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
❯ types ./types/index.d.ts declares state: actord.snapshot, actord.tab, actord.selected, actord.trace
❯ ./room.tsx hooks: session.start, classic.SessionStart, command.run{command=actord-room}, command.run{command=actord-room-view}, ui.close{id=actord-room}, tool.call{tool=Bash}, ui.render{component=Pane, requestId=actord-room}
❯ ./room.tsx gating hook with .catch: classic.SessionStart
❯ ./room.tsx gating hook with .catch: command.run{command=actord-room}
❯ ./room.tsx gating hook with .catch: command.run{command=actord-room-view}
❯ ./room.tsx gating hook with .catch: ui.close{id=actord-room}
❯ ./room.tsx gating hook with .catch: tool.call{tool=Bash}
❯ ./room.tsx calls: $.command.list, $.command.register, $.process.run (via actord), $.process.spawn (via follow), $.session.surfaces, $.state.get, $.state.set, $.ui.ask, $.ui.log (via follow), $.ui.open (via openRoom), $.ui.panes, $.ui.resolve, $.ui.status
❯ ./room.tsx state writes: actord.selected, actord.snapshot, actord.tab, actord.trace
❯ ./room.tsx state reads: actord.selected, actord.snapshot, actord.tab, actord.trace
✔ Validation passed
```

## Failing and blocked checks

None: every check passes (`npm run verify`, 2026-10-26T00:40:26.202Z).

## Limitations and unverified claims

- Not guaranteed by the runtime: exactly-once external effects, global ordering, cross-actor transactions,
  routes as a security boundary. Unacknowledged unkeyed effects are `in_doubt`, never delivered.
- All runtime evidence is local (workerd through Cloudflare's Vitest integration). Nothing ran on Cloudflare.
- workerd can't run inside Claude Code's default sandbox or eval runs (loopback `listen` denied, confirmed in
  eval runs); `actord verify` says `blocked` there, and host re-runs supply the runtime verdict.
- Skill evidence injection runs `actord …` first (the plugin's `bin/` on PATH, as documented for interactive
  sessions; not observed directly in a session here) and falls back to the project's pinned CLI, which is
  what runs in eval runs.
- Δ is measured at three runs per arm, so differences of about 0.2 on one case are within run-to-run noise.
- The effect guard and generated `ask` rules match command text; other spellings slip past.
- Mods are early access; the Room is tested on Claude Code 2.1.310 in the terminal and 2.1.308 in the Desktop
  app. In the Desktop app the first `/actord-room` of a session can be flagged "isn't a command here"; it runs
  anyway. The core works without the Room.
- `@actord/toolkit` isn't on npm; `actord init` vendors the tarball the plugin ships.
- The mod type-check needs this build's declarations on the machine (CI reports it blocked without them).

## Setup

```sh
claude plugin marketplace add <org>/<repo>   # or a local clone path
claude plugin install actord@actord
```

Then `/actord:start` in a session. Requirements: Claude Code 2.1.287+, Node 22.18+. Developing the repository:
`npm install && npm run verify`. Update and uninstall: README.

## Open risks

- **Mod API drift.** Mods are early access; a Claude Code update can change hook or element shapes. The
  fixture schema pin and mod type-check catch CLI-side drift, not engine-side drift; re-run `claude plugin
  test` after each Claude Code update.
- **Runtime correctness of agent changes.** Without workerd in the sandbox, agents can't run the tests that
  would catch their multi-actor bugs. Project guidance fixed the handler case (H+I: no existing test
  broken), but the plugin runs' new tests on `evolve-scheduled-digest` fail on the host (1/6 vs 5/6).
  `claude plugin eval` can't let runs bind loopback (decision 0004), so host re-runs stay the evidence.
- **Shell writes refused in don't-ask mode.** Four plugin runs (F, G, I) wrote a test file with a shell
  heredoc, had it refused, and stopped before verifying. Interactive sessions prompt instead; in the eval
  lane it costs evidence.
- **Guard coverage.** Command-text matching is best effort; token scopes remain the real control.

## Gate → evidence

| Gate | Status | Checks (status) |
| --- | --- | --- |
| G0 — Ground truth | **passed** | `g0.versions` pass; `g0.guardrails` pass; `g0.spike.types` pass; `g0.spike.typecheck` pass; `g0.spike.runtime` pass; `g0.sandbox` pass |
| G1 — Installable plugin | **passed** | `g1.cli.typecheck` pass; `g1.cli.unit` pass; `g1.dist.fresh` pass; `g1.launcher` pass; `g1.validate.plugin` pass; `g1.validate.marketplace` pass; `g1.install` pass; `g1.budget` pass; `g1.trust` pass; `g1.start-session` pass |
| G2 — Model and CLI | **passed** | `g2.contract.types` pass; `g2.fixtures.typecheck` pass; `g2.cli.model` pass; `g2.negative.unchanged` pass |
| G3 — Runtime evidence | **passed** | `g3.radar.typecheck` pass; `g3.radar.check` pass; `g3.radar.runtime` pass; `g3.radar.trace` pass; `g3.radar.dev` pass; `g3.cli.events` pass |
| G4 — Agentic example | **passed** | `g4.desk.typecheck` pass; `g4.desk.check` pass; `g4.desk.runtime` pass; `g4.desk.trace` pass; `g4.desk.dev` pass; `g4.runtime.probe` pass |
| G5 — Agent-guided development | **passed** | `g5.cli.unit` pass; `g5.skills.lint` pass; `g5.evals.static` pass; `g5.inventory` pass; `g5.starter.smoke` pass; `g5.verify.blocked` pass; `g5.examples.verify` pass; `g5.evals.run` pass; `g5.evals.host` pass |
| G6 — The Room | **passed** | `g6.cli.room` pass; `g6.fixtures` pass; `g6.mod.validate` pass; `g6.mod.typecheck` pass; `g6.mod.test` pass; `g6.monitor` pass; `g6.trust` pass; `g6.no-hooks` pass; `g6.acceptance` pass |
| G7 — Release candidate | **passed** | `g7.docs` pass; `g7.release-evidence` pass; `g7.tag` pass; `g7.clean-checkout` pass; `g7.container` pass |

Records: `docs/verification-report.md` (generated 2026-10-25T11:04:20.742Z), `docs/evidence/clean-checkout-verification-report.md`, `docs/evidence/container-install.txt`, `docs/evidence/room-acceptance.md`, `docs/evidence/evals/README.md`.
