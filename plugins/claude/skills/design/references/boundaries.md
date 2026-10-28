# Actor, effect, source, function, Workflow, or Queue?

| If the thing… | Make it | Why |
| --- | --- | --- |
| Owns state that must be consistent and is addressed by an id (a feed, a user, an item) | **Actor** (Durable Object, SQLite storage) | One instance per id serializes access to its state |
| Needs a periodic wake | **A schedule on the actor that owns the work**: `every: "15m"` or `cron: "0 9 * * *"` (UTC), routed from `@clock` | Per instance, and only once the instance has started. A missed tick is delivered once, then the schedule re-arms from now. Lifecycle owns the object's one alarm and actord shares it, so a schedule never needs an actor of its own |
| Needs one wake later: a reminder, a timeout, a nudge | **A timer**: `ctx.after(delay, …)` or `ctx.at(epochMs, …)`, routed from `@timer` | Set only if the handler commits, survives restarts, and is handled at most once. Setting its key again or cancelling it before it fires wins |
| Is an event from outside: a GitHub webhook, the owner's email reply | **A source** (`webhook`, `inboundEmail`), routed from `@<name>` to the actor that owns the state | The toolkit's handler verifies it (a webhook's signature; an email's sender and signed token), and a redelivered webhook is a duplicate. A source is a sender, not an actor, and actors never subscribe |
| Is the Worker's own request or code reaching an actor | **A route from `@ingress`** (`ingress(...)`) | The receiver's schema and inbox validate and deduplicate it |
| Waits on outside work for minutes or hours (a CI run, a batch, a deferred response) | **A job effect** (`kind: "job"`, `deadline`, `probe`, `completes`) of the actor that wants the outcome | Started quickly and settled once: by its completion message, its probe, a cancel, or its deadline (`in_doubt`). No poller actor, and no handler that waits |
| Is a judgment with fixed answers (a route, yes or no, a 1–4 score), or typed facts pulled from text | **A decision or extraction effect** of the actor that owns the item, which can stay `deterministic` | Clef or Clairic answers with probabilities or confidences. The call is keyed and budgeted, and each confirmed answer is recorded for `actord scorecard`; `mode: "shadow"` tries a candidate without acting on it |
| Needs free-form model output (a summary, a draft), with the steps fixed | **A model effect of a `model-assisted` actor**: a call with your adapter, `budget: { maxAttempts, timeoutMs }` | The handlers keep the control flow, validate the output, and route failures to a person |
| Must choose its own steps: read and edit files, run commands, retry until done | **An `agent` actor**: a Pi session, `budget: { usd, turns, wallClock }` | It settles once, as `returns`, `agent.failed` or `agent.exhausted`. It costs the most: optional peers to install (Pi, Computer), Workers AI to run on, and container commands that don't run in tests |
| Needs a person's yes before it runs | **`approval: "human"` on the effect** (and `approvals.notify` to ask by email) | It is parked until approved, denied, or expired (`"3d"` by default). An unanswered approval fails, and a late one does nothing |
| Is a pure decision over its inputs, needing no model (validate, parse, format, price) | **Function** in `src/` | No identity, no state: an actor adds latency and failure modes for nothing |
| Is a long multi-step process with retries per step and no concurrent messages | **Cloudflare Workflow** | Durable step execution; see Cloudflare's docs |
| Is high-volume fan-out or buffering with batch consumers | **Cloudflare Queue** | Delivery is at least once, batched; an actor can consume |
| Is shared relational data read by many | **D1** | Not an actor's private state; different consistency |
| Is a large object or archive | **R2** | Objects, not records |
| Is a cache or lookup that tolerates staleness | **KV** | Eventually consistent: never for authoritative state |
| Calls an external API | **An effect of an actor** | Runs after commit, outside the transaction; its result comes back as a message |

Common over-splitting the critic will flag:
- An "Intake" or "Webhook" actor that only verifies and forwards: a source verifies, and schemas validate. Keep it
  only if it owns state (dedupe across retries from the outside world) or is the permission boundary to untrusted
  input.
- A "Scheduler" or "Timer" actor that only wakes other actors: give the owner a schedule or a timer.
- A "Classifier" or "Judge" actor that only labels another actor's items: make it a decision effect of the owner.
- A "Watcher" actor that polls an outside run: make the run a job effect with a `probe`.
- An "Approver" actor: approval is a field of the effect.
- An `agent` whose steps are known in advance: a decision effect, a job, or a `model-assisted` actor does the job
  for less.
- A "Notifier" actor per channel: notification is usually an effect of the actor that owns the finding. Split it
  out only to isolate retries or approvals from the main path.
- One actor per pipeline stage when the stages share state: merge them.

Native escape hatch: a Durable Object may stay outside `system.ts`. `actord check` warns
(`CONFIG_UNDECLARED_DO`), and nothing about it is checked or traced.
