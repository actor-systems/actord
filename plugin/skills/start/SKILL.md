---
name: start
description: Orient a developer to the actors toolkit (Actor-Native Cloudflare Toolkit), run `actors doctor`, and point to the reference apps. Use when someone asks how to get started with actors, what this plugin does, or invokes /actors:start. Writes no files.
allowed-tools: Bash(npx --no-install actors doctor *) Bash(actors doctor *) Bash(actors --version)
---

# Start with the actors toolkit

Rules that hold for this whole skill:
- Write no files and run nothing that deploys, signs in, or touches a Cloudflare account.
- Report the doctor output as it is. Don't call the environment ready while an `error` finding remains.
- End with exactly one concrete next step.

## Current environment

!`actors doctor --exit-zero || npx --no-install actors doctor --exit-zero || true`

## What to tell the developer

1. **What the toolkit is.** One typed declaration (`system.ts`) lists the actors (native Durable Objects),
   the messages they exchange, and the allowed routes. The `actors` CLI checks the declaration against
   the code, graphs it, diffs it, and reads the structured event log that tests write. Tests run in
   workerd, Cloudflare's real runtime. Claude proposes; the checks and tests decide.
2. **What the doctor found.** Go through each `error` and `warn` finding and give its `fix:` line. If the
   doctor output is missing because `actors` isn't on PATH, say the plugin isn't enabled in this session
   and suggest `/plugin` to enable it.
3. **Where to look.** Two reference apps show the conventions end to end:
   - `examples/release-radar`: deterministic actors with scheduling, duplicate input, and a causal trace.
   - `examples/briefing-desk`: an agent actor with a model adapter, approval gateway, and in-doubt effects.
4. **What to do next.** Offer one step that fits the doctor result:
   - not in a project → `/actors:setup` to scaffold one, or `/actors:design` to start from an idea;
   - in a project with warnings → the first fix the doctor gave;
   - in a healthy project → `actors graph` to see the topology, then `/actors:evolve` for a change.

The other skills: `setup` (scaffold), `design` (topology with a boundary critic), `implement`
(messages and handlers), `reliability` (fault tests), `inspect` (why did this happen), `evolve` (safe
changes with a semantic diff and a deploy plan, never a deploy). Platform detail beyond actor
conventions lives in Cloudflare's own skills (`durable-objects`, `wrangler`, `agents-sdk`).
