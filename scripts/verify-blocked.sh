#!/usr/bin/env bash
# Inside the default OS sandbox (srt, the library behind Claude Code's sandbox), `actors verify` must
# report BLOCKED, with static evidence still passing, not PASS and not a product failure (decision 0004).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(uname)" = Darwin ] || { echo "skip: macOS-specific"; exit 0; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$root/scripts/scaffold-project.sh" "$tmp/starter" starter >/dev/null
jq --arg t "/private/tmp/claude-$(id -u)" '.filesystem.allowWrite += [$t]' "$root/spikes/do-messaging/sandbox/default.json" > "$tmp/srt.json"
cd "$tmp/starter"
"$root/node_modules/.bin/srt" --settings "$tmp/srt.json" -- node node_modules/.bin/actors verify || true
jq -e '.verdict == "blocked" and ([.steps[] | select(.id == "check" or .id == "typecheck") | .status] == ["pass", "pass"]) and .summary.blocked == 3' .actors/evidence.json >/dev/null
echo "verify-blocked: ok"
