#!/usr/bin/env bash
# Build a self-contained, git-initialized actor project with dependencies installed, offline.
#   scaffold-project.sh <dest-dir> starter|release-radar|briefing-desk|deps
# (deps: only node_modules and an empty git repository, for a case that creates the project itself)
# Used by the eval suite's scaffold scripts and by the offline starter smoke check. node_modules is
# cloned from this repository (copy-on-write on APFS) and actors-toolkit is copied as a real package,
# so the result has no links back into the repository (eval sandboxes can't read the home directory).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$1"
what="$2"
mkdir -p "$dest"
case "$what" in
  starter) node "$root/plugin/dist/actors.mjs" init "$dest" --name starter-app >/dev/null ;;
  deps) ;;
  release-radar | briefing-desk)
    (cd "$root/examples/$what" && tar cf - --exclude node_modules --exclude .actors --exclude .wrangler --exclude worker-configuration.d.ts .) | (cd "$dest" && tar xf -)
    ;;
  *) echo "unknown project: $what" >&2; exit 2 ;;
esac
cp -cR "$root/node_modules" "$dest/node_modules" 2>/dev/null || cp -R "$root/node_modules" "$dest/node_modules"
rm -rf "$dest/node_modules/actors-toolkit" "$dest/node_modules/release-radar" "$dest/node_modules/briefing-desk" "$dest/node_modules/spike-do-messaging"
mkdir -p "$dest/node_modules/actors-toolkit"
cp -R "$root/packages/cli/package.json" "$root/packages/cli/dist" "$dest/node_modules/actors-toolkit/"
ln -sf ../actors-toolkit/dist/cli.mjs "$dest/node_modules/.bin/actors"
cd "$dest"
if [ "$what" = deps ]; then git init -q -b main; echo "scaffolded deps at $dest"; exit 0; fi
[ -f .gitignore ] || printf 'node_modules/\n.wrangler/\n.actors/\nworker-configuration.d.ts\n' > .gitignore
npx --no-install wrangler types >/dev/null 2>&1 || true
[ -f actors.manifest.json ] || node node_modules/.bin/actors graph --write >/dev/null
git init -q -b main && git add -A && git -c user.name=scaffold -c user.email=scaffold@example.invalid commit -q -m "scaffold: $what"
echo "scaffolded $what at $dest"
