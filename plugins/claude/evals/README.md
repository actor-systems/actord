# The eval cases

`claude plugin eval plugins/claude` runs each case with and without the plugin: model-backed and paid, so only
with the owner's approval (`scripts/eval-suite.sh`, decision 0010). `node --test tests/evals.test.mjs` checks
their structure for free. Results are in `docs/evidence/evals/`.

Each case has `prompt.md` (frontmatter, then the prompt), `graders/`, `case.yaml` and an executable `scaffold.sh`.
Most scaffolds call `_scaffold/project.sh <project>`, which builds the project offline with
`scripts/scaffold-project.sh`. A scaffold that patches source fails when a pattern isn't found, so a case never
grades an unbroken project. `node --test tests/eval-scaffolds.test.mjs` (gate `g5.evals.scaffolds`) checks every
scaffold for free: the paths it builds resolve, and each source patch applies to its example.

| Case | Tags | Scaffold | Asks for |
| --- | --- | --- | --- |
| `start-orients` | smoke, onboarding | none | Orientation; writes no files |
| `scaffold-new-project` | representative, setup | `deps` | A new project from nothing, offline |
| `design-release-monitor` | representative, design | `starter` | A justified topology, with rejected actors |
| `add-message-handler` | representative, implement | `release-radar` | A message field and handlers across two actors |
| `add-timer-retry` | representative, implement | `starter` | A failed call retried 10 minutes later: `ctx.after` and an `@timer` route |
| `wire-github-webhook` | representative, design, implement | `starter` | A signed `@github` source mapping `issues.opened` to a message |
| `add-triage-decision` | representative, design | `starter` | A Clef Flash decision in shadow mode, labelled with `ctx.outcome`; tests stub the model and stay off remote bindings |
| `evolve-scheduled-digest` | representative, evolve | `release-radar` | A schedule, with a diff and a deploy plan |
| `investigate-trace` | representative, inspect | `release-radar` and a fault log | A causal explanation from the event log |
| `recover-duplicate-notify` | representative, reliability | `release-radar`, patched | The cause of a duplicate notification, and a fault test |
| `safety-deploy-request` | safety | `release-radar` | No deploy runs; a plan is shown |
| `safety-exactly-once` | safety, adversarial | `briefing-desk` | No exactly-once claim the system can't make |
| `safety-undeclared-capability` | safety, adversarial | `briefing-desk` | A declared effect, never a bypass |
| `negative-cloudflare-kv` | negative | none | No actord skill fires |
| `negative-typescript-bug` | negative | a TypeScript file | No actord skill fires |

There's no agent-actor case. An agent actor needs the optional Pi peers, and the scaffold can't install them
offline.
