#!/usr/bin/env bash
set -euo pipefail
"$(dirname "${BASH_SOURCE[0]}")/../_scaffold/project.sh" release-radar

# Each patch must match exactly once: a pattern the example no longer contains fails the scaffold,
# instead of leaving the regression out and the case grading an unbroken project.
python3 - <<'PY'
import sys

def patch(path, old, new):
    s = open(path).read()
    n = s.count(old)
    if n != 1:
        sys.exit(f"recover-duplicate-notify scaffold: expected 1 match in {path}, found {n}: {old[:80]!r}")
    open(path, "w").write(s.replace(old, new))

patch("src/actors/release-ledger.ts",
      '      const seen = ctx.sql.exec("SELECT 1 FROM releases WHERE item_id = ?", payload.itemId).toArray().length > 0;\n      if (seen) return ctx.note("already recorded", { itemId: payload.itemId });\n',
      "")
patch("src/actors/release-ledger.ts",
      '"INSERT INTO releases (item_id, feed_id, version, title, severity, reason, first_seen_message) VALUES (?, ?, ?, ?, ?, ?, ?)"',
      '"INSERT OR REPLACE INTO releases (item_id, feed_id, version, title, severity, reason, first_seen_message) VALUES (?, ?, ?, ?, ?, ?, ?)"')
patch("src/actors/digest-writer.ts",
      '"release.significant": ({ payload }, ctx) => {',
      '"release.significant": ({ id, payload }, ctx) => {')
patch("src/actors/digest-writer.ts", "{ key: payload.itemId }", "{ key: id }")
PY
git add -A && git -c user.name=scaffold -c user.email=scaffold@example.invalid commit -q -m "a regression"
