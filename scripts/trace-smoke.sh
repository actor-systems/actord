#!/usr/bin/env bash
# After Release Radar's suite has run, trace a real significant release from the live event log.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/examples/release-radar"
log=.actord/events.ndjson
[ -s "$log" ] || { echo "no events recorded; run the example's tests first"; exit 1; }
id="$(jq -r 'select(.type == "release.significant" and .kind == "handled") | .messageId' "$log" | head -1)"
[ -n "$id" ] || { echo "no handled release.significant in $log"; exit 1; }
out="$(node "$root/plugin/dist/actord.mjs" trace "$id")"
echo "$out"
grep -q "◀ target" <<<"$out"
grep -q "effect notify.digest .* ✓ confirmed" <<<"$out"
grep -q "@clock → FeedPoller" <<<"$out"
