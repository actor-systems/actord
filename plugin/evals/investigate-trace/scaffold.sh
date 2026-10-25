#!/usr/bin/env bash
set -euo pipefail
"$(dirname "${BASH_SOURCE[0]}")/../_scaffold/project.sh" release-radar
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
mkdir -p .actord && cp "$repo/fixtures/events/release-radar-faults.ndjson" .actord/events.ndjson
