---
tags: [representative, design, implement]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Connect this guestbook to our GitHub repository: whenever someone opens an issue there, sign the guestbook for the issue's author, using their GitHub login as the name. GitHub will POST its webhooks to this Worker at `/webhooks/github`, signed with a secret we'll keep in `GITHUB_WEBHOOK_SECRET`. Refuse any request that isn't signed with that secret, and don't sign the guestbook twice when GitHub redelivers the same webhook. Add tests for both. When you're done, run `npx actord verify --json --out .actord/evidence.json` and report its verdict.
