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
step "install actors@actors-toolkit"
claude plugin install actors@actors-toolkit
step "list"
listed="$(claude plugin list --json)"
jq -e '.[] | select(.id == "actors@actors-toolkit" and .enabled == true)' <<<"$listed" >/dev/null \
  || { echo "plugin not listed as enabled: $listed"; exit 1; }
step "launcher from the installed plugin"
dir="$(jq -r '.[] | select(.id == "actors@actors-toolkit") | .installPath // empty' <<<"$listed")"
[ -d "$dir/bin" ] || dir="$root/plugin"   # a local-path marketplace loads the plugin in place
echo "launcher: $dir/bin/actors"
got="$(cd "$cfg" && "$dir/bin/actors" --version)"
[ "$got" = "$version" ] || { echo "launcher printed '$got', expected $version"; exit 1; }
(cd "$cfg" && "$dir/bin/actors" doctor --json) | jq -e '.schemaVersion == 1 and .command == "doctor"' >/dev/null
step "uninstall"
claude plugin uninstall actors@actors-toolkit
claude plugin marketplace remove actors-toolkit
step "nothing left"
jq -e '.plugins == {}' "$cfg/plugins/installed_plugins.json" >/dev/null
jq -e '(.enabledPlugins // {}) == {} and (.extraKnownMarketplaces // {}) == {}' "$cfg/settings.json" >/dev/null
[ ! -e "$cfg/plugins/data/actors-actors-toolkit" ]
echo "install-smoke: ok (actors $version)"
