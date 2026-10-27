# 0019 — Agent actors: a Pi session is a job effect, and declared effects are its tools

- **Date:** 2026-10-27 · **Gate:** plan 3 (agent actors) · **Status:** accepted · **Reversibility:** moderate (a
  new actor kind, `kind: "agent"`, and a new entry point, `@actord/toolkit/agents`; other actors are unchanged)

## Context
An agent actor runs a model in a loop: it reads, edits, runs commands and asks for things outside its sandbox, for
minutes at a time (spec §7). The factory needs that loop to start, steer and stop on messages, to return a typed
message, to spend no more than its budget, and to survive a restart the way every other actor does.

Spec §7 was written before Pi and Computer were read. Where the packages differ from it, this decision follows the
packages: plan 3's design corrections 1 to 4 and 7. Decision 0022 records the workspace (corrections 5 and 6).
Spike 3 (`docs/evidence/spike-3-agents-in-workerd.md`) showed the two can share one Durable Object.

## Decisions
1. **One Durable Object, two capabilities.** `agentRuntime(host, system, actor, handlers, options)` installs the
   Agents SDK's `PiHarness` on the actor's `Lifecycle`, beside actord. They share the object's one alarm (decision
   0016). Pi's tables have the prefix `pi_`. actord's agent rows are `_actors_agent_sessions` (one per session) and
   `_actors_agent_waits` (one per tool request that waits for a person).
2. **A session is a job effect.** Each session runs as the internal job effect `agent.session` (decision 0018),
   keyed by the id of the message that started it. That id is also Pi's `operationId`, so the outbox's key, deadline,
   probe, cancel, honest `in_doubt` and trace all apply. The `on` verbs:
   - **`start`** opens a new Pi session and submits the message, rendered, as its prompt (default: the type, then the
     payload as indented JSON). A start while a session runs replaces it: its job is cancelled, Pi aborts it, and the
     new session gets the next generation. A redelivered start finds its row and starts nothing.
   - **`steer`** joins the running turn. It is a second internal effect, `agent.session.steer`, a call keyed by the
     steering message's id, because Pi can't be called inside actord's transaction. With no live session it is a
     note. Sent before the session's start has returned, it waits and is tried again, so it can't reach Pi ahead of
     the prompt.
   - **`stop`** cancels the job, and the cancel aborts Pi. A stop that lands before the start has returned is kept on
     the row (`stopped_at`), and the start acts on it: before Pi is asked, it starts nothing; after, it aborts the
     session.
   - Every `agent.session` and `agent.session.*` name is reserved: a system may not declare one
     (`AGENT_NAME_RESERVED`).
3. **The probe settles the job (correction 1).** `PiHarness` has no completion callback: it reports completion only by
   polling (`pending()`, `wait(operationId)`).
   - A session ends when the model calls the `finish` tool, whose parameters are the `returns` message's schema.
     `finish` validates the payload against the schema too: a mismatch is an error the model sees and can correct.
     A valid one is recorded on the row, and `finish` asks for a look now (`probeNow`), so nothing waits out a probe
     period.
   - The probe runs every 30 s as the backstop. It settles the job `confirmed` with the recorded result; `failed`
     with `exhausted:<budget>` once a budget ran out; `failed` with `stopped` for a stop kept on the row; and `failed`
     with "ended without returning a result" once Pi has no work left for the session and no tool of it waits for a
     person.
   - The job's deadline is the actor's `wallClock` plus 10 minutes. If it passes, the job is `in_doubt` ("deadline
     passed"). A session whose job settles in doubt is then aborted by a third internal effect,
     `agent.session.abort`, after the settlement commits, so Pi doesn't keep spending on a job actord has given up on.
   - The job's result message, `agent.session.settled`, becomes the `returns` message (validated again; a mismatch is
     `agent.failed`), `agent.exhausted` or `agent.failed`, sent by the actor to itself. Each needs a self-route
     (`AGENT_SELF_ROUTE_MISSING`). The app declares `agent.failed` and `agent.exhausted` with the toolkit's exported
     schemas (`agentFailed`, `agentExhausted`), like `approval.decided`. A session a later start replaced settles with
     a note only, and so does its `finish`.
