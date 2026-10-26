# actord on Lifecycle: the foundation (plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make actord a capability on the Agents SDK's `Lifecycle`, and give it the primitives a long-running factory needs:
- timers;
- several schedules, including cron;
- per-effect budgets and usage;
- job effects;
- a heartbeat and crash-loop parking;
- visible reused effect keys (issue #2);
- approval expiry with approver identity.

**Architecture:** `actorRuntime` stops owning the Durable Object's alarm. It registers an `ActordCapability` on a `Lifecycle` that the actor class installs. The capability keeps a single Lifecycle job (`id: "actord"`) due at the earliest moment actord needs a wake, and runs actord's existing drive loop when that job fires.

All new state lives in actord's own SQLite tables and commits inside the handler's transaction, as today. Timers, probes and deadlines are rows that the single job's due time is computed from.

**Tech Stack:** TypeScript 7.0.2, `agents@0.30.1` (`agents/lifecycle`, which the SDK docs mark stable), `cron-schedule@6.0.0`, zod 4, vitest 5.0.5 with `@cloudflare/vitest-plugin` 1.4.7 (workerd), esbuild.

**Spec:** `docs/superpowers/specs/2026-10-25-agents-sdk-foundation-design.md` (§5 is this plan; §4 holds the constraints).

**Where this plan sits.** It is the first of several. The later plans are written after this one lands, because spikes inform them:

| Plan | Covers | After |
| --- | --- | --- |
| 2 | Sources (`@github`, `@email`), approvals by email | Spike 6 |
| 3 | Agent actors: `PiHarness` on a Computer workspace | Spikes 2–5 |
| 4 | Decision and extraction effects, decision records | Spike 7 |
| 5 | Plugin skills, `actord init` docs and eval scaffolds updated to the new foundation | — |

The factory itself gets its own design and plan, in its own repo. Spike 1 (the Lifecycle adapter) is Task 1 here.

## Global Constraints

- **Pin `agents` exactly.** `devDependencies.agents` is `"0.30.1"` and `peerDependencies.agents` is `"~0.30.1"` in `packages/toolkit/package.json`. Examples and the `actord init` starter pin `"agents": "0.30.1"`.
- **Keep `agents` external.** It must stay external to the toolkit's library bundles (`runtime`, `testing`), so the user's app and actord share one `Lifecycle` class. `cron-schedule` is bundled.
- **No actor class defines or forwards `alarm()`.** The SDK docs say: "Do not define forwarding versions of those methods" (`agents/docs/agents/lifecycle.md`).
- **`receive()` awaits readiness.** It is native RPC, which bypasses Lifecycle startup, so every `receive()` awaits `lifecycle.ready()` before touching storage.
- **Every new guarantee gets a workerd test** in `packages/toolkit/test-runtime/runtime.test.ts`, tagged `[tag]` like the existing ones, or is written down as not guaranteed. Spec §2.
- **Defaults:**
  - heartbeat: a wake at most 30 s away while any effect is `running`;
  - parking: after 5 interruptions;
  - approval expiry: `"3d"`;
  - effect timeout: 30 s, and delivery attempts: 6 (both unchanged).
- **Ids derive with `deriveId(...)` from causal position,** as today:
  - timer fires: `deriveId(self, "timer", key, dueAt, causationId)`, where `causationId` is the id of the message that set the timer;
  - schedule ticks: `deriveId(self, "tick", message, dueAt)`.
- **Toolkit machinery never calls a model,** and never approves anything (charter conviction 11).
- **Rebuild and commit `dist/` after toolkit changes.** After any change under `packages/toolkit/src`, run `npm run build -w @actord/toolkit` and commit the rebuilt artifacts (`packages/toolkit/dist`, `plugins/*/dist`, `plugins/claude/hooks/effect-patterns.ts`). CI checks that a fresh build reproduces them byte for byte, and toolkit unit tests run the shipped CLI.
- **Breaking API changes are allowed.** Both reference apps and the starter must keep passing their own tests.
- **No version bump, no npm release, no paid eval run, and no plugin skill edits in this plan.** Plan 5 updates the skills.

## Review Focus

These conditions are implied by the spec but no other test covers them:

1. **An object that wakes long after its schedule was due** (evicted for hours) ticks once, with `payload.at` set to the missed due time, and is then re-armed from now. It does not fire once per missed period. → Task 3, `[schedule-late-wake]`.
2. **A handler that sets a timer and then throws** leaves no timer behind, because the timer row is part of the rolled-back transaction. → Task 2, `[timer-atomic]`.
3. **A completion message that arrives after a job's deadline** already made it `in_doubt` gets `settleJob(...) === false`. The actor receives exactly one result message. → Task 5, `[job-late-settle]`.
4. **An effect key reused after its effect finished** (`in_doubt` or `dead`) is still a duplicate, for the actor's lifetime. It is never re-run. → Task 7, `[effect-key-reuse-after-settled]`.
5. **An approval that arrives after expiry** gets `ctx.approve(...) === false`. The effect never runs, and the actor has already received the `failed` result. → Task 8, `[approve-after-expiry]`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/toolkit/src/runtime/capability.ts` (new) | `ActordCapability`: the Lifecycle glue (start hook, job hook, arming the one `"actord"` job, readiness) |
| `packages/toolkit/src/runtime/timers.ts` (new) | Timer table: schema, set, cancel, due rows, earliest due time |
| `packages/toolkit/src/runtime/schedules.ts` (new) | Next-due computation for `every` and `cron`; per-schedule meta keys; the legacy `schedule.next` migration |
| `packages/toolkit/src/runtime/jobs.ts` (new) | Job-effect row transitions (`awaiting_job`, probe, deadline, cancel) and the adapter types |
| `packages/toolkit/src/runtime/index.ts` | `actorRuntime` orchestration: receive, handler context, drain, effects. Delegates to the files above |
| `packages/toolkit/src/system.ts` | Declaration types: `@timer`, `schedules`, effect `budget` / `kind` / `deadline` / `probe` / `completes` / `expires`, `TimerMessages` |
| `packages/toolkit/src/testing.ts` | Seams registry plus `settle`, `tick`, `fireTimers`, `expireJobs`, `expireApprovals`, `captureEvents`, `overrideEffectBudget` |
| `packages/toolkit/src/model/{check,manifest,diff,mermaid,events}.ts` | Rules, the manifest shape, diffs, the graph label, and the trace for the new declarations and events |
| `packages/toolkit/src/cli/commands/events.ts` | Trace text for duplicate effect requests and jobs |
| `packages/toolkit/src/templates/project.ts` | Starter actors on Lifecycle; `agents` pinned |
| `packages/toolkit/test-runtime/src/index.ts`, `runtime.test.ts` | The probe system and the workerd guarantee tests |
| `fixtures/negative/*` (new dirs) | One negative fixture per new error rule |
| `examples/*/src/actors/*.ts`, `examples/*/package.json`, `examples/release-radar/system.ts` | Reference apps on the new foundation |
| `docs/wiki/Runtime.md`, `docs/charter.md` §4, `docs/decisions/0016-*.md`, `docs/decisions/0018-*.md` | Guarantees table, the charter amendment, decisions |

---

### Task 1: actord as a Lifecycle capability

**Files:**
- Create: `packages/toolkit/src/runtime/capability.ts`
- Modify: `packages/toolkit/src/runtime/index.ts`:
  - host type (around `:277-283`);
  - `armAlarm` (`:669-679`), which becomes `arm()`;
  - `alarm` (`:681-705`), which becomes `drive()`;
  - the returned object (`:707-740`);
  - the test seams (`:227-244`).
- Modify: `packages/toolkit/src/testing.ts` (`settle`, `tick`, `seams`)
- Modify: `packages/toolkit/package.json`, `packages/toolkit/build.mjs` (`external` on the `runtime` and `testing` builds)
- Modify: `packages/toolkit/src/templates/project.ts` (`PINNED`, the `Greeter` and `Guestbook` templates)
- Modify: all six example actors, `examples/release-radar/src/actors/{feed-poller,release-ledger,digest-writer}.ts` and `examples/briefing-desk/src/actors/{intake,analyst,desk}.ts`, plus both `examples/*/package.json` (add `"agents": "0.30.1"`)
- Modify: `packages/toolkit/test-runtime/src/index.ts` (Probe on Lifecycle, `backoffMs: () => 40`, a `Pinger` capability)
- Test: `packages/toolkit/test-runtime/runtime.test.ts`; create `packages/toolkit/test/templates.test.ts`
- Docs: create `docs/decisions/0016-actord-on-lifecycle.md`; amend `docs/charter.md` §4 (the "Actors are native runtime components" paragraph); update `docs/wiki/Runtime.md` (opening paragraph)

**Interfaces:**
- Produces, in `runtime/index.ts`:
  - `export interface ActorHost { lifecycle: Lifecycle; ctx: DurableObjectStateLike; env: unknown }`
  - `actorRuntime(host: ActorHost, system, actorName, handlers, options?): ActorRuntime`
  - `ActorRuntime` keeps `receive`, `decide` and `outbox`, drops `alarm` and `start`, and gains `/** @internal for @actord/toolkit/testing */ drive(): Promise<void>`.
- Produces, in `runtime/capability.ts`:
  - `export const ACTORD_JOB_ID = "actord"`
  - `export class ActordCapability extends LifecycleCapability` with:
    - `constructor(hooks: { start(): Promise<void>; drive(): Promise<void> })`, calling `super("actord")`;
    - `onStart(): Promise<void>`;
    - `onJob(ctx: LifecycleJobContext): Promise<void>`;
    - `arm(when: number | null): Promise<void>`;
    - `ready(): Promise<void>`.
- Produces: `TestSeams.runtimes: Map<string, ActorRuntime>`, keyed by `ctx.id.toString()`. It is filled only when `globalThis.__actorsTestSeams` exists when the runtime is constructed. `testing.ts` creates it at import.
- Every later task arms through `arm(earliestWake())`. `earliestWake()` is the one function in `index.ts` that takes the minimum over every source of a wake. In this task its sources are pending outbox `next_at` and schedule meta.

- [ ] **Step 1: Add the dependency and build externals.**
  - In `packages/toolkit/package.json` add `devDependencies.agents: "0.30.1"` and `peerDependencies.agents: "~0.30.1"`, and add `agents` to `peerDependenciesMeta`, not optional.
  - In `build.mjs`, pass `external: ["agents", "agents/*"]` on the `runtime` entry build and add the same to the `testing` build.
  - Run `npm install`.
  - Expected: `node -e "import('agents/lifecycle').then(m => console.log(typeof m.Lifecycle))"`, run in `packages/toolkit`, prints `function`.

- [ ] **Step 2: Write the failing workerd test.**

```ts
it("[lifecycle-shared-alarm] actord and another Lifecycle capability share the object's one alarm", async () => {
  let runs = 0;
  overrideEffect("gateway.keyed", { run: async () => { if (++runs === 1) throw new Error("transient"); return "ok"; } });
  await send("shared", "gateway.keyed");        // first attempt fails, so a retry is pending in 40 ms
  await probe("shared").pingAt(Date.now() + 20); // the Pinger capability's own job
  const owners = await runInDurableObject(probe("shared"), (_i, s) =>
    s.storage.sql.exec<{ capability: string }>("SELECT capability FROM cf_agents_jobs ORDER BY capability").toArray().map((r) => r.capability));
  expect(owners).toEqual(["actord", "pinger"]);
  await new Promise((r) => setTimeout(r, 60));
  await runDurableObjectAlarm(probe("shared"));
  await settle(env, system);
  expect(await probe("shared").pings()).toBe(1);
  expect(await probe("shared").outcomes()).toEqual([{ key: "shared", status: "confirmed", error: null }]);
});
```

  Add `Pinger` to `test-runtime/src/index.ts`:
  - It is a `LifecycleCapability` with id `"pinger"`. `pingAt(time)` pushes `{ id: "ping", fn: "ping", time }`, and its `onJob` increments a `pings` row.
  - Probe exposes `pingAt(time: number)` and `pings(): number` as RPC.
  - Probe's class becomes:
    - `readonly lifecycle = Lifecycle.install(this)`;
    - `readonly pinger = new Pinger()`, which the constructor body registers with `this.lifecycle.use(this.pinger)`;
    - `actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "Probe", handlers, { backoffMs: () => 40 })`;
    - no `alarm()`.

- [ ] **Step 3: Run it to verify it fails.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts -t lifecycle-shared-alarm`
  - Expected: a type or runtime failure, because `actorRuntime` doesn't accept `lifecycle`, or the `owners` list lacks `"actord"`.

