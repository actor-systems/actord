# 0013 — A note beside refused heredocs, and `reliability` for reported failures

- **Date:** 2026-10-25 · **Gate:** G5 · **Status:** accepted, not yet measured · **Reversibility:** easy

## Context
Two findings from release runs H through K (`docs/evidence/evals/README.md`).

1. **A refused heredoc ends the run.** Eval runs use don't-ask mode, which refuses a Bash command with a
   heredoc (`cat >> f <<'EOF'`, `python3 - <<'E'`) even where its program is allowed. The refusal reads
   "Permission to use Bash has been denied because Claude Code is running in don't ask mode". In five plugin
   runs across F to J, Claude took that for all of Bash, made its edits with Edit, and stopped without
   verifying. The project's `CLAUDE.md` says to write files with Write and Edit; it didn't prevent it. Other
   refusals (reads outside the workspace, `cd` into `node_modules`) are common in both arms and never ended
   a run.
2. **`reliability` didn't fire on the recover case** (1 of 12 plugin runs across H to K). The case reports a
   duplicate notification and asks for the cause, a fix, and a fault test. The skill's description spoke
   only of establishing guarantees, and its steps started from the claims file, not from a reported failure.

## Decision
1. **A third command hook, PreToolUse on Bash, that only adds context.** `hooks/heredoc-note.sh` exits at
   once unless the hook input says `"dontAsk"` and the command contains `<<`. Only then does it run
   `actord hook heredoc-note`. Inside an actor project, for a real heredoc (a delimiter line closes it),
   that returns `additionalContext`: the refusal covers only that command, Bash is still available, and
   files are written with Write and Edit. It returns no permission decision, so it never blocks, allows, or
   changes a call.
   - Claude Code 2.1.310 keeps a PreToolUse hook's context in the tool's result messages when the
     permission check then refuses the call. The hooks reference doesn't say so; we read the shipped bundle.
   - The fast path is a POSIX `sh` case match, about 6 ms per Bash call. Starting Node on every Bash call
     would cost about 60 ms.
   - We don't use the `if` field (`Bash(*<<*)`): whether its rule syntax matches heredoc commands isn't
     documented, and a filter that never matches would turn the note off without anyone noticing.
2. **`reliability` takes reported failures.** Its description now names the case: something happened twice,
   went missing, or got stuck after a retry, crash, restart, or repeated poll; find the cause, fix it, and
   prove the fix with a fault test. A short first section covers that path:
   - reproduce the failure with a tagged fault test, and keep the existing tests;
   - find the cause, keeping in mind that a repeated input carries the same business event under a new
     message id;
   - fix it, run the tests and `actord verify`, and report what they showed.
   The always-on cost rises from about 733 to about 803 tokens.

## Alternatives
- *Deny heredocs with a reason (`permissionDecision: "deny"`).* The documented way to show Claude a
  reason, but it would block heredocs that a user's allow rules accept.
- *Only `CLAUDE.md` guidance.* Already in place, and it didn't prevent the fifth case.
- *Allow heredocs in the eval lane.* That would hide the failure without fixing it for users who work in
  don't-ask mode.

## Consequences
Neither change is measured. A run on the recover case (or a full run) will show whether `reliability` fires,
and the transcripts of any refused heredoc will show the note beside the refusal.
