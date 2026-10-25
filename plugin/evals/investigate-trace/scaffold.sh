#!/usr/bin/env bash
set -euo pipefail
"$(dirname "${BASH_SOURCE[0]}")/../_scaffold/project.sh" release-radar
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
mkdir -p .actors && cp "$repo/fixtures/events/release-radar-faults.ndjson" .actors/events.ndjson
