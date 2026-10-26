---
name: implement-actor-behavior
description: Add or change typed messages, handlers, state, scheduling or bounded model effects in an actord Cloudflare project.
---

1. Read `system.ts`, actor code, existing tests and `actord check --json`. Change the declaration and contracts first; use compiler diagnostics to find affected handlers and sends.
2. Compose `actorRuntime(...)` in normal Durable Object classes. Keep handlers storage-only: state, inbox, outgoing messages and effect intents commit in one transaction. Use `ctx.send` on declared routes and `ctx.effect` for model/network work; process the result as a declared message.
3. Preserve public read methods and existing return shapes and tests. Add a focused test proving the new behavior and fault tests for its delivery/effect boundary. New capabilities must be declared; the user's explicit request authorizes that declaration.
4. Validate model output, bound attempts/time/tokens and reject stale generations. Use idempotency keys only when the destination honors them; otherwise preserve `in_doubt` and approval/reconciliation behavior.
5. Run typecheck and affected workerd tests, then `actord graph --write` and `actord verify --json`. Fix failures. Report the real verdict and claims; if execution is blocked, identify the exact unverified command.

Use the [shared API and evidence conventions](references/workflow.md) when needed. Completion requires executed checks and inspectable outputs; report blocked commands precisely. Routes are cooperative correctness contracts, while native bindings retain authority. The user's instructions take precedence. Deployment and real external writes require authorization.
