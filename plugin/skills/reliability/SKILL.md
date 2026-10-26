---
name: reliability
description: Establish what an actor system on Cloudflare Durable Objects actually guarantees, and fix it where it falls short. Use when a message, notification, or effect happens twice, goes missing, or gets stuck (after a retry, crash, restart, or repeated poll), to find the cause, fix it, and prove the fix with a fault test; or when asked what the system guarantees. Writes and runs workerd fault tests (duplicates, crashes before and after writes, retries, restarts, reentrancy at await points, lost acknowledgments), then classifies each claim as proved locally, stub only, or not guaranteed. Has the delivery-auditor review handlers.
allowed-tools: Bash(actord test *) Bash(actord verify *) Bash(actord events *) Bash(actord trace *) Bash(actord check *)
---

# Verify reliability

Rules that hold for this whole skill:
- **Evidence is a passing test in workerd**, recorded by `actord verify` in `.actord/evidence.json`. An
  explanation, a review, or a critic's opinion is not evidence.
- **Never claim exactly-once external effects**, unrestricted sandboxing of generated code, global ordering,
  or cross-actor transactions. If asked to promise exactly-once, decline. Explain what the system does
  instead: at-least-once delivery, receivers that deduplicate by message id, idempotency keys where the
  destination honors them, and `in_doubt` outcomes where it doesn't.
- A claim proved only against a test double of an external system is **stub only**, never "proved".
- `blocked` (for example, a sandbox denying local port binding) is not a pass. Say what blocked it.

## Steps

**For a reported failure** (something happened twice, never happened, or is stuck), start here, then go on
to step 1 for the faults around it:
- Write the fault test that reproduces it, named with its claim tag, and keep the existing tests as they
  are.
- Find the cause in the handlers and in `actord events --notable` / `actord trace <id>`. A repeated poll or
  an outside retry carries the same business event under a new message id, so dedupe and effect keys
  must name the event (the item, the order), not the message.
- Fix it, then run the tests and `actord verify`. Report what the tests showed, or that they couldn't
  run and why.

1. **Read the claims:** `actord.claims.json` (create it if missing). Each claim has an `id`, a `statement`,
   a `basis` (`workerd`, `stub`, or `not-guaranteed`), tagged `tests`, and for not-guaranteed claims a `why`.
2. **Have the auditor look:** launch the `delivery-auditor` subagent on the handlers and effect adapters.
   Turn each finding into a fault test or a code fix, never into an unverified claim.
3. **Cover the fault matrix** (`references/fault-matrix.md`): a duplicate inbound message; a rejected or
   malformed message; delayed or out-of-order delivery; a crash before and after a durable write; a
   delivery retry; a scheduled wake and a restart; simultaneous messages around an external await; an
   unavailable model or tool; gateway acceptance followed by a lost acknowledgment; a denied capability.
   Skip only what the system can't exhibit, and say why.
4. **Run them:** `actord test --profile ${user_config.fault_profile}`, then `actord verify`. The profile is
   the plugin's `fault_profile` option: `standard` unless it was set to `extended`. Where the option was
   never saved, the line above shows its placeholder; use `standard`.
5. **When something fails,** find out why with `actord events --notable` and `actord trace <id>`.

## Report (done when shown)

A table of every claim with its status from `.actord/evidence.json`: **proved locally**, **stub only**,
**not guaranteed** (with why), **blocked** (with why), **failing**, or **untested**. List the tests behind each
proved claim, and end with the verdict exactly as `actord verify` gave it.
