# Trust and safety

Everything the Claude Code plugin runs on your machine is listed here. The repository's
`tests/trust-section.test.mjs` fails the build if a hook, mod event, mod call, or monitor command exists in
`plugins/claude/` without appearing on this page. The Codex plugin ships no hooks, mod, or monitor; its
skills run the same `actord` CLI.

**Hooks (settings-style command hooks; deterministic, no model calls):**
- `PreToolUse` on `Bash`: runs `hooks/heredoc-note.sh` (5 s timeout), a POSIX `sh` script that exits at once
  unless the session is in don't-ask mode and the command contains `<<`. Then it runs
  `bin/actord hook heredoc-note`, which, inside an actor project and for a real heredoc, adds a note for
  Claude: if the command is refused, Bash is still available, and files are written with Write and Edit. It
  returns no permission decision, so it never blocks, allows, or changes a command (decision 0013).
- `PostToolUse` on `Write|Edit`: runs `bin/actord hook check-on-edit` (5 s timeout). It reads the edited path
  from stdin and exits at once unless the file is `system.ts`, `wrangler.jsonc`, `actord.manifest.json`,
  `src/index.ts`, or under `src/actors/` or `src/messages/` in an actor project. Otherwise it runs `actord check`
  within a 2-second budget and returns hard errors to Claude as context. It never blocks an edit, says
  nothing when clean, and logs one line if it runs out of time. Turn it off with the `check_on_edit` option.
- `Stop`: runs `bin/actord hook evidence-gate` (10 s timeout). It does nothing unless you turn on the
  `strict_evidence` option. Then, if actor files changed since the last passing `actord check` (recorded in
  `.actord/last-check.json`), it blocks the stop once with "run `actord check` and the affected tests before
  reporting". It never blocks twice in a turn.

**The Room (a mod, `hooks/room.tsx`; deterministic, no model calls, approves nothing).** Its events, as
`claude plugin validate plugins/claude` lists them:
- `session.start`: registers `/actord-room` (or `/actord-room-view` when another plugin owns the name). In an
  interactive session it runs `actord room --json` once for the status line, for example
  `3 actors · 5 routes · check ✓`. Headless runs (`-p`, the SDK, evals) run nothing.
- `classic.SessionStart`: after `/clear`, runs `actord room --json` again so the pane isn't empty.
- `command.run{command=actord-room}` and `command.run{command=actord-room-view}`: open the pane (only when you
  run the command) and start `actord room --follow --json`, which prints a new snapshot when the project's
  files or `.actord/` evidence change.
- `ui.close{id=actord-room}`: stops that follower.
- `ui.render{component=Pane, requestId=actord-room}`: draws the Topology, Mailboxes, Contracts, and Evidence
  tabs from the snapshot. Selecting a message runs `actord trace <id> --json`.
- `tool.call{tool=Bash}`: the effect guard. A Bash command that matches the deploy, secret, or remote-write
  patterns (the table in `packages/toolkit/src/patterns.ts`, copied into `hooks/effect-patterns.ts` at build) is
  passed to `actord guard --json`. Inside an actor project the guard holds it and asks you, showing the
  semantic diff summary and deploy plan; the default answer is Refuse. Refusing, dismissing, any failure (the
  hook's `.catch`), or a session with nobody to ask denies the command. "Run it" passes the command on
  unchanged, so Claude Code's own permission rules still apply. Other commands pass untouched.

Its calls: `$.process.run` and `$.process.spawn` (only `bin/actord`: `room`, `trace`, `guard`),
`$.command.list`, `$.command.register`, `$.session.surfaces`, `$.state.get`, `$.state.set`, `$.ui.ask`,
`$.ui.log`, `$.ui.open`, `$.ui.panes` (after a reload, to restart the follower for a pane still up), `$.ui.resolve`, `$.ui.status`. It never uses `$.model`, `$.http`, `$.fs`,
`$.prompt.submit`, `$.session.send`, or `tool.check`. Pane state lives in `$.state`; it stores nothing across
sessions.

**Monitor commands:** `bin/actord events --follow --notable --exclusive`, declared twice (`actor-events` and
`actor-events-reliability`) because each starts the first time its skill runs (`inspect`, `reliability`).
It prints one line per notable local event (rejected or undeliverable message, handler failure, exhausted
retry, in-doubt or failed effect), never one per message. `--exclusive` keeps it to one follower per session
and project: a second start exits quietly. Monitors run only in interactive sessions.

**Executables:** `bin/actord`, a POSIX `sh` launcher that runs `node dist/actord.mjs` or the project's
pinned `node_modules/.bin/actord`. It never contacts the network.

**What the toolkit never does:** call a model from its own machinery (the CLI, hooks, mod, monitor);
approve a tool call; read, print, or store Cloudflare credentials; deploy, or write to a Cloudflare account.
Deploys belong to `wrangler`, run by a person or by Claude after the person approves.

**Enforcement, honestly stated.** The enforceable layers are Claude Code permission rules (`actord init`
generates `ask` rules for deploy, secret, and remote-write commands) and the scopes of your Cloudflare API
tokens. Pattern-matching guards, including the Room's effect guard, are conveniences: they miss some
spellings of a command, and mods are not sandboxed.
