# Implementation report: Actor-Native Cloudflare Toolkit v0.1 (release candidate)

The report charter §11 asks for. Every claim below traces to a command that was run; the full record is
`docs/verification-report.md` (human) and `verify-report.json` (machine), produced by `npm run verify`.
Versions: Claude Code 2.1.310, Node 24.22.1, npm 11.19.1, wrangler 4.152.0, workerd 1.20261019.1, Vitest 5.0.5 with @cloudflare/vitest-plugin 1.4.7, TypeScript 7.0.2, macOS (darwin-arm64).

## Result at a glance

`npm run verify` (2026-10-25T03:27:50.435Z): **49 pass · 0 fail · 3 blocked · 0 skipped.** G0 passed, G1 blocked, G2 passed, G3 passed, G4 passed, G5 blocked, G6 blocked, G7 passed. The three blocked checks are the owner's: the model-backed eval suite (which also settles G1's "start works in a fresh session") and two interactive acceptance steps. A fresh clone of the repository passes the same suite (`g7.clean-checkout`), and a clean Linux container installs the plugin from the marketplace and verifies a new project in workerd (`g7.container`).

G7's own checks pass, but the charter's G7 exit also requires every mandatory gate green, so the release
candidate isn't complete until G1, G5, and G6 clear their owner items. The release tag (`actors--v0.1.0`,
validated by `claude plugin tag --dry-run`) is created locally only after that; it's never pushed without
authorization. Nothing was deployed, published, or run against a Cloudflare account, and no model-backed eval
has run (see "Blocked checks").

Found and fixed by the release lanes themselves: the clean clone caught a non-reproducible build (file mode on
the CLI) and a snapshot holding an absolute path; the acceptance run caught a trace drawn below the fold and a
follower lost on mod reload; the clone's report caught a gate counting skipped checks as passed.

## Installed package layout

```
.claude-plugin/marketplace.json      marketplace "actors-toolkit" → ./plugin
plugin/
  .claude-plugin/plugin.json         actors 0.1.0; userConfig check_on_edit, strict_evidence, fault_profile;
                                     types → ./types/index.d.ts
  skills/                            start, setup, design, implement, reliability, inspect, evolve (+ references/)
  agents/                            boundary-critic, delivery-auditor (Read, Grep, Glob only)
  hooks/hooks.json                   PostToolUse check-on-edit, Stop evidence-gate, module ./room.tsx
  hooks/room.tsx                     the Room (mod); effect-patterns.ts generated from the CLI's table
  monitors/monitors.json             actor-events (inspect), actor-events-reliability (reliability)
  types/index.d.ts                   the Room's $.state contract
  bin/actors                         sh launcher: project pin, else dist/actors.mjs
  dist/actors.mjs, VERSION           the CLI, one dependency-free ESM file (128 KB)
  dist/actors-toolkit-0.1.0.tgz      the toolkit package `actors init` vendors until it's on npm
  tests/                             mod tests and recorded CLI fixtures
  evals/                             12 cases + offline scaffolds
packages/cli/                        actors-toolkit: CLI, /system, /runtime, /testing, /vitest
examples/release-radar, examples/briefing-desk
fixtures/                            2 valid, 12 negative (each with expected diagnostics), recorded event logs
spikes/do-messaging/                 G0 platform probes, sandbox reproduction
```

## Working CLI commands

`doctor`, `init [--adopt]`, `check [--changed] [--format brief]`, `graph [--write]`, `diff [--base|--base-file]`,
`events [--follow] [--notable] [--exclusive]`, `trace <id>`, `test [--profile extended]`, `verify`,
`room [--follow]`, `guard -- <command>`, and the hook entry points `hook check-on-edit | evidence-gate`.
Every command has `--json` with `schemaVersion` and a `volatile` list; exit 0 ok, 1 errors, 2 usage, 3 no
project. Evidence: 84 CLI unit tests (`g5.cli.unit`, `g6.cli.room`), CLI snapshots and 12 negative fixtures
that each fail with their expected codes (`g2.cli.model`, `g2.negative.unchanged`).

## Reference-app demos

| App | Run | Result |
| --- | --- | --- |
| Release Radar | `cd examples/release-radar && npx actors verify` | PASS: 20 workerd tests pass (1 `[extended]` skipped); claims 8 proved locally, 1 stub only, 3 not guaranteed |
| Briefing Desk | `cd examples/briefing-desk && npx actors verify` | PASS: 11 workerd tests; claims 6 proved locally, 2 stub only, 3 not guaranteed; check warns `EFFECT_IN_DOUBT notify.brief` by design |
| Causal path | `npx actors trace <id>` (`g3.radar.trace`, `g4.desk.trace`) | Root cause through effects to consequences; *unknown* where coverage ends |
| Fresh project | `actors init` → `npm install` → `actors verify` (`g5.starter.smoke`, container lane) | PASS, 3 claims proved locally |
| The Room | `claude --plugin-dir ../../plugin`, `/actors-room` (acceptance run) | Pane, live mailboxes, trace, stale check, `/clear`, close: 9 of 11 steps recorded passing |

