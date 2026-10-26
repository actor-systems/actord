# Actor, function, Workflow, or Queue?

| If the thing… | Make it | Why |
| --- | --- | --- |
| Owns state that must be consistent and is addressed by an id (a feed, a user, an item) | **Actor** (Durable Object, SQLite storage) | One instance per id serializes access to its state |
| Needs a periodic wake | **Actor with a `schedule`** (alarm) | One alarm per instance; at least once, can be up to a minute late |
| Is a pure decision over its inputs (classify, parse, format, price) | **Function** in `src/` | No identity, no state: an actor adds latency and failure modes for nothing |
| Is a long multi-step process with retries per step and no concurrent messages | **Cloudflare Workflow** | Durable step execution; see Cloudflare's docs |
| Is high-volume fan-out or buffering with batch consumers | **Cloudflare Queue** | Delivery is at least once, batched; an actor can consume |
| Is shared relational data read by many | **D1** | Not an actor's private state; different consistency |
| Is a large object or archive | **R2** | Objects, not records |
| Is a cache or lookup that tolerates staleness | **KV** | Eventually consistent: never for authoritative state |
| Calls a model or external API | **An effect of an actor** | Runs after commit, outside the transaction; result comes back as a message |

Common over-splitting the critic will flag:
- An "Intake" actor that only validates and forwards: schemas already validate. Keep it only if it owns
  state (dedupe across retries from the outside world) or is the permission boundary to untrusted input.
- A "Notifier" actor per channel: notification is usually an effect of the actor that owns the finding.
  Split it out only to isolate retries or approvals from the main path.
- One actor per pipeline stage when the stages share state: merge them.

Native escape hatch: a Durable Object may stay outside `system.ts`. `actord check` warns
(`CONFIG_UNDECLARED_DO`), and nothing about it is checked or traced.
