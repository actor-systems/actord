# @actord/toolkit

The core of [actord](https://github.com/actor-systems/actord): conventions, checks, and inspection for small
systems of communicating actors on Cloudflare Durable Objects. One package holds the `actord` CLI and the
libraries an actor project imports. Actors stay native Durable Object classes; the declaration in `system.ts`
is typed, so the compiler, `actord check`, and workerd tests can hold a design to what it says.

Requires Node.js 22.19 or later.

## Start a project

```sh
npx @actord/toolkit init my-app   # a tested starter: system.ts, two actors, workerd tests
cd my-app && npm install && npm test
```

Or add it to an existing Worker project: `npm install -D @actord/toolkit zod`, then `npx actord init --adopt`.

## What's in it

| Import | What it gives you |
| --- | --- |
| `@actord/toolkit/system` | `defineSystem` and `message`: the typed declaration of actors, messages, routes, effects, and schedules |
| `@actord/toolkit/runtime` | `actorRuntime(...)` for native Durable Object classes: an inbox that handles each message id once, transactional handlers, an outbox that delivers at least once, and effects that run after commit |
| `@actord/toolkit/sources` | `handleWebhook` and `handleEmail`: the generated handlers for a system's webhook and email sources, and approvals by email reply |
| `@actord/toolkit/agents` | `agentRuntime(...)` for agent actors: a Pi session as a job effect, declared effects as its tools, budgets, and a Computer workspace with clone and push from the Durable Object. It loads Pi and `@cloudflare/computer`, optional peers that no other entry point imports |
| `@actord/toolkit/testing` | workerd test helpers with `@cloudflare/vitest-plugin`: `settle`, `tick`, `injectFault`, `overrideEffect`, `overrideBudget`, `resetSeams` |
| `@actord/toolkit/vitest` | `actorEvents()`, which records each test run's events to `.actord/events.ndjson` for `actord trace` |

Message payloads are Standard Schema validators (for example zod 4, an optional peer dependency).

## The `actord` CLI

| Command | What it does |
| --- | --- |
| `actord init [dir] [--adopt]` | Creates a tested starter, or adds project guidance to an existing one; never overwrites |
| `actord doctor` | Checks Node, the project, version pins, Worker config, and permission rules |
| `actord check` | Validates what the compiler can't: routes, schemas, schedules, effects, bindings, exports, manifest freshness |
| `actord graph [--write] [--format mermaid]` | Prints the topology, updates `actord.manifest.json`, or prints a Mermaid flowchart |
| `actord diff [--base <ref>]` | Classifies changes against a commit as compatible, breaking, or risky, and ends with a deploy plan, never a deploy |
| `actord test`, `actord verify` | Runs the workerd tests; `verify` adds typecheck, `check`, and claim classification and writes `.actord/evidence.json` |
| `actord events`, `actord trace <id>` | Queries the local event log, and follows a message's causes and consequences |
| `actord room`, `actord guard` | The views behind the Claude Code plugin's Room and its deploy guard |

Every command takes `--json`. Read-only commands never contact Cloudflare.

## Guarantees

The runtime refuses malformed, wrong-version, off-route, and invalid messages; handles a message id at most
once per actor; commits a handler's writes, outgoing messages, and effect intents together; delivers at least
once with retries, then dead-letters; and never reports an unacknowledged external effect as delivered. It
does **not** guarantee exactly-once external effects, global ordering, or transactions across actors.

Handlers may await some storage calls, but not I/O. Request I/O with `ctx.effect`: it runs after commit, and its
outcome comes back as a message.

- **What fails.** A handler that awaits a `fetch`, a timer or a model fails its delivery with "handlers may not
  await I/O; use ctx.effect". Its transaction would otherwise stay open across an event-loop turn, and other
  writers' rows could join it. Any await still pending at the next event-loop turn fails the delivery, even
  `setTimeout(0)` and libraries that use timers internally.
- **What a handler may await.** `get`, `put`, `list` and `delete`, the alarm calls, `ctx.sql`, `kv`,
  `transactionSync` and Lifecycle's `jobs.push`.
- **What a handler must not await.** A nested `transaction()`, `sync()`, `getCurrentBookmark()` or a body read.
  These let a waiting writer in without the delivery failing (#82).

## With a coding agent

The repository ships plugins for Claude Code and Codex that design, implement, test, inspect, and evolve
actor systems with this toolkit:

```sh
claude plugin marketplace add actor-systems/actord && claude plugin install actord@actord
codex plugin marketplace add actor-systems/actord && codex plugin add actord@actord
```

## License

Apache-2.0. See [LICENSE](https://github.com/actor-systems/actord/blob/main/LICENSE).
