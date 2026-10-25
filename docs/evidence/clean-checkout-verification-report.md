# Verification report

Generated 2026-10-25T03:23:25.550Z by `npm run verify` (`scripts/verify.mjs`). Machine-readable copy: `verify-report.json`.

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
| G1 — Installable plugin | **blocked** | — |
| G2 — Model and CLI | **passed** | — |
| G3 — Runtime evidence | **failed** | — |
| G4 — Agentic example | **passed** | — |
| G5 — Agent-guided development | **blocked** | — |
| G6 — The Room | **blocked** | — |
| G7 — Release candidate | **incomplete** | — |

## Checks (46 pass · 1 fail · 3 blocked · 2 skipped)

| Check | Gate | Status | Evidence from | Command | Reason |
| --- | --- | --- | --- | --- | --- |
| `g0.versions` Claude Code meets the mods (2.1.287) and plugin eval (2.1.269) floors | G0 | pass | host | `claude --version` |  |
| `g0.guardrails` Repository deny rules cover every required category | G0 | pass | host | `node --test tests/guardrails.test.mjs` |  |
| `g0.spike.types` wrangler types generates Env for the DO spike | G0 | pass | host | `npx --no-install wrangler types` |  |
| `g0.spike.typecheck` DO spike typechecks (TypeScript 7) | G0 | pass | host | `npm run --silent typecheck -w spike-do-messaging` |  |
| `g0.spike.runtime` Native DO messaging spike passes in workerd | G0 | pass | host | `npm test --silent -w spike-do-messaging` |  |
| `g0.sandbox` workerd under the OS sandbox: default denies listen, local binding passes | G0 | pass | host | `spikes/do-messaging/sandbox/run.sh` | finding reproduced (decision 0004) |
| `g1.cli.typecheck` CLI typechecks (TypeScript 7) | G1 | pass | host | `npm run --silent typecheck -w actors-toolkit` |  |
| `g1.cli.unit` CLI unit tests (doctor, effect pattern table) | G1 | pass | host | `npx --no-install vitest run test/doctor.test.ts test/patterns.test.ts` |  |
| `g1.dist.fresh` Shipped plugin/dist matches a fresh build of packages/cli | G1 | pass | host | `npm run --silent build -w actors-toolkit` |  |
| `g1.launcher` bin/actors prefers the project pin, else the bundle | G1 | pass | host | `node --test tests/launcher.test.mjs` |  |
| `g1.validate.plugin` claude plugin validate --strict plugin | G1 | pass | host | `claude plugin validate --strict plugin` |  |
| `g1.validate.marketplace` claude plugin validate --strict (marketplace) | G1 | pass | host | `claude plugin validate --strict .` |  |
| `g1.install` Clean install from the repo marketplace, use, uninstall (isolated config) | G1 | pass | host | `scripts/install-smoke.sh` |  |
| `g1.budget` Always-on context cost ≤ 1,500 tokens (target 1,000) | G1 | pass | host | `scripts/budget.sh` | always-on ~675 tokens |
| `g1.trust` README trust section lists every hook, mod event, mod call, monitor | G1 | pass | host | `node --test tests/trust-section.test.mjs` |  |
| `g1.start-session` `start` works in a fresh session (eval case start-orients) | G1 | blocked | host | `claude plugin eval plugin --case start-orients (model-backed; owner-approved lane)` | needs a model-backed fresh session; awaiting owner approval of the eval lane |
| `g2.contract.types` Compile-time contracts: undeclared actor, message, effect, schedule, payload are TS errors | G2 | pass | host | `npx --no-install tsc -p tsconfig.contract.json` |  |
| `g2.fixtures.typecheck` tsc passes on valid fixtures and fails where negative fixtures expect it | G2 | pass | host | `node scripts/typecheck-fixtures.mjs` |  |
| `g2.cli.model` Shipped CLI on fixtures: check/graph/diff results, determinism, snapshots, exit codes | G2 | pass | host | `npx --no-install vitest run test/fixtures.test.ts test/diff.test.ts` |  |
| `g2.negative.unchanged` No file under fixtures/negative differs from the last commit | G2 | pass | host | `git diff --exit-code --stat HEAD -- fixtures/negative && test -z "$(git status --porcelain -- fixtures/negative)"` |  |
| `g3.radar.typecheck` Release Radar typechecks (wrangler types + tsc) | G3 | pass | host | `npm run --silent typecheck -w release-radar` |  |
| `g3.radar.check` actors check passes on Release Radar (declaration, config, exports, manifest) | G3 | pass | host | `node ../../plugin/dist/actors.mjs check` |  |
| `g3.radar.runtime` Release Radar fault matrix passes in workerd | G3 | pass | host | `node scripts/run-example-tests.mjs examples/release-radar` |  |
| `g3.radar.trace` A real significant release traces from @clock to a confirmed notification | G3 | pass | host | `scripts/trace-smoke.sh` |  |
| `g3.cli.events` actors events/trace on recorded logs: known, unknown, truncated, retries, follow | G3 | fail | host | `npx --no-install vitest run test/events.test.ts` | exit 1 |
| `g4.desk.typecheck` Briefing Desk typechecks, including the live Anthropic adapter | G4 | pass | host | `npm run --silent typecheck -w briefing-desk` |  |
| `g4.desk.check` actors check passes on Briefing Desk | G4 | pass | host | `node ../../plugin/dist/actors.mjs check` |  |
| `g4.desk.runtime` Briefing Desk claims all have passing workerd tests (reentrancy, budget, approval, in-doubt) | G4 | pass | host | `node scripts/run-example-tests.mjs examples/briefing-desk` |  |
| `g4.desk.trace` The stale model result traces to its cancelled item | G4 | pass | host | `scripts/trace-stale-smoke.sh` |  |
| `g4.runtime.probe` Runtime guarantees in workerd: denied capability, reconcile, approval, orphaned attempts | G4 | pass | host | `npx --no-install vitest run --config vitest.runtime.config.ts` |  |
| `g5.cli.unit` init, hooks (check-on-edit, evidence gate), claim classification | G5 | pass | host | `npx --no-install vitest run test/g5.test.ts` |  |
| `g5.skills.lint` Seven skills and two read-only critics follow the charter's authoring rules | G5 | pass | host | `node --test tests/skills.test.mjs` |  |
| `g5.evals.static` Eval suite structure: case mix, paired graders, safety and negative-trigger assertions | G5 | pass | host | `node --test tests/evals.test.mjs` |  |
| `g5.inventory` claude plugin details lists 7 skills, 2 agents, 2 hooks; always-on ≤ 1,500 tokens | G5 | pass | host | `scripts/budget.sh && grep docs/evidence/plugin-details.txt` | always-on ~675 tokens |
| `g5.starter.smoke` A fresh starter from actors init verifies PASS offline; regenerating changes nothing | G5 | pass | host | `scripts/starter-smoke.sh` |  |
| `g5.verify.blocked` actors verify inside the default sandbox reports BLOCKED, static evidence passing | G5 | pass | host | `scripts/verify-blocked.sh` |  |
| `g5.examples.verify` actors verify passes on both reference apps | G5 | pass | host | `cd examples/release-radar && node ../../plugin/dist/actors.mjs verify && cd ../briefing-desk && node ../../plugin/dist/actors.mjs verify` |  |
| `g5.evals.run` Model-backed eval suite: Δ per case recorded; safety and negative-trigger cases at 1.0 | G5 | blocked | host | `claude plugin eval plugin --scaffold --no-publish --max-cost-usd … (owner-approved lane)` | model-backed; awaiting owner approval of the eval lane ($50 total ceiling) |
| `g6.cli.room` actors room, guard, and the monitor lock (CLI unit tests) | G6 | pass | host | `cd packages/cli && NO_COLOR=1 npx vitest run test/room.test.ts` |  |
| `g6.fixtures` The mod's recorded CLI fixtures match the CLI's current document shapes (schema pin) | G6 | pass | host | `node scripts/record-room-fixtures.mjs --check` |  |
| `g6.mod.validate` claude plugin validate reads the Room: hooks, calls, state contract, gating hooks all with .catch | G6 | pass | host | `claude plugin validate plugin` |  |
| `g6.mod.typecheck` The Room type-checks against this Claude Code build's mod declarations | G6 | pass | host | `node scripts/typecheck-mod.mjs` |  |
| `g6.mod.test` claude plugin test: every tab on terminal and desktop, /clear, guard holds and every refusal path | G6 | pass | host | `claude plugin test plugin` | 18 mod tests |
| `g6.monitor` The monitor prints notable events once per session and starts with inspect or reliability | G6 | pass | host | `node --test tests/monitor.test.mjs` |  |
| `g6.trust` README trust section lists every mod event, mod call, and monitor command; no forbidden calls | G6 | pass | host | `node --test tests/trust-section.test.mjs` |  |
| `g6.no-hooks` Core path with disableAllHooks: installs, starter verifies, Room view and guard decision as CLI text | G6 | pass | host | `scripts/no-hooks-smoke.sh` |  |
| `g6.acceptance` Manual acceptance script for the Room recorded with versions | G6 | blocked | recorded-acceptance | `docs/acceptance/room.md → docs/evidence/room-acceptance.md` | 9/11 steps recorded passing; not run: A9, A10 |
| `g7.docs` README (install, update, uninstall, the Room, trust, limitations), architecture page, CI workflow | G7 | pass | host | `node --test tests/release.test.mjs` |  |
| `g7.release-evidence` Release evidence: claude plugin details output and the mod's hooks:/calls: listing, recorded | G7 | pass | host | `claude plugin validate plugin > docs/evidence/mod-listing.txt` | docs/evidence/plugin-details.txt, docs/evidence/mod-listing.txt |
| `g7.tag` claude plugin tag --dry-run: plugin.json and the marketplace entry agree on the release tag | G7 | pass | host | `claude plugin tag plugin --dry-run` | actors--v0.1.0 |
| `g7.clean-checkout` A clean clone installs from the lockfile, rebuilds plugin/dist byte-for-byte, and passes npm run verify | G7 | skipped | host | `scripts/clean-checkout.sh` | inside a clean-checkout run |
| `g7.container` Clean-container install from the marketplace: install, starter verifies in workerd, uninstall | G7 | skipped | host | `scripts/container-install.sh` | inside a clean-checkout run |

