# 0018 — Job effects: start with a handle, settle once, later

- **Date:** 2026-10-25 · **Gate:** plan 1 (the Lifecycle foundation) · **Status:** accepted · **Reversibility:**
  easy (a new, optional effect kind; call effects are unchanged)

## Context
An effect today is a call: `run(input)` is one request, answered within the effect's timeout (30 s by default).
The factory's work doesn't fit that. An agent session, a GitHub Actions run or a deferred model response runs
for minutes or hours, longer than any request and longer than a 15-minute alarm invocation. Holding an
attempt open for it is impossible, and polling from a handler would hold the input gate. The work needs to be
started quickly, remembered durably, and settled later, by whichever of several signals arrives first.

## Decisions
1. **A job is an effect with `kind: "job"`.** It keeps everything an effect has: the outbox row, the key, the
   idempotency rules, the budget, usage, approval, and the `result` message. Its adapter (`JobAdapter`) has
   `start(input)`, which returns a JSON handle quickly, and optionally `probe(handle)` and `cancel(handle)`.
2. **The row's lifecycle:** `pending → running` (start) → `awaiting_job`, with `body.handle` and
   `body.deadlineAt` stored, then settled once as `confirmed`, `failed` or `in_doubt`. A start that fails
   follows the call rules: retried with an idempotency key, in doubt without one.
3. **Four ways to settle, one result path.** Each records `body.settledBy` and goes through the same
   `finishEffect` → `enqueueResult` path as a call, so the actor receives exactly one result message with the
   usual payload (`key`, `status`, `value` or `error`, `usage`):
   - **its completion message:** the handler of the message named by `completes: { message }` calls
     `ctx.settleJob(effect, key, outcome)`, inside that message's transaction;
   - **its probe:** `probe: { every }` books a look every period; `probe(handle)` runs in the background, like
     an effect attempt, bounded by the effect's timeout, and `done` settles the job;
   - **its deadline:** `deadline` is required; once it passes, the job is `in_doubt` with "deadline passed";
   - **a cancel:** `ctx.cancelJob(effect, key)` marks the row `cancelling` in the transaction, and after commit
     the runtime calls `cancel(handle)`. Only a confirmed cancel (`true`) settles it `failed` ("cancelled");
     `false`, a throw, a timeout or no `cancel` settles it `in_doubt` ("cancel not confirmed"), because the work
     may still finish.
4. **Settling is explicit: `ctx.settleJob`, not a declarative matcher** (refined while planning). A matching
   function in `system.ts` (from a completion payload to the job's key and outcome) would make the declaration
   impossible to serialize into the manifest, so `check`, `diff` and the graph couldn't see it. The handler does
   that matching in ordinary code; `completes: { message }` only names the message, so `actord check` can
   require a route that delivers it to every actor that requests the job (`JOB_COMPLETES_ROUTE_MISSING`).
5. **`settleJob` and `cancelJob` act only on a waiting job.** Anything else (already settled, past its
   deadline, being cancelled, not yet started) returns `false` and changes nothing. A completion that arrives
   late is therefore visible to the handler and never produces a second result.
6. **A waiting job has nothing in flight, so it isn't an orphan.** A restart neither starts it again nor loses
   it. A probe in flight when the instance stops is simply tried again at the next booked look, since its
   next look is booked before it runs. A `cancelling` row found at startup asks for the cancel again.
7. **One wake.** A waiting job's `next_at` is the nearer of its next probe and its deadline, and
   `earliestWake()` includes it, so the one `"actord"` Lifecycle job (decision 0016) wakes for it.
8. **Checks.** `JOB_DEADLINE_MISSING` (error: no deadline, or one that isn't a duration), `JOB_UNOBSERVABLE`
   (warning: neither `probe` nor `completes`, so every run ends in doubt) and `JOB_COMPLETES_ROUTE_MISSING`
   (error). The manifest's effects carry `kind`, `deadline`, `probe` and `completes`.

## Outcomes
| What happened | Outcome | `settledBy` |
| --- | --- | --- |
| The completion message's handler settled it | as reported (`confirmed` or `failed`) | `message` |
| A probe reported done | as reported | `probe` |
| The deadline passed first | `in_doubt`, "deadline passed" | `deadline` |
| A cancel was confirmed | `failed`, "cancelled" | `cancel` |
| A cancel wasn't confirmed (false, a throw, a timeout, no `cancel`) | `in_doubt`, "cancel not confirmed" | `cancel` |
| `start` failed | the call rules: retried with a key, else `in_doubt` | none |

## Rejected alternatives
- **A declarative matcher on the effect** (`completes: { message, match: (payload) => ... }`). It isn't
  serializable, as above.
- **Holding the attempt open**, with a long timeout. An attempt can't outlive the instance or the alarm
  invocation, and a restart would make every long job an orphan.
- **A separate jobs table.** The outbox row already carries the key, the budget, usage and the result path; a
  second table would need a second copy of each.

## Consequences
- `trace` shows a job's handle and what settled it (`job <handle> settled by <how>`).
- `@actord/toolkit/testing` gains `expireJobs()`, and `settle()` also waits for probes and cancels in flight.
  `settle()` doesn't make probes or deadlines due: a test does that itself, or calls `expireJobs()`.
- Not guaranteed: a completion message that arrives before `start` has returned finds the job not yet waiting,
  so `settleJob` returns `false`; the probe or the deadline settles it instead. Usage a probe reports after its
  job has settled is dropped.
