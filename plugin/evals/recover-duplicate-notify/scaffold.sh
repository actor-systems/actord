#!/usr/bin/env bash
set -euo pipefail
"$(dirname "${BASH_SOURCE[0]}")/../_scaffold/project.sh" release-radar

python3 - <<'PY'
import re
p = "src/actors/release-ledger.ts"; s = open(p).read()
s = s.replace('      const seen = ctx.sql.exec("SELECT 1 FROM releases WHERE item_id = ?", payload.itemId).toArray().length > 0;\n      if (seen) return ctx.note("already recorded", { itemId: payload.itemId });\n', "")
s = s.replace('"INSERT INTO releases (item_id, feed_id, version, title, severity, reason, first_seen_message) VALUES (?, ?, ?, ?, ?, ?, ?)"', '"INSERT OR REPLACE INTO releases (item_id, feed_id, version, title, severity, reason, first_seen_message) VALUES (?, ?, ?, ?, ?, ?, ?)"')
open(p, "w").write(s)
p = "src/actors/digest-writer.ts"; s = open(p).read()
s = s.replace('"release.significant": ({ payload }, ctx) => {', '"release.significant": ({ id, payload }, ctx) => {')
s = s.replace("{ key: payload.itemId }", "{ key: id }")
open(p, "w").write(s)
PY
git add -A && git -c user.name=scaffold -c user.email=scaffold@example.invalid commit -q -m "a regression"