- [ ] **Step 4: Implement `ActordCapability` and rewire `actorRuntime`.**
  - **The capability:**
    - `actorRuntime` constructs `new ActordCapability({ start, drive })` and calls `host.lifecycle.use(cap)`.
    - `start()` runs `recoverOrphans()`, then `ensureSchedule()`, then `arm(earliestWake())`.
    - `drive()` is the old `alarm()` body, with `armAlarm()` replaced by `cap.arm(earliestWake())`.
  - **`arm(when)`:**
    - `when === null` calls `this.lifecycle.jobs.cancel(ACTORD_JOB_ID)`.
    - Otherwise it pushes `{ id: ACTORD_JOB_ID, fn: "drive", time: when }`, unless `jobs.get(ACTORD_JOB_ID)?.time === when`.
  - **`onJob`** calls `hooks.drive()` when `ctx.job.fn === "drive"`. A push made during dispatch supersedes the job's drive result (`job-queue.ts` doc on `LifecycleJobOutcome`), so `drive` re-arming itself is correct.
  - **`receive()` and `drive()`** both first await `cap.ready()`, then `recoverOrphans()`. `cap.ready()` is `this.lifecycle.ready()`, which runs Lifecycle's initialization (`#ensureInitialized`). The test helpers call `drive()` directly, before any platform event has started the object, so `drive()` needs this too.
  - Remove `alarm` and `start` from `ActorRuntime`. Add `drive`.
  - Register in `seams()?.runtimes?.set(ctx.id.toString(), runtime)`.

