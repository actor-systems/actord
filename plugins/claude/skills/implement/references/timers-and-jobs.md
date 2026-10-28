# Timers, schedules, jobs and approval expiry

Every wake here is a message delivered to a handler, under the same rules as any other: synchronous, and handlers
may not await I/O (`runtime.md`). The declaration the examples use:

```ts
// actord:check system
import { defineSystem, message } from "@actord/toolkit/system";
import { z } from "zod";

const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional() });
const Tick = z.object({ at: z.number() }); // a schedule's tick carries its scheduled time

export default defineSystem({
  name: "ci-watch",
  messages: {
    "run.requested": message({ version: 1, description: "Run CI for a commit", payload: z.object({ sha: z.string().min(7) }) }),
    "run.finished": message({ version: 1, description: "CI reports that a run finished", payload: z.object({ sha: z.string(), ok: z.boolean() }) }),
    "run.cancel": message({ version: 1, description: "Stop a commit's run", payload: z.object({ sha: z.string() }) }),
    "run.settled": message({ version: 1, description: "The ci.run job's outcome", payload: Outcome }),
    "run.nudge": message({ version: 1, description: "A run has been quiet for a while", payload: z.object({ sha: z.string() }) }),
    "release.approved": message({ version: 1, description: "A person approves a release", payload: z.object({ sha: z.string(), by: z.string() }) }),
    "release.published": message({ version: 1, description: "The release.publish outcome", payload: Outcome }),
    "sweep.due": message({ version: 1, description: "Every hour", payload: Tick }),
    "report.due": message({ version: 1, description: "Daily at 09:00 UTC", payload: Tick }),
  },
  actors: {
    CiWatcher: {
      binding: "CI_WATCHER",
      kind: "deterministic",
      purpose: "Runs CI for one commit (one instance per sha) and releases it once a person approves",
      justification: ["identity", "scheduling"],
      schedules: [{ every: "1h", message: "sweep.due" }, { cron: "0 9 * * *", message: "report.due" }],
      effects: ["ci.run", "release.publish"],
    },
  },
  effects: {
    "ci.run": { description: "Start a CI run, which finishes minutes later", kind: "job", idempotency: "key", deadline: "2h", probe: { every: "5m" }, completes: { message: "run.finished" }, result: "run.settled" },
    "release.publish": { description: "Publish the release", idempotency: "key", approval: "human", expires: "1d", result: "release.published" },
  },
  routes: [
    { from: "@ingress", message: "run.requested", to: "CiWatcher" },
    { from: "@ingress", message: "run.finished", to: "CiWatcher" },
    { from: "@ingress", message: "run.cancel", to: "CiWatcher" },
    { from: "@ingress", message: "release.approved", to: "CiWatcher" },
    { from: "CiWatcher", message: "run.settled", to: "CiWatcher" },
    { from: "CiWatcher", message: "release.published", to: "CiWatcher" },
    { from: "@timer", message: "run.nudge", to: "CiWatcher" },
    { from: "@clock", message: "sweep.due", to: "CiWatcher" },
    { from: "@clock", message: "report.due", to: "CiWatcher" },
  ],
});
```

```ts
// actord:check
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { actorRuntime, type EffectAdapter, type Envelope, type JobAdapter } from "@actord/toolkit/runtime";
import system from "./system";

/** start() returns a handle quickly. The outcome comes later: completion message, probe, deadline or cancel. */
const ci: JobAdapter<{ sha: string }, { runId: number }, { conclusion: string }> = {
  async start({ sha }, { key, signal }) {
    const res = await fetch("https://ci.example/runs", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ sha }), signal });
    if (!res.ok) throw new Error(`CI ${res.status}`); // keyed: retried, as a call would be
    return (await res.json()) as { runId: number };
  },
  async probe({ runId }, { signal }) {
    const run = (await (await fetch(`https://ci.example/runs/${runId}`, { signal })).json()) as { status: string; conclusion: string };
    if (run.status !== "completed") return { done: false };
    return run.conclusion === "success" ? { done: true, status: "confirmed", value: { conclusion: run.conclusion } } : { done: true, status: "failed", error: run.conclusion };
  },
  async cancel({ runId }, { signal }) {
    const res = await fetch(`https://ci.example/runs/${runId}/cancel`, { method: "POST", signal });
    return res.status === 202; // true only when CI confirms the run won't complete
  },
};

