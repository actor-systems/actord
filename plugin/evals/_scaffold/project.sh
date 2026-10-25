#!/usr/bin/env bash
# Shared scaffold for eval cases: builds the named project in the current (empty) workspace, offline.
# Runs outside the agent's sandbox, from this repository (cases are evaluated in place: `claude plugin eval plugin`).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
"$repo/scripts/scaffold-project.sh" "$PWD" "$@" >/dev/null
