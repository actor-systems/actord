#!/usr/bin/env bash
# The model-backed release lane (owner-approved; spends real usage). One full run of the eval suite with
# pinned models, a cost ceiling, no publishing, and kept workspaces, then a host re-run of each workspace's
# runtime verification (decision 0004). Results: docs/evidence/evals/<label>.json and <label>.host.json.
#   eval-suite.sh <label> <max-cost-usd> [case-glob] [subdir]
# A case glob re-measures one case (after a documented grader correction) into docs/evidence/evals/<subdir>.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
label="${1:?label}"
ceiling="${2:?max cost in USD}"
case_args=()
[ -n "${3:-}" ] && case_args=(--case "$3")
dir="$root/docs/evidence/evals${4:+/$4}"
mkdir -p "$dir"
out="$dir/$label.json"
log="$dir/$label.log"
cd "$root"
claude plugin eval plugin ${case_args[@]+"${case_args[@]}"} --scaffold --no-publish --trust-plugin --keep-temp \
  --model claude-sonnet-5-5 --judge-model claude-haiku-5-5 --max-cost-usd "$ceiling" -j 4 \
  --allow-tools Write Edit "Bash(actord *)" "Bash(npx actord *)" "Bash(npx --no-install actord *)" "Bash(*/bin/actord *)" "Bash(npm run *)" "Bash(npm test*)" \
  "Bash(npx vitest *)" "Bash(npx tsc *)" "Bash(git diff*)" "Bash(git status*)" "Bash(git log*)" \
  "Bash(git show*)" "Bash(git ls-files*)" "Bash(ls*)" "Bash(cat *)" "Bash(head *)" "Bash(tail *)" "Bash(wc *)" \
  "Bash(cd *)" "Bash(grep *)" "Bash(find *)" "Bash(sed *)" "Bash(mkdir *)" "Bash(mv *)" "Bash(cp *)" \
  "Bash(echo *)" "Bash(printf *)" "Bash(test *)" "Bash(python3 *)" "Bash(which *)" \
  --json "$out" 2>"$log"
status=$?
"$root/scripts/rerun-eval-workspaces.sh" "$out" "$dir/$label.host.json"
jq -r '"\(.aggregates.casesPassed)/\(.aggregates.casesTotal) cases at threshold · score \(.aggregates.overallScore) · mean Δ \(.aggregates.meanDelta) · $\(.costUsd) · partial \(.partial)"' "$out"
jq -r '.cases[] | "  \(.name)  with \(.aggregates.score)  without \(.aggregates.scoreWithout // "-")  Δ \(.aggregates.delta // "-")"' "$out"
exit "$status"
