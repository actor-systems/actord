---
tags: [representative, implement]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Once the guestbook records a greeting, it should send the guest a thank-you note through our mail service. Stub the mail service for now (log instead of sending); the real API comes later. The service has outages that last a few minutes, so when a note fails to send, try it again 10 minutes later, at most 3 tries in all, and then record that the note wasn't sent. Add a test that proves a failed note is tried again after the delay. When you're done, run `npx actord verify --json --out .actord/evidence.json` and report its verdict.
