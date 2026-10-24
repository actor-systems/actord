# Progress — Actor-Native Cloudflare Toolkit v0.1

Read this file and `docs/decisions/` before doing anything else when resuming.
Authoritative intent: `docs/charter.md`. Gate evidence: `verify-report.json` / `docs/verification-report.md`.

## Current gate
**G0 — Ground truth** (in progress)

## Done
- Guardrails: `.claude/settings.json` deny/ask rules, probed in-session (decision 0001).

## Next
- G0: compatibility notes, DO + messaging spike, workerd-in-sandbox spike, tooling decision, CF plugin decision.

## Open issues
- (none yet)

## Standing constraints (from the owner)
- Ask before: any deploy, real credentials, publishing/submitting, contacting external services
  (beyond reading docs and installing npm packages), and any model-backed `claude plugin eval` run.
- Eval budget: total ceiling $50, `--max-cost-usd` on every run, always `--no-publish`.
- Blocked ≠ passed. Evidence = commands actually run, recorded in the verification report.
