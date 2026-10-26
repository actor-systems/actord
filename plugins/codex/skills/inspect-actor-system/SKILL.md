---
name: inspect-actor-system
description: Explain a known actor message ID, causal path, retry or effect outcome from actord local structured event data.
---

1. Read `actord graph --json` and use `actord events` to find the message by actor, kind or correlation. These commands read `.actord/events.ndjson`; use `--file <path>` for a separate log.
2. Run `actord trace <message-id> --json`. Follow the earliest recorded cause, all branches, delivery attempts, notes and effects. Use the causal tree rather than lexically sorting event IDs or grepping a log.
3. Explain what triggered each step and connect decisions to recorded notes or handler code. Quote IDs, outcomes and reasons exactly. State unknown when the cause or outcome lies outside recorded coverage.
4. Distinguish local/test evidence, stub effects and any separately authorized production evidence. Return the causal explanation, relevant evidence and remaining unknowns; never infer production delivery from local tests.

Use the [shared API and evidence conventions](references/workflow.md) when needed. Completion requires executed checks and inspectable outputs; report blocked commands precisely. Routes are cooperative correctness contracts, while native bindings retain authority. The user's instructions take precedence. Deployment and real external writes require authorization.
