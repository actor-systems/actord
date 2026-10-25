# What `actors diff` classes mean on Cloudflare

| Change | Class | What to do |
| --- | --- | --- |
| New actor | compatible | Add its binding and `exports` entry (`storage: "sqlite"`); the namespace is provisioned on deploy |
| Removed actor | breaking, **irreversible**, needs approval | `exports.<Class>.state = "deleted"` destroys all its data, with no trash. Export data first. For a rename, use `state: "renamed"` with `renamed_to` to keep the data |
| New route or message | compatible | Deploy; senders start using it immediately |
| Removed route or message | breaking | Queued copies are refused after the deploy: drain first |
| Payload: new optional field; field removed from a `z.object` or `z.looseObject`; enum widened or lifted; type widened (`.nullable()`, integer → number); bound relaxed; format or pattern dropped | compatible | Every payload the old schema accepted still validates |
| Payload: new required field; field removed from a `z.strictObject`; type narrowed; enum narrowed, or a free value limited to an enum or literal; bound tightened; format or pattern added | breaking | Old copies are refused. Keep accepting the old shape, or add a new message beside the old one and retire the old one in a later deploy; otherwise drain first |
| Payload: anything `actors diff` can't decide (a changed union or pattern, a `z.object` made strict, a new field on a `z.looseObject`) | risky | Drain as if breaking, unless a test shows old copies still pass |
| Message version bump | risky | A receiver accepts one version at a time, so every queued copy of the old version is refused (`version_mismatch`): drain first |
| New external effect, or an actor gaining one | risky, needs approval | A person approves the new capability |
| Effect loses its idempotency key | risky | Lost acknowledgments become `in_doubt` |
| Schedule change | risky | An alarm already set keeps its old time until it fires once |
| Kind becomes model-assisted or agent | risky | Output is no longer deterministic; needs a budget and validated output |

"compatible" for a payload means proven: the new schema accepts everything the old one did. It assumes
one thing: a sender didn't put undeclared fields in a `z.object` payload (which strips them).

Platform facts behind the plan:
- All actors in one Worker deploy together. The compatibility question is what's already in flight
  (outboxes, alarms), not old and new code talking to each other.
- Durable Object lifecycle changes apply only through `wrangler deploy` (not `wrangler versions upload`).
  They can't be gradually deployed, and a rollback can't cross them.
- Deploys need a person's approval and Cloudflare credentials. The toolkit never deploys.
