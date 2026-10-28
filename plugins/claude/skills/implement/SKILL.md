---
name: implement
description: Write or change actor code to match system.ts (message contracts, handlers, state, schedules, effects, model calls) in a Cloudflare Durable Objects actor project, starting from the current `actord check` output. Has the delivery-auditor review handlers that cause effects.
paths: ["system.ts", "src/actors/**", "src/messages/**"]
allowed-tools: Bash(npx --no-install actord check *) Bash(actord check *) Bash(actord graph *) Bash(actord test *)
---

# Implement actor behavior

Rules that hold for this whole skill:
- **Keep what already works.** Preserve existing public read methods and their return shapes. Keep
  existing tests, and add a focused test that proves the requested change. An incompatible contract change
  follows `/actord:evolve`: a version bump alone refuses every queued copy.
- **Run the tests before reporting.** Run the affected workerd tests. If the host blocks them, report the
  change as unverified and give the exact command to run on the host.
- **Change the declaration first.** Edit `system.ts`, then let the compiler and `actord check` show every
  handler and send that no longer fits.
- **Handlers may not await I/O.** Each handler runs inside one storage transaction, so its writes, sends, timers
  and effect requests commit together. A `fetch`, a model or container call, a timer (`setTimeout(0)` included), or
  any other await that yields to the event loop fails the delivery with `handlers may not await I/O; use ctx.effect`,
  rolls the transaction back, and fails again on every retry. Request the work with `ctx.effect(name, input, { key })`
  and handle the declared `result` message. Only microtasks and the storage calls `references/runtime.md` lists
  may be awaited.
- **Assume every message can arrive twice.** Make writes idempotent: key rows by business id, upsert, and
  use generation counters to drop stale results.
- **Effects:** use an idempotency key when the destination honors one. Otherwise declare
  `idempotency: "none"` and handle `in_doubt`. Never mark an unacknowledged effect as done.
- **New capabilities are declared, never smuggled in.** Posting to a webhook, sending mail, or calling an
  API becomes an effect in `system.ts` (with its idempotency) that the actor requests with `ctx.effect`. Never
  call the network from a handler. The user's explicit request approves declaring it; if nobody asked, ask.
- **Model output is untrusted input.** Validate it with a schema before acting, bound it with the actor's
  `budget`, and route failures to a person.
- Never deploy, and never add deploy commands to scripts.

## Current state

!`actord check --json --exit-zero || npx --no-install actord check --json --exit-zero || true`

## Steps

1. Read the diagnostics above. Fix every `error` before adding anything.
2. Update `system.ts` and `src/messages/` for the change: new messages start at version 1, and a changed
   contract stays backward compatible (`actord diff` checks), or follow `/actord:evolve`.
3. Implement handlers with `actorRuntime(...)` (API: `references/runtime.md`). The class installs
   `Lifecycle.install(this)` and keeps a public `receive(envelope)`; Lifecycle owns the alarm, so it defines no
   `alarm()`. Add the binding and `exports` entry to `wrangler.jsonc`, and export the class from the Worker entry.
   Read the reference for what the change touches:
   - a timer, a schedule, a job effect, or an approval that expires: `references/timers-and-jobs.md`;
   - a webhook, inbound email, or approval by email reply: `references/sources.md`;
   - an actor declared `kind: "agent"`, or a workspace: `references/agents.md`;
   - a decision or an extraction (Clef, Clairic), or the scorecard: `references/decisions.md`.
4. For every handler that requests an effect or calls a model, launch the `delivery-auditor` subagent on
   those files and resolve its findings, by changing code or by adding the fault test it proposes.
5. Write tests in workerd (`references/runtime.md`, Testing). Tag each with the claim it establishes,
   such as `[duplicate-delivery]`, and add or update the claim in `actord.claims.json`. Assert that each
   receipt a test relies on is `handled`, and override every effect a test asserts on, a new one included.
6. Run `actord check`, `actord graph --write`, and `actord test`, and fix what fails.

Done when: the code builds; valid messages reach only declared handlers; malformed or unauthorized messages
fail with a clear `rejected` reason (tested); `actord check` and the tests pass.

Stop and ask before removing an actor that has stored data, or when a change relies on an external system's
guarantee you can't verify.
