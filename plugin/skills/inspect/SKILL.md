---
name: inspect
description: Explain why a message, state change, or effect happened (or didn't) in an actor system on Cloudflare Durable Objects, from its topology and recorded events (`actors events`, `actors trace`). Use for questions about an actor event log (`.actors/events.ndjson`), such as why a message was retried, rejected, or delayed, or whether a notification went out. Reports unknown where recorded coverage ends; never invents production history.
allowed-tools: Bash(actors graph *) Bash(actors events *) Bash(actors trace *) Bash(actors check *)
---

# Inspect an actor system

Rules that hold for this whole skill:
- **Answer only from evidence:** the declaration, `.actors/events.ndjson` (written by test and dev runs),
  and code. When the evidence stops, say "unknown" and say where coverage ends.
- **Never invent production history.** `actors trace` covers local runs only. If Cloudflare's observability
  tools are connected and authorized, you may consult platform logs, but label them as a separate source.
- Quote message ids, event kinds, and reasons exactly as recorded.
- **Trace with the CLI, not a text search.** `actors trace` follows causation ids across actors, groups retries
  of one message, and joins effects to their results; grepping or reading the log misses those links.

## Topology

!`actors graph --json || true`

## Steps

1. **Find the message.** Use the id the user gives, or search:
   `actors events --kind <kind>`, `--actor <Actor>`, `--correlation <id>`, or `--notable` for faults.
   If there are no events, say so and offer to run the tests (`actors test`) to produce some.
2. **Trace it:** `actors trace <id>` (add `--json` to read fields). It shows the root cause, every hop with
   its outcome (handled, duplicate, rejected with a reason, failed with retries, dead-lettered), the
   effects with their outcomes, and notes the handlers recorded.
3. **Explain** in the order things happened: what triggered the first message, which actor decided what
   and why (cite the handler code and the recorded note), what came of each effect, and where the path
   ended. Tie each step to an event or a line of code.
4. **Say what isn't known:** a cause outside recorded coverage, effects whose outcome is `in_doubt`, or
   anything that happened in production.

Done when: a known id returns its path, outcome, and evidence; an unknown id is reported as unknown, with
the coverage that was searched.