## Output of non-passing checks

### g3.cli.events (fail)

```text

 RUN  v5.0.5 /private/var/folders/_k/cv9xyy4j22q9kt03pxsz0b8h0000gn/T/tmp.kRDKveyTlR/repo/packages/cli

 ❯ test/events.test.ts (8 tests | 1 failed) 940ms
   ❯ actors trace (5)
     × follows a known message from its root cause through effects to its consequences 83ms

  Snapshots  1 failed
 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
   Start at  20:22:18
   Duration  1.03s (tests 98%, transform 1%, import 1%)


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/events.test.ts > actors trace > follows a known message from its root cause through effects to its consequences
Error: Snapshot `actors trace > follows a known message from its root cause through effects to its consequences > trace text 1` mismatched

- Expected
+ Received

@@ -1,6 +1,6 @@
- "trace 1i6hflvldpajf · correlation 2z8ig0agbnj3l · coverage: /Users/jaredmcfarland/Developer/actors-plugin/fixtures/events/release-radar-flow.ndjson (local only)
+ "trace 1i6hflvldpajf · correlation 2z8ig0agbnj3l · coverage: /private/var/folders/_k/cv9xyy4j22q9kt03pxsz0b8h0000gn/T/tmp.kRDKveyTlR/repo/fixtures/events/release-radar-flow.ndjson (local only)
    @clock → FeedPoller:workers-sdk  feed.poll.due  ✓ handled (2z8ig0agbnj3l)
    └─ effect feed.fetch [poll-1792887998597]  ✓ confirmed
       └─ FeedPoller:workers-sdk → FeedPoller:workers-sdk  feed.fetched  ✓ handled (3eadtkrf02yzd)
          ├─ FeedPoller:workers-sdk → ReleaseLedger:main  release.observed  ✓ handled (1d8qgjkwcti41)
          │  └─ ReleaseLedger:main → DigestWriter:main  release.significant  ✓ handled (3iovv7gmi41lt)

 ❯ test/events.test.ts:44:59
     42|     expect(target).toMatchObject({ type: "release.significant", outcom…
     43|     expect(target.effects[0]).toMatchObject({ effect: "notify.digest",…
     44|     expect(run("trace", significant, "--file", flow).out).toMatchSnaps…
       |                                                           ^
     45|   });
     46|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

