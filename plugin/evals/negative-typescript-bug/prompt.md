---
tags: [negative]
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

src/range.ts has an off-by-one bug: range(1, 3) should return [1, 2, 3]. Fix it.
