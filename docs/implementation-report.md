# Implementation report: Actor-Native Cloudflare Toolkit v0.1 (release candidate)

The report charter §11 asks for. Every claim below traces to a command that was run; the full record is
`docs/verification-report.md` (human) and `verify-report.json` (machine), produced by `npm run verify`.
Versions: Claude Code 2.1.310, Node 24.22.1, npm 11.19.1, wrangler 4.152.0, workerd 1.20261019.1, Vitest 5.0.5 with @cloudflare/vitest-plugin 1.4.7, TypeScript 7.0.2, macOS (darwin-arm64).

## Result at a glance

FINAL_VERIFY_SUMMARY

Nothing was deployed, published, tagged on a remote, or run against a Cloudflare account, and no model-backed
eval has run: those need the owner (see "Blocked checks").

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
PLUGIN_DETAILS
```

## The mod's `hooks:` / `calls:` listing

```
MOD_LISTING
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

GATE_TRACE
