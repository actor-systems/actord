---
name: setup
description: Scaffold a new actor system on Cloudflare Durable Objects with `actord init` (typed system.ts, native actors, workerd tests, a project verify skill, permission rules), then install, typecheck, and pass the first test. Use when starting a new actor project. Writes only to an empty directory unless the user confirms.
allowed-tools: Bash(actord init *) Bash(actord doctor *) Bash(actord graph *) Bash(actord check *) Bash(actord verify *)
---

# Set up an actor project

Rules that hold for this whole skill:
- Write only into an empty or new directory. For an existing project, ask first, then use
  `actord init --adopt`: it adds only missing files and never changes existing `.claude/` files.
- Never sign in to Cloudflare, create account resources, or deploy. Local work needs no credentials.
- Report each step's real outcome. If `npm install` fails (for example, offline), stop and say so.

## Steps

1. **Check the environment:** `actord doctor`. Fix `error` findings first (Node.js 22.19+ is required).
2. **Pick the directory.** Confirm it's empty or new; otherwise ask, and offer `--adopt`.
3. **Scaffold:** `actord init <dir> --name <name>`. The starter is a complete two-actor system (Greeter →
   Guestbook) with tests, `actord.claims.json`, `.claude/skills/verify/SKILL.md`, `.claude/settings.json`
   (`ask` rules for deploy, secret, and remote-write commands), and a short `CLAUDE.md`. Until
   @actord/toolkit is on npm, init vendors the plugin's copy into `vendor/` and pins it.
4. **Install:** `npm install` in the new directory. It needs the npm registry, so tell the user it uses the
   network. The pin means CI and Claude run the same toolkit version.
5. **Derive the manifest:** `actord graph --write`, then commit `actord.manifest.json` with the rest.
6. **Verify:** `actord verify` (also `npm run verify`). Expect `PASS`: typecheck, `actord check`, and three
   workerd tests. `BLOCKED` means a sandbox denied local port binding: say so, and point to the sandbox's
   `network.allowLocalBinding` setting as the user's decision.
7. **Explain the layout** in a few lines: `system.ts` (the declaration), `src/actors/`, `src/messages/`,
   `tests/`, `actord.manifest.json` (derived), `.actord/` (local evidence, ignored by git).

Done when: install, typecheck, check, and the first tests pass; the verify skill and permission rules exist
(`actord doctor` shows both as ok). Then offer one next step: `/actord:design` to shape the real topology.

Tooling: the project uses Wrangler (`wrangler.jsonc`, `wrangler types`, `wrangler dev`). Cloudflare's
`wrangler` and `durable-objects` skills cover the platform. A deploy is always a person's decision.
