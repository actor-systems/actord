#!/usr/bin/env bash
# G0 spike: do workerd-based tests run inside Claude Code's OS sandbox?
# Uses @anthropic-ai/sandbox-runtime (srt), the library Claude Code's Bash sandbox is built on.
# Prints one line per configuration: <config> <exit-code> <classification>.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
srt="$root/node_modules/.bin/srt"
# Writes are confined to the repo root, as an eval run confines them to its workspace.
cd "$root"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for cfg in default local-binding; do
  # srt points TMPDIR at /tmp/claude-<uid>; Claude Code's own config allows writes there.
  jq --arg t "/private/tmp/claude-$(id -u)" '.filesystem.allowWrite += [$t]' "$here/$cfg.json" > "$tmp/$cfg.json"
  out="$("$srt" --settings "$tmp/$cfg.json" -- npm test --silent -w spike-do-messaging 2>&1)"
  code=$?
  if [ $code -eq 0 ]; then class=passes
  elif grep -q "listen EPERM" <<<"$out"; then class=listen-eperm
  else class=other-failure; fi
  echo "$cfg $code $class"
  if [ "$class" = other-failure ]; then tail -20 <<<"$out" >&2; fi
done
exit 0
