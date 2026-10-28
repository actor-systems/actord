---
name: inspect
description: Explain why a message, state change, or effect happened (or didn't) in an actor system on Cloudflare Durable Objects, from its topology and recorded events (`actord events`, `actord trace`, `actord scorecard`). Use for questions about an actor event log (`.actord/events.ndjson`), such as why a message was retried, rejected, or delayed, whether a notification went out, or how a decision effect scores. Reports unknown where recorded coverage ends; never invents production history.
allowed-tools: Bash(npx --no-install actord graph *) Bash(actord graph *) Bash(actord events *) Bash(actord trace *) Bash(actord scorecard *) Bash(actord check *)
---

# Inspect an actor system

Rules that hold for this whole skill:
- **Answer only from evidence:** the declaration, `.actord/events.ndjson` (written by test and dev runs),
  and code. When the evidence stops, say "unknown" and say where coverage ends.
- **Never invent production history.** `actord trace` and `actord scorecard` cover local runs only. If Cloudflare's
  observability tools are connected and authorized, you may consult platform logs, but label them as a separate
  source.
- Quote message ids, event kinds, and reasons exactly as recorded.
- **Trace with the CLI, not a text search.** `actord trace` follows causation ids across actors, groups retries
  of one message, and joins effects to their results; grepping or reading the log misses those links.

## Topology

!`actord graph --json --exit-zero || npx --no-install actord graph --json --exit-zero || true`

## Steps

1. **Find the message.** Use the id the user gives, or search:
   `actord events --kind <kind>`, `--actor <Actor>`, `--correlation <id>`, or `--notable` for faults (add
   `--json` for each event's `detail`). If there are no events, say so and offer to run the tests (`actord test`)
   to produce some.
2. **Trace it:** `actord trace <id>` (add `--json` to read fields). It shows the root cause, every hop with
   its outcome (handled, duplicate, rejected with a reason, failed with retries, dead-lettered), the
   effects with their outcomes, and notes the handlers recorded.
3. **Explain** in the order things happened: what triggered the first message, which actor decided what
   and why (cite the handler code and the recorded note), what came of each effect, and where the path
   ended. Tie each step to an event or a line of code. Read the parts below that apply.
4. **For a decision or an extraction,** run `actord scorecard [--effect <name>]` when the question is how well it
   answers: per effect, the recorded, shadow, labelled and acted counts, then accuracy or Brier score, mean absolute
   error, or the share labelled correct. `-` means no labels yet. It reads the same local log as the trace.
5. **Say what isn't known:** a cause outside recorded coverage, effects whose outcome is `in_doubt`, or
   anything that happened in production.

## Reading a trace

- **A handler that awaited.** A hop with `! <Actor>.<type>: handlers may not await I/O; use ctx.effect` failed
  because its handler awaited, and it fails on every attempt: a message from another actor ends
  `retry.exhausted` after 6, a timer is dropped, and an `ingress` caller gets `failed`.
- **How a job settled.** A job effect's line is followed by `job <handle> settled by <how> after <wait>`:
  - `message`: its `completes` handler called `ctx.settleJob`, with the outcome that handler gave;
  - `probe`: the adapter's probe reported it done;
  - `deadline`: `in_doubt`, "deadline passed"; the work may still finish;
  - `cancel`: `failed` "cancelled" only when the destination confirmed; otherwise `in_doubt`, "cancel not
    confirmed".

  `not settled yet` means it is still waiting (`awaiting_job`) or being cancelled (`cancelling`).
- **A parked effect** is `in_doubt` with a reason starting `parked:` (`interrupted N times without settling`, or
  `cancel interrupted N times without settling`). N restarts cut it off, so it will never run again, and whether
  it happened is unknown. `actord events --kind effect.parked` lists them; `--notable` shows the `effect.in_doubt`
  recorded beside each.
- **`source.*` events** come from a webhook or inbound email (their `actor` is the source, such as `@github`), and
  the `reason` says why: `source.rejected` (`signature`, `secret_missing`, `not_owner`, `unauthenticated`, …),
  `source.invalid` (`invalid_payload`, `delivery_id_missing`, …), `source.failed` (`handler_failed`: GitHub doesn't
  redeliver it by itself), and `source.ignored` (an unmapped event or an auto-reply; not in `--notable`). A
  refusal before the delivery id was read has no message id. `actord trace <delivery id>` follows a webhook
  delivery that reached an actor; for one the source refused it has no outcome to show (`? unknown`), so read the
  `source.*` event itself with `actord events --actor @github --json`.
- **Decisions.** In the trace a decision is an effect like any other, with its result message under it; a shadow
  decision has none. The `decision.*` events aren't drawn there: read them with `actord events --kind <kind> --json`.
  - `decision.recorded`: the answer as recorded, with its `mode` (`act` or `shadow`); an extraction's values are
    left out.
  - `decision.acted`: what the actor did (`ctx.acted`), from the handler that did it.
  - `decision.outcome`: what was really so (`ctx.outcome`), the label the scorecard compares.

Done when: a known id returns its path, outcome, and evidence; an unknown id is reported as unknown, with
the coverage that was searched; a scorecard question is answered with the scorecard's own numbers.
