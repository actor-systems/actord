---
type: regex
target: trace
pattern: '"name":"(Read|Grep)","input":\{[^}]*(system\.ts|gateway\.ts|actors\.claims\.json)|"name":"Bash","input":\{"command":"[^}]*\b(cat|head|grep|sed)\b[^}]*(system\.ts|gateway\.ts|actors\.claims\.json)'
---
