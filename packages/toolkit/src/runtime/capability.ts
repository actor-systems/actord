// actord as one capability on the Agents SDK's Lifecycle, which owns the Durable Object's single alarm.
// actord keeps its own rows (outbox, schedule) and asks Lifecycle for one job, "actord", due at the
// earliest of them; other capabilities, such as harnesses, push their own jobs onto the same alarm.
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";

export const ACTORD_JOB_ID = "actord";
/**
 * How soon the actord job runs again after a dispatch whose drive hasn't re-armed it: drive() normally re-arms it
 * first, and this only wakes an object whose drive failed, or was lost with its isolate.
 */
const BACKSTOP_MS = 30_000;

interface ActordHooks {
  start(): Promise<void>;
  drive(): Promise<void>;
  /** Record a drive, or a dispatch, that failed; the backstop runs it again. */
  failed(error: unknown): void;
}

export class ActordCapability extends LifecycleCapability {
  readonly #hooks: ActordHooks;

  constructor(hooks: ActordHooks) {
    super("actord");
    this.#hooks = hooks;
  }

  onStart(): Promise<void> {
    return this.#hooks.start();
  }

  /**
   * Bounded: the drive is handed to Lifecycle as alarm work and runs on in the background, so a harness's job on
   * the same alarm never waits on actord's ticks, timers or deliveries. Decision 0016 §3.
   */
  async onJob(ctx: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (ctx.job.fn !== "drive") return;
    const work = this.#hooks.drive().catch((err: unknown) => this.#hooks.failed(err));
    // Outside an alarm there is no alarm work to join, so wait as before.
    if (!this.lifecycle.trackAlarmWork(work)) await work;
    // drive() re-arms or cancels the job through arm(), and Lifecycle lets that newer intent win over this outcome.
    // Only a drive that failed, or never got that far, leaves the backstop in place.
    return { rescheduleAt: Date.now() + BACKSTOP_MS };
  }

  /** A dispatch that failed every retry keeps the job, at the backstop, instead of letting Lifecycle delete it. */
  onJobError(_ctx: LifecycleJobContext, error: unknown): LifecycleJobOutcome {
    this.#hooks.failed(error);
    return { rescheduleAt: Date.now() + BACKSTOP_MS };
  }

  /** Point the one actord job at `when`, or cancel it when nothing is due. */
  async arm(when: number | null): Promise<void> {
    if (when === null) {
      await this.lifecycle.jobs.cancel(ACTORD_JOB_ID);
      return;
    }
    if (this.lifecycle.jobs.get(ACTORD_JOB_ID)?.time === when) return;
    await this.lifecycle.jobs.push({ id: ACTORD_JOB_ID, fn: "drive", time: when });
  }

  /** Run Lifecycle's startup if nothing has yet: native RPC and test helpers bypass it. */
  ready(): Promise<void> {
    return this.lifecycle.ready();
  }
}
