---
name: setup-actor-project
description: Scaffold and verify a new Cloudflare Durable Objects actor project with the shared actord, or explicitly adopt an existing project.
---

1. Run `actord doctor --json`. The plugin bundles its CLI: if `actord` is absent from PATH, use `node <plugin-root>/bin/actord.js` for every command. Node >=22.18 and npm are required; no provider credentials are needed.
2. Choose a new or empty directory. Run `actord init <directory> --json` for the two-actor starter, or add `--template release-radar` or `--template briefing-desk` for a reference application. For an existing project use `actord init --adopt --host codex` only within the user's requested scope; it preserves existing guidance.
3. In the new project, run `npm install`, `npx actord graph --write`, and `npx actord verify --json`. Installation needs the npm registry. The generated project pins the shared `@actord/toolkit` tarball and carries `AGENTS.md`, `.agents/skills/verify/SKILL.md`, and reliability claims.
4. Read `.actord/evidence.json`; resolve failures and report the real verdict, claims, and commands. A blocked workerd check establishes no pass. Explain `system.ts`, native actor classes, message contracts, tests, manifest, and local events. Return one next development step.

Use the [shared API and evidence conventions](references/workflow.md) when needed. Completion requires executed checks and inspectable outputs; report blocked commands precisely. Routes are cooperative correctness contracts, while native bindings retain authority. The user's instructions take precedence. Deployment and real external writes require authorization.
