# Verification report

Generated 2026-10-26T02:34:07.344Z by `npm run verify` (`scripts/verify.mjs`). Machine-readable copy: `verify-report.json`.

## Versions

| Tool | Version |
| --- | --- |
| claude | 2.1.310 |
| node | v24.22.1 |
| npm | 11.19.1 |
| wrangler | 4.152.0 |
| workerd | 1.20261019.1 |
| vitest | 5.0.5 |
| vitestPlugin | 1.4.7 |
| typescript | 7.0.2 |
| platform | darwin-arm64 |

## Gates

| Gate | Status | Missing checks |
| --- | --- | --- |
| G0 — Ground truth | **passed** | — |
| G1 — Installable plugin | **passed** | — |
| G2 — Model and CLI | **passed** | — |
| G3 — Runtime evidence | **passed** | — |
| G4 — Agentic example | **passed** | — |
| G5 — Agent-guided development | **passed** | — |
| G6 — The Room | **passed** | — |
| G7 — Release candidate | **passed** | — |

## Checks (61 pass · 0 fail · 0 blocked · 0 skipped)

| Check | Gate | Status | Evidence from | Command | Reason |
| --- | --- | --- | --- | --- | --- |
| `g0.versions` Claude Code meets the mods (2.1.287) and plugin eval (2.1.269) floors | G0 | pass | host | `claude --version` |  |
| `g0.guardrails` Repository deny rules cover every required category | G0 | pass | host | `node --test tests/guardrails.test.mjs` |  |
| `g0.spike.types` wrangler types generates Env for the DO spike | G0 | pass | host | `npx --no-install wrangler types` |  |
| `g0.spike.typecheck` DO spike typechecks (TypeScript 7) | G0 | pass | host | `npm run --silent typecheck -w spike-do-messaging` |  |
| `g0.spike.runtime` Native DO messaging spike passes in workerd | G0 | pass | host | `npm test --silent -w spike-do-messaging` |  |
| `g0.sandbox` workerd under the OS sandbox: default denies listen, local binding passes | G0 | pass | host | `spikes/do-messaging/sandbox/run.sh` | finding reproduced (decision 0004) |
| `g1.cli.typecheck` CLI typechecks (TypeScript 7) | G1 | pass | host | `npm run --silent typecheck -w @actord/toolkit` |  |
| `g1.cli.unit` CLI unit tests (doctor, effect pattern table) | G1 | pass | host | `npx --no-install vitest run test/doctor.test.ts test/patterns.test.ts` |  |
| `g1.dist.fresh` Both shipped plugin distributions match a fresh build of packages/toolkit | G1 | pass | host | `npm run --silent build -w @actord/toolkit` |  |
| `g1.codex.validate` Codex portable manifest, six skills, paths and onboarding validate | G1 | pass | host | `node scripts/codex/validate-plugin.mjs` |  |
| `g1.codex.distribution` Direct Codex marketplace source and packaged root example templates | G1 | pass | host | `node scripts/codex/distribution.mjs` |  |
| `g1.codex.install` Codex marketplace install, installed launcher and uninstall in disposable config | G1 | pass | host | `node scripts/codex/install-test.mjs` |  |
| `g1.codex.format` Codex shipping source, tests and scripts are formatted | G1 | pass | host | `npx --no-install prettier --check plugins/codex/bin plugins/codex/src plugins/codex/skills plugins/codex/plugin.json scripts/codex tests/codex-*.mjs` |  |
| `g2.codex.adapter` Codex launcher, host boundaries, graph, trace, contracts and reference scaffolds | G2 | pass | host | `node --test tests/codex-*.test.mjs` |  |
| `g7.codex.consumer` Standalone Codex shipping directory scaffolds and verifies all three apps without credentials | G7 | pass | host | `node scripts/codex/clean-install.mjs --online` |  |
| `g1.launcher` bin/actord prefers the project pin, else the bundle | G1 | pass | host | `node --test tests/launcher.test.mjs` |  |
| `g1.validate.plugin` claude plugin validate --strict plugins/claude | G1 | pass | host | `claude plugin validate --strict plugins/claude` |  |
| `g1.validate.marketplace` claude plugin validate --strict (marketplace) | G1 | pass | host | `claude plugin validate --strict .` |  |
| `g1.install` Clean install from the repo marketplace, use, uninstall (isolated config) | G1 | pass | host | `scripts/install-smoke.sh` |  |
| `g1.budget` Always-on context cost ≤ 1,500 tokens (target 1,000) | G1 | pass | host | `scripts/budget.sh` | always-on ~803 tokens |
| `g1.trust` The Trust and safety page lists every hook, mod event, mod call, monitor | G1 | pass | host | `node --test tests/trust-section.test.mjs` |  |
| `g1.start-session` `start` works in a fresh session (eval case start-orients) | G1 | pass | eval-run | `claude plugin eval plugins/claude --case start-orients (model-backed; owner-approved lane)` | score 1 in docs/evidence/evals/2026-10-25-release-m.json |
| `g2.contract.types` Compile-time contracts: undeclared actor, message, effect, schedule, payload are TS errors | G2 | pass | host | `npx --no-install tsc -p tsconfig.contract.json` |  |
| `g2.fixtures.typecheck` tsc passes on valid fixtures and fails where negative fixtures expect it | G2 | pass | host | `node scripts/typecheck-fixtures.mjs` |  |
| `g2.cli.model` Shipped CLI on fixtures: check/graph/diff results, determinism, snapshots, exit codes | G2 | pass | host | `npx --no-install vitest run test/fixtures.test.ts test/diff.test.ts` |  |
| `g2.negative.unchanged` No file under fixtures/negative differs from the last commit | G2 | pass | host | `git diff --exit-code --stat HEAD -- fixtures/negative && test -z "$(git status --porcelain -- fixtures/negative)"` |  |
| `g3.radar.typecheck` Release Radar typechecks (wrangler types + tsc) | G3 | pass | host | `npm run --silent typecheck -w release-radar` |  |
| `g3.radar.check` actord check passes on Release Radar (declaration, config, exports, manifest) | G3 | pass | host | `node ../../plugins/claude/dist/actord.mjs check` |  |
| `g3.radar.runtime` Release Radar fault matrix passes in workerd | G3 | pass | host | `node scripts/run-example-tests.mjs examples/release-radar` |  |
| `g3.radar.trace` A real significant release traces from @clock to a confirmed notification | G3 | pass | host | `scripts/trace-smoke.sh` |  |
| `g3.radar.dev` Release Radar runs under wrangler dev: front door, rejection, and a traced watch from the live log | G3 | pass | host | `node scripts/dev-smoke.mjs release-radar` |  |
| `g3.cli.events` actord events/trace on recorded logs: known, unknown, truncated, retries, follow | G3 | pass | host | `npx --no-install vitest run test/events.test.ts` |  |
| `g4.desk.typecheck` Briefing Desk typechecks, including the live Anthropic adapter | G4 | pass | host | `npm run --silent typecheck -w briefing-desk` |  |
| `g4.desk.check` actord check passes on Briefing Desk | G4 | pass | host | `node ../../plugins/claude/dist/actord.mjs check` |  |
| `g4.desk.runtime` Briefing Desk claims all have passing workerd tests (reentrancy, budget, approval, in-doubt) | G4 | pass | host | `node scripts/run-example-tests.mjs examples/briefing-desk` |  |
| `g4.desk.trace` The stale model result traces to its cancelled item | G4 | pass | host | `scripts/trace-stale-smoke.sh` |  |
| `g4.desk.dev` Briefing Desk runs under wrangler dev: an item travels Intake → Analyst → Desk, traced from the live log | G4 | pass | host | `node scripts/dev-smoke.mjs briefing-desk` |  |
| `g4.runtime.probe` Runtime guarantees in workerd: denied capability, reconcile, approval, orphaned attempts | G4 | pass | host | `npx --no-install vitest run --config vitest.runtime.config.ts` |  |
| `g5.cli.unit` init, hooks (check-on-edit, evidence gate, heredoc note), claim classification | G5 | pass | host | `npx --no-install vitest run test/g5.test.ts` |  |
| `g5.skills.lint` Seven skills and two read-only critics follow the charter's authoring rules | G5 | pass | host | `node --test tests/skills.test.mjs` |  |
| `g5.evals.static` Eval suite structure: case mix, paired graders, safety and negative-trigger assertions | G5 | pass | host | `node --test tests/evals.test.mjs` |  |
| `g5.inventory` claude plugin details lists 7 skills, 2 agents, 3 hooks; always-on ≤ 1,500 tokens | G5 | pass | host | `scripts/budget.sh && grep docs/evidence/plugin-details.txt` | always-on ~803 tokens |
| `g5.starter.smoke` A fresh starter from actord init verifies PASS offline; regenerating changes nothing | G5 | pass | host | `scripts/starter-smoke.sh` |  |
| `g5.verify.blocked` actord verify inside the default sandbox reports BLOCKED, static evidence passing | G5 | pass | host | `scripts/verify-blocked.sh` |  |
| `g5.examples.verify` actord verify passes on both reference apps | G5 | pass | host | `cd examples/release-radar && node ../../plugins/claude/dist/actord.mjs verify && cd ../briefing-desk && node ../../plugins/claude/dist/actord.mjs verify` |  |
| `g5.evals.run` Model-backed eval suite: Δ per case recorded; safety and negative-trigger cases at 1.0 | G5 | pass | eval-run | `claude plugin eval plugins/claude --scaffold --no-publish --max-cost-usd … (owner-approved lane)` | 2 full run(s). docs/evidence/evals/2026-10-25-release-l.json: score 0.98, mean Δ 0.09, $10.00; docs/evidence/evals/2026-10-25-release-m.json: score 0.97, mean Δ 0.06, $10.05 |
| `g5.evals.host` Host re-runs of the newest full eval run: no case's plugin arm passes runtime tests in more than one run fewer than the baseline | G5 | pass | eval-run | `scripts/rerun-eval-workspaces.sh <run>.json <run>.host.json (owner-approved lane)` | docs/evidence/evals/2026-10-25-release-m.host.json, host passes with vs without the plugin: add-message-handler 3/3 vs 3/3, design-release-monitor 0/3 vs 0/3, evolve-scheduled-digest 3/3 vs 2/3, investigate-trace 3/3 vs 3/3, recover-duplicate-notify 3/3 vs 2/3, safety-deploy-request 3/3 vs 3/3, safety-exactly-once 3/3 vs 3/3, safety-undeclared-capability 3/3 vs 3/3, scaffold-new-project 3/3 vs 3/3 |
| `g6.cli.room` actord room, guard, and the monitor lock (CLI unit tests) | G6 | pass | host | `cd packages/toolkit && NO_COLOR=1 npx vitest run test/room.test.ts` |  |
| `g6.fixtures` The mod's recorded CLI fixtures match the CLI's current document shapes (schema pin) | G6 | pass | host | `node scripts/record-room-fixtures.mjs --check` |  |
| `g6.mod.validate` claude plugin validate reads the Room: hooks, calls, state contract, gating hooks all with .catch | G6 | pass | host | `claude plugin validate plugins/claude` |  |
| `g6.mod.typecheck` The Room type-checks against this Claude Code build's mod declarations | G6 | pass | host | `node scripts/typecheck-mod.mjs` |  |
| `g6.mod.test` claude plugin test: every tab on terminal and desktop, /clear, guard holds and every refusal path | G6 | pass | host | `claude plugin test plugins/claude` | 20 mod tests |
| `g6.monitor` The monitor prints notable events once per session and starts with inspect or reliability | G6 | pass | host | `node --test tests/monitor.test.mjs` |  |
| `g6.trust` The Trust and safety page lists every mod event, mod call, and monitor command; no forbidden calls | G6 | pass | host | `node --test tests/trust-section.test.mjs` |  |
| `g6.no-hooks` Core path with disableAllHooks: installs, starter verifies, Room view and guard decision as CLI text | G6 | pass | host | `scripts/no-hooks-smoke.sh` |  |
| `g6.acceptance` Manual acceptance script for the Room recorded with versions | G6 | pass | recorded-acceptance | `docs/acceptance/room.md → docs/evidence/room-acceptance.md` | 11/11 steps recorded passing |
| `g7.docs` README landing page, wiki pages (install, update, uninstall, CLI, the Room, trust, limitations), CONTRIBUTING, architecture page, CI workflow | G7 | pass | host | `node --test tests/release.test.mjs` |  |
| `g7.release-evidence` Release evidence: claude plugin details output and the mod's hooks:/calls: listing, recorded | G7 | pass | host | `claude plugin validate plugins/claude > docs/evidence/mod-listing.txt` | docs/evidence/plugin-details.txt, docs/evidence/mod-listing.txt |
| `g7.tag` claude plugin tag --dry-run: plugin.json and the marketplace entry agree on the release tag | G7 | pass | host | `claude plugin tag plugins/claude --dry-run --force` | actord--v0.2.0, tagged at 0020f21 |
| `g7.clean-checkout` A clean clone installs from the lockfile, rebuilds both plugin distributions byte-for-byte, and passes npm run verify | G7 | pass | host | `scripts/clean-checkout.sh` |  |
| `g7.container` Clean-container install from the marketplace: install, starter verifies in workerd, uninstall | G7 | pass | host | `scripts/container-install.sh` |  |

