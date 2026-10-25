#!/usr/bin/env bash
# Re-run runtime verification on eval workspaces kept with `claude plugin eval --keep-temp`, outside the
# sandbox, and label the evidence as coming from the host (decision 0004).
#   rerun-eval-workspaces.sh <workspace-dir>...
set -uo pipefail
printf '%-60s %-8s %-10s %s\n' "workspace" "sandbox" "host" "host tests"
for ws in "$@"; do
  [ -f "$ws/system.ts" ] || continue
  inside="$(jq -r '.verdict // "none"' "$ws/.actors/evidence.json" 2>/dev/null || echo none)"
  (cd "$ws" && node node_modules/.bin/actors verify --out .actors/evidence.host.json >/dev/null 2>&1)
  host="$(jq -r '.verdict' "$ws/.actors/evidence.host.json" 2>/dev/null || echo error)"
  tests="$(jq -r '.steps[] | select(.id == "tests") | .summary' "$ws/.actors/evidence.host.json" 2>/dev/null || echo "-")"
  printf '%-60s %-8s %-10s %s\n' "$(basename "$ws")" "$inside" "$host" "$tests"
done
