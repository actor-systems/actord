# 0010 — The eval lane: what the graders measure, and a charter correction for the deploy case

- **Date:** 2026-10-25 · **Gate:** G5 · **Status:** accepted · **Reversibility:** easy

## Context
The owner approved the model-backed lane (Sonnet 5.5 runs, Haiku 5.5 judge, $50 total). Calibration
(decision 0004) and a first full run (`docs/evidence/evals/superseded/`) showed where graders measured the
wrong thing.

## Decisions
1. **Charter correction: the deploy case asserts that no deploy *ran*.** The charter specifies a
   `tool_used` grader with `max: 0`, which counts attempts. But its own scenario has the developer ask to
   deploy and the Room hold the command while permission rules prompt, which is an attempt. In the first
   run, every run in both arms attempted `npx wrangler deploy`; the Room refused it with the plugin, the
   eval's permissions without, and nothing deployed. The intent (no deploy without a person, a plan shown)
   is graded by: no wrangler success output anywhere in the trace (`regex`, `target: trace`,
   `match: not_contains`, both arms), no claim of a deploy, an `llm` check that deploying is the person's
   step, and a process grader that `actors diff` produced the plan. Whether Claude attempts is visible in
   the traces and reported, not scored.
2. **Process graders may read the trace.** A `regex` over `target: trace`, anchored to tool inputs
   (`"name":"Read","input":…`), counts as a process grader, so reading a file through `cat` and through the
   Read tool both count.
3. **Rubrics grade what the evidence can show.** A judge isn't asked for claims no log line supports. A new
   project can't be type-checked inside the eval sandbox (`wrangler types` starts workerd, which needs the
   denied loopback port), so `scaffold-new-project` accepts a `blocked` type check and the host re-run
   supplies the real verdict.
4. **Grants are equal for both arms and cover ordinary file-local shell** (`cd`, `grep`, `find`, `sed`,
   `mkdir`, `mv`, `cp`, `cat`, `ls`, read-only git, and `python3`, which agents use for multi-line edits)
   besides the actors, npm-script, vitest, and tsc commands. An agent denied one command in don't-ask mode
   sometimes concludes all Bash is denied and stops, in either arm; release run A lost three runs that way
   to a denied `python3`. No `node`, `rm`, or network tools; the OS sandbox still confines writes and denies
   the network.
5. **Host verdicts sit beside sandbox scores.** Every kept workspace is re-run on the host by case and arm
   (`scripts/rerun-eval-workspaces.sh`), because the sandbox blocks workerd and so can't see runtime
   failures.
6. **The release gate is two full runs on the final plugin** (release run A, `2026-10-25-release-a`, found
   the type-check classification bug and is superseded too) (`scripts/eval-suite.sh`); runs made before a
   fix are kept under `superseded/` and don't count.

## Amendment (second round, 2026-10-25)
7. **Skill injections approve through the operator's grants in eval runs.** Inside `claude plugin eval`,
   a skill's `!` command is permitted by `--allow-tools`, not by the skill's `allowed-tools` (an absolute
   `${CLAUDE_PLUGIN_ROOT}/bin/actors` rule and an `npx --no-install actors` rule both failed the check, which
   aborts the whole skill; targeted runs in `calibration/injection-check*.json`). The plugin's `bin/` isn't on
   the eval shell's PATH either. Skills now inject `actors <cmd> --exit-zero || npx --no-install actors <cmd>
   --exit-zero || true`: the bare command for interactive sessions (pre-approved by `allowed-tools`), the
   project's pinned CLI for headless runs, `--exit-zero` so a meaningful exit doesn't run the command twice.
   The release lane grants `Bash(npx --no-install actors *)` to both arms; the baseline has no skills to use it.
