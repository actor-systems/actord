#!/usr/bin/env bash
set -euo pipefail
mkdir -p src
cat > package.json <<'J'
{ "name": "tiny-range", "private": true, "type": "module" }
J
cat > src/range.ts <<'T'
/** Integers from start to end, inclusive: range(1, 3) is [1, 2, 3]. */
export function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
T
git init -q -b main && git add -A && git -c user.name=scaffold -c user.email=scaffold@example.invalid commit -q -m init
