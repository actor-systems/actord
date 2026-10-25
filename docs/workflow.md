# Authoring and evolving an actor system

The loop the plugin teaches, and the command that establishes each step. Claude proposes; the compiler,
`actord check`, and tests in workerd decide.

| Step | Skill | What establishes it |
| --- | --- | --- |
| Orient | `/actord:start` | `actord doctor` |
| Scaffold | `/actord:setup` | `actord init`, `npm install`, `actord verify` → PASS |
| Design | `/actord:design` + `boundary-critic` | `system.ts` typechecks; `actord check`; each kept actor names a justification; rejected actors and critic objections recorded |
| Implement | `/actord:implement` + `delivery-auditor` | `tsc` (undeclared routes, payload mismatches, and missing handlers are type errors); `actord check`; workerd tests |
| Prove reliability | `/actord:reliability` | Tagged fault tests; `actord verify` classifies each claim in `actord.claims.json` as proved locally, stub only, not guaranteed, blocked, failing, or untested |
| Explain | `/actord:inspect` | `actord events`, `actord trace <id>`; "unknown" where coverage ends |
| Change | `/actord:evolve` + both critics | `actord diff` (against the manifest committed at HEAD): compatibility class, approval, irreversibility, and a deploy plan |
| Deploy | none: a person's decision | Generated `ask` rules prompt for `wrangler deploy`; the Room's guard holds it where active |

## Edit time
With the plugin enabled, editing `system.ts`, `src/actors/`, or `src/messages/` runs `actord check` in a
PostToolUse hook (2-second budget), and hard errors reach Claude immediately. The TypeScript LSP plugin adds
compiler diagnostics. Turn on `strict_evidence` to make Claude run the check before it reports.

## Commit time
Each project carries `.claude/skills/verify/SKILL.md`. Claude Code runs a project skill named `verify`
before commits, so `npm run verify` (`actord verify`) runs even in sessions without the plugin. CI runs the
same command with the same pinned `@actord/toolkit`.

## What is never automatic
Deploys, secrets, remote writes, and sign-ins. Removing an actor class destroys its data, so the plan says
so and needs explicit approval. Nothing can automatically undo an external effect that already happened.
