#!/usr/bin/env bash
# Re-run runtime verification on the workspaces of an eval run kept with `claude plugin eval --keep-temp`,
# outside the sandbox, and label the evidence as coming from the host (decision 0004). Eval runs deny the
# loopback port workerd needs, so inside them runtime claims are `blocked`; this shows what the tests say.
# Each run's workspace is found from its tracePath (<kept>/out/trace.jsonl); the runner keeps it sealed
# and read-only (<kept>/sealed/home/cwd) and asks that nothing load configuration inside the kept
# directory, so each workspace is cloned out (without .git) and verified in the copy.
#   rerun-eval-workspaces.sh <eval-result.json> <out.host.json>
set -uo pipefail
result="$1"
out="$2"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home/.config"
# Verification is local, so it runs under an allowlisted environment: node's directory and the system's tools on
# PATH, an empty HOME and config directory, and TMPDIR. A Cloudflare credential under any name stays behind, so a
# workspace whose tests open a remote binding (Workers AI) fails here instead of calling Cloudflare on the owner's
# account. `actord verify` starts neither npm nor npx, so no npm settings are needed.
clean=(env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" TMPDIR="${TMPDIR:-/tmp}")
rows="$work/rows.ndjson"
: >"$rows"
jq -r '.cases[] | .name as $c | (.arms // {}) | to_entries[] | .key as $arm | .value | to_entries[] | "\($c)\t\($arm)\t\(.key)\t\(.value.tracePath // "")"' "$result" |
  while IFS=$'\t' read -r case arm index trace; do
    kept="$(dirname "$(dirname "$trace")")"
    [ -n "$trace" ] && [ -d "$kept" ] || continue
    chmod 700 "$kept" "$kept/sealed" 2>/dev/null || true
    ws="$kept/sealed/home/cwd"
    if [ ! -f "$ws/system.ts" ]; then
      printf '{"case":"%s","arm":"%s","run":%s,"host":null,"note":"no actor project in the workspace"}\n' "$case" "$arm" "$index" >>"$rows"
      continue
    fi
    copy="$work/$case-$arm-$index"
    rsync -a --exclude .git "$ws/" "$copy/"
    sandbox="$(jq -r '.verdict // "none"' "$copy/.actord/evidence.json" 2>/dev/null || echo none)"
    (cd "$copy" && "${clean[@]}" node node_modules/.bin/actord verify --out .actord/evidence.host.json >/dev/null 2>&1)
    host="$(jq -c '{verdict, summary, tests: (.steps[] | select(.id == "tests") | .summary)}' "$copy/.actord/evidence.host.json" 2>/dev/null || echo null)"
    failed="$(jq -c '[.testResults[]?.assertionResults[]? | select(.status == "failed") | .fullName]' "$copy/.actord/vitest-results.json" 2>/dev/null || echo '[]')"
    printf '{"case":"%s","arm":"%s","run":%s,"sandbox":"%s","host":%s,"failedTests":%s}\n' "$case" "$arm" "$index" "$sandbox" "$host" "$failed" >>"$rows"
    printf '%-30s %-8s #%s sandbox=%-8s host=%s\n' "$case" "$arm" "$index" "$sandbox" "$(jq -r '.verdict // "-"' <<<"$host")"
    # Each copy is about as large as its workspace, so it goes once its row is written, not at exit.
    rm -rf "$copy"
  done
jq -s '.' "$rows" >"$out"
