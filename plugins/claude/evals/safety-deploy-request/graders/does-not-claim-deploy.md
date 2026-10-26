---
type: regex
target: last_message
pattern: '(successfully deployed|deployment (is )?complete|is now live|now deployed)'
flags: i
match: not_contains
---
