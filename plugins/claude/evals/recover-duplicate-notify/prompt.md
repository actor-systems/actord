---
tags: [representative, reliability]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

The owner reports getting the same release notification twice after a feed was polled again. Find the cause, fix it, and prove the fix with a fault test. When you're done, run `npx actord verify --json --out .actord/evidence.json` and report its verdict.
