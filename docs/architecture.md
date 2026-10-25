# Architecture

Why the toolkit is shaped the way it is. The charter (`docs/charter.md`) states the intent; the decision log
(`docs/decisions/`) records each consequential choice with its alternatives and evidence. This page connects
them.

## The shape in one picture

```
   person ──asks──▶ Claude Code ──────────────────────────────────────────────┐
                     │ skills (judgment, visible)    critics (read-only)       │
                     │ start · setup · design ·      boundary-critic           │
                     │ implement · reliability ·     delivery-auditor          │
                     │ inspect · evolve                                        │
                     ▼                                                         │
   system.ts ──(import)──▶ normalized model ──▶ actors check · graph · diff     │ views of the
   (typed declaration)      actors.manifest.json   room · guard               │ same two
        │                                                                      │ sources of
        │  native Durable Object classes compose actorRuntime(...)             │ truth
        ▼                                                                      │
   workerd tests (Cloudflare Vitest) ──▶ .actors/events.ndjson ──▶ events · trace · room
                                     └─▶ .actors/evidence.json ──▶ verify · the Room · eval graders
                                                                               │
   deterministic machinery, no model calls: CLI · hooks · the Room (mod) · monitor ┘
```

## Principles and where they live

**One model, many views.** There are exactly two sources of truth: the normalized system model (derived from
`system.ts`) and the structured event log (written by tests and local runs). `check`, `graph`, `diff`,
`room`, `guard`, the hooks, the Room, the monitor, and the eval graders all read them; none computes its own
answer. That's why the Room is a thin renderer over `actors room --json`, and why the guard's question comes
from `actors guard` (decision 0009).

**TypeScript is the declaration language.** `system.ts` declares actors, messages (Standard Schema payloads
with versions), routes, schedules, effects, and budgets, typed so that undeclared routes, mismatched payloads,
and missing handlers are compile errors. There's no second YAML description to keep in sync; the manifest
is derived and checked for freshness (decision 0006).

**Actors stay native Durable Objects.** A class composes `actorRuntime(...)` rather than extending a base
class, so `ctx.sql`, alarms, and RPC remain available and the code reads like ordinary Cloudflare code. The
DO lifecycle uses wrangler's declarative `exports` map; removing an actor is an explicit, irreversible plan
step because deleting an export destroys its data (decision 0006).

**Runtime guarantees are few, tested, and stated with their limits.** Each handler runs in one SQLite
transaction (writes, inbox mark, outgoing messages, effect intents commit together); delivery is at least once
with an inbox for dedupe and an outbox drained by alarms with bounded retries and a dead letter; effects run
after commit, retried only with an idempotency key and otherwise reported `in_doubt`. Exactly-once external
effects, global ordering, and cross-actor transactions are not offered. Each guarantee rests on a probe of
platform behavior (decision 0007), and each app lists its claims in `actors.claims.json`, classified by
`actors verify` as proved locally, stub only, or not guaranteed.

**Deterministic machinery, visible judgment.** The CLI, hooks, mod, and monitor never call a model and never
approve anything. Judgment lives in skills and the two critics, where it shows in the transcript and is
measured by `claude plugin eval` with and without the plugin (decision 0008).

**Evidence flows through files.** `actors check` records `.actors/last-check.json` with a fingerprint of the
actor files; `actors verify` writes `.actors/evidence.json`. The edit-time hook, the evidence gate, the
Room's Contracts and Evidence tabs, CI, and the eval graders all read those files, so every consumer agrees
on what was established and when it went stale.

**Enforcement over instruction, honestly labeled.** Permission rules are the enforceable layer inside Claude
Code (`actors init` generates `ask` rules from the same pattern table the Room's guard uses); Cloudflare token
scopes are the enforceable layer outside it. The guard and the rules match command text, so they're
conveniences against mistakes, not a security boundary (decisions 0001, 0009).

## The plugin's parts

| Part | Job | Why this mechanism |
| --- | --- | --- |
| Skills | The authoring loop (`docs/workflow.md`); rules first, injected CLI evidence | Judgment that should be visible and measurable |
| Critics | Argue for fewer actors; audit idempotency and in-doubt honesty | Isolated context, read-only tools |
| `bin/actors` | The machine interface, preferring the project's pinned version | One deterministic binary for Claude, hooks, the Room, CI |
| Hooks | `check-on-edit` (contract errors at edit time), `evidence-gate` (opt-in) | Feedback at the moment of change, never blocking edits |
| The Room (mod) | Pane, status line, effect guard | Only a mod can draw a pane or hold a tool call for a decision |
| Monitor | Notable local events as notifications | Faults reach Claude without polling |

The core (skills, critics, CLI) works without hooks, the mod, the monitor, credentials, or Cloudflare's own
plugin (decision 0005; `scripts/no-hooks-smoke.sh`). Generated projects keep working without the plugin:
their verify skill, permission rules, and pinned CLI live in the project.

## Tooling choices

Wrangler, Cloudflare's Vitest integration, and workerd are the build, test, and deploy layer; `cf` and Void
were evaluated and aren't dependencies (decision 0002). Actors are native Durable Objects rather than Agents
SDK classes in v0.1 (decision 0003). The CLI is one dependency-free ESM bundle, and projects use Node's native
TypeScript loading. Inside Claude Code's default sandbox workerd
can't bind its loopback port, so verification reports `blocked` there rather than pretending (decision 0004).

## Decision index

| # | Decision |
| --- | --- |
| [0001](decisions/0001-implementing-agent-guardrails.md) | Guardrails for the implementing agent |
| [0002](decisions/0002-cloudflare-tooling.md) | Wrangler; `cf` and Void are not dependencies |
| [0003](decisions/0003-runtime-and-toolchain.md) | Native Durable Objects, Cloudflare's Vitest plugin, no Agents SDK in v0.1 |
| [0004](decisions/0004-workerd-and-the-eval-sandbox.md) | workerd tests and the eval sandbox: split and label the evidence |
| [0005](decisions/0005-cloudflare-plugin-composition.md) | Cloudflare's plugin: recommended companion, not a dependency |
| [0006](decisions/0006-declaration-model-and-do-exports.md) | The typed declaration, the derived manifest, DO `exports` |
| [0007](decisions/0007-runtime-semantics.md) | Transactional handlers, outbox, effects after commit |
| [0008](decisions/0008-agent-guided-development.md) | Skills, critics, hooks, claims, evals |
| [0009](decisions/0009-the-room.md) | The Room: one CLI document, a prefiltered guard, a deduplicated monitor |
| [0010](decisions/0010-eval-lane.md) | The eval lane: what the graders measure; the deploy case asserts no deploy ran |
| [0011](decisions/0011-payload-compatibility.md) | Payload compatibility: "compatible" is a proof, and the plan drains what isn't |

## Coding-host adapters

The core in `packages/cli` is shared with the sibling Codex adapter in `../actors/`. Host profiles select project guidance only; native runtime, type contracts and evidence are the same. Claude integration stays in `plugin/`; Codex keeps its portable manifest, skills and launcher in its own distribution. See [decision 0012](decisions/0012-shared-core-host-adapters.md).
