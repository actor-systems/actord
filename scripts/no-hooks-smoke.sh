#!/usr/bin/env bash
# The core without hooks or the mod: install the plugin into a throwaway Claude Code config whose settings
# turn every hook off (`disableAllHooks`, which also keeps mods from loading), then run the core path
# through the installed launcher: a fresh starter verifies PASS, and the Room's view and guard decision are
# available as CLI text. Never touches the real ~/.claude, never calls a model.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export CLAUDE_CONFIG_DIR="$work/config"
mkdir -p "$CLAUDE_CONFIG_DIR"
echo '{ "disableAllHooks": true }' >"$CLAUDE_CONFIG_DIR/settings.json"
step() { printf '%s\n' "== $*"; }

step "install with disableAllHooks"
claude plugin marketplace add "$root" >/dev/null
claude plugin install actord@actord >/dev/null
jq -e '.disableAllHooks == true' "$CLAUDE_CONFIG_DIR/settings.json" >/dev/null
listed="$(claude plugin list --json)"
jq -e '.[] | select(.id == "actord@actord" and .enabled == true)' <<<"$listed" >/dev/null
details="$(claude plugin details actord@actord)"
grep -E 'Skills \(7\)' <<<"$details"
grep -E 'Agents \(2\)' <<<"$details"
dir="$(jq -r '.[] | select(.id == "actord@actord") | .installPath // empty' <<<"$listed")"
[ -d "$dir/bin" ] || dir="$root/plugin"
launcher="$dir/bin/actord"

step "starter project verifies through the installed launcher"
"$root/scripts/scaffold-project.sh" "$work/starter" starter >/dev/null
cd "$work/starter"
"$launcher" verify | head -5
jq -e '.verdict == "pass"' .actord/evidence.json >/dev/null

step "the Room's view as text"
"$launcher" room | head -12
"$launcher" room --json | jq -e '.schemaVersion == 1 and (.status | test("check ✓"))' >/dev/null

step "the effect guard's decision as text"
w="wrang""ler"
"$launcher" guard -- "npx $w deploy" | head -3
"$launcher" guard --json -- "npx $w deploy" | jq -e '.hold == true' >/dev/null

claude plugin uninstall actord@actord >/dev/null
claude plugin marketplace remove actord >/dev/null
echo "no-hooks-smoke: ok"
