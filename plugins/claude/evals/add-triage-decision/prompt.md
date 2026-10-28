---
tags: [representative, design]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

We want to try Cloudflare's Clef Flash model for deciding whether a guestbook greeting is spam, without letting it change anything yet: ask it about every greeting and record its answer, but don't act on that answer. Later a moderator will tell us which greetings really were spam, and those labels should be recorded against the model's answers, so that `npx actord scorecard` can say how well it does. Add a test for it. Our tests run without Cloudflare credentials and must never call the real model: in your test, replace the decision effect with a stub through `overrideEffect` from `@actord/toolkit/testing`, and set `remoteBindings: false` in `vitest.config.ts` so that no test opens a remote Workers AI session. When you're done, run `npx actord verify --json --out .actord/evidence.json`, report its verdict, and say in a sentence or two how a moderator's label is recorded against the model's answer.
