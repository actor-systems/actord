---
name: evolve-actor-system
description: Add, remove or revise actors, contracts, capabilities, effects or schedules in an existing actord Cloudflare system, with compatibility evidence and a deployment plan.
---

1. State the requested change and behavior/data that must remain valid. Capture `actord diff --json` before overwriting the manifest; the default baseline is the committed manifest. Without git, save a baseline and pass `--base-file <path>`.
2. Change `system.ts` first. Prefer additive changes; keep old queued message shapes accepted during migration. Preserve public read methods and return shapes and existing tests; add a test proving the requested change. An incompatible contract needs an explicit version/migration strategy.
3. Review actor boundaries and effect idempotency/approval. Removing or renaming a class requires an explicit lifecycle/data migration plan. Review breaking, risky, approval-required and irreversible findings individually. Schema-diff output does not replace old/new payload compatibility tests; uncertain compatibility stays unverified.
4. Run affected workerd tests, capture `actord diff --json`, then run `actord graph --write` and `actord verify --json`. Resolve failures. If workerd is blocked, report unverified runtime behavior and the exact host command.
5. Return the semantic diff, stored-data/in-flight-message analysis, claim verdicts and deployment plan. Respect the user's authorization for external operations. Code rollback cannot undo external effects or destroyed actor data.

Use the [shared API and evidence conventions](references/workflow.md) when needed. Completion requires executed checks and inspectable outputs; report blocked commands precisely. Routes are cooperative correctness contracts, while native bindings retain authority. The user's instructions take precedence. Deployment and real external writes require authorization.