const publisher: EffectAdapter<{ sha: string }, { url: string }> = {
  async run({ sha }, { key, signal }) {
    const res = await fetch("https://releases.example/publish", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ sha }), signal });
    if (!res.ok) throw new Error(`publish ${res.status}`);
    return (await res.json()) as { url: string };
  },
};

export class CiWatcher extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS runs (sha TEXT PRIMARY KEY, status TEXT NOT NULL)");
  }

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "CiWatcher", {
    "run.requested": ({ payload: { sha } }, ctx) => {
      ctx.sql.exec("INSERT INTO runs (sha, status) VALUES (?, 'running') ON CONFLICT (sha) DO NOTHING", sha);
      ctx.effect("ci.run", { sha }, { key: sha });
      ctx.after("30m", "run.nudge", { sha }, { key: `nudge:${sha}` }); // one timer per key: setting it again replaces it
    },
    // The job's `completes` message: match it to the job's key in code, and settle it in this transaction.
    "run.finished": ({ payload }, ctx) => {
      const outcome = payload.ok ? { status: "confirmed" as const, value: { conclusion: "success" } } : { status: "failed" as const, error: "CI reported failure" };
      if (!ctx.settleJob("ci.run", payload.sha, outcome)) ctx.note("ci.run was already settled", { sha: payload.sha });
    },
    "run.cancel": ({ payload }, ctx) => {
      if (!ctx.cancelJob("ci.run", payload.sha)) ctx.note("no waiting run to cancel", { sha: payload.sha });
    },
    // Exactly one result per job, however it settled. in_doubt means the run may still finish: don't report it done.
    "run.settled": ({ payload }, ctx) => {
      ctx.cancelTimer(`nudge:${payload.key}`);
      ctx.sql.exec("UPDATE runs SET status = ? WHERE sha = ?", payload.status, payload.key);
      if (payload.status === "confirmed") ctx.effect("release.publish", { sha: payload.key }, { key: payload.key }); // parks for a person
    },
    "run.nudge": ({ payload }, ctx) => ctx.note("still waiting on CI", { sha: payload.sha }),
    "release.approved": ({ payload }, ctx) => {
      if (!ctx.approve("release.publish", payload.sha, { by: payload.by })) ctx.note("nothing waiting: already decided, or expired");
    },
    // An expired approval arrives here as failed, with "approval expired".
    "release.published": ({ payload }, ctx) => {
      ctx.sql.exec("UPDATE runs SET status = ? WHERE sha = ?", payload.status === "confirmed" ? "released" : `not released: ${payload.error ?? payload.status}`, payload.key);
    },
    "sweep.due": ({ payload }, ctx) => ctx.note("sweep", { scheduledFor: payload.at }),
    "report.due": ({ payload }, ctx) => ctx.note("daily report", { scheduledFor: payload.at }),
  }, { effects: { "ci.run": ci, "release.publish": publisher } });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
}
```

## Timers

- `ctx.after(delay, type, payload, { key })` delivers `type` to this instance after `delay`, a `Duration` (`"30m"`)
  or milliseconds. `ctx.at(epochMs, …)` does the same at a time. `ctx.cancelTimer(key)` returns `false` when nothing
  is pending under the key.
- Each needs a route `{ from: "@timer", message, to: <this actor> }`. Without it the call is a type error, and throws
  at runtime. A time that isn't a finite number at or after 0 throws.
- A timer is set only if the handler commits, survives restarts, and is handled at most once. Cancelling it, or
  setting its key again, before it fires wins. A handler that keeps failing on it is retried with backoff; after 6
  attempts the timer is dropped (`retry.exhausted`), not delivered.

## Schedules

- `schedules: [{ every: "15m", message }]` or `{ cron: "0 9 * * *", message }` (UTC), each on a route from `@clock`.
  The message's payload takes `{ at: number }`: the time the tick was due.
- Schedules are per instance. Each instance ticks once it has started, so an instance nothing has reached never
  ticks.
- A tick missed while the object slept is delivered once, with the missed time as `payload.at`, and the schedule
  re-arms from now. Missed ticks aren't replayed.

## Job effects (decision 0018)

- `kind: "job"` with a required `deadline`, and `probe: { every }`, `completes: { message }`, or both. With neither,
  every run ends in doubt (`JOB_UNOBSERVABLE`). `completes` needs a route that delivers that message to every actor
  that requests the job.
- The adapter is a `JobAdapter`: `start(input)` returns a JSON handle quickly; `probe(handle)` answers `{ done: false }`
  or `{ done: true, status, value | error }`; `cancel(handle)` returns `true` only when the destination confirms.
- It settles exactly once, and the actor gets one `result` message:
  - by `ctx.settleJob(name, key, outcome)` in the `completes` handler: as reported;
  - by a probe that reports done: as reported;
  - by its deadline: `in_doubt`, "deadline passed";
  - by `ctx.cancelJob(name, key)`: `failed` "cancelled" only when `cancel` returned `true`. Anything else (`false`, a
    throw, a timeout, no `cancel`) is `in_doubt`, "cancel not confirmed", because the work may still finish.
- `settleJob` returns `false` only when the job is already settled, already holds an earlier completion, or doesn't
  exist. A completion that arrives before the start returns is kept, and settles the job as soon as the start attempt
  finishes; the start isn't run again.
- A failing `start` follows the call rules: retried with an idempotency key, otherwise `in_doubt`.

## Parked after interruptions

A keyed effect whose attempt is cut off by a restart is retried, until its 5th interruption
(`parkAfterInterruptions`). Then it is `in_doubt` with `parked: interrupted N times without settling`, an
`effect.parked` event and its result message, and it never runs again. A cancel cut off by 5 restarts is parked the
same way (`parked: cancel interrupted N times without settling`). Handle it as any `in_doubt`: tell a person.

## Approval expiry

- An effect with `approval: "human"` waits for `ctx.approve` or `ctx.deny` until `expires` (default `"3d"`).
- When it passes, the effect is denied with "approval expired", an `effect.denied` event is emitted, and the result
  message says `failed`, even for a job whose completion arrived early. `ctx.approve` and `ctx.deny` then return
  `false`, so a late approval does nothing.
- Approvals parked by a toolkit without approval expiry (npm's 0.2.0 and earlier) have no expiry time, and are
  treated as expired on the first wake after upgrading.
- To ask by email, see `sources.md`.

## Testing

```ts
// actord:check
import { env } from "cloudflare:workers";
import { ingress } from "@actord/toolkit/runtime";
import { captureEvents, expireApprovals, expireJobs, fireTimers, overrideEffect, resetSeams, settle, tick } from "@actord/toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "./system";

