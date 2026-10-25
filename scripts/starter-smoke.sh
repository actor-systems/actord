#!/usr/bin/env bash
# A fresh starter project, scaffolded offline from the plugin's own `actors init`, must verify PASS.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$(mktemp -d)/starter"
trap 'rm -rf "$(dirname "$dir")"' EXIT
"$root/scripts/scaffold-project.sh" "$dir" starter
cd "$dir"
node node_modules/.bin/actors verify
jq -e '.verdict == "pass" and .summary.provedLocally == 3' .actors/evidence.json >/dev/null
# verify needs neither npm nor npx: eval sandboxes refuse to start them from a child process.
env PATH=/usr/bin:/bin "$(command -v node)" node_modules/.bin/actors verify >/dev/null
jq -e '.verdict == "pass" and ([.steps[].status] == ["pass", "pass", "pass"])' .actors/evidence.json >/dev/null
# Generating again changes nothing and never overwrites: init refuses, adopt creates nothing.
if node node_modules/.bin/actors init . >/dev/null 2>&1; then echo "init overwrote a project"; exit 1; fi
node node_modules/.bin/actors init --adopt --json | jq -e '.created == []' >/dev/null
echo "starter-smoke: ok"
