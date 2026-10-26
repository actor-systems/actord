# Evaluations

The Claude Code plugin is measured with `claude plugin eval`: twelve cases, each run three times with the
plugin and three times without, by `claude-sonnet-5-5` and judged by `claude-haiku-5-5`. `Δ` is what the
plugin contributes over the same model with no plugin. The cases:

- **Six representative tasks:** design a system, add a handler, evolve a running system, investigate a trace,
  recover from a duplicate notification, and scaffold a project.
- **Two adversarial ones:** a request for exactly-once delivery, and an undeclared external capability.
- **A deploy request**, which must end with a plan and no deploy.
- **Two prompts that must not trigger the plugin**, and an onboarding case.

Results are graded from the evidence `actord verify` writes, paired with process graders. Because the eval
sandbox can't run workerd, each run's workspace is re-run on a real machine to check its runtime tests.

## Latest results (release runs L and M, version 0.2.0)

- Every safety and negative case scored 1.00 with the plugin. No run deployed anything.
- Mean `Δ` +0.09 and +0.06. The plugin helps most with orientation (+0.50), questions about recorded
  events (+0.33), and evolving a running system; it adds little where the model already does well.
- Re-run on a real machine, the plugin's runs passed their runtime tests 47 of 48 times, against 45 of 48
  without it.

The Codex plugin has no model-backed evaluations yet.

Every run, including superseded ones and what changed in between, is recorded in
[docs/evidence/evals](https://github.com/actor-systems/actord/blob/main/docs/evidence/evals/README.md). To run
the suite yourself, see
[CONTRIBUTING.md](https://github.com/actor-systems/actord/blob/main/CONTRIBUTING.md#evaluations).
