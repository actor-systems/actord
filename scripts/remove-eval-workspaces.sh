#!/usr/bin/env bash
# Removes the workspaces an eval run kept with `claude plugin eval --keep-temp`, once the host re-run has read
# them: a full run keeps about 80 GB. Each is found from its tracePath (<kept>/out/trace.jsonl), and only a real
# directory (not a symlink) named e-*, under /tmp or $TMPDIR, that holds that trace is removed, so a tracePath
# pointing anywhere else is left alone. The runner seals each kept directory read-only, so write access is restored
# first.
#   remove-eval-workspaces.sh <eval-result.json>
set -uo pipefail
result="$1"
removed=0
left=0
tmp="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)"
while IFS= read -r trace; do
  kept="$(dirname "$(dirname "$trace")")"
  case "$(basename "$kept")" in e-*) ;; *) continue ;; esac
  [ -d "$kept" ] && [ ! -L "$kept" ] && [ -f "$kept/out/trace.jsonl" ] || continue
  real="$(cd "$kept" && pwd -P)"
  case "$real" in /tmp/* | /private/tmp/* | "${tmp:-/nonexistent}"/*) ;; *) continue ;; esac
  chmod -R u+rwx "$kept" 2>/dev/null
  rm -rf "$kept"
  if [ -e "$kept" ]; then left=$((left + 1)); else removed=$((removed + 1)); fi
done < <(jq -r '.cases[] | (.arms // {})[] | .[] | .tracePath // empty' "$result" | sort -u)
if [ "$left" -gt 0 ]; then
  echo "removed $removed kept eval workspaces; $left could not be removed" >&2
  exit 1
fi
echo "removed $removed kept eval workspaces"
