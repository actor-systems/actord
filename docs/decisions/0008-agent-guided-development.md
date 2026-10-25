# 0008 — Agent-guided development: init, verify, claims, hooks, skills, evals

- **Date:** 2026-10-24 · **Gate:** G5 · **Status:** accepted · **Reversibility:** easy to moderate

## Decisions
1. **`actors init` vendors the toolkit until it's on npm.** The plugin ships an `npm pack` tarball (built
   reproducibly; same sha across builds). `init` copies it to `vendor/` and pins
   `"actors-toolkit": "file:vendor/actors-toolkit-<v>.tgz"`, so a new project installs the exact version Claude
   runs, offline for the toolkit itself. Publishing needs the owner's authorization; after that, init pins
   the registry version. The launcher exports `ACTORS_PLUGIN_DIST` so a project-pinned CLI can still find
   the bundled package.
2. **`init` never overwrites.** It creates only in an empty directory, where `.git` and `node_modules` don't
   count. `--adopt` adds only missing files and prints suggested `ask` rules instead of editing an existing
   `.claude/settings.json`. Regenerating changes nothing (tested by `scripts/starter-smoke.sh`).
3. **Reliability claims are data: `actors.claims.json`.** Each claim has a `basis` (`workerd`, `stub`, or
   `not-guaranteed`) and test tags. `actors verify` classifies claims from the Vitest JSON report: a tag
   needs at least one passing test and no failing one; tests skipped by a profile don't count. A sandboxed
   run that can't bind a port marks runtime claims `blocked` (decision 0004). The example runner derives
   required tags from the claims, so a claim can't silently lose its test.
4. **`actors verify` is the evidence workflow** (typecheck → check → workerd tests → claims) and writes
   `.actors/evidence.json` (`verdict`: pass, fail, or blocked). Eval graders, the Room, CI, and the project
   verify skill all read that one file. `actors check` records `.actors/last-check.json` (with a fingerprint
   of the actor files) for the evidence gate and the Room.
5. **Hooks are CLI subcommands** (`actors hook check-on-edit | evidence-gate`) in exec form with
   `${CLAUDE_PLUGIN_ROOT}/bin/actors`. One deterministic binary serves every view.
6. **Skills:** seven, with rules first (they survive compaction), injected evidence (`actors check --json`,
   `actors graph --json`, `actors diff --json`, each `|| true` and pre-approved exactly), and `implement` scoped
   by `paths`. `tests/skills.test.mjs` enforces the charter's authoring rules. Always-on cost: ~675 tokens.
7. **Critics are read-only** (`Read, Grep, Glob`) with unpinned models; pin only if evals show a difference.
8. **Evals:** 12 cases. Scaffolds build offline workspaces in about 11 s (APFS clone of `node_modules`, a real
   copy of `actors-toolkit` because eval sandboxes can't read the home directory, and a git commit so
   `actors diff` has a base). Graders read `.actors/evidence.json` and accept `blocked` for runtime tests
   inside the sandbox. `scripts/rerun-eval-workspaces.sh` re-runs kept workspaces on the host and labels the
   source.
9. **The optional `design-review` workflow isn't shipped.** The charter allows it only if evals show a gain
   over the single-critic path. Measuring that costs model runs beyond the core suite. Cut first, per the
   charter's scope rule (polish and optional components before verification).
