---
name: verify-actor-reliability
description: Test duplicates, retries, crashes, restart, reentrancy, cancellation or uncertain external effects in an actord Cloudflare project.
---

1. Read `actord.claims.json`, handlers and effect adapters. Each workerd/stub claim needs tagged tests; unsupported guarantees need a reason.
2. Cover duplicate and malformed messages, denied routes/capabilities, delayed/out-of-order delivery, crashes before/after mutation, retry exhaustion, scheduled wake/restart, cancellation across await, stale results, unavailable/invalid model output, approval/denial and lost acknowledgments as applicable. Explain any excluded case.
3. Run `actord test --profile extended` and `actord verify --json`. Use `actord events --notable` and `actord trace <id>` to diagnose failures. Keep existing API/test coverage while adding the requested behavior.
4. Read `.actord/evidence.json` and report every claim as proved locally, stub only, not guaranteed, blocked, failing or untested. Tests against doubles do not prove provider behavior. Never promise exactly-once external effects, global ordering or cross-actor transactions. Fix failures and report the actual verdict.

Use the [shared API and evidence conventions](references/workflow.md) when needed. Completion requires executed checks and inspectable outputs; report blocked commands precisely. Routes are cooperative correctness contracts, while native bindings retain authority. The user's instructions take precedence. Deployment and real external writes require authorization.
