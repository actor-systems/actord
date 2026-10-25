# Verification report

Generated 2026-10-25T00:45:14.508Z by `npm run verify` (`scripts/verify.mjs`). Machine-readable copy: `verify-report.json`.

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
| G0 — Ground truth | **failed** | — |
| G1 — Installable plugin | **blocked** | — |
| G2 — Model and CLI | **failed** | — |
| G3 — Runtime evidence | **passed** | — |

## Checks (22 pass · 2 fail · 1 blocked · 0 skipped)

| Check | Gate | Status | Evidence from | Command | Reason |
| --- | --- | --- | --- | --- | --- |
| `g0.versions` Claude Code meets the mods (2.1.287) and plugin eval (2.1.269) floors | G0 | pass | host | `claude --version` |  |
| `g0.guardrails` Repository deny rules cover every required category | G0 | pass | host | `node --test tests/guardrails.test.mjs` |  |
| `g0.spike.types` wrangler types generates Env for the DO spike | G0 | pass | host | `npx --no-install wrangler types` |  |
| `g0.spike.typecheck` DO spike typechecks (TypeScript 7) | G0 | fail | host | `npm run --silent typecheck -w spike-do-messaging` | exit 1 |
| `g0.spike.runtime` Native DO messaging spike passes in workerd | G0 | pass | host | `npm test --silent -w spike-do-messaging` |  |
| `g0.sandbox` workerd under the OS sandbox: default denies listen, local binding passes | G0 | pass | host | `spikes/do-messaging/sandbox/run.sh` | finding reproduced (decision 0004) |
| `g1.cli.typecheck` CLI typechecks (TypeScript 7) | G1 | pass | host | `npm run --silent typecheck -w actors-toolkit` |  |
| `g1.cli.unit` CLI unit tests (doctor, effect pattern table) | G1 | pass | host | `npx --no-install vitest run test/doctor.test.ts test/patterns.test.ts` |  |
| `g1.dist.fresh` Shipped plugin/dist matches a fresh build of packages/cli | G1 | pass | host | `npm run --silent build -w actors-toolkit` |  |
| `g1.launcher` bin/actors prefers the project pin, else the bundle | G1 | pass | host | `node --test tests/launcher.test.mjs` |  |
| `g1.validate.plugin` claude plugin validate --strict plugin | G1 | pass | host | `claude plugin validate --strict plugin` |  |
| `g1.validate.marketplace` claude plugin validate --strict (marketplace) | G1 | pass | host | `claude plugin validate --strict .` |  |
| `g1.install` Clean install from the repo marketplace, use, uninstall (isolated config) | G1 | pass | host | `scripts/install-smoke.sh` |  |
| `g1.budget` Always-on context cost ≤ 1,500 tokens (target 1,000) | G1 | pass | host | `scripts/budget.sh` | always-on ~66 tokens |
| `g1.trust` README trust section lists every hook, mod event, mod call, monitor | G1 | pass | host | `node --test tests/trust-section.test.mjs` |  |
| `g1.start-session` `start` works in a fresh session (eval case start-orients) | G1 | blocked | host | `claude plugin eval plugin --case start-orients (model-backed; owner-approved lane)` | needs a model-backed fresh session; awaiting owner approval of the eval lane |
| `g2.contract.types` Compile-time contracts: undeclared actor, message, effect, schedule, payload are TS errors | G2 | pass | host | `npx --no-install tsc -p tsconfig.contract.json` |  |
| `g2.fixtures.typecheck` tsc passes on valid fixtures and fails where negative fixtures expect it | G2 | pass | host | `node scripts/typecheck-fixtures.mjs` |  |
| `g2.cli.model` Shipped CLI on fixtures: check/graph/diff results, determinism, snapshots, exit codes | G2 | fail | host | `npx --no-install vitest run test/fixtures.test.ts test/diff.test.ts` | exit 1 |
| `g2.negative.unchanged` No file under fixtures/negative differs from the last commit | G2 | pass | host | `git diff --exit-code --stat HEAD -- fixtures/negative && test -z "$(git status --porcelain -- fixtures/negative)"` |  |
| `g3.radar.typecheck` Release Radar typechecks (wrangler types + tsc) | G3 | pass | host | `npm run --silent typecheck -w release-radar` |  |
| `g3.radar.check` actors check passes on Release Radar (declaration, config, exports, manifest) | G3 | pass | host | `node ../../plugin/dist/actors.mjs check` |  |
| `g3.radar.runtime` Release Radar fault matrix passes in workerd | G3 | pass | host | `node scripts/run-example-tests.mjs examples/release-radar duplicate-input duplicate-delivery malformed unauthorized-route unknown-message out-of-order crash-before-mutation crash-after-mutation delivery-retry restart retry-exhausted scheduled-wake lost-ack-idempotent` |  |
| `g3.radar.trace` A real significant release traces from @clock to a confirmed notification | G3 | pass | host | `scripts/trace-smoke.sh` |  |
| `g3.cli.events` actors events/trace on recorded logs: known, unknown, truncated, retries, follow | G3 | pass | host | `npx --no-install vitest run test/events.test.ts` |  |

## Output of non-passing checks

### g0.spike.typecheck (fail)

```text
src/index.ts(2,32): error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.
```

### g2.cli.model (fail)

```text
      "projectRoot",

 ❯ test/fixtures.test.ts:36:65
     34|         const b = run(dir, ...args);
     35|         expect(a.out).toBe(b.out);
     36|         expect(args.includes("--json") ? stable(a.out) : a.out).toMatc…
       |                                                                 ^
     37|       }
     38|     });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

 FAIL  test/fixtures.test.ts > valid fixtures > evolved: the committed manifest is what graph --json derives
AssertionError: expected { …(7) } to deeply equal { schemaVersion: 1, …(6) }

- Expected
+ Received

@@ -68,11 +68,10 @@
        "approval": "none",
        "description": "Message the operator about a sequence gap",
        "idempotency": "key",
        "name": "notify.operator",
        "reconcile": false,
-       "result": null,
      },
    ],
    "messages": [
      {
        "description": "The schedule says it's time to ping",

 ❯ test/fixtures.test.ts:41:83
     39|     it(`${name}: the committed manifest is what graph --json derives`,…
     40|       const graph = JSON.parse(run(dir, "graph", "--json").out);
     41|       expect(JSON.parse(readFileSync(join(dir, "actors.manifest.json")…
       |                                                                                   ^
     42|     });
     43|   }

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯
```