afterEach(() => resetSeams());

it("[job-deadline-in-doubt] a run that never reports is in doubt at its deadline, and never released", async () => {
  overrideEffect("ci.run", { async start() { return { runId: 1 }; }, async probe() { return { done: false }; } }); // never finishes
  const events = captureEvents();
  await ingress(env, system, "CiWatcher", "run.requested", { sha: "abc1234" }, { key: "abc1234" });
  await settle(env, system);
  expect(await fireTimers(env, system, "CiWatcher", "abc1234")).toBe(1); // the nudge
  expect(await expireJobs(env, system, "CiWatcher", "abc1234")).toBe(1);
  await settle(env, system);
  expect(events.some((e) => e.kind === "effect.in_doubt" && e.effect === "ci.run" && e.reason === "deadline passed")).toBe(true);
  expect(events.some((e) => e.kind === "effect.requested" && e.effect === "release.publish")).toBe(false); // in_doubt never releases
  expect(await expireApprovals(env, system, "CiWatcher", "abc1234")).toBe(0); // nothing was parked
});

it("[schedule-tick] a scheduled tick is delivered with its time", async () => {
  overrideEffect("ci.run", { async start() { return { runId: 2 }; }, async probe() { return { done: false }; } }); // no real CI call
  await ingress(env, system, "CiWatcher", "run.requested", { sha: "def5678" }, { key: "def5678" }); // the instance must exist
  const events = captureEvents();
  await tick(env, system, "CiWatcher", "def5678", "report.due");
  expect(events.some((e) => e.kind === "note" && e.reason === "daily report" && typeof e.detail?.scheduledFor === "number")).toBe(true);
});
```

`settle` doesn't make probes or deadlines due: use `expireJobs`, or make the probe report done. `tick` and the
`expire*` helpers need an instance that has already received a message.
