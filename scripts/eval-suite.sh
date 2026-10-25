#!/usr/bin/env bash
# The model-backed release lane (owner-approved; spends real usage). One full run of the eval suite with
# pinned models, a cost ceiling, no publishing, and kept workspaces, then a host re-run of each workspace's
# runtime verification (decision 0004). Results: docs/evidence/evals/<label>.json and <label>.host.json.
#   eval-suite.sh <label> <max-cost-usd>
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
label="${1:?label}"
ceiling="${2:?max cost in USD}"
out="$root/docs/evidence/evals/$label.json"
log="$root/docs/evidence/evals/$label.log"
cd "$root"
claude plugin eval plugin --scaffold --no-publish --trust-plugin --keep-temp \
  --model claude-sonnet-5-5 --judge-model claude-haiku-5-5 --max-cost-usd "$ceiling" -j 4 \
  --allow-tools Write Edit "Bash(actors *)" "Bash(npx actors *)" "Bash(npm run *)" "Bash(npm test*)" \
  "Bash(npx vitest *)" "Bash(npx tsc *)" "Bash(git diff*)" "Bash(git status*)" "Bash(git log*)" \
  "Bash(git show*)" "Bash(git ls-files*)" "Bash(ls*)" "Bash(cat *)" "Bash(head *)" "Bash(tail *)" "Bash(wc *)" \
  --json "$out" 2>"$log"
status=$?
"$root/scripts/rerun-eval-workspaces.sh" "$out" "$root/docs/evidence/evals/$label.host.json"
jq -r '"\(.aggregates.casesPassed)/\(.aggregates.casesTotal) cases at threshold · score \(.aggregates.overallScore) · mean Δ \(.aggregates.meanDelta) · $\(.costUsd) · partial \(.partial)"' "$out"
jq -r '.cases[] | "  \(.name)  with \(.aggregates.score)  without \(.aggregates.scoreWithout // "-")  Δ \(.aggregates.delta // "-")"' "$out"
exit "$status"
