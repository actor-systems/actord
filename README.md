# actord

**Build systems of communicating actors on Cloudflare Durable Objects with your coding agent, and know what
actually holds.**

actord gives Claude Code and Codex a typed, checkable way to design, build, test, and evolve small actor
systems. Your agent proposes the design and writes the code. The TypeScript compiler, `actord check`, and
tests that run in workerd, Cloudflare's own runtime, decide whether it's right.

[Get started](#get-started) · [Documentation](https://github.com/actor-systems/actord/wiki) ·
[npm](https://www.npmjs.com/package/@actord/toolkit) · [Contributing](CONTRIBUTING.md)

## Why actord

A coding agent can write a Durable Object in seconds. Making a system of them correct is the hard part:
messages arrive twice, a handler crashes halfway through, a retry sends the same notification again, and a
"small" schema change strands messages already in flight. actord makes those risks visible and testable.

- **A design you can check.** One typed `system.ts` declares every actor, message, route, effect, and
  schedule. What the compiler can't catch, `actord check` does.
- **Reliability you can prove.** Each message is handled once per actor, a handler's writes and messages
  commit together, delivery retries until it lands, and an effect that might not have happened is reported
  as in doubt. Every claim is backed by a test in workerd, or marked as not guaranteed.
- **Changes without surprises.** `actord diff` classifies a change as compatible, breaking, or risky and
  writes the deploy plan. It never deploys.
- **Answers from evidence.** `actord trace` explains why a message was retried, rejected, or delivered, from
  recorded events, and says *unknown* where the record ends.

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

Requires Node.js 22.18+. Updating, uninstalling, and requirements for each agent:
[Getting started](https://github.com/actor-systems/actord/wiki/Getting-Started).

## What a system looks like

Release Radar, one of the two reference apps, polls release feeds, records what it has seen, and notifies its
owner once per significant release. This diagram is `actord graph --format mermaid`:

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

Its 22 workerd tests cover duplicates, crashes before and after writes, retries, restarts, ordering, the
schedule, and a lost acknowledgment.

## What you get

| | |
| --- | --- |
| **Plugins for Claude Code and Codex** | Skills to design, implement, test, inspect, and evolve a system, and critics that argue for fewer actors and audit handlers for duplicate safety |
| **`@actord/toolkit`** | The `actord` CLI and the runtime your actors use: native Durable Object classes, no framework lock-in |
| **The Room** (Claude Code) | A live pane with the topology, mailboxes, contracts, and evidence, and a guard that asks you before deploy commands it recognizes run |
| **Two reference apps** | Release Radar (rule-based) and Briefing Desk (model-assisted, with human approval before anything leaves) |

## Status

Version 0.2.0. Every check in the repository passes in CI on a clean checkout. The Claude Code plugin is
measured against the same model without it, and every safety case holds
([Evaluations](https://github.com/actor-systems/actord/wiki/Evaluations)). Nothing deploys without you, and
nothing here promises exactly-once external effects
([Limitations](https://github.com/actor-systems/actord/wiki/Limitations)). Everything the plugin runs on your
machine is listed in [Trust and safety](https://github.com/actor-systems/actord/wiki/Trust-and-Safety).

## License

Apache-2.0. See [LICENSE](LICENSE).
