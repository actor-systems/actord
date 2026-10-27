# 0016 — actord on Lifecycle: one capability, one job, the object's one alarm

- **Date:** 2026-10-25 · **Gate:** plan 1 (the Lifecycle foundation) · **Status:** accepted · **Reversibility:**
  moderate (actor classes and the `actorRuntime` host change shape; the guarantees and tables don't)

## Context
A Durable Object has one alarm. Until now `actorRuntime` owned it: it called `ctx.storage.setAlarm()` and the
class forwarded `alarm()`. The factory's agent actors need capabilities from the Agents SDK, such as harnesses,
that are built on its `Lifecycle` (`agents/lifecycle`, stable in `agents@0.30.1`). `Lifecycle` owns the
object's alarm and multiplexes it over a durable job queue (`cf_agents_jobs`). Two owners of one alarm
overwrite each other's wakes, so actord has to become one of `Lifecycle`'s capabilities.

## Verified platform behavior (agents@0.30.1 source; `packages/toolkit/test-runtime`)
- `Lifecycle.install(this)` in a field initializer installs `fetch`, `alarm` and the WebSocket handlers,
  skipping any the class defines itself. `use(capability)` must run before startup.
- A job is `{ id, fn, time }` owned by one capability. Every queue change re-arms the physical alarm from the
  earliest job; a change made during startup defers that until startup ends.
- A same-id `push` made while that job is dispatching supersedes the dispatch's result, so a job that
  re-arms itself from `onJob` isn't deleted when `onJob` returns.
- Native RPC bypasses startup; `lifecycle.ready()` runs it. Startup requires `ctx.id.name`, so an instance
  reached only through an id without a name (for example one from `listDurableObjectIds` after a restart)
  can't start.
- `agents/lifecycle` imports `cloudflare:workers` for its side effects, so Node can't load it as is.

## Decisions
1. **actord is a `LifecycleCapability` with the id `"actord"`** (`runtime/capability.ts`). `actorRuntime`
   takes `{ lifecycle, ctx, env }` and registers it with `lifecycle.use()`.
2. **actord keeps one job, `{ id: "actord", fn: "drive" }`.** Its rows stay in actord's own tables. One
   function, `earliestWake()`, takes the minimum over every source of a wake (pending outbox rows and the
   schedule), and one method, `arm(when)`, points the job there, or cancels it when nothing is due.
3. **`onStart` recovers orphaned effects, arms the schedule and arms the job; `onJob` runs `drive()`**, the
   old `alarm()` body: the schedule's tick, inbox retention, then the outbox.
   - *Amended (2026-10-27, #45 and #41):* `onJob` hands `drive()` to Lifecycle as tracked alarm work
     (`trackAlarmWork`) and returns at once with `{ rescheduleAt: now + 30 s }`.
   - Before this, `drive()` awaited each schedule tick, each due timer and each outbox delivery, including
     deliveries to other actors. The shared alarm's dispatch waited for it, so a slow receiver delayed every
     other capability's job on the object.
   - Lifecycle applies the backstop outcome only if the job wasn't pushed or cancelled during the dispatch.
     `drive()` ends by re-arming through `arm()`, so its own wake wins, and the backstop remains only when a drive
     fails or is lost with its isolate.
   - `drive()` is single-flight: a call that arrives mid-drive shares the running drive, which then makes one
     more pass.
   - A drive that throws is recorded as a `note` (`drive failed: …`) and runs again at the backstop.
   - `onJobError` keeps the job at the backstop too, so Lifecycle never deletes it after a failed dispatch.
   - Outside an alarm, `onJob` still awaits `drive()`.
   - Tests: `[lifecycle-alarm-not-held]` and `[drive-throws-keeps-wake]`.
4. **`receive()` and `drive()` await `ready()` first**, since RPC and the test helpers reach the object
   without a platform event.
5. **A drain releases its guard before it arms the job.** Arming now always awaits storage, and a row
   queued in that window (an effect's result) would otherwise join a drain that has stopped looking, and
   wait with no wake.
6. **The test helpers drive the runtime directly.** `@actord/toolkit/testing` keeps each instance's runtime
   in its seams; `settle()` and `tick()` call `drive()` instead of setting and running the physical alarm.

## Rejected alternatives
- **A shim `DurableObjectStateLike`** whose `setAlarm` pushes a job. It hides the shared alarm behind an API
  that claims to own it, and a capability is the extension point the SDK documents.
- **Moving actord's rows into `cf_agents_jobs`**, one job per outbox row or schedule. The table is the SDK's
  internal storage, and its policies aren't actord's delivery semantics: a job is deleted when its dispatch
  returns, retried three times in process, and more than ten due jobs per capability log a backlog warning.
  It stays possible later if the adapter turns out to fight the SDK.

## Consequences
- Actor classes install `Lifecycle` (`readonly lifecycle = Lifecycle.install(this)`, the first field) and
  define no `alarm()`. `ActorRuntime` loses `alarm()` and `start()`. The templates and both reference apps
  changed to match, and `agents` is a pinned peer dependency of `@actord/toolkit`.
- Other capabilities can share the object: the probe's `[lifecycle-shared-alarm]` test runs a second
  capability's job and actord's retry on the one alarm.
- Node tests that load the runtime give `cloudflare:workers` an empty module (`vitest.config.ts`).
