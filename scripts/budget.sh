#!/usr/bin/env bash
# Measure the plugin's always-on context cost with `claude plugin details`, both loaded with
# --plugin-dir and installed from the marketplace into a throwaway config. Prints JSON; exits 1 if the
# larger figure exceeds the 1,500-token limit (target: 1,000).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cfg="$(mktemp -d)"
trap 'rm -rf "$cfg"' EXIT
tokens() { grep -Eo 'Always-on:[[:space:]]+[~<]?[[:space:]]*[0-9,]+' | grep -Eo '[0-9,]+' | tr -d ,; }
dir_tok="$(cd "$cfg" && CLAUDE_CONFIG_DIR="$cfg" claude --plugin-dir "$root/plugin" plugin details actors | tokens)"
CLAUDE_CONFIG_DIR="$cfg" claude plugin marketplace add "$root" >/dev/null
CLAUDE_CONFIG_DIR="$cfg" claude plugin install actors@actors-toolkit >/dev/null
details="$(CLAUDE_CONFIG_DIR="$cfg" claude plugin details actors)"
inst_tok="$(tokens <<<"$details")"
max=$(( dir_tok > inst_tok ? dir_tok : inst_tok ))
mkdir -p "$root/docs/evidence"
printf '%s\n' "$details" > "$root/docs/evidence/plugin-details.txt"
printf '{"pluginDir":%s,"installed":%s,"max":%s,"target":1000,"limit":1500}\n' "$dir_tok" "$inst_tok" "$max"
[ "$max" -le 1500 ]
