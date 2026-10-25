#!/usr/bin/env bash
# The clean-checkout path CI takes, run locally: clone HEAD into a temporary directory, install from the
# lockfile, confirm the build reproduces the committed plugin/dist, and run the full offline verification.
# Needs the npm registry (or its cache); no credentials, no model calls.
set -euo pipefail
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
[ "$status" -eq 0 ] || { echo "clean-checkout: verify failed (exit $status); see docs/evidence/clean-checkout-verification-report.md"; exit "$status"; }
echo "clean-checkout: ok"
