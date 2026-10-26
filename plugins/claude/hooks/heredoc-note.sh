#!/bin/sh
# PreToolUse on Bash (hooks.json). Runs on every Bash call while the plugin is enabled, so it exits at once
# unless the session is in don't-ask mode and the command contains "<<"; only then does it start the CLI
# (`actord hook heredoc-note`), which answers inside an actor project and never decides the call.
input=$(cat)
case $input in *'"dontAsk"'*) ;; *) exit 0 ;; esac
case $input in *'<<'*) ;; *) exit 0 ;; esac
printf '%s' "$input" | exec "$(dirname -- "$0")/../bin/actord" hook heredoc-note
