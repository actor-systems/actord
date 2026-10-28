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
   system.ts ──(import)──▶ normalized model ──▶ actord check · graph · diff     │ views of the
   (typed declaration)      actord.manifest.json   room · guard               │ same two
        │                                                                      │ sources of
        │  native Durable Object classes compose actorRuntime(...)             │ truth
        ▼                                                                      │
   workerd tests (Cloudflare Vitest) ──▶ .actord/events.ndjson ──▶ events · trace · room
                                     └─▶ .actord/evidence.json ──▶ verify · the Room · eval graders
                                                                               │
   deterministic machinery, no model calls: CLI · hooks · the Room (mod) · monitor ┘
```

## Principles and where they live

**One model, many views.** There are exactly two sources of truth: the normalized system model (derived from
`system.ts`) and the structured event log (written by tests and local runs). `check`, `graph`, `diff`,
`room`, `guard`, the hooks, the Room, the monitor, and the eval graders all read them; none computes its own
answer. That's why the Room is a thin renderer over `actord room --json`, and why the guard's question comes
from `actord guard` (decision 0009).

**TypeScript is the declaration language.** `system.ts` declares actors, messages (Standard Schema payloads
with versions), routes, schedules, effects, and budgets, typed so that undeclared routes, mismatched payloads,
and missing handlers are compile errors. There's no second YAML description to keep in sync; the manifest
is derived and checked for freshness (decision 0006).

**Actors stay native Durable Objects.** A class composes `actorRuntime(...)` rather than extending a base
class, so `ctx.sql`, alarms, and RPC remain available and the code reads like ordinary Cloudflare code. The
DO lifecycle uses wrangler's declarative `exports` map; removing an actor is an explicit, irreversible plan
step because deleting an export destroys its data (decision 0006).

**Runtime guarantees are few, tested, and stated with their limits.** Each handler runs in one SQLite
transaction (writes, inbox mark, outgoing messages, effect intents commit together). It may await some storage
calls, but not I/O: a handler that yields to the event loop fails its delivery ("handlers may not await I/O; use
ctx.effect", decision 0007's #80 and #82 amendments). Delivery is at least once
with an inbox for dedupe and an outbox drained by alarms with bounded retries and a dead letter; effects run
after commit, retried only with an idempotency key and otherwise reported `in_doubt`. Exactly-once external
effects, global ordering, and cross-actor transactions are not offered. Each guarantee rests on a probe of
platform behavior (decision 0007), and each app lists its claims in `actord.claims.json`, classified by
`actord verify` as proved locally, stub only, or not guaranteed.

**An agent is an actor.** An actor declared `kind: "agent"` runs a Pi session in its own Durable Object, beside
actord. The session is a job effect, settled by its probe; its tools are the effects the system declares, with the
same keys, approvals and `in_doubt`; and actord, not the harness, enforces its budget (decision 0019). Its files live
in a Computer workspace in the same object, its commands in a container that holds no credential, and its pushes
leave from the object (decision 0022). Everything Pi- or Computer-specific is in `@actord/toolkit/agents`, so an app
without agents never loads either.

**A decision is an effect.** Clef and Clairic calls are effects of two kinds, `"decision"` and `"extraction"`, run by
adapters over the Workers AI binding from `@actord/toolkit/decisions`, so they have keys, retries, budgets and usage
like any other effect, and the machinery still calls no model. Every answer is recorded in the actor's
`_actors_decisions`. The actor labels it later with `ctx.acted` and `ctx.outcome`, and `actord scorecard` reports
calibration from those events in the local log. A shadow decision is recorded and never delivered, and a decision's
result can't approve or deny (decision 0020).

**Deterministic machinery, visible judgment.** The CLI, hooks, mod, and monitor never call a model and never
approve anything. Judgment lives in skills and the two critics, where it shows in the transcript and is
measured by `claude plugin eval` with and without the plugin (decision 0008).

**Evidence flows through files.** `actord check` records `.actord/last-check.json` with a fingerprint of the
actor files; `actord verify` writes `.actord/evidence.json`. The edit-time hook, the evidence gate, the
Room's Contracts and Evidence tabs, CI, and the eval graders all read those files, so every consumer agrees
on what was established and when it went stale.

**Enforcement over instruction, honestly labeled.** Permission rules are the enforceable layer inside Claude
Code (`actord init` generates `ask` rules from the same pattern table the Room's guard uses); Cloudflare token
scopes are the enforceable layer outside it. The guard and the rules match command text, so they're
conveniences against mistakes, not a security boundary (decisions 0001, 0009).

## The plugin's parts

| Part | Job | Why this mechanism |
| --- | --- | --- |
| Skills | The authoring loop (`docs/workflow.md`); rules first, injected CLI evidence | Judgment that should be visible and measurable |
| Critics | Argue for fewer actors; audit idempotency and in-doubt honesty | Isolated context, read-only tools |
| `bin/actord` | The machine interface, preferring the project's pinned version | One deterministic binary for Claude, hooks, the Room, CI |
| Hooks | `check-on-edit` (contract errors at edit time), `evidence-gate` (opt-in), `heredoc-note` (beside a refused heredoc) | Feedback at the moment of change, never blocking edits or deciding tool calls |
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
| [0013](decisions/0013-heredoc-note-and-recover-trigger.md) | A note beside refused heredocs; `reliability` takes reported failures |
| [0014](decisions/0014-one-repository.md) | One repository for the core and both plugins, one version, Apache-2.0 |
| [0015](decisions/0015-readme-wiki-contributing.md) | A landing-page README, a wiki for reference (from `docs/wiki/`), CONTRIBUTING for the repository |
| [0016](decisions/0016-actord-on-lifecycle.md) | actord on the Agents SDK's `Lifecycle`: one capability, one job, the object's one alarm |
| [0017](decisions/0017-sources.md) | Sources: system-level senders, generated handlers, ids from delivery ids |
| [0018](decisions/0018-job-effects.md) | Job effects: start with a handle, settle once, later |
| [0019](decisions/0019-agent-actors.md) | Agent actors: a Pi session is a job effect, and declared effects are its tools |
| [0020](decisions/0020-decisions-and-extractions.md) | Decisions and extractions: Clef and Clairic calls are recorded effects, and shadow never steers |
| [0021](decisions/0021-approvals-by-email-reply.md) | Approvals by email: reply, never link, matched by a signed subject token |
| [0022](decisions/0022-agent-workspaces.md) | Agent workspaces: Computer in the object, commands in a container, git from the object |
| [0023](decisions/0023-skills-track-the-runtime.md) | Skills track the runtime: no new skills, code examples that compile, and eval scaffolds that run |

## Coding-host adapters

The core in `packages/toolkit` serves both plugins in this repository: `plugins/claude/` and `plugins/codex/`. Host profiles select project guidance only; native runtime, type contracts and evidence are the same. Each plugin keeps its own manifest, skills, and launcher, and each host's marketplace file points at its plugin's directory. See [decision 0012](decisions/0012-shared-core-host-adapters.md) and [decision 0014](decisions/0014-one-repository.md).