4. **actord enforces the budget (correction 2).** Pi has no budgets, and a Pi hook can't stop a run: its throw is only
   reported.
   - **`usd` and `turns`:** a watcher of the session's events (`turn_end`, `usage_changed`) marks the session
     exhausted once its turns or cost reach the limit, aborts it from outside the run, and asks for a look. A
     request's cost is known only when it ends, so the overshoot is at most two model requests: the one that crosses
     the limit, and one already in flight when the abort lands. For `turns`, that is at most one response past the
     limit (`[agent-exhausted-turns]`, `[agent-exhausted-usd]`). A turn is one model response.
   - **What `usd` counts:** the model cost pi-ai reports, not container seconds, so the factory counts container time
     itself.
   - **`wallClock`:** a timer asks for a look once it has passed, counted from the start message, and every look checks
     it.
   - The watcher and the timer are in memory. When Pi opens after a restart, every waiting session is watched again
     before Pi resumes its runs, and each look reads turns and cost again from what Pi recorded
     (`[agent-exhausted-after-restart]`).
   - Each look reports what the session spent since the last one as the job's usage, so the job's events and the
     `agent.*` messages carry it.
5. **Declared effects are tools (corrections 3 and 4).**
   - `EffectSpec` gains `input`, a Standard Schema. A tool's JSON Schema is derived from it the way the manifest
     derives message payload schemas. An effect tool without one is `AGENT_TOOL_INPUT_MISSING`. The tool's name is the
     effect's, with `.` → `_`.
   - Each call is one effect request, keyed `<session>:<callId>`. Pi gives a call the same id when it runs it again
     after a restart, so the rerun finds the request's row. A keyed effect is `replay: "safe"`: the rerun waits for
     actord's retry. Any other is `"unsafe"`: Pi tells the model it was interrupted, and actord records the attempt in
     doubt (`[agent-restart-mid-tool-unkeyed]`).
   - **Approval.** A Pi tool can't defer its result. A tool for an `approval: "human"` effect answers at once that it
     waits for a person. The result comes back later as a steer input, which the model sees as a user message
     (`Result of <effect> (request <key>): <status> …`), not as the tool's result (`[agent-tool-approval]`). The
     job's probe is the backstop: it steers in a waited request that settled with no steer yet, such as a person's
     denial, which sends no result message. An approval-gated tool effect with no `result` message is a warning,
     `AGENT_TOOL_APPROVAL_RESULT_MISSING`: the session learns its outcome from the probe, up to 30 s later.
   - Every tool effect's result message also reaches the actor's own handler for it, if it has one.
6. **Instructions are pinned per session (correction 7).** The instructions text is stored on the session row when
   the session starts, and set as that Pi session's instructions (`conversation.configure({ instructions })`). A
   deploy that changes them reaches new sessions only (`[agent-instructions-pinned]`). The Worker passes the text in
   (`options.instructions`, a wrangler Text module), and `actord check` reports an `instructions` file that doesn't
   exist next to `system.ts` (`AGENT_INSTRUCTIONS_MISSING`).
7. **The model is Workers AI, pinned by id.** `model.id` goes to the `AI` binding through the SDK's `createAI`, in a
   pi-ai registry of the actor's own. `model.reasoning` becomes the session's thinking level through `PiHarness`'s
   defaults. For DeepSeek V4.1 Flash the declared level can't be honoured: pi-ai's catalog raises `low` to
   `high`, and `createAI` takes no `reasoningEffort`. Spikes 2 and 4 ran at the model's default reasoning.
