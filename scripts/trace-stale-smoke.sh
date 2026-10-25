#!/usr/bin/env bash
# After Briefing Desk's suite has run, trace the model result that arrived after its item was cancelled.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/examples/briefing-desk"
log=.actord/events.ndjson
id="$(jq -r 'select(.kind == "note" and (.reason // "" | test("stale analysis ignored"))) | .messageId' "$log" | head -1)"
[ -n "$id" ] || { echo "no stale analysis recorded in $log; run the example's tests first"; exit 1; }
out="$(node "$root/plugin/dist/actord.mjs" trace "$id")"
echo "$out"
grep -q "effect model.analyze .* ✓ confirmed" <<<"$out"
grep -q "analysis.completed .* ◀ target" <<<"$out"
grep -q "stale analysis ignored (item cancelled" <<<"$out"
