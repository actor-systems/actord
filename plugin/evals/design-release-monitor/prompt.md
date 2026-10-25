---
tags: [representative, design]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

Design a release-monitoring system that polls a few feeds, stores what it has seen, asks a second actor to classify significant changes, and notifies me only about new findings. This directory is a starter actor project: replace its declaration (system.ts and the message contracts) with your design. Implementation can come later. Explain which actors you kept and which you rejected, and why. Run `npx actors check` at the end and report what it says.
