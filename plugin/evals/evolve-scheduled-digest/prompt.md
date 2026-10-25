---
tags: [representative, evolve]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Add a scheduled daily digest to this release monitor without breaking the running monitor: once a day, summarize the day's findings and send them to the owner. Don't deploy anything. Tell me what changed, what could break, and how it should be deployed. When you're done, run `npx actord verify --json --out .actord/evidence.json` and report its verdict.