## Test results

| Suite | Count | Where |
| --- | --- | --- |
| CLI unit and snapshot tests (Vitest) | 84 | `packages/cli/test` |
| Runtime probe tests (workerd) | 6 | `packages/cli/test-runtime` |
| Release Radar (workerd) | 21 (20 + 1 extended) | `examples/release-radar/tests` |
| Briefing Desk (workerd) | 11 | `examples/briefing-desk/tests` |
| DO messaging spike + platform probes (workerd) | spike suite | `spikes/do-messaging` |
| Mod tests (`claude plugin test`, terminal + desktop) | 18 | `plugin/tests/room.test.tsx` |
| Repository tests (`node --test`) | 84 | guardrails 8, launcher 2, trust 4, skills 32, evals 31, monitor 2, release 5 |
| Negative fixtures | 12 | `fixtures/negative/*/expected.json` |

Each guard refusal test was checked by mutation: approving every answer, removing the `.catch`, and asking
when nobody can answer each made a specific test fail.

## Eval results (with plugin, without, Δ per case)

**Not run.** The suite (12 cases: 6 representative, 2 adversarial, 1 deploy request, 2 negative-trigger, 1
onboarding) is built and statically verified (`g5.evals.static`: case mix, paired result and process graders,
safety assertions, scaffolds that build offline workspaces in ~11 s). Running it spends the owner's usage and
needs approval. Δ per case: pending for every case.

## `claude plugin details`

```
Actor-Native Cloudflare Toolkit (actors) 0.1.0
  Description: Design, build, test, inspect, and safely evolve small systems of communicating Durable Object actors on Cloudflare.
  Source: actors@actors-toolkit

Component inventory
  Skills (7)  design, evolve, implement, inspect, reliability, setup, start
  Agents (2)  boundary-critic, delivery-auditor
  Hooks (2)  PostToolUse, Stop  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~675 tok   added to every session

Per-component (rounded)
  component         always-on  on-invoke
  design                  ~90       ~770
  inspect                 ~70       ~420
  setup                   ~80       ~560
  start                   ~70       ~510
  evolve                  ~80       ~540
  reliability             ~90       ~550
  implement               ~70       ~690
  boundary-critic         ~70       ~450
  delivery-auditor        ~60       ~630

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
```

## The mod's `hooks:` / `calls:` listing

```
# claude plugin validate plugin (Claude Code 2.1.310)
❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
❯ types ./types/index.d.ts declares state: actors.snapshot, actors.tab, actors.selected, actors.trace
❯ ./room.tsx hooks: session.start, classic.SessionStart, command.run{command=actors-room}, command.run{command=actors-room-view}, ui.close{id=actors-room}, tool.call{tool=Bash}, ui.render{component=Pane, requestId=actors-room}
❯ ./room.tsx gating hook with .catch: classic.SessionStart
❯ ./room.tsx gating hook with .catch: command.run{command=actors-room}
❯ ./room.tsx gating hook with .catch: command.run{command=actors-room-view}
❯ ./room.tsx gating hook with .catch: ui.close{id=actors-room}
❯ ./room.tsx gating hook with .catch: tool.call{tool=Bash}
❯ ./room.tsx calls: $.command.list, $.command.register, $.process.run (via actors), $.process.spawn (via follow), $.session.surfaces, $.state.get, $.state.set, $.ui.ask, $.ui.log (via follow), $.ui.open (via openRoom), $.ui.panes, $.ui.resolve, $.ui.status
❯ ./room.tsx state writes: actors.selected, actors.snapshot, actors.tab, actors.trace
❯ ./room.tsx state reads: actors.selected, actors.snapshot, actors.tab, actors.trace
✔ Validation passed
```

## Blocked checks

| Check | Why | What unblocks it |
| --- | --- | --- |
| `g1.start-session` | "start works in a fresh session" needs a model turn (eval case `start-orients`) | Owner-approved eval lane |
| `g5.evals.run` | Model-backed suite, Δ per case, safety at 1.0 | Owner-approved eval lane (≤ $50 total) |
| `g6.acceptance` A9 | A deploy request held by the Room needs one model turn | Owner runs step A9 of `docs/acceptance/room.md` |
| `g6.acceptance` A10 | SVG topology in the Desktop app | Owner runs step A10 in the Desktop app |

