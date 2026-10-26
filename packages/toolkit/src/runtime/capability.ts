// actord as one capability on the Agents SDK's Lifecycle, which owns the Durable Object's single alarm.
// actord keeps its own rows (outbox, schedule) and asks Lifecycle for one job, "actord", due at the
// earliest of them; other capabilities, such as harnesses, push their own jobs onto the same alarm.
import { LifecycleCapability, type LifecycleJobContext } from "agents/lifecycle";

export const ACTORD_JOB_ID = "actord";

export class ActordCapability extends LifecycleCapability {
  readonly #hooks: { start(): Promise<void>; drive(): Promise<void> };

  constructor(hooks: { start(): Promise<void>; drive(): Promise<void> }) {
    super("actord");
    this.#hooks = hooks;
  }

  onStart(): Promise<void> {
    return this.#hooks.start();
  }

  /** Bounded: drive() starts effects in the background and returns. */
  async onJob(ctx: LifecycleJobContext): Promise<void> {
    // drive() re-arms the job through arm(); a same-id push made during dispatch supersedes this
    // dispatch's result, so returning nothing doesn't delete the job it just re-armed.
    if (ctx.job.fn === "drive") await this.#hooks.drive();
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
