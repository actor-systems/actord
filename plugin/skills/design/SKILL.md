---
name: design
description: Turn an application idea into a minimal actor topology on Cloudflare Durable Objects. Decide what deserves to be an actor rather than a function, Workflow, or Queue, then write the typed system.ts declaration. Has the boundary-critic subagent challenge every proposed actor. Use when designing or redesigning an actor system.
allowed-tools: Bash(actors check *) Bash(actors graph *)
---

# Design an actor system

Rules that hold for this whole skill:
- **Fewer actors.** An entity becomes an actor only if at least one of these holds: distinct persistent
  **identity**, **state** ownership, independent **lifecycle**, concurrency or failure **isolation**,
  **scheduling**, or **permissions**. Everything else is a function, a module, or a Cloudflare primitive.
- **Programs before agents.** Use a model only where interpretation or judgment is needed. Mark such actors
  `model-assisted` (fixed control flow calling a model) or `agent`, and give them a `budget`.
- **The compiler and tests decide.** A critic's objection is a hypothesis until a check or test settles it.
- Write no code beyond `system.ts` and `src/messages/`; implementation is `/actors:implement`.
- Never promise exactly-once external effects, global ordering, or cross-actor transactions.

## Steps

1. **Restate the intent** in two sentences. List the nouns that might hold state or act on their own.
2. **Test each candidate** against the six justifications. Write down the ones that hold. A candidate with
   none is rejected: say what it becomes instead (see `references/boundaries.md`).
3. **Draft the topology:** actors (binding, kind, purpose, justification, schedule, effects, budget),
   messages (`noun.verb` names, version 1, payload schemas), routes (`from`, `message`, `to`; senders can be
   `@ingress` or `@clock`), and effects (`idempotency: "key" | "none"`, `reconcile`, `approval`, optional
   `result` message). Anything slow or external is an effect, never an `await` inside a handler.
4. **Ask the boundary critic.** Launch the `boundary-critic` subagent with the draft (actors, routes,
   justifications) and the intent. It argues for fewer actors.
5. **Resolve every objection:** merge or drop the actor, or keep it and name the check or test that would
   prove the critic wrong. Record both sides.
6. **Write the declaration** with `actors-toolkit/system` (cheat sheet: `references/declaration.md`):
   `system.ts` plus `src/messages/index.ts`. If the project doesn't exist yet, run `/actors:setup` first.
7. **Check it:** `actors check` (fix every error), then `actors graph --write`.

## Output (the design is done when all of this is shown)

- The typed declaration (files written) and `actors graph` output.
- A route map: who sends what to whom, and why each message is asynchronous or a request/reply.
- **Assumptions** that could be wrong, such as volumes, latency, or what an external API guarantees.
- **Rejected actors**, each with the justification it failed and what it became.
- **Critic objections**, each with its resolution and the check or test that settles it.

Stop and ask the user when the intent leaves a consequential choice open: what an external system
guarantees, who approves outbound effects, or data that must never be lost.

Platform detail (Durable Object limits, Workflows, Queues, D1, R2, KV) lives in Cloudflare's own skills
(`durable-objects`, `workers-best-practices`, `agents-sdk`) and docs. This skill only adds the actor
conventions.