8. **A stop or a replacement withdraws the session's open approvals.** Each of the session's tool requests still
   waiting for a person (keyed `<session>:`) is denied, with "the session was stopped" or "the session was replaced".
   A later approval changes nothing, and the effect never runs. A new start withdraws the old session's approvals
   even if that session had already settled: an approval for a session that no longer exists shouldn't run.
   A tool call already on its way when its session was stopped or replaced requests nothing, and the model is told
   the session was stopped, or replaced by a new start (`[agent-tool-after-stop]`, `[agent-tool-after-replace]`).
9. **`wallClock` isn't paused while a tool waits for approval.** An approval advertises its expiry (3 days by
   default), but the session's job ends at `wallClock` plus 10 minutes. A session that waits longer than its
   `wallClock` is exhausted, the effect stays parked, and its later result is only a note
   (`[agent-exhausted-awaiting-approval]`). An app whose approvals take long needs a longer `wallClock`.
10. **Events and transcripts.** `agent.started`, `agent.turn`, `agent.tool` and `agent.ended` are recorded under the
    session job's effect and key, so `actord trace` shows a session as one node. `agent.tool` never carries a tool's
    arguments, and leaves out `finish`. `agent.ended` carries the outcome, the turns and what the session spent.
    Given a `transcripts` bucket (R2), the session's messages are written to
    `transcripts/<actor>/<key>/<session>.json` when it ends, and `agent.ended` names that object. A transcript is
    never copied into events.
11. **`scriptedModel` is a test seam.** It ships in the agents bundle and goes in `options.model` in place of Workers
    AI. It is a pi-ai provider built with `createProvider`, which reports the tokens and cost a script gives it. pi-ai's
    own `fauxProvider` replaces usage with a text-length estimate and a cost of 0, so it can't test a budget (spike 3).

## The handler-I/O hazard
A handler's transaction that spans an event-loop turn lets other writers' rows join it. Pi's storage, Computer's
vfs sync-back, Lifecycle's job rows and actord's own drain settlements all write beside a handler. If the handler
then throws, their rows roll back with it. The runtime test `[beside-transaction-nested]` pins what workerd does: a
transaction started from outside runs inside the handler's once the handler yields to the event loop. A tool's
`requestEffect` in that window is refused (`REQUESTED_IN_HANDLER`).

The hazard is older than agent actors. The owner's ruling: race each handler against a macrotask sentinel, and fail
the delivery loudly ("handlers may not await I/O; use ctx.effect"). It is tracked in #80 and lands after plan 3.
Until then, a handler must not await I/O.

## Rejected alternatives
- **The harness's completion settles the job** (spec §7.2). `PiHarness` has no completion callback.
- **Stopping a run from a Pi hook.** A hook's throw is only reported, and the run goes on.
- **Holding a tool's result until a person decides.** A Pi tool can't defer its result.
- **Rendering instructions from the deployed file at each turn.** A redeploy would change a running session.
- **Wrapping Pi's storage so its transactions queue behind actord's handler** (the first recommendation).
  `PiHarness` opens its store from `lifecycle.storage`, so there is nothing to wrap, and the hazard isn't Pi's alone.

## Consequences
- The overshoot past `usd` is at most two model requests: the one that crosses the limit, and one already in flight
  when the abort lands. Past `turns` it is one response. After a restart, sessions whose start or cancel was in flight aren't watched until
  that start runs again or the cancel settles.
- `budget.usd` is enforced only for a model pi-ai prices. The pinned model is priced. For an unpriced one the
  cost stays 0, and the budget is silently unenforced. A session's `usd` counts the model cost pi-ai reports, not
  container seconds, so the factory counts container time itself.
- `@actord/toolkit/agents` loads `@cloudflare/computer` and zod at import, so every agent app installs both, even
  without a workspace. The other entry points never load Pi or Computer: a test scans the built bundles.
- Not guaranteed: `agent.ended` is recorded once per instance, by a guard in memory, so a restart in between can
  record it twice. The transcript is written to the same object both times.
