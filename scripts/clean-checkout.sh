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
npm run --silent verify | tail -12
cp verify-report.json "$root/docs/evidence/clean-checkout-verify-report.json"
echo "clean-checkout: ok"
