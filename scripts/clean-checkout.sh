#!/usr/bin/env bash
# The clean-checkout path CI takes, run locally: clone HEAD into a temporary directory, install from the
# lockfile, confirm the build reproduces the committed plugin/dist, and run the full offline verification.
# Needs the npm registry (or its cache); no credentials, no model calls.
set -euo pipefail
# Under `npm run verify`, npm 11 exports the user's allow-scripts setting as npm_config_allow_scripts, and a
# nested project-scoped `npm ci` refuses it as a command-line option (EALLOWSCRIPTS). Read from .npmrc, the
# same setting is accepted, so drop only the exported copy: the clone then installs as it would directly.
unset npm_config_allow_scripts
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
step() { printf '%s\n' "== $*"; }
step "clone $(git -C "$root" log --oneline -1)"
git clone -q "$root" "$work/repo"
cd "$work/repo"
step "npm ci"
npm ci --no-audit --no-fund --silent
step "build reproduces plugin/dist"
npm run --silent build -w actors-toolkit
git diff --exit-code --stat -- plugin/dist plugin/hooks/effect-patterns.ts
step "npm run verify"
status=0
npm run --silent verify >verify.log 2>&1 || status=$?
tail -12 verify.log
# Keep the clone's evidence either way: a failure here is a finding about the clean checkout.
cp verify-report.json "$root/docs/evidence/clean-checkout-verify-report.json"
cp docs/verification-report.md "$root/docs/evidence/clean-checkout-verification-report.md"
# The offline workflow must reproduce: any failing check that ran here fails the lane. Checks that read the
# owner's recorded evidence (model-backed eval runs, interactive acceptance) are the same files in every
# checkout, so they're reported here, not re-judged.
offline="$(jq -r '[.checks[] | select(.status == "fail" and .evidenceSource != "eval-run" and .evidenceSource != "recorded-acceptance") | .id] | join(", ")' verify-report.json)"
recorded="$(jq -r '[.checks[] | select(.status == "fail" and (.evidenceSource == "eval-run" or .evidenceSource == "recorded-acceptance")) | .id] | join(", ")' verify-report.json)"
[ -z "$recorded" ] || echo "clean-checkout: recorded-evidence checks failing (same as the source tree): $recorded"
[ -z "$offline" ] || { echo "clean-checkout: offline checks failed in the clean clone: $offline (exit $status); see docs/evidence/clean-checkout-verification-report.md"; exit 1; }
echo "clean-checkout: ok"
