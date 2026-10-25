# Verification report

Generated 2026-10-25T00:14:54.295Z by `npm run verify` (`scripts/verify.mjs`). Machine-readable copy: `verify-report.json`.

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

## Checks (15 pass · 0 fail · 1 blocked · 0 skipped)

| Check | Gate | Status | Evidence from | Command | Reason |
| --- | --- | --- | --- | --- | --- |
| `g0.versions` Claude Code meets the mods (2.1.287) and plugin eval (2.1.269) floors | G0 | pass | host | `claude --version` |  |
| `g0.guardrails` Repository deny rules cover every required category | G0 | pass | host | `node --test tests/guardrails.test.mjs` |  |
| `g0.spike.types` wrangler types generates Env for the DO spike | G0 | pass | host | `npx --no-install wrangler types` |  |
| `g0.spike.typecheck` DO spike typechecks (TypeScript 7) | G0 | pass | host | `npm run --silent typecheck -w spike-do-messaging` |  |
| `g0.spike.runtime` Native DO messaging spike passes in workerd | G0 | pass | host | `npm test --silent -w spike-do-messaging` |  |
| `g0.sandbox` workerd under the OS sandbox: default denies listen, local binding passes | G0 | pass | host | `spikes/do-messaging/sandbox/run.sh` | finding reproduced (decision 0004) |
| `g1.cli.typecheck` CLI typechecks (TypeScript 7) | G1 | pass | host | `npm run --silent typecheck -w actors-toolkit` |  |
| `g1.cli.unit` CLI unit tests (doctor, effect pattern table) | G1 | pass | host | `npm test --silent -w actors-toolkit` |  |
| `g1.dist.fresh` Shipped plugin/dist matches a fresh build of packages/cli | G1 | pass | host | `npm run --silent build -w actors-toolkit` |  |
| `g1.launcher` bin/actors prefers the project pin, else the bundle | G1 | pass | host | `node --test tests/launcher.test.mjs` |  |
| `g1.validate.plugin` claude plugin validate --strict plugin | G1 | pass | host | `claude plugin validate --strict plugin` |  |
| `g1.validate.marketplace` claude plugin validate --strict (marketplace) | G1 | pass | host | `claude plugin validate --strict .` |  |
| `g1.install` Clean install from the repo marketplace, use, uninstall (isolated config) | G1 | pass | host | `scripts/install-smoke.sh` |  |
| `g1.budget` Always-on context cost ≤ 1,500 tokens (target 1,000) | G1 | pass | host | `scripts/budget.sh` | always-on ~66 tokens |
| `g1.trust` README trust section lists every hook, mod event, mod call, monitor | G1 | pass | host | `node --test tests/trust-section.test.mjs` |  |
| `g1.start-session` `start` works in a fresh session (eval case start-orients) | G1 | blocked | host | `claude plugin eval plugin --case start-orients (model-backed; owner-approved lane)` | needs a model-backed fresh session; awaiting owner approval of the eval lane |

