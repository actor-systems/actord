# 0009 — The Room: one CLI document, a prefiltered guard, a deduplicated monitor

- **Date:** 2026-10-24 · **Gate:** G6 · **Status:** accepted · **Reversibility:** easy

## Context
The charter gives the Room two jobs (a pane of four tabs, an effect guard) and forbids it from computing
anything: every view comes from CLI JSON. Hooks run inside a ten-second budget; the guard sees every Bash
call in every session where the plugin is installed.

## Decisions
1. **`actors room --json` is the Room's view model.** One document carries the status line, topology with
   changes against the base (text lines and an SVG), contracts with the last check, mailboxes, and the
   verify report grouped by claim status. The charter names `diff`, `events`, `check`, and `verify` as the
   tabs' sources; `room` composes exactly those models, so one process serves a redraw instead of four.
   `actors trace <id> --json` stays the source for a selected message. Text output of `room` is the same
   view with mods off.
2. **`--follow` prints a snapshot per change from a fresh process.** An ES module can't be re-imported in
   place, so a long-lived follower would keep an old `system.ts`. The follower polls a signature (actor-file
   fingerprint plus `.actors/` stamps) every 500 ms and runs `actors room --json` anew when it changes.
3. **The SVG is the CLI's.** `topologySvg` lays actors out by distance from external senders, colors
   additions green and removals red (dashed), and escapes names. The terminal, which has no `Svg`, draws the
   text lines.
4. **Mailboxes are per actor class**, each entry naming the receiving instance, the latest 12 per actor.
   Tests create many instances (one per feed), so per-instance boxes would bury the topology.
5. **The guard is a prefilter plus a CLI decision.** Spawning Node for every Bash call would tax every
   session, so the mod tests the command against a copy of the shared pattern table generated at build
   (`plugin/hooks/effect-patterns.ts`; `g1.dist.fresh` fails if stale). Only a match runs `actors guard`,
   which decides `hold` and writes the question (diff summary and deploy plan) and the refusal. It holds
   only inside an actor project, so the plugin doesn't add a question to unrelated repositories.
   Refuse is the first option; refusing, dismissing, a failure (`.catch`), no surface to ask on, or any
   answer but "Run it" denies. "Run it" calls `next(e)`, so Claude Code's permission rules still run.
6. **Status line only where someone sees it.** `session.start` runs `actors room --json` only when the
   session is interactive; headless runs (`-p`, SDK, evals) run nothing at start.
7. **Command collision:** if another plugin already registers `/actors-room`, the Room registers
   `/actors-room-view`. A built-in's name is refused by the engine.
8. **State:** snapshot, tab, selection, and trace live in `$.state` (`types/index.d.ts`), with shape tags so
   a reload declines an older document. Nothing goes to `$.store`. A CLI document of another
   `schemaVersion` is refused on screen, and `scripts/record-room-fixtures.mjs --check` fails the build when
   the CLI's documents drift from the fixtures the mod tests stub with.
9. **Monitor:** two entries (`when` takes one skill), one follower per session through `--exclusive`.
10. **`actors verify` records a fingerprint** of the actor files in `.actors/evidence.json`, so the Evidence
    tab can say a report is stale.
11. **Mod type declarations aren't committed.** They're generated per Claude Code build;
    `scripts/typecheck-mod.mjs` finds them (env, the engine's `.claude-plugin/types/`, or the
    plugin-authoring skill's copy for the running version) and reports **blocked** when there are none.

## Evidence
`claude plugin test plugin` (18 tests: every tab on terminal and desktop, /clear, reload, collision, schema
pin, and every guard path), mutation checks of the guard (each mutation failed a test), CLI unit tests
(`packages/cli/test/room.test.ts`), `tests/monitor.test.mjs`, `scripts/no-hooks-smoke.sh`, and a recorded
interactive acceptance run (`docs/evidence/room-acceptance.md`, 9 of 11 steps; the model-turn and Desktop
steps are the owner's).
