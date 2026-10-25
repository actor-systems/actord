# What `actors diff` classes mean on Cloudflare

| Change | Class | What to do |
| --- | --- | --- |
| New actor | compatible | Add its binding and `exports` entry (`storage: "sqlite"`); the namespace is provisioned on deploy |
| Removed actor | breaking, **irreversible**, needs approval | `exports.<Class>.state = "deleted"` destroys all its data, with no trash. Export data first. For a rename, use `state: "renamed"` with `renamed_to` to keep the data |
| New route or message | compatible | Deploy; senders start using it immediately |
| Removed route or message | breaking | Queued copies are refused after the deploy: drain first |
| Payload: new optional field, field removed, enum widened | compatible | Old in-flight copies still validate |
| Payload: new required field, type change, enum narrowed | breaking | Bump the version, or keep accepting the old shape; drain before switching |
| Message version bump | risky | Copies of the old version are refused (`version_mismatch`) unless outboxes drain first |
| New external effect, or an actor gaining one | risky, needs approval | A person approves the new capability |
| Effect loses its idempotency key | risky | Lost acknowledgments become `in_doubt` |
| Schedule change | risky | An alarm already set keeps its old time until it fires once |
| Kind becomes model-assisted or agent | risky | Output is no longer deterministic; needs a budget and validated output |

Platform facts behind the plan:
- All actors in one Worker deploy together. The compatibility question is what's already in flight
  (outboxes, alarms), not old and new code talking to each other.
- Durable Object lifecycle changes apply only through `wrangler deploy` (not `wrangler versions upload`).
  They can't be gradually deployed, and a rollback can't cross them.
- Deploys need a person's approval and Cloudflare credentials. The toolkit never deploys.
