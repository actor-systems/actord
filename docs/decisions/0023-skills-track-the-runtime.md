# 0023 — Skills track the runtime: no new skills, code examples that compile, and eval scaffolds that run

- **Date:** 2026-10-28 · **Gate:** plan 5 (plugin skills) · **Status:** accepted · **Reversibility:** easy (skill text,
  two test gates and one doctor check); the toolkit change in decision 5 is a re-export and is kept

## Context
Plans 1 to 4 gave actord Lifecycle timers and schedules, job effects, sources and email approvals, agent actors with
workspaces, and decisions and extractions. The plugin skills, both agents and the Codex copies still taught the
release-0.2 style. Their code examples had drifted without any check noticing: no gate compiled a block in a skill, so
a renamed export or a changed signature stayed in the text until a person read it. Plan 5 rewrote them, and found two
other things that had also gone unnoticed.

## Decisions
1. **No new skills.** The plugin keeps its 7 skills and 2 agents. A capability goes in a reference file under the skill
   whose job it belongs to: sources, timers, agents and decisions under `implement`, the declaration under `design`,
   fault rows under `reliability`. A new skill adds a description to every session's always-on text (budget 821
   tokens after plan 5), and a model picks between seven skills better than between eleven. Skills load a reference
   only when the work needs it.
2. **A `// actord:check` block must compile.** A fenced `ts` block in a skill or agent whose first line is
   `// actord:check` is typechecked against the built `@actord/toolkit` types by `tests/skill-snippets.test.mjs`
   (gate `g5.skills.snippets`, which builds the toolkit first). Code that is only a sketch carries no marker.
   - **`// actord:check system`** names a block `system.ts`, which sibling blocks of the same file import as
     `./system`, so a reference can show a declaration once and the handlers that use it.
   - **A closed `cloudflare:workers` stub** stands in for the Workers types, which the toolkit's own typecheck doesn't
     need. Its `Env` is empty on purpose: an open index signature let a misspelled binding compile.
   - A marker that isn't the first line of a fenced `ts` block, a repeated sibling name, or a file with no block where
     one is required fails the test, so a marker can't be silently lost.
   - The gate is wired in plan 5's last code task (R1), so the branch stayed green while the skills were rewritten.
3. **A test pins the Codex copies.** Each Codex skill carries a hand-copied `references/workflow.md`, and nothing
   regenerates them. `tests/codex-workflows.test.mjs` requires the evolve, inspect and setup copies to be
   byte-identical, the implement and verify copies likewise, and the design copy to differ from both, so an edit to one
   copy that misses its twins fails. It runs inside `g2.codex.adapter`'s glob.
4. **`actord doctor` requires Node 22.19.** The skills teach `@actord/toolkit` imports that need it, and the repo's
   own README and CI already said 22.19+. Doctor said less, so a project on an older Node passed doctor and failed
   later.
5. **The three schemas move to `@actord/toolkit/system` (ruling R2).** `approvalDecided`, `agentFailed` and
   `agentExhausted` were hand-written `StandardSchemaV1` objects in the `/sources` and `/agents` entry points. A
   `system.ts` that imported them, as Runtime.md taught, failed `actord check` with `DECLARATION_LOAD_FAILED`:
   `actord check` loads the declaration in Node, and those entry points import the agent lifecycle, which imports
   `cloudflare:workers`. They now live in a dependency-free module exported from the Node-safe `/system`;
   `/sources` and `/agents` re-export them, so nothing that imported them breaks. A RED-first test makes a `system.ts`
   with all three pass `actord check`. This is a toolkit fix made in a skills plan, because the alternative was to teach
   around it.
6. **A gate runs the eval scaffolds (R4).** 9 of the 13 scaffolds had been broken since `d4103b5` moved the examples:
   `_scaffold/project.sh` and `investigate-trace/scaffold.sh` pointed one directory too high. No free check ran them,
   and runs L and M predate the move. A scaffold also now fails when a source patch doesn't apply, instead of grading
   an unbroken project. Gate `g5.evals.scaffolds` (`tests/eval-scaffolds.test.mjs`) is static: it resolves each
   scaffold's paths from its own location and applies each patch to its example, in 0.3 s. Running every scaffold takes
   64 to 121 s, and the static check fails 12 tests on the old paths.
7. **The host re-run needs no Cloudflare credentials, and a test never opens a remote model session (R5, R6).**
   `scripts/rerun-eval-workspaces.sh` runs `actord verify` with the Cloudflare variables removed. A decision test that
   overrides the decision effect (`overrideEffect`) still opened a remote Workers AI session when the project declared
   an `ai` binding, which on a host would call the model with the owner's credentials. So the test project's vitest
   config sets `remoteBindings: false`; `implement/references/decisions.md` teaches both ("Testing a decision without
   the model"), and `add-triage-decision` requires and grades them.
8. **Eval evidence: runs L and M are superseded (option A).** Decision 0010 says a run that measured a changed plugin
   is superseded. Plan 5 rewrote every skill and agent they measured, so `docs/evidence/evals/2026-10-25-release-{l,m}`
   moved to `superseded/` and the README says there is no current record. Until a new round,
   - `g5.evals.run`, `g5.evals.host` and `g1.start-session` report **blocked**, not failed, and `npm run verify` still
     exits 0 (a blocked check never counts as a pass);
   - after merge the owner approves a paid round of two full runs of the 15 cases, about $12–13 each, about $25 in all,
     with a $14-a-run ceiling. They restore the three gates.
   The alternative (option B) kept L and M in place with a note that they measured the skills at `9f9701a`. It would
   have left the gates green on evidence that no longer measures the plugin.

## Known gaps
- **A misspelled optional field compiles** and `actord check` doesn't flag it; a misspelled `publishes` skips
  `PUBLISHES_WITHOUT_APPROVAL` (#89). The skills show the correct fields and say so.
- **The CLI's `--notable` lacks `effect.parked`, and `trace` shows source refusals as unknown and draws no `decision.*`
  events** (#90). The `inspect` skill documents the workaround.
- **The agents reference's clone pattern** (a declared `repo.clone` call effect over `gitClone`) is labelled not yet
  exercised by a test; the factory design settles it (R3).
- **`// actord:check` proves a block compiles, not that it is the right advice.** The reviews of plan 5 checked claims
  by hand against the runtime, and found a wrong one in each of several references.
- **No eval has measured the new skills.** Until the paid round, the plugin's measured effect is unknown.

## Rejected alternatives
- **A skill per capability** (sources, agents, decisions, timers). It adds always-on text and more choices (decision 1).
- **Teaching around the Node-unsafe imports.** The bug was real for any user who followed Runtime.md (decision 5).
- **Running every eval scaffold in a gate.** 64 to 121 s of verify time for what a 0.3 s static check catches.
- **Keeping L and M as the record** (option B, decision 8).
