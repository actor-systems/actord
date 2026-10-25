---
name: evolve
description: Use when someone asks to deploy, ship, or release an actor system on Cloudflare Durable Objects, or to change a running one (add, remove, or revise actors, messages, routes, effects, schedules). Produces the semantic diff, compatibility risks, passing tests, and the deploy plan a person runs, never a deploy. Starts from `actors diff`; has both critics review a change.
allowed-tools: Bash(npx --no-install actors diff *) Bash(actors diff *) Bash(actors check *) Bash(actors graph *) Bash(actors test *) Bash(actors verify *)
---

# Evolve a running actor system

Rules that hold for this whole skill:
- **Produce a deploy plan, never a deploy.** Don't run `wrangler deploy`, `wrangler versions …`, secrets, or
  remote writes. If asked to deploy, show the plan and say a person runs it after approval. The project's
  permission rules (and the Room's guard, where it's active) will ask anyway.
- **Never imply a deploy can be undone automatically.** Deleting an actor class destroys its data; a
  rollback can't cross a Durable Object lifecycle change.
- Flag every change that is breaking, needs approval, or is irreversible, as `actors diff` classifies it.
- Keep in-flight messages in mind: anything already queued must still be accepted after the deploy.

## Changes since the last commit

!`actors diff --json --exit-zero || npx --no-install actors diff --json --exit-zero || true`

## Steps

1. **State the change** and what must keep working (running schedules, queued messages, stored state).
2. **Change the declaration first** (`system.ts`, `src/messages/`). Prefer additive changes: new optional
   fields, new messages, new routes. For an incompatible payload change, bump the message version and
   accept both shapes until queues drain.
3. **Ask the critics:** `boundary-critic` for new or removed actors and routes, and `delivery-auditor` for
   changed handlers and effects. Resolve each objection with code or a test.
4. **Implement and test:** follow `/actors:implement`, and add tests for the new behavior and for what must
   not break. Run `actors test`. `actors check` reports the manifest as stale until step 5; that's expected.
5. **Classify, then record:** run `actors diff` first. It compares against the manifest committed at `HEAD`,
   or, where git isn't usable, against `actors.manifest.json` on disk, which the next command overwrites.
   Then run `actors graph --write` and `actors verify`. Read `references/compatibility.md` for what each
   class means on Cloudflare.

## Output (done when shown)

- The **semantic diff**: each change with its class (compatible, breaking, or risky), approval required,
  irreversible.
- **Compatibility analysis:** in-flight messages, stored data, schedules, and external effects.
- **Tests and verify verdict:** what was run, with the real result.
- The **deploy plan** from `actors diff`: config steps, drains, approvals, then "a person runs
  `npx wrangler deploy`". State plainly that nothing was deployed.