- [ ] **Step 5: Move test helpers off the physical alarm.**
  - In `testing.ts`, `seams()` is called once at module top level, and the seams object gains `runtimes: new Map()`.
  - `settle()` keeps its rounds. Inside `runInDurableObject(stub, async (_i, state) => { … })` it:
    1. runs `UPDATE _actors_outbox SET next_at = 0 WHERE status = 'pending'`;
    2. runs `await seams().runtimes.get(state.id.toString())?.drive()`.

    It no longer calls `setAlarm` or `runDurableObjectAlarm`.
  - `tick()` writes its meta and then calls `drive()` the same way. It returns `true`.
  - Remove the now-unused `runDurableObjectAlarm` import.

- [ ] **Step 6: Migrate every actor class and the starter.**
  - In the six example actors and the two `templates/project.ts` actor templates:
    - add `import { Lifecycle } from "agents/lifecycle";`;
    - add `readonly lifecycle = Lifecycle.install(this);` as the first field;
    - pass `{ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }`;
    - delete `alarm()`.
  - Add `agents: "0.30.1"` to `PINNED`, and to both `examples/*/package.json` `devDependencies`.

- [ ] **Step 7: Write the starter regression test.** In `packages/toolkit/test/templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { starterFiles } from "../src/templates/project.ts";

describe("starter actors", () => {
  it("compose a Lifecycle and forward no alarm()", () => {
    const files = starterFiles("demo", "0.2.0");
    for (const path of ["src/actors/greeter.ts", "src/actors/guestbook.ts"]) {
      expect(files[path]).toContain("Lifecycle.install(this)");
      expect(files[path]).not.toMatch(/\balarm\(\)/);
    }
    expect(JSON.parse(files["package.json"]!).devDependencies.agents).toBe("0.30.1");
  });
});
```

- [ ] **Step 8: Run everything touched.**
  - Run: `npm run build -w @actord/toolkit && (cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts && npx vitest run) && npm test -w release-radar && npm test -w briefing-desk`
  - Expected: all pass. That is the 6 existing runtime tests plus the new one, the 22 Release Radar tests, and the 11 Briefing Desk tests.

- [ ] **Step 9: Write the docs.**
  - `docs/decisions/0016-actord-on-lifecycle.md` follows the format of `0007-runtime-semantics.md`:
    - what: actord is a Lifecycle capability with one `"actord"` job;
    - why: one alarm per Durable Object, and the harnesses need Lifecycle;
    - the rejected alternatives: a shim `DurableObjectStateLike`, and moving rows into `cf_agents_jobs`;
    - the consequences: no `alarm()` on actors, and `ready()` before RPC.
  - Charter §4: replace "favor native Durable Object classes and the Agents SDK when its scheduling, queueing, or agent capabilities are needed" with "favor native Durable Object classes that install the Agents SDK's `Lifecycle`; actord runs as one capability on it, so SDK capabilities such as harnesses can share the object".
  - `docs/wiki/Runtime.md` opening: "Actors stay native Durable Object classes that install `Lifecycle` and compose `actorRuntime(...)`."

- [ ] **Step 10: Commit.**

```bash
git add packages/toolkit plugins examples docs package-lock.json
git commit -m "actord runs as a Lifecycle capability: one alarm shared with the Agents SDK (decision 0016)"
```

---

### Task 2: Timers handlers can set

**Files:**
- Create: `packages/toolkit/src/runtime/timers.ts`
- Modify: `packages/toolkit/src/system.ts`. In `ExternalSender` (`:81`) add `"@timer"`. Next to `IngressMessages` (`:163`) add `export type TimerMessages<S, A extends string> = Extract<Extract<S["routes"][number], { from: "@timer"; to: A }>["message"], MessageName<S>>`.
- Modify: `packages/toolkit/src/runtime/index.ts`:
  - `HandlerContext`;
  - `handlerContext()`, where rows are inserted in the handler's transaction;
  - `drive()`, which delivers due timers;
  - `earliestWake()`, which adds `MIN(due_at)`;
  - `EventKind`, which adds `"timer.set" | "timer.cancelled" | "timer.fired"`.
- Modify: `packages/toolkit/src/model/check.ts`. `EXTERNAL` gains `@timer`, and the `ROUTE_INVALID_SENDER` message becomes "use @clock, @ingress, @timer, or an actor".
- Modify: `packages/toolkit/src/testing.ts`. Add `fireTimers(env, system, actor: string, key = "main"): Promise<number>`: it sets `due_at = 0` for that instance's timers, drives, and returns how many were due.
- Modify: `test-runtime/src/index.ts`:
  - messages `probe.timer.set` `{ key, delayMs, fail?: boolean }`, `probe.timer.cancel` `{ key }` and `probe.timer.fired` `{ key }`;
  - routes `@ingress→set/cancel→Probe` and `@timer→probe.timer.fired→Probe`;
  - a `fired` table, exposed through RPC `fired(): string[]`.
- Test: `test-runtime/runtime.test.ts`

**Interfaces:**
- Produces, in `HandlerContext<S, A>`:
  - `after<M extends TimerMessages<S, A>>(delay: Duration | number, type: M, payload: PayloadIn<S, M>, options: { key: string }): void`;
  - `at<M extends TimerMessages<S, A>>(when: number, type: M, payload: PayloadIn<S, M>, options: { key: string }): void`;
  - `cancelTimer(key: string): boolean`.
