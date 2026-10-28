---
name: design
description: Turn an application idea into a minimal actor topology on Cloudflare Durable Objects. Decide what deserves to be an actor rather than a function, Workflow, or Queue, then write the typed system.ts declaration. Has the boundary-critic subagent challenge every proposed actor. Use when designing or redesigning an actor system.
allowed-tools: Bash(actord check *) Bash(actord graph *)
---

# Design an actor system

Rules that hold for this whole skill:
- **Fewer actors.** An entity becomes an actor only if at least one of these holds: distinct persistent
  **identity**, **state** ownership, independent **lifecycle**, concurrency or failure **isolation**,
  **scheduling**, or **permissions**. Everything else is a function, an effect, a source, a schedule or timer on an
  actor that already exists, or a Cloudflare primitive.
- **Programs before agents.** Use a model only where interpretation or judgment is needed, and take the first of
  these that does the job:
  1. a **decision or extraction effect** on a `deterministic` actor, when the answer is a fixed choice, a yes or no,
     a score, or typed facts from text (Clef, Clairic). No new actor, and each confirmed answer is
     recorded for `actord scorecard`;
  2. a **`model-assisted`** actor, when the output is free-form but the steps are fixed: its handlers request a
     model effect and validate what comes back, bounded by `budget: { maxAttempts, timeoutMs }`;
  3. an **`agent`** actor, only when the model must choose its own steps (edit files, run commands, try again): a
     Pi session bounded by `budget: { usd, turns, wallClock }`.
- **The compiler and tests decide.** A critic's objection is a hypothesis until a check or test settles it.
- Write no code beyond `system.ts` and `src/messages/`; implementation is `/actord:implement`.
- Never promise exactly-once external effects, global ordering, or cross-actor transactions.

## Steps

1. **Restate the intent** in two sentences. List the nouns that might hold state or act on their own.
2. **Test each candidate** against the six justifications. Write down the ones that hold. A candidate with
   none is rejected: say what it becomes instead (see `references/boundaries.md`).
3. **Draft the topology:**
   - **actors:** binding, kind, purpose, justification, schedules, effects, and budget;
   - **messages:** `noun.verb` names, version 1, payload schemas;
   - **routes:** `from`, `message`, `to`. A sender is an actor, or one of `@ingress` (the Worker's own code, through
     `ingress(...)`), `@clock` (a schedule's tick), `@timer` (a timer the actor set for itself) and `@<source>` (a
     webhook or inbound email declared under `sources`);
   - **effects:** `kind` (`call`; `job` for outside work that runs minutes or hours; `decision`; `extraction`),
     `idempotency: "key" | "none"`, `reconcile`, `approval` and `expires`, `publishes`, an optional `result`
     message, and a `budget` of its own when the actor's doesn't fit.

   Anything slow or external is an effect, never an `await` inside a handler: handlers may not await I/O.
4. **Justify each model use.** For every decision, extraction, `model-assisted` actor and `agent` actor, say why
   the lighter choice before it wouldn't do.
5. **Ask the boundary critic.** Launch the `boundary-critic` subagent with the draft (actors, routes, effects,
   justifications) and the intent. It argues for fewer actors, and for effects in place of agents.
6. **Resolve every objection:** merge or drop the actor, or keep it and name the check or test that would
   prove the critic wrong. Record both sides.
7. **Write the declaration** with `@actord/toolkit/system`: `system.ts` plus `src/messages/index.ts`. The cheat
   sheet is `references/declaration.md`. Checked declarations of each feature are in the implement skill's
   references: timers, schedules and jobs in `../implement/references/timers-and-jobs.md`, sources and approvals
   in `../implement/references/sources.md`, agents in `../implement/references/agents.md`, and decisions in
   `../implement/references/decisions.md`. If the project doesn't exist yet, run `/actord:setup` first.
8. **Check it:** `actord check` (fix every error), then `actord graph --write`.

## Output (the design is done when all of this is shown)

- The typed declaration (files written) and `actord graph` output.
- A route map: who sends what to whom, and why each message is asynchronous or a request/reply.
- **Model use:** each decision, extraction, model-assisted and agent actor, with why the lighter choice wouldn't do.
- **Assumptions** that could be wrong, such as volumes, latency, or what an external API guarantees.
- **Rejected actors**, each with the justification it failed and what it became.
- **Critic objections**, each with its resolution and the check or test that settles it.

Stop and ask the user when the intent leaves a consequential choice open: what an external system
guarantees, who approves outbound effects, how much a model or agent may spend, or data that must never be lost.

Platform detail (Durable Object limits, Workflows, Queues, D1, R2, KV) lives in Cloudflare's own skills
(`durable-objects`, `workers-best-practices`, `agents-sdk`) and docs. This skill only adds the actor
conventions.
