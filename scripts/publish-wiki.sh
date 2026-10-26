#!/usr/bin/env bash
# Publishes docs/wiki/ to the GitHub wiki (actor-systems/actord.wiki). The wiki is a separate git repository,
# so its pages live here, versioned and tested with the code, and this copies them over: the wiki then holds
# exactly docs/wiki's pages (a page removed here is removed there). Pushes to GitHub unless --dry-run.
#   scripts/publish-wiki.sh [--dry-run]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
remote="${ACTORD_WIKI_REMOTE:-https://github.com/actor-systems/actord.wiki.git}"
source_rev="$(git -C "$root" rev-parse --short HEAD)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone -q "$remote" "$work/wiki"
find "$work/wiki" -maxdepth 1 -name '*.md' -delete
cp "$root"/docs/wiki/*.md "$work/wiki/"
cd "$work/wiki"
git add -A
if git diff --cached --quiet; then
  echo "wiki: already matches docs/wiki at $source_rev"
  exit 0
fi
git diff --cached --stat
if [ "${1:-}" = "--dry-run" ]; then
  echo "wiki: dry run, nothing pushed"
  exit 0
fi
git commit -q -m "Sync from docs/wiki at $source_rev"
git push -q origin HEAD
echo "wiki: published docs/wiki at $source_rev"
