# Authoring and evolving an actor system

The loop the plugin teaches, and the command that establishes each step. Claude proposes; the compiler,
`actors check`, and tests in workerd decide.

| Step | Skill | What establishes it |
| --- | --- | --- |
| Orient | `/actors:start` | `actors doctor` |
| Scaffold | `/actors:setup` | `actors init`, `npm install`, `actors verify` → PASS |
| Design | `/actors:design` + `boundary-critic` | `system.ts` typechecks; `actors check`; each kept actor names a justification; rejected actors and critic objections recorded |
| Implement | `/actors:implement` + `delivery-auditor` | `tsc` (undeclared routes, payload mismatches, and missing handlers are type errors); `actors check`; workerd tests |
| Prove reliability | `/actors:reliability` | Tagged fault tests; `actors verify` classifies each claim in `actors.claims.json` as proved locally, stub only, not guaranteed, blocked, failing, or untested |
| Explain | `/actors:inspect` | `actors events`, `actors trace <id>`; "unknown" where coverage ends |
| Change | `/actors:evolve` + both critics | `actors diff` (against the manifest committed at HEAD): compatibility class, approval, irreversibility, and a deploy plan |
| Deploy | none: a person's decision | Generated `ask` rules prompt for `wrangler deploy`; the Room's guard holds it where active |

## Edit time
With the plugin enabled, editing `system.ts`, `src/actors/`, or `src/messages/` runs `actors check` in a
PostToolUse hook (2-second budget), and hard errors reach Claude immediately. The TypeScript LSP plugin adds
compiler diagnostics. Turn on `strict_evidence` to make Claude run the check before it reports.

## Commit time
Each project carries `.claude/skills/verify/SKILL.md`. Claude Code runs a project skill named `verify`
before commits, so `npm run verify` (`actors verify`) runs even in sessions without the plugin. CI runs the
same command with the same pinned `actors-toolkit`.

## What is never automatic
Deploys, secrets, remote writes, and sign-ins. Removing an actor class destroys its data, so the plan says
so and needs explicit approval. Nothing can automatically undo an external effect that already happened.