## Limitations and unverified claims

- Not guaranteed by the runtime: exactly-once external effects, global ordering, cross-actor transactions,
  routes as a security boundary. Unacknowledged unkeyed effects are `in_doubt`, never delivered.
- All runtime evidence is local (workerd through Cloudflare's Vitest integration). Nothing ran on Cloudflare.
- workerd can't run inside Claude Code's default sandbox (loopback `listen` denied); `actors verify` says
  `blocked` there. Whether eval runs allow local binding is unverified until the first eval run.
- The plugin's contribution (Δ) is unmeasured until the eval lane runs.
- The effect guard and generated `ask` rules match command text; other spellings slip past.
- Mods are early access; the Room is tested on Claude Code 2.1.310 only. The core works without it.
- `actors-toolkit` isn't on npm; `actors init` vendors the tarball the plugin ships.
- The mod type-check needs this build's declarations on the machine (CI reports it blocked without them).

## Setup

```sh
claude plugin marketplace add <org>/<repo>   # or a local clone path
claude plugin install actors@actors-toolkit
```

Then `/actors:start` in a session. Requirements: Claude Code 2.1.287+, Node 22.18+. Developing the repository:
`npm install && npm run verify`. Update and uninstall: README.

## Open risks

- **Mod API drift.** Mods are early access; a Claude Code update can change hook or element shapes. The
  fixture schema pin and mod type-check catch CLI-side drift, not engine-side drift; re-run `claude plugin
  test` after each Claude Code update.
- **Eval outcome unknown.** Skills could show Δ near zero on some cases; the charter treats that as a finding.
- **Eval sandbox and workerd.** If eval runs deny local binding, runtime evidence inside evals stays
  `blocked` and is re-run on kept workspaces outside the sandbox (decision 0004).
- **Guard coverage.** Command-text matching is best effort; token scopes remain the real control.

## Gate → evidence

| Gate | Status | Checks (status) |
| --- | --- | --- |
| G0 — Ground truth | **passed** | `g0.versions` pass; `g0.guardrails` pass; `g0.spike.types` pass; `g0.spike.typecheck` pass; `g0.spike.runtime` pass; `g0.sandbox` pass |
| G1 — Installable plugin | **blocked** | `g1.cli.typecheck` pass; `g1.cli.unit` pass; `g1.dist.fresh` pass; `g1.launcher` pass; `g1.validate.plugin` pass; `g1.validate.marketplace` pass; `g1.install` pass; `g1.budget` pass; `g1.trust` pass; `g1.start-session` blocked (needs a model-backed fresh session; awaiting owner approval of the eval lane) |
| G2 — Model and CLI | **passed** | `g2.contract.types` pass; `g2.fixtures.typecheck` pass; `g2.cli.model` pass; `g2.negative.unchanged` pass |
| G3 — Runtime evidence | **passed** | `g3.radar.typecheck` pass; `g3.radar.check` pass; `g3.radar.runtime` pass; `g3.radar.trace` pass; `g3.cli.events` pass |
| G4 — Agentic example | **passed** | `g4.desk.typecheck` pass; `g4.desk.check` pass; `g4.desk.runtime` pass; `g4.desk.trace` pass; `g4.runtime.probe` pass |
| G5 — Agent-guided development | **blocked** | `g5.cli.unit` pass; `g5.skills.lint` pass; `g5.evals.static` pass; `g5.inventory` pass; `g5.starter.smoke` pass; `g5.verify.blocked` pass; `g5.examples.verify` pass; `g5.evals.run` blocked (model-backed; awaiting owner approval of the eval lane ($50 total ceiling)) |
| G6 — The Room | **blocked** | `g6.cli.room` pass; `g6.fixtures` pass; `g6.mod.validate` pass; `g6.mod.typecheck` pass; `g6.mod.test` pass; `g6.monitor` pass; `g6.trust` pass; `g6.no-hooks` pass; `g6.acceptance` blocked (9/11 steps recorded passing; not run: A9, A10) |
| G7 — Release candidate | **passed** | `g7.docs` pass; `g7.release-evidence` pass; `g7.tag` pass; `g7.clean-checkout` pass; `g7.container` pass |

Record: `docs/verification-report.md` (generated 2026-10-25T03:27:50.435Z). Clean-checkout run: `docs/evidence/clean-checkout-verification-report.md`. Container run: `docs/evidence/container-install.txt`. Acceptance: `docs/evidence/room-acceptance.md`.
