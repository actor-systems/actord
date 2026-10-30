# actord

**A toolkit and plugins for building systems of Durable Object actors on Cloudflare with Claude Code or
Codex.**

actord helps a coding agent design, build, test, and change small systems of communicating actors. The agent
writes the design and the code. The TypeScript compiler, `actord check`, and tests that run in workerd,
Cloudflare's runtime, check them.

Typical examples: a service that watches release feeds and tells you about significant releases, one that
reads incoming reports and drafts briefings for your approval, or a set of coding agents that turns GitHub
issues into pull requests. Each is a few actors that pass messages to each other. Between events they sleep
and cost almost nothing, and they keep their state across restarts.

[Get started](#get-started) · [Documentation](https://github.com/actor-systems/actord/wiki) ·
[npm](https://www.npmjs.com/package/@actord/toolkit) · [Contributing](CONTRIBUTING.md)

## Why actord

The actor model dates from 1973. An actor has its own identity and private state, handles one message at a
time, and affects other actors only by sending them messages. It fits AI agents well: an agent keeps its own
state, works on one task at a time, and communicates through messages.

Durable Objects implement the model on Cloudflare. Each object has a unique name, its own SQLite database, and
a single thread, and it sleeps until a message wakes it. There's no cluster to run, so one person can keep a
system of a dozen long-lived actors on their own account.

A coding agent can write a single Durable Object quickly. Getting a system of them right is harder: messages
arrive twice, a handler crashes halfway through, a retry sends the same notification again, and a schema
change strands messages already in flight. actord makes these problems visible and testable:

- **Typed declaration.** One `system.ts` declares every actor, message, route, effect, and schedule, and each
  actor lists why it needs to be a separate actor. `actord check` catches what the compiler can't.
- **Tested guarantees.** Each message is handled at most once per actor, a handler's writes and outgoing
  messages commit together, delivery is retried until it succeeds, and an effect that may or may not have
  happened is reported as in doubt. Each guarantee has a test in workerd, or is listed as not guaranteed.
- **Change classification.** `actord diff` labels a change compatible, breaking, or risky and writes a deploy
  plan. It doesn't deploy.
- **Traces.** `actord trace` shows why a message was retried, rejected, or delivered, using recorded events,
  and reports *unknown* where the record has gaps.

## What a system looks like

Release Radar, one of the two reference apps, polls release feeds and notifies its owner once per significant
release. Part of its `system.ts`:

```ts
export default defineSystem({
  name: "release-radar",
  actors: {
    FeedPoller: {
      kind: "deterministic",
      purpose: "Watches one feed (one instance per feed id) and reports every item it sees",
      justification: ["identity", "scheduling"],
      schedules: [{ every: "15m", message: "feed.poll.due" }],
      effects: ["feed.fetch"],
    },
    ReleaseLedger: {
      kind: "deterministic",
      purpose: "Owns the record of every release seen; deduplicates and classifies new ones by rule",
      justification: ["state"],
    },
    // DigestWriter, the message schemas, and the effects
  },
  routes: [
    { from: "@clock", message: "feed.poll.due", to: "FeedPoller" },
    { from: "FeedPoller", message: "release.observed", to: "ReleaseLedger" },
    { from: "ReleaseLedger", message: "release.significant", to: "DigestWriter" },
    // and two more
  ],
});
```

`actord graph --format mermaid` draws the same file:

```mermaid
flowchart LR
  x_clock(["@clock"])
  x_ingress(["@ingress"])
  a_DigestWriter["DigestWriter<br/>deterministic"]
  a_FeedPoller["FeedPoller<br/>deterministic · every 15m"]
  a_ReleaseLedger["ReleaseLedger<br/>deterministic"]
  x_clock -->|"feed.poll.due@1"| a_FeedPoller
  x_ingress -->|"feed.watch@1"| a_FeedPoller
  a_FeedPoller -->|"feed.fetched@1"| a_FeedPoller
  a_FeedPoller -->|"release.observed@1"| a_ReleaseLedger
  a_ReleaseLedger -->|"release.significant@1"| a_DigestWriter
```

Release Radar's 22 workerd tests cover duplicates, crashes before and after writes, retries, restarts,
ordering, the schedule, and a lost acknowledgment.

## Actor kinds

Each actor is one of three kinds:

| Kind | What it is | Typical work |
| --- | --- | --- |
| `deterministic` | Ordinary code | Poll a feed, keep a ledger, send one digest per finding |
| `model-assisted` | Code that calls a model and validates the answer before changing anything | Classify an item, route an issue with a probability for each option, extract typed values with confidence scores |
| `agent` | An agent session in its own Durable Object, with tools, a budget (dollars, turns, and wall-clock time), and an optional workspace that survives restarts | Edit a repository, run its tests, push a branch |

Most actors should be deterministic, since they're cheaper, faster, and easier to test. Use a model where a
task needs judgment.

A system can also declare schedules and timers, sources (signed GitHub webhooks and inbound email), effects
with idempotency keys and budgets, and approvals. An effect that acts for you, such as sending a message to
someone, can wait for your approval, which you can give by replying to an email. `actord scorecard` reports
how well calibrated a model's decisions and extractions were.

## What I'm building with it

I'm building actord to run what I call standing systems: small systems on my own Cloudflare account that
handle ongoing personal work. I describe what I need, a coding agent builds the system, and it runs for as
long as I need it. It reacts to events, can wait for days without losing state, and asks me when a decision
needs a person.

The first one, now in design, is a software factory for this repository. An actor owns each issue as a job. A
coding agent works on it in its own Durable Object, with a workspace and a spending limit. Tests and a
separate reviewer model check the work; the reviewer sees the brief, the diff, and the test results, but not
the implementer's transcript. The result is a draft pull request with evidence for each acceptance criterion,
and I do the merging.

Spikes on deployed Workers have tested the riskiest parts:

- An agent session kept running through a deploy and an eviction, and finished all 30 of its edits in 17
  minutes with the tests passing.
- A git push authenticated from the Durable Object, with the token kept out of the container.
- A reply to an email approved a parked action.

Other systems I plan to build with it: a tracker for commitments I've made and that others have made to me,
which drafts a reminder when one is overdue and waits for my approval to send it; monitors that run on a
schedule and call a model only when a rule fires; and research pipelines that run for weeks. The same
structure also works for systems that aren't personal, such as triage queues or multi-agent backends.

I expect coding agents to write a lot more software like this: long-running, acting for someone, and changed
often. My goal for actord is to make these systems as easy to build as Rails made web applications, with
tests that show what each system guarantees.

## Get started

**Claude Code**

```sh
claude plugin marketplace add actor-systems/actord
claude plugin install actord@actord
```

Then run `/actord:start` in a session.

**Codex**

```sh
codex plugin marketplace add actor-systems/actord
codex plugin add actord@actord
```

Then open a fresh chat and invoke `setup-actor-project`.

**The toolkit on its own**

```sh
npx @actord/toolkit init my-app
cd my-app && npm install && npm test
```

Requires Node.js 22.19+. Updating, uninstalling, and requirements for each agent:
[Getting started](https://github.com/actor-systems/actord/wiki/Getting-Started).

## What you get

| | |
| --- | --- |
| **Plugins for Claude Code and Codex** | Skills to design, implement, test, inspect, and evolve a system, and two critic subagents: one proposes fewer actors, the other audits handlers for duplicate safety |
| **`@actord/toolkit`** | The `actord` CLI (`check`, `graph`, `diff`, `trace`, `verify`, and more) and the runtime your actors use: native Durable Object classes built on Cloudflare's Agents SDK |
| **The Room** (Claude Code) | A live pane beside the transcript with the topology, mailboxes, contracts, and evidence, and a guard that asks you before deploy commands it recognizes run |
| **Two reference apps** | Release Radar (rule-based) and Briefing Desk (model-assisted, with human approval before anything is sent) |

## Status

`@actord/toolkit` 0.2.0 is on npm. The plugins install from this repository's main branch, which adds
sources, approvals by email reply, agent actors with workspaces, and decisions and extractions on Workers AI.
CI runs every check on a clean checkout, and all of them pass.

The Claude Code plugin is evaluated with `claude plugin eval` on fifteen cases, against the same model without
the plugin. All safety cases pass: no run deployed anything, and when asked for exactly-once delivery, the
plugin explains why it can't be guaranteed. The plugin helps most with orientation and with questions about
recorded events. Systems built with the plugin pass their runtime tests slightly less often than the baseline
(55 of 66 runs against 61 of 66), and that's the next thing I'm working on
([Evaluations](https://github.com/actor-systems/actord/wiki/Evaluations)).

actord never deploys on its own, and it doesn't guarantee exactly-once external effects
([Limitations](https://github.com/actor-systems/actord/wiki/Limitations)).
[Trust and safety](https://github.com/actor-systems/actord/wiki/Trust-and-Safety) lists everything the plugin
runs on your machine.

## License

Apache-2.0. See [LICENSE](LICENSE).
