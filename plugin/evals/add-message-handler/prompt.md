---
tags: [representative, implement]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

In this release monitor, add support for retracted releases: a feed item can now come with `retracted: true`. The ledger should mark that release retracted, and the digest writer must not send a notification for a retracted release that hasn't been notified yet. Add a test for it. When you're done, run `npx actord verify --json --out .actord/evidence.json` and report its verdict.
