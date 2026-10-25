---
name: verify
description: Run this actor project's evidence workflow (typecheck, actors check, workerd tests, reliability claims) before committing or before reporting work as done.
allowed-tools: Bash(npm run verify) Bash(npx actors verify *)
---

# Verify

1. Run `npm run verify`. It runs `actors verify`, which writes `.actors/evidence.json`.
2. Report the verdict exactly: `pass`, `fail`, or `blocked`, with each failing step and claim.
   `blocked` means a check couldn't run (for example, the sandbox denies the local port workerd needs).
   It is not a pass.
3. Don't commit or call the work done while the verdict is `fail`. Fix the cause, or say plainly what
   is still failing.

Evidence comes from the commands above, not from reading the code. Deploying is never part of
verification; it needs a person's approval.
