# 0011 — Payload compatibility: "compatible" is a proof, and the plan drains what isn't

- **Date:** 2026-10-25 · **Gate:** G2 · **Status:** accepted · **Reversibility:** easy

## Context
A review of `actord diff` (from the Codex implementation of the same charter) found two unsafe answers in
`comparePayload`: removing a field from a strict object (`z.strictObject`, `additionalProperties: false`)
was "compatible", though the new schema refuses every old copy carrying the field; and limiting a free
string to an enum was "compatible", because a missing old enum read as an empty one. Both are confirmed
by tests. An audit of the same function found more: `.nullable()` read as breaking, lifting an enum read
as narrowing, a strict object made loose went unclassified, and array items weren't compared. The deploy
plan drained only "breaking" changes, so a version bump (which refuses every queued old copy, since a
receiver accepts one version) and an undecided payload change got no drain step. The evolve skill also
advised bumping the version "to accept both shapes", which the runtime can't do.

Codex's comparator classifies every same-version schema change as breaking. That's safe, but it makes
the commonest evolution (a new optional field) a drain, and its advice (keep the old version beside the
new) relies on multi-version routes this runtime doesn't have.

## Decision
1. `comparePayload` answers one question: does the new schema accept every payload the old one did?
   "compatible" only where that holds by construction; "breaking" where a class of old payloads is
   refused; "risky" for whatever it can't decide (unions, changed patterns), never "compatible".
2. One stated assumption: where an old object schema is silent on undeclared properties (`z.object`,
   which strips them), senders didn't send any. So a new optional field there is compatible, and making
   such an object strict is risky, not compatible.
3. The plan drains every message or route change that isn't compatible, including version bumps and
   risky payload changes, and names the alternatives that avoid a drain: accept the old shape too, or add
   a new message beside the old one and retire it in a later deploy.

## Evidence
`packages/toolkit/test/diff.test.ts`: 35 classification cases (both review cases among them) and the drain
rules; 26 of them failed on the previous comparator.
