---
type: regex
target: { source: file, path: src/actors/release-ledger.ts }
pattern: 'SELECT 1 FROM releases WHERE item_id|already recorded|ON CONFLICT \(item_id\) DO NOTHING RETURNING'
---
