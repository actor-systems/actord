# The actord CLI

| Command | What it does |
| --- | --- |
| `actord init [dir] [--adopt]` | Creates a tested starter project (or adds the verify skill, `ask` rules, and CLAUDE.md to an existing one); never overwrites |
| `actord doctor [--json]` | Checks Node, Claude Code, the project, CLI version pinning, Worker config, the verify skill, and permission rules, and reports actionable fixes |
| `actord check [--changed <file>...] [--format brief] [--json]` | Validates what the compiler can't: routes, schemas, schedules, effects, budgets, `wrangler.jsonc` bindings and `exports`, Worker entry exports, and manifest freshness. Hard errors exit 1; warnings advise |
| `actord graph [--write] [--format mermaid] [--json]` | Prints the topology; `--write` updates the derived `actord.manifest.json`; `--format mermaid` prints it as a Mermaid flowchart, which GitHub and Obsidian draw |
| `actord diff [--base <ref>] [--base-file <path>] [--json]` | Classifies architectural changes against the manifest committed at `<ref>` (default `HEAD`): compatible, breaking, or risky; approval-required; irreversible. Ends with a deploy plan, never a deploy |
| `actord events [--follow] [--notable] [--json]` | Queries or follows the local structured event log (`.actord/events.ndjson`, written by tests); `--json` prints NDJSON, `--notable` keeps faults only |
| `actord test [--profile extended]` | Runs the workerd tests (the standard profile skips `[extended]` tests) |
| `actord verify [--out F] [--json]` | Typecheck, `actord check`, workerd tests, and claim classification; writes `.actord/evidence.json` with verdict `pass`, `fail`, or `blocked` (for example, a sandbox that denies the local port workerd needs) |
| `actord trace <message-id> [--json]` | Follows a message's causes and consequences, with outcomes, retries, and effects; says *unknown* where recorded coverage ends and never invents production history |
| `actord scorecard [--effect <name>] [--file F] [--json]` | How well each decision and extraction effect is calibrated, from `decision.recorded`, `decision.acted` and `decision.outcome` in the local event log, the same source as `trace`: per effect, the recorded, shadow, labelled and acted counts; a `choice`'s accuracy, Brier score and how often each option was wrong when chosen; a `noul`'s Brier score; a `score`'s mean absolute error; and each field's correct rate by confidence. `--json` adds the calibration bins |
| `actord room [--follow] [--json]` | The Room's view as one document: topology with changes against the last commit (text and SVG), mailboxes per actor, contracts with the last check, and the verify report by claim status. `--follow --json` prints a new snapshot whenever those inputs change |
| `actord guard -- <command> [--json]` | Whether the Room's effect guard holds a shell command (a deploy, secret, or remote-write command inside an actor project), with the diff summary and deploy plan it shows |

Every command offers `--json` with a `schemaVersion` and a `volatile` list naming the machine-dependent
fields. Exit status: 0 ok, 1 hard errors, 2 usage, 3 not in an actor project. Read-only commands never
contact Cloudflare.
