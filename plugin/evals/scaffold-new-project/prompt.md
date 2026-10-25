---
tags: [representative, setup]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Create a new actor system project for a small guestbook service in the current directory, using the actord toolkit. Dependencies are already installed in node_modules and there is no network access, so don't run npm install. Make sure it typechecks and passes its checks. When you're done, run `npx actord verify --json --out .actord/evidence.json` and report its verdict.
