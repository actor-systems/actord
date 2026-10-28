---
name: design-actor-system
description: Design a minimal Cloudflare actor topology with actord, justified state owners, typed message routes, effects and model budgets. Do not use for generic architecture discussions.
---

1. Read intent and the existing declaration. Justify each actor by identity, private state, lifecycle, isolation, scheduling or permissions; challenge unnecessary actors. Stateless rules stay functions. Record assumptions and rejected actors in `design.md`.
2. Declare `system.ts` using `defineSystem` from `@actord/toolkit/system` and versioned Standard Schema message contracts. Routes determine permitted sends and handlers at compile time. Declare effect idempotency, approval and result messages; model-assisted actors need attempt and time budgets (`maxAttempts`, `timeoutMs`); nothing enforces `maxTokens`, so bound tokens in the model request itself.
3. Put slow or external work in effects outside handlers, which may not await. Actors are Durable Object classes with `Lifecycle` installed; consult Cloudflare documentation for platform decisions.
4. Run project typecheck, `actord check --json`, and `actord graph --write`. Resolve errors. Return the topology, assumptions, rejected actors and actual check evidence.

Use the [shared API and evidence conventions](references/workflow.md) when needed. Completion requires executed checks and inspectable outputs; report blocked commands precisely. Routes are cooperative correctness contracts, while native bindings retain authority. The user's instructions take precedence. Deployment and real external writes require authorization.