- Timer semantics: setting a key that already exists replaces it. The timer is delivered only to this actor instance, as an envelope with `from: "@timer"`, `causationId` set to the setting message's id, and the setter's `correlationId`.
- Produces, in `timers.ts`:
  - `TIMERS_SCHEMA: string[]`, creating `_actors_timers (key TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, causation_id TEXT, correlation_id TEXT NOT NULL)`;
  - `setTimer(sql, row)`;
  - `cancelTimer(sql, key): boolean`;
  - `dueTimers(sql, now): TimerRow[]`, ordered by `due_at, key`;
  - `earliestTimer(sql): number | null`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("[timer-fires] a timer set in a handler arrives later as a message from @timer", async () => {
  await ingress(env, system, "Probe", "probe.timer.set", { key: "t1", delayMs: 20 }, { key: "tm" });
  expect(await probe("tm").fired()).toEqual([]);
  await new Promise((r) => setTimeout(r, 30));
  await settle(env, system);
  expect(await probe("tm").fired()).toEqual(["t1"]);
});
it("[timer-survives-restart] a pending timer fires after the object restarts", async () => { /* set delayMs 20, abortAllDurableObjects(), wait 30 ms, settle → ["t2"] */ });
it("[timer-duplicate-fire] a timer delivered twice is handled once", async () => { /* fire it, re-insert the same key and due_at with runInDurableObject, fireTimers → fired() stays ["t3"] */ });
it("[timer-cancel] a cancelled timer never fires", async () => { /* set, cancel, fireTimers → [] */ });
it("[timer-replace] setting the same key again replaces the pending timer", async () => { /* set key t5 twice; fireTimers → fired() === ["t5"], with a count of 1 */ });
it("[timer-atomic] a handler that sets a timer and then throws leaves no timer", async () => {
  const r = await ingress(env, system, "Probe", "probe.timer.set", { key: "t6", delayMs: 0, fail: true }, { key: "tm6" });
  expect(r.status).toBe("failed");
  expect(await runInDurableObject(probe("tm6"), (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_timers").one().n)).toBe(0);
});
```

  The `probe.timer.set` handler calls `ctx.after(payload.delayMs, "probe.timer.fired", { key: payload.key }, { key: payload.key })`, then throws if `payload.fail`.

- [ ] **Step 2: Run them to verify they fail.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts -t timer-`
  - Expected: FAIL (`ctx.after is not a function`, or a type error).

- [ ] **Step 3: Implement `timers.ts` and the context methods.**
  - **Writes are transactional.** `after` and `at` write the row inside the open transaction through `ctx.sql`, so a rollback removes it. `after` resolves a `Duration` with the existing `durationMs`.
  - **Delivery in `drive()`.** It calls `receive(envelope)` for each due row, with `id = deriveId(self, "timer", key, due_at, causation_id)`, where `causation_id` is the id of the message that set the timer.
    - `handled`, `duplicate` or `rejected`: delete the row. A rejection also emits `undeliverable`.
    - `failed`: set `attempts + 1` and `due_at = now + backoff(attempts)`. At `maxAttempts`, delete the row and emit `retry.exhausted`.
  - Emit `timer.set` and `timer.cancelled` with the handler's notes, and `timer.fired` before delivery.
  - Add `earliestTimer` to `earliestWake()`.

- [ ] **Step 4: Run the timer tests and the full runtime suite.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts`
  - Expected: PASS.

- [ ] **Step 5: Add `@timer` to check and run the fixtures.**
  - Run: `npm run build -w @actord/toolkit && (cd packages/toolkit && npx vitest run)`
  - Expected: PASS, with no snapshot changes. Valid fixtures declare no `@timer` routes.

- [ ] **Step 6: Document the guarantee.** Add this row to `docs/wiki/Runtime.md`:

  | Guarantee | How |
  | --- | --- |
  | A timer set by a handler is delivered once, after its delay, even across restarts; it is set only if the handler commits | `_actors_timers` row in the handler's transaction; derived id |

- [ ] **Step 7: Commit.**

```bash
git add packages/toolkit plugins docs
git commit -m "Timers: ctx.after, ctx.at and ctx.cancelTimer, delivered from @timer"
```

---

### Task 3: Several schedules, including cron

**Files:**
- Create: `packages/toolkit/src/runtime/schedules.ts`
- Modify: `packages/toolkit/src/system.ts`:
  - `ActorSpec.schedule` (`:51-52`) is replaced by `schedules?: readonly ScheduleSpec[]`;
  - `ActorRefs` (`:89-92`).
- Modify: `packages/toolkit/src/model/manifest.ts:15,69`, `check.ts:41-44,73-74`, `diff.ts:102-103,332` and `mermaid.ts:26`.
- Modify: `packages/toolkit/src/runtime/index.ts`: `ensureSchedule`, `drive()`, `earliestWake()`.
- Modify: `packages/toolkit/src/testing.ts`: the `tick()` signature.
- Modify: `examples/release-radar/system.ts` (FeedPoller), then regenerate `examples/release-radar/actord.manifest.json`; regenerate every fixture manifest whose system declares a schedule.
- Create: `fixtures/negative/schedule-cron-invalid/` (copy `schedule-route-missing`, set an invalid cron, with `expected.json` codes `["SCHEDULE_INVALID"]`) and `fixtures/negative/schedule-duplicate/` (two schedules for one message, with codes `["SCHEDULE_DUPLICATE"]`).
- Modify: `fixtures/negative/schedule-route-missing/system.ts` to the new shape.
- Test: `test-runtime/runtime.test.ts`; the fixture snapshots (`packages/toolkit/test/__snapshots__/fixtures.test.ts.snap`)

**Interfaces:**
- `export type ScheduleSpec = { readonly every: Duration; readonly message: string; readonly cron?: never } | { readonly cron: string; readonly message: string; readonly every?: never }`
- Manifest actor: `schedules: Array<{ every: string | null; everyMs: number | null; cron: string | null; message: string }>`.
- `schedules.ts`:
  - `nextDue(spec: ScheduleSpec, from: number): number`. For `every` it returns `from + durationMs(every)`; for `cron` it returns `parseCronExpression(cron).getNextDate(new Date(from)).getTime()`, using `cron-schedule`.
  - `scheduleKey(message: string): string`, which returns `` `schedule.next:${message}` ``.
  - `migrateLegacy(meta, setMeta, specs)`: when the old `schedule.next` key exists and there is exactly one schedule, it moves that value to the new key.
- `tick(env, system, actor, key = "main", message?: string)` defaults to the actor's first schedule's message.
- Check codes:
  - `SCHEDULE_INVALID`: a bad duration, or a cron that `parseCronExpression` throws on.
  - `SCHEDULE_DUPLICATE`: two schedules with the same message.
  - `SCHEDULE_ROUTE_MISSING`: kept, applied per entry.
  - `CLOCK_ROUTE_WITHOUT_SCHEDULE`: uses `schedules.some(...)`.
- The Mermaid label joins the schedules' labels with `" · "`, as `every 15m` or `cron 0 9 * * *`.

- [ ] **Step 1: Add the dependency.** Add `devDependencies["cron-schedule"]: "6.0.0"` to `packages/toolkit/package.json`; it is bundled into `runtime.mjs` and the CLI. Run `npm install`.

- [ ] **Step 2: Write the failing tests.** Give the Probe system `schedules: [{ every: "1h", message: "probe.tick.hourly" }, { cron: "0 9 * * *", message: "probe.tick.daily" }]`, with `@clock` routes and handlers that record the tick in a `ticks` table. Then:

```ts
it("[schedules-independent] each schedule ticks on its own message", async () => {
  await tick(env, system, "Probe", "sch", "probe.tick.hourly");
  await tick(env, system, "Probe", "sch", "probe.tick.daily");
  expect(await probe("sch").ticks()).toEqual(["probe.tick.daily", "probe.tick.hourly"]);
});
it("[schedule-late-wake] an object that wakes long after its due time ticks once and re-arms from now", async () => {
  const due = Date.now() - 5 * 3_600_000; // five hourly periods missed
  await runInDurableObject(probe("late"), async (_i, s) => {
    s.storage.sql.exec("INSERT INTO _actors_meta (k, v) VALUES ('schedule.next:probe.tick.hourly', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(due));
  });
  await settle(env, system);
  expect(await probe("late").ticks()).toEqual(["probe.tick.hourly"]);
  const next = await runInDurableObject(probe("late"), (_i, s) => Number(s.storage.sql.exec("SELECT v FROM _actors_meta WHERE k = 'schedule.next:probe.tick.hourly'").one().v));
  expect(next).toBeGreaterThan(Date.now() + 3_500_000);
});
it("[schedule-cron-next] nextDue follows the cron expression", () => {
  const from = Date.UTC(2026, 9, 25, 10, 0, 0);
  expect(new Date(nextDue({ cron: "0 9 * * *", message: "m" }, from)).toISOString()).toBe("2026-10-26T09:00:00.000Z");
});
```

  `settle` must call `drive()` even when the outbox is empty, so the late schedule fires. Step 4 makes `settle` drive every instance once per round.

- [ ] **Step 3: Run them to verify they fail.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts -t schedule`
  - Expected: FAIL.

- [ ] **Step 4: Implement it.**
  - `ensureSchedule` becomes `ensureSchedules`: it migrates the legacy key, then sets any missing `scheduleKey(m)` to `nextDue(spec, now)`.
  - `drive()`: for each schedule whose meta is due, set `next = nextDue(spec, now)`, then deliver one tick with `payload: { at: due }` and `id = deriveId(self, "tick", message, due)`.
  - `earliestWake()` takes every schedule key into account.
  - `settle()` calls `drive()` on every instance in each round, not only those with pending rows.
  - Update `manifest.ts`, `check.ts`, `diff.ts` (`actor.schedule` compares the arrays; the plan text is unchanged) and `mermaid.ts`.
  - Update `fixtures/negative/schedule-route-missing/system.ts` and FeedPoller to `schedules: [{ every: "15m", message: "feed.poll.due" }]`.

- [ ] **Step 5: Regenerate manifests and snapshots, then run everything.**
  - First, `npm run build -w @actord/toolkit`.
  - Then, in `examples/release-radar` and in each fixture listed by `rg -l 'schedule' fixtures --glob 'system.ts'`, run `node <repo>/plugins/claude/dist/actord.mjs graph --write`. Skip `fixtures/negative/manifest-stale`, which must stay stale.
  - Then run: `(cd packages/toolkit && npx vitest run -u && npx vitest run && npx vitest run --config vitest.runtime.config.ts) && npm test -w release-radar && npm test -w briefing-desk`
  - Expected: all pass. The snapshot diff shows only `schedule` becoming `schedules`.

- [ ] **Step 6: Document the guarantee.** In `docs/wiki/Runtime.md`, add the row "A schedule that was missed while the object slept ticks once, then re-arms from now".

- [ ] **Step 7: Commit.**

```bash
git add packages/toolkit plugins fixtures examples docs package-lock.json
git commit -m "Several schedules per actor, every or cron; a missed tick fires once"
```

---

### Task 4: Per-effect budgets and usage reporting

**Files:**
- Modify: `packages/toolkit/src/system.ts` (`EffectSpec`, `:59-75`)
- Modify: `packages/toolkit/src/runtime/index.ts`: `runEffect`'s budget resolution (`:597-601`), `finish`, `enqueueResult`, and the `EffectAdapter` type (`:152-156`)
- Modify: `packages/toolkit/src/testing.ts`: add `overrideEffectBudget`
- Modify: `packages/toolkit/src/model/check.ts`: add `EFFECT_BUDGET_INVALID`
- Create: `fixtures/negative/effect-budget-invalid/` (`timeoutMs: 0`, with codes `["EFFECT_BUDGET_INVALID"]`)
- Test: `test-runtime/runtime.test.ts`. Probe's `Outcome` schema gains `usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(), containerSeconds: z.number().optional() }).optional()`, and `outcomes()` returns `usage`.

**Interfaces:**
- `EffectSpec.budget?: { readonly maxAttempts?: number; readonly timeoutMs?: number }`
- Resolution order:
  1. `seams.effectBudgets[effect]`;
  2. `effect.budget`;
  3. `seams.budgets[actor]`;
  4. `actor.budget`;
  5. the defaults (30 000 ms, then `maxAttempts`).
- `export interface EffectUsage { inputTokens?: number; outputTokens?: number; costUsd?: number; containerSeconds?: number }`
- The `EffectAdapter.run` context gains `reportUsage(usage: EffectUsage): void`. Usage is summed field by field over every report within an attempt, then over attempts.
- The result payload gains `usage?: EffectUsage` whenever any usage was reported. The `effect.confirmed`, `effect.failed` and `effect.in_doubt` events carry `detail.usage`.
- `overrideEffectBudget(effect: string, budget: { maxAttempts?: number; timeoutMs?: number }): void`

- [ ] **Step 1: Write the failing tests.**

```ts
it("[effect-budget] an effect's own timeout overrides its actor's", async () => {
  overrideBudget("Probe", { timeoutMs: 5_000 });
  overrideEffectBudget("gateway.plain", { timeoutMs: 20 });
  overrideEffect("gateway.plain", { run: () => new Promise(() => {}) });
  await send("eb", "gateway.plain");
  await settle(env, system);
  expect(await probe("eb").outcomes()).toMatchObject([{ key: "eb", status: "in_doubt", error: "effect timed out after 20ms" }]);
});
it("[effect-usage] usage reported by an adapter arrives with the result", async () => {
  overrideEffect("gateway.keyed", { run: async (_i, c) => { c.reportUsage({ inputTokens: 10, costUsd: 0.01 }); c.reportUsage({ inputTokens: 5, outputTokens: 2 }); return "ok"; } });
  await send("eu", "gateway.keyed");
  await settle(env, system);
  expect((await probe("eu").outcomes())[0]).toMatchObject({ status: "confirmed", usage: { inputTokens: 15, outputTokens: 2, costUsd: 0.01 } });
});
```

- [ ] **Step 2: Run them to verify they fail.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts -t effect-`
  - Expected: FAIL.

- [ ] **Step 3: Implement it.** Add the resolution order, the accumulator stored on the row body as `usage`, and the payload and event detail.

- [ ] **Step 4: Run the runtime suite, then build and run the fixtures.**
  - Run: `npm run build -w @actord/toolkit && (cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts && npx vitest run)`
  - Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/toolkit plugins fixtures
git commit -m "Per-effect budgets; effects report usage in their result"
```

---

### Task 5: Job effects

**Files:**
- Create: `packages/toolkit/src/runtime/jobs.ts`
- Modify: `packages/toolkit/src/system.ts` (`EffectSpec`)
- Modify: `packages/toolkit/src/runtime/index.ts`:
  - `RuntimeOptions.effects`, which accepts `JobAdapter`;
  - `startEffect`/`runEffect`, which branch on `fx.kind === "job"`;
  - `HandlerContext`, which gains `settleJob` and `cancelJob`;
  - `drive()`, which handles probes and deadlines;
  - `earliestWake()`, which includes the `next_at` of `awaiting_job` rows;
  - `EventKind`, which adds `"job.started" | "job.probed" | "job.cancel_requested"`.
- Modify: `packages/toolkit/src/model/check.ts`: add `JOB_DEADLINE_MISSING` (error), `JOB_UNOBSERVABLE` (warning: neither `probe` nor `completes`) and `JOB_COMPLETES_ROUTE_MISSING` (error).
- Modify: `packages/toolkit/src/model/manifest.ts`: the effect gains `kind`, `deadline`, `probe` and `completes`.
- Modify: `packages/toolkit/src/model/events.ts`: `TraceEffect` gains `job?: { handle: unknown; settledBy: "message" | "probe" | "deadline" | "cancel" | null }`.
- Modify: `packages/toolkit/src/cli/commands/events.ts`: trace text prints `job <handle> settled by <how>`.
- Modify: `packages/toolkit/src/testing.ts`: add `expireJobs(env, system, actor, key = "main")`, which sets every `awaiting_job` deadline to now and drives.
- Create: `fixtures/negative/job-deadline-missing/` (codes `["JOB_DEADLINE_MISSING"]`)
- Modify: `test-runtime/src/index.ts`:
  - effect `gateway.job` `{ kind: "job", idempotency: "key", deadline: "1h", probe: { every: "1m" }, completes: { message: "probe.job.done" }, result: "probe.outcome" }`;
  - messages `probe.job.start` `{ key }`, `probe.job.done` `{ key, ok: boolean }` and `probe.job.cancel` `{ key }`, with `@ingress` routes;
  - the `probe.job.done` handler records `ctx.settleJob(...)`'s return value in a `settled` table, exposed as RPC `settled(): Array<{ key: string; ok: boolean }>`.
- Docs: create `docs/decisions/0018-job-effects.md`; add rows to `docs/wiki/Runtime.md`.
- Test: `test-runtime/runtime.test.ts`

**Interfaces:**
- `EffectSpec`:
  - `kind?: "call" | "job"` (default `"call"`);
  - `deadline?: Duration` (required when `kind === "job"`);
  - `probe?: { readonly every: Duration }`;
  - `completes?: { readonly message: string }`.
- In `jobs.ts`:

```ts
export interface JobAdapter<I = unknown, H = unknown, O = unknown> {
  start(input: I, ctx: { key: string; attempt: number; signal: AbortSignal; reportUsage(u: EffectUsage): void }): Promise<H>;
  probe?(handle: H, ctx: { key: string; signal: AbortSignal; reportUsage(u: EffectUsage): void }): Promise<JobProbe<O>>;
  cancel?(handle: H, ctx: { key: string; signal: AbortSignal }): Promise<boolean>;
}
export type JobProbe<O = unknown> = { done: false } | { done: true; status: "confirmed"; value: O } | { done: true; status: "failed"; error: string };
```

- `HandlerContext`:
  - `settleJob(name: EffectsOf<S, A>, key: string, outcome: { status: "confirmed"; value?: unknown } | { status: "failed"; error: string }): boolean`. It works inside the handler's transaction. It returns `false`, and does nothing, unless the row is `awaiting_job`.
  - `cancelJob(name: EffectsOf<S, A>, key: string): boolean`. It marks the row `cancelling` in the transaction. After commit the runtime calls `cancel(handle)`: `true` settles the job `failed` with error `"cancelled"`; `false`, a throw or a missing `cancel` settles it `in_doubt` with error `"cancel not confirmed"`.
- **The row lifecycle:**
  - `pending → running` (`start`).
    - **Start fails:** the existing call-effect rules apply (keyed → retry; unkeyed → `in_doubt`).
    - **Start succeeds:** the row becomes `awaiting_job`, with `body.handle` and `body.deadlineAt`, and `next_at = min(now + probe.every, deadlineAt)`. The runtime emits `job.started` with `detail.handle`.
  - **In `drive()`:**
    - **The deadline has passed:** the row becomes `in_doubt` with error `"deadline passed"`.
    - **A probe is due:** the probe runs in the background, like effects, using the effect's budget timeout.
      - `done` settles the row.
      - Not done, or a throw, sets `next_at = min(now + probe.every, deadlineAt)` and emits `job.probed`.
  - **Every settlement** goes through `enqueueResult` with the existing result payload shape (`key`, `status`, `value` or `error`, `usage`) and records `body.settledBy`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("[job-settled-by-message] a job finishes when its completion message settles it", async () => {
  let starts = 0;
  overrideEffect("gateway.job", { start: async () => ({ runId: `r-${++starts}` }) } as never);
  await ingress(env, system, "Probe", "probe.job.start", { key: "j1" }, { key: "j1" });
  await settle(env, system);
  expect(await probe("j1").outcomes()).toEqual([]);
  await ingress(env, system, "Probe", "probe.job.done", { key: "j1", ok: true }, { key: "j1" });
  await settle(env, system);
  expect(await probe("j1").outcomes()).toMatchObject([{ key: "j1", status: "confirmed" }]);
  expect(starts).toBe(1);
});
it("[job-settled-by-probe] a probe that reports done settles the job", async () => { /* probe returns {done:false} then {done:true,status:"confirmed",value:1}; between rounds, set next_at = 0 via runInDurableObject; confirmed */ });
it("[job-deadline-in-doubt] a job that outlives its deadline is in doubt", async () => { /* start only; expireJobs → in_doubt, error "deadline passed" */ });
it("[job-cancel-honest] a confirmed cancel fails the job, an unconfirmed one is in doubt", async () => { /* cancel → true gives failed "cancelled"; cancel → false gives in_doubt "cancel not confirmed" */ });
it("[job-restart-awaiting] a restart while waiting neither re-starts the job nor loses it", async () => { /* start; abortAllDurableObjects(); done message → confirmed; starts === 1 */ });
it("[job-late-settle] a completion after the deadline changes nothing and adds no second result", async () => {
  overrideEffect("gateway.job", { start: async () => ({ runId: "late" }) } as never);
  await ingress(env, system, "Probe", "probe.job.start", { key: "j6" }, { key: "j6" });
  await settle(env, system);
  await expireJobs(env, system, "Probe", "j6");
  await ingress(env, system, "Probe", "probe.job.done", { key: "j6", ok: true }, { key: "j6" });
  await settle(env, system);
  expect(await probe("j6").outcomes()).toMatchObject([{ key: "j6", status: "in_doubt", error: "deadline passed" }]);
  expect(await probe("j6").settled()).toEqual([{ key: "j6", ok: false }]);
});
```

  Widen `overrideEffect`'s parameter type to `EffectAdapter | JobAdapter` so these casts can be dropped.

- [ ] **Step 2: Run them to verify they fail.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts -t job-`
  - Expected: FAIL.

- [ ] **Step 3: Implement `jobs.ts`, the context methods, `drive()` handling, and `earliestWake()`.** In `recoverOrphans`, an `awaiting_job` row is not an orphan, since nothing is in flight. A `cancelling` row found at startup re-issues the cancel.

- [ ] **Step 4: Add the check rules, manifest fields, trace and CLI text, and the fixture. Build and run everything.**
  - Run: `npm run build -w @actord/toolkit && (cd packages/toolkit && npx vitest run -u && npx vitest run && npx vitest run --config vitest.runtime.config.ts)`
  - Expected: PASS. The snapshot changes are only the new optional manifest fields, which are `null` on existing effects.

- [ ] **Step 5: Write the docs.**
  - `0018-job-effects.md` covers:
    - why: long work outlives a request and a 15-minute alarm;
    - the explicit `settleJob` instead of a declarative matcher, which keeps `system.ts` serializable;
    - the outcomes.
  - `docs/wiki/Runtime.md` gets the row: "A job is settled once, by its completion message, its probe, its deadline (in_doubt), or a cancel reported honestly".

- [ ] **Step 6: Commit.**

```bash
git add packages/toolkit plugins fixtures docs
git commit -m "Job effects: start, then settle by message, probe, deadline or cancel (decision 0018)"
```

---

### Task 6: Heartbeat while effects run, and crash-loop parking

**Files:**
- Modify: `packages/toolkit/src/runtime/index.ts`:
  - `earliestWake()`, which adds `now + 30_000` when any row is `running`;
  - `recoverOrphans()` (`:517-536`), which counts interruptions and parks;
  - `SCHEMA`, which migrates the `interruptions` column;
  - `RuntimeOptions`, which gains `parkAfterInterruptions?: number` (default 5);
  - `EventKind`, which adds `"effect.parked"`;
  - `NOTABLE_KINDS`, which adds `"effect.parked"`.
- Test: `test-runtime/runtime.test.ts`

**Interfaces:**
- Migration: if `PRAGMA table_info(_actors_outbox)` lacks `interruptions`, run `ALTER TABLE _actors_outbox ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0`.
- **Parking.** When a keyed orphan's `interruptions + 1 >= parkAfterInterruptions`, the row:
  - becomes `status = 'in_doubt'`, with `last_error = "parked: interrupted N times without settling"`, where N is the count;
  - emits `effect.parked` and then `effect.in_doubt`;
  - enqueues the result with `status: "in_doubt"`.

  It is never run again.

- [ ] **Step 1: Write the failing tests.**

```ts
it("[heartbeat-armed] while an effect runs, actord keeps a wake at most 30 s away", async () => {
  overrideEffect("gateway.keyed", { run: () => new Promise(() => {}) });
  await send("hb", "gateway.keyed");
  const due = await runInDurableObject(probe("hb"), (_i, s) => Number(s.storage.sql.exec("SELECT time FROM cf_agents_jobs WHERE capability = 'actord'").one().time));
  expect(due).toBeLessThanOrEqual(Date.now() + 30_000);
});
it("[crash-loop-parked] a keyed effect interrupted 5 times is parked in doubt and not run again", async () => {
  let runs = 0;
  overrideEffect("gateway.keyed", { run: () => { runs++; return new Promise(() => {}); } });
  await send("park", "gateway.keyed");
  for (let i = 0; i < 5; i++) { await abortAllDurableObjects(); await settle(env, system, { rounds: 2 }); }
  expect(await probe("park").outcomes()).toMatchObject([{ key: "park", status: "in_doubt", error: "parked: interrupted 5 times without settling" }]);
  expect(runs).toBe(5);
});
```

- [ ] **Step 2: Run them to verify they fail.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts -t "heartbeat|parked"`
  - Expected: FAIL.

- [ ] **Step 3: Implement it.**

- [ ] **Step 4: Run the full runtime suite.** Expected: PASS. `[restart-mid-effect]` still passes, since one interruption is below the threshold.

- [ ] **Step 5: Document, build and commit.**
  - In `docs/wiki/Runtime.md`, add the row "An effect interrupted 5 times without settling is parked as in_doubt".
  - Build, then commit:

```bash
git add packages/toolkit plugins docs
git commit -m "Heartbeat while effects run; park a crash-looping effect as in_doubt"
```

---

### Task 7: Reused effect keys made visible (issue #2)

**Files:**
- Modify: `packages/toolkit/src/runtime/index.ts`: `handlerContext().effect` (`:434-443`), and `EventKind`, which adds `"effect.duplicate"`.
- Modify: `packages/toolkit/src/runtime/index.ts` and `src/testing.ts`: seams gain `events?: ActorEvent[]`; `emit()` pushes into it when it is set; `testing.ts` exports `captureEvents(): ActorEvent[]`, which starts capture and returns the live array.
- Modify: `packages/toolkit/src/model/events.ts`: trace (`:150-185`); `TraceEffect` gains `duplicateOf?: string | null`.
- Modify: `packages/toolkit/src/cli/commands/events.ts`: trace text prints `already requested by <messageId> (<status>)`.
- Modify: `docs/wiki/Runtime.md`: add a "Effect keys" paragraph.
- Test: `test-runtime/runtime.test.ts`, `packages/toolkit/test/events.test.ts`

**Interfaces:**
- **How `effect()` detects a duplicate.** Inside the transaction it looks up `SELECT status, body FROM _actors_outbox WHERE id = ?`, and also checks this handler's own `pending` list. If either has the id, it pushes no insert and records a note event:
  - `kind: "effect.duplicate"`;
  - `detail: { existingStatus, firstCausationId }`;
  - `effect`, `effectKey`, `causationId` (the current message) and `correlationId`.

  It never emits `effect.requested` for a duplicate.
- **Trace.** For node `mid`, effects also include `effect.duplicate` events whose `causationId === mid`, with `outcome: "duplicate"`, `attempts: 0`, `result: null` and `duplicateOf: firstCausationId`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("[effect-key-reuse] a reused key runs the effect once and records a duplicate request", async () => {
  const events = captureEvents();
  let runs = 0;
  overrideEffect("gateway.keyed", { run: async () => ++runs });
  await send("reuse", "gateway.keyed");
  await settle(env, system);
  await ingress(env, system, "Probe", "probe.effect", { effect: "gateway.keyed", key: "reuse" }, { key: "reuse" });
  await settle(env, system);
  expect(runs).toBe(1);
  expect(events.filter((e) => e.kind === "effect.requested" && e.effectKey === "reuse")).toHaveLength(1);
  expect(events.filter((e) => e.kind === "effect.duplicate" && e.effectKey === "reuse")).toMatchObject([{ detail: { existingStatus: "confirmed" } }]);
});
it("[effect-key-reuse-after-settled] a key whose effect ended in doubt is still a duplicate", async () => { /* plain effect → in_doubt; same key again → runs stays 1, effect.duplicate with existingStatus "in_doubt" */ });
```

  In `test/events.test.ts`, add `it("trace attributes a duplicate request to the message that made it, not the first outcome")`. Build a log in which M1 requests `x:k`, which is confirmed, and M2 makes an `effect.duplicate` for `x:k` with `firstCausationId: M1`. Assert that the trace of M2 has `effects: [{ effect: "x", key: "k", outcome: "duplicate", duplicateOf: "M1" }]`.

- [ ] **Step 2: Run them to verify they fail.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts -t effect-key && npx vitest run test/events.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement it.** Add the duplicate detection, `captureEvents`, the trace attribution and the CLI text.

- [ ] **Step 4: Run the runtime suite and the toolkit unit tests.** Expected: PASS.

- [ ] **Step 5: Document it.** The "Effect keys" paragraph in `docs/wiki/Runtime.md` reads: "An effect key identifies one effect for the actor's lifetime. Requesting it again records `effect.duplicate` and runs nothing. A new attempt at the same logical work needs a new key, for example one that includes an attempt or generation number."

- [ ] **Step 6: Build and commit.**

```bash
git add packages/toolkit plugins docs
git commit -m "A reused effect key records effect.duplicate, and trace attributes it correctly

Fixes #2"
```

---

### Task 8: Approval expiry and approver identity

**Files:**
- Modify: `packages/toolkit/src/system.ts`: `EffectSpec.expires?: Duration`.
- Modify: `packages/toolkit/src/runtime/index.ts`:
  - `runEffect`'s approval parking (`:581-585`), which sets `next_at = now + expires` (default `"3d"`);
  - `earliestWake()`, which includes `awaiting_approval` rows' `next_at`;
  - `drive()`, which expires due rows;
  - `approve` and `deny` (`:444-460`), which take an optional identity;
  - `decide()`.
- Modify: `packages/toolkit/src/model/check.ts`: add the `APPROVAL_EXPIRES_IGNORED` warning (`expires` without `approval: "human"`).
- Modify: `packages/toolkit/src/testing.ts`: add `expireApprovals(env, system, actor, key = "main")`.
- Modify: `test-runtime/src/index.ts`:
  - message `probe.approve` `{ key, by }` from `@ingress`, whose handler records `ctx.approve("gateway.approval", key, { by })`'s return value in an `approvals` table;
  - RPC `approvals(): Array<{ key: string; ok: boolean }>`.
- Test: `test-runtime/runtime.test.ts`

**Interfaces:**
- `HandlerContext`:
  - `approve(name, key, identity?: { by: string }): boolean`;
  - `deny(name, key, reason: string, identity?: { by: string }): boolean`.
- **The recorded approver.** The row body gets `approvedBy: { messageId: current.id, from: current.from, by: identity?.by ?? null }`. The note or `effect.denied` event carries `detail: { by, via: current.from }`. `decide()` records `via: "@rpc"`.
- **Expiry.** An expired `awaiting_approval` row:
  - becomes `status = 'denied'`, with `last_error = "approval expired"`;
  - emits `effect.denied` with `reason: "approval expired"`;
  - enqueues the result with `status: "failed"` and `error: "approval expired"`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("[approval-expiry] an approval nobody answers expires and the actor hears it failed", async () => {
  overrideEffect("gateway.approval", { run: async () => "ran" });
  await send("exp", "gateway.approval");
  await settle(env, system);
  await expireApprovals(env, system, "Probe", "exp");
  await settle(env, system);
  expect(await probe("exp").outcomes()).toMatchObject([{ key: "exp", status: "failed", error: "approval expired" }]);
});
it("[approval-identity] an approval records who approved and through which sender", async () => {
  const events = captureEvents();
  overrideEffect("gateway.approval", { run: async () => "ran" });
  await send("who", "gateway.approval");
  await settle(env, system);
  await ingress(env, system, "Probe", "probe.approve", { key: "who", by: "owner@example.com" }, { key: "who" });
  await settle(env, system);
  expect(events.find((e) => e.kind === "note" && e.effectKey === "who")).toMatchObject({ detail: { by: "owner@example.com", via: "@ingress" } });
});
it("[approve-after-expiry] approving after expiry does nothing and the effect never runs", async () => {
  let runs = 0;
  overrideEffect("gateway.approval", { run: async () => ++runs });
  await send("late-ap", "gateway.approval");
  await settle(env, system);
  await expireApprovals(env, system, "Probe", "late-ap");
  await ingress(env, system, "Probe", "probe.approve", { key: "late-ap", by: "owner@example.com" }, { key: "late-ap" });
  await settle(env, system);
  expect(await probe("late-ap").approvals()).toEqual([{ key: "late-ap", ok: false }]);
  expect(runs).toBe(0);
});
```

- [ ] **Step 2: Run them to verify they fail.**
  - Run: `cd packages/toolkit && npx vitest run --config vitest.runtime.config.ts -t approv`
  - Expected: FAIL. The existing `[approval-required]` still passes.

- [ ] **Step 3: Implement it.**
  - Update Briefing Desk's `analyst.ts`, whose `briefing.decided` handler calls `ctx.approve` or `ctx.deny`, to pass `{ by: payload.by }`.
  - Run: `npm test -w briefing-desk`
  - Expected: PASS.

- [ ] **Step 4: Add the check rule. Build and run everything.**
  - Run: `npm run build -w @actord/toolkit && (cd packages/toolkit && npx vitest run && npx vitest run --config vitest.runtime.config.ts) && npm test -w release-radar && npm test -w briefing-desk`
  - Expected: PASS.

- [ ] **Step 5: Document and commit.**
  - In `docs/wiki/Runtime.md`, add the row "An approval request expires (default 3 days); the actor receives a failed result, and a late approval does nothing".
  - Commit:

```bash
git add packages/toolkit plugins examples docs
git commit -m "Approvals expire (default 3d) and record who approved, through which sender"
```

---

### Task 9: Full verification

**Files:**
- Modify: `docs/progress.md`: what plan 1 delivered, and that plan 2 is next.
- Modify: `docs/wiki/Limitations.md`: "Container behaviour is not yet tested", unchanged; add "Approver identity is whatever the approving sender supplies until plan 2's verified sources exist".
- The verify outputs `verify-report.json` and `docs/verification-report.md`.

- [ ] **Step 1: Run the full offline lane.**
  - Run: `npm run build -w @actord/toolkit && npm run verify`
  - Expected: every gate `pass`. A gate whose prerequisite is missing may be `blocked`; no gate may `fail`.
  - Record the pass, fail and blocked counts from the report.

- [ ] **Step 2: Confirm the build is reproducible.**
  - Run: `git status --short`
  - Expected: after the build, only `verify-report.json` and `docs/verification-report.md` differ. Any `dist/` difference means an earlier task forgot to commit its build.

- [ ] **Step 3: Commit, in the repository's style for verification commits.**

```bash
git add verify-report.json docs/verification-report.md docs/progress.md docs/wiki/Limitations.md
git commit -m "Verification for plan 1 (actord on Lifecycle): <N> pass, <F> fail, <B> blocked"
```
