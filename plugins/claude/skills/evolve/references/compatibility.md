# What `actord diff` classes mean on Cloudflare

## Actors, messages and routes

| Change | Class | What to do |
| --- | --- | --- |
| New actor | compatible | Add its binding and `exports` entry (`storage: "sqlite"`); the namespace is provisioned on deploy |
| Removed actor | breaking, **irreversible**, needs approval | `exports.<Class>.state = "deleted"` destroys all its data, with no trash. Export data first. For a rename, use `state: "renamed"` with `renamed_to` to keep the data |
| Binding renamed | breaking | `wrangler.jsonc` and every `env` reference change together |
| New route or message | compatible | Deploy; senders start using it immediately |
| Removed route or message | breaking | Queued copies are refused after the deploy: drain first |
| Payload: new optional field; field removed from a `z.object` or `z.looseObject`; enum widened or lifted; type widened (`.nullable()`, integer → number); bound relaxed; format or pattern dropped | compatible | Every payload the old schema accepted still validates |
| Payload: new required field; field removed from a `z.strictObject`; type narrowed; enum narrowed, or a free value limited to an enum or literal; bound tightened; format or pattern added | breaking | Old copies are refused. Keep accepting the old shape, or add a new message beside the old one and retire the old one in a later deploy; otherwise drain first |
| Payload: anything `actord diff` can't decide (a changed union or pattern, a `z.object` made strict, a new field on a `z.looseObject`) | risky | Drain as if breaking, unless a test shows old copies still pass |
| Message version bump | risky | A receiver accepts one version at a time, so every queued copy of the old version is refused (`version_mismatch`): drain first |
| An actor gaining an effect | risky, needs approval | A person approves the new capability |
| Schedule change | risky | An alarm already set keeps its old time until it fires once |
| Kind changed (`actor.kind`) | risky | To model-assisted or agent, output is no longer deterministic; needs a budget and validated output |
| Budget (`actor.budget`) | compatible if every changed agent limit (`usd`, `turns`, `wallClock`) went down; otherwise risky | Any change to `maxAttempts`, `timeoutMs` or `maxTokens`, and any limit raised, added or removed (or the whole budget added or removed), is risky |
| A field `actord diff` has no rule for (`actor.changed`, `effect.changed`, `source.changed`) | risky | Check by hand how what is already in flight behaves |

## Agent actors (`agent.*`)

| Change | Class | What to do |
| --- | --- | --- |
| `agent.model` | risky; needs approval when the model id changes | Sessions already running keep the model they started with. `budget.usd` is silently unenforced for a model pi-ai doesn't price (Limitations) |
| `agent.tool.added` | risky, needs approval | The model may now call that tool |
| `agent.tool.removed` | compatible | |
| `agent.instructions` | compatible | Running sessions keep the text they started with |
| `agent.on.added`, `agent.on.removed` | risky | The actor starts, or stops, reacting to that message |
| `agent.on` (verb changed) | breaking | Messages already on their way get the new verb (`start`, `steer`, `stop`). The plan lists no drain for it: drain those messages first, or accept the new verb for them |
| `agent.harness`, `agent.returns` | risky | `actord diff` has no finer rule: check by hand how a session already running settles under the new code |

**A deploy reaches a busy agent late.** A running Durable Object keeps its version until it restarts, so a busy agent
can run the old code for minutes after the deploy (Limitations, "A deploy reaches a busy agent late"). Don't promise
the new code is live on running agents; say a restart is what rolls it out.

## Sources and approvals (`source.*`, `approvals.notify`)

| Change | Class | What to do |
| --- | --- | --- |
| `source.added` | compatible | Configure the provider (webhook URL, secret) after the deploy |
| `source.removed` | breaking | Deliveries still on their way, and the provider's calls, are refused: remove the provider's webhook too |
| `source.kind` | risky | |
| `source.path` | risky | The provider keeps calling the old path until it is reconfigured |
| `source.verify` | risky | Deliveries signed the old way are refused |
| `source.message` | risky | Email replies already on their way arrive as the old message: keep its handler |
| `source.event.added` | compatible | |
| `source.event.message` | risky | Deliveries already on their way keep the old message |
| `source.event.removed` | risky | The provider may still send it; it is then unmapped (`204`, `source.ignored`) |
| `approvals.notify` | risky | Requests already waiting were announced through the old effect |
| `system.renamed` | risky | |

## Effects (`effect.*`)

| Change | Class | What to do |
| --- | --- | --- |
| New external effect | risky, needs approval | A person approves the new capability |
| Effect removed | compatible | |
| `effect.idempotency` | risky | To `none`: lost acknowledgments become `in_doubt` |
| `effect.approval` | risky; needs approval when it becomes `none` | |
| `effect.publishes` | risky; needs approval when it becomes `true` | An email reply that isn't authenticated can no longer approve it |
| `effect.reconcile` | risky | Applies to unkeyed attempts that fail after the deploy: turned off, a lost acknowledgment is `in_doubt` at once; turned on, the adapter's `reconcile` decides. Effects already `in_doubt` stay so |
| `effect.result` | risky | In-flight outcomes use the old result message: keep its handler |
| `effect.budget` | risky | Applies from the next attempt, including retries of effects already in flight |
| `effect.expires` | risky | Approvals already waiting keep the expiry they were given |
| `effect.input` | risky | The tool parameters an agent sees changed |
| `effect.kind` | risky | Effects in flight change how they settle: a job already waiting can't be settled by `ctx.settleJob` once the effect is a call, and waits out its deadline |
| `effect.deadline` | risky | Jobs already waiting keep the deadline they started with |
| `effect.probe` | risky | Jobs already waiting keep the next look they booked |
| `effect.completes` | risky | Completions already on their way arrive as the old message, whose handler must still settle the job |
| `effect.model` | risky | Answers change, and probabilities or confidences aren't comparable across models (see below) |
| `effect.questions`, `effect.fields` | risky | Recorded answers were to the old questions or fields. Labels follow the current declaration, so `ctx.outcome` on an old record throws for a question or field that was removed |
| `effect.mode` to `act` | risky | The decision's answer is now delivered, and the actor acts on it |
| `effect.mode` to `shadow` | compatible | The answer is recorded for the scorecard and no longer delivered |

**The scorecard mixes models after a model change.** `actord scorecard` keeps one card per effect, so an effect whose
`model` changed pools both models' records under the first record's model (Limitations). To compare a new model,
add a new effect for it, in shadow, rather than changing `model` in place.

"compatible" for a payload means proven: the new schema accepts everything the old one did. It assumes
one thing: a sender didn't put undeclared fields in a `z.object` payload (which strips them).

Platform facts behind the plan:
- All actors in one Worker deploy together. The compatibility question is what's already in flight
  (outboxes, alarms, waiting jobs and approvals), not old and new code talking to each other.
- Durable Object lifecycle changes apply only through `wrangler deploy` (not `wrangler versions upload`).
  They can't be gradually deployed, and a rollback can't cross them.
- Deploys need a person's approval and Cloudflare credentials. The toolkit never deploys.
