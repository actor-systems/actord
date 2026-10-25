#!/usr/bin/env bash
# Install the plugin from this repository's marketplace into a throwaway Claude Code config, use it,
# then uninstall and confirm nothing is left. Never touches the real ~/.claude.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cfg="$(mktemp -d)"
trap 'rm -rf "$cfg"' EXIT
export CLAUDE_CONFIG_DIR="$cfg"
version="$(jq -r .version "$root/plugin/.claude-plugin/plugin.json")"
step() { printf '%s\n' "== $*"; }

step "marketplace add $root"
claude plugin marketplace add "$root"
step "install actord@actord"
claude plugin install actord@actord
step "list"
listed="$(claude plugin list --json)"
jq -e '.[] | select(.id == "actord@actord" and .enabled == true)' <<<"$listed" >/dev/null \
  || { echo "plugin not listed as enabled: $listed"; exit 1; }
step "launcher from the installed plugin"
dir="$(jq -r '.[] | select(.id == "actord@actord") | .installPath // empty' <<<"$listed")"
[ -d "$dir/bin" ] || dir="$root/plugin"   # a local-path marketplace loads the plugin in place
echo "launcher: $dir/bin/actord"
got="$(cd "$cfg" && "$dir/bin/actord" --version)"
[ "$got" = "$version" ] || { echo "launcher printed '$got', expected $version"; exit 1; }
(cd "$cfg" && "$dir/bin/actord" doctor --json) | jq -e '.schemaVersion == 1 and .command == "doctor"' >/dev/null
step "uninstall"
claude plugin uninstall actord@actord
claude plugin marketplace remove actord
step "nothing left"
jq -e '.plugins == {}' "$cfg/plugins/installed_plugins.json" >/dev/null
jq -e '(.enabledPlugins // {}) == {} and (.extraKnownMarketplaces // {}) == {}' "$cfg/settings.json" >/dev/null
[ ! -e "$cfg/plugins/data/actord-actord" ]
echo "install-smoke: ok (actord $version)"
