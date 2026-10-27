# Spike 4: a long agent run through a deploy and an eviction

**Run:** 2026-10-27, 19:27–20:25 UTC, on the `spike-agent-workspace` Worker (Workers Paid).
- **The container:** one `standard-2` container, runtime `2521bbf8`, kept the whole time.
- **The model:** Workers AI's `@cf/deepseek-ai/deepseek-v4.1-flash-1017` through `PiHarness`.
- **The tools:** Computer's Pi tools on a Computer `Workspace` whose backend is that container.
- **The code:** `spikes/agent-workspace/src/index.ts`, `POST /long`, as `spikes/agent-workspace/README.md` describes.

**The task.** `/long` plants a `TODO(spike-4)` comment at the top of 30 files under `packages/toolkit/src`. It asks Pi to
resolve them one file at a time, running `npm test -w @actord/toolkit` after each. The prompt also says: "If a command is
interrupted, or fails for a reason that isn't your change, run it again." A watchdog alarm snapshots the workspace every
minute.

**Three runs.** The README planned one run, with a redeploy about 10 minutes in and an eviction about 20 minutes in.
The model finished the whole task in 16 to 17 minutes, so the first two runs ended undisturbed, and the third took both
disruptions.

Ruling: R27/R28 — spike 4 ran `/long` three times and moved the disruptions into the third run's window, because DeepSeek Flash finishes the task in about 16 minutes, sooner than the planned 10/20-minute disruptions could land — cost if wrong: about $0.15 of model spend and 35 minutes of container time beyond the plan.

## The runs

| Run | Window (UTC) | Responses | Spend | Result | Disruptions |
| --- | --- | --- | --- | --- | --- |
| job 9 | 19:27:39–19:43:39 | 70 | $0.038 | 30 of 30 TODOs, suite 209/209 | none |
| job 10 | 19:44:36–20:01:36 | 65 | $0.067 | 30 of 30, suite 209/209 | none; the redeploy landed at 20:07, after it |
| job 11 | 20:07:40–20:24:40 | 65 | $0.086 | 30 of 30, suite 209/209 and `tsc --noEmit` clean | a deploy reached it mid-run; an eviction during a command |

Each test run took 23 to 25 seconds, and a command was running about three quarters of the time.

## Run 3

### The deploy

- **The deploy.** The owner deployed version `fdfc2dfd` at 20:07:02.
- **The start.** Run 3 started 38 seconds later on the old version, `d7db0c70` (boot 3).
- **The restart.** The new version reached the object at 20:12:13 (boot 4), five minutes after the deploy and mid-run.
- **Between commands.** Exec 105 completed on boot 3 with exit 0, and exec 106 started on boot 4.
- **Pi.** It recorded no interrupted tool call or model call at that restart. Its first model response on the new boot
  came at 20:12:15.

A second deploy, `4d43af7b`, went out at 20:15:10 while a command ran. The object was still on boot 4 at the eviction 56
seconds later, so that deploy hadn't reached it yet.

This matches Cloudflare's description. A deploy restarts every Durable Object, but in-flight requests and WebSockets keep
running on the old version, so "new code reaches a busy sandbox late"
(https://developers.cloudflare.com/sandbox/concepts/lifetime/).

Earlier in the session the object stayed on its first version through several deploys and secret changes, each for two
or three minutes, until the spike evicted it. A deploy is not a way to roll code out to a running agent on any schedule.
`/evict` (`ctx.abort()`) is, and every boot after an eviction ran the newest version.

### The eviction

The spike evicted at 20:16:06, while exec 113 (a test run) had been running for 15 seconds.

| Question | Observed | Result |
| --- | --- | --- |
| Did the object come back? | Boot 5, version `4d43af7b`, at 20:16:12, six seconds after the eviction. The container kept running. | pass |
| Did the command come back interrupted, or run again? | Interrupted. Exec 113 never got a result. Pi's tool result, written at 20:16:12 on the new boot, was `isError: true` with `<harness>[error] Tool exec was interrupted and may have partially run</harness>`, and the diagnostic code was `interrupted`. Nothing ran it again by itself. | **in doubt, reported honestly** |
| Did Pi resume by itself, and how long was the gap? | Yes. Its next response at 20:16:15 said "The test command was interrupted; re-running it (no file change since)", and exec 114 ran the same command from 20:16:14. The gap from eviction to the next command was 8 seconds. | pass |
| Was a workspace edit lost? | No. The snapshot before the eviction (20:16:03) and the next tick (20:16:40) have the same workspace diff: SHA-256 `4deb5811…`, 12,790 bytes, 21 changed files, 15 TODOs left. | **pass** |
| Was a sync left pending? | No. Every snapshot's Computer sync operations were empty, before and after. Exec 114's sync completed (24 applied), like every other exec's. | pass |

## What this changes in the toolkit (Task 9 follow-up)

Ruling: no `pull()` before an agent session resumes. Across an eviction during a command, no edit was lost and no sync was pending. The interrupted command is the only in-doubt part, Pi already tells the model it "may have partially run", and the next exec's sync brings back whatever it wrote — cost if wrong: after an eviction, a read tool could see a file as it was before an interrupted command wrote it, until the next exec.

Not observed: whether exec 113's process kept running in the container after the object went away. Computer's record of
it ends at the eviction.

## Cost

About $0.19 of model spend for the three runs, at pi's list-price accounting. Container time was about 60 minutes of
`standard-2`, roughly $0.13 at most.
