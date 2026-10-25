# Room acceptance run

Script: `docs/acceptance/room.md`. Run 2026-10-25T01:40Z–01:59Z by the implementing agent, driving a real
interactive session through tmux (160×50 terminal, fullscreen layout, pane docked): Claude Code 2.1.310,
Node v24.22.1, macOS (Darwin 25.6.0), `claude --plugin-dir ../../plugin` in `examples/release-radar`.
Only slash commands, pane keys, and files were used; no prompt was sent to the model.

| Step | Observed | Result |
| --- | --- | --- |
| A1 | Status line under the prompt: `actors: 3 actors · 5 routes · check ✓`. | pass |
| A2 | `/actors-room` answered "The actors Room is open: 3 actors · 5 routes · check ✓"; the pane docked beside the transcript with the five routes and three actors as text. | pass |
| A3 | Mailboxes listed DigestWriter (16), FeedPoller (39), ReleaseLedger (25). Selecting `release.vanished` marked it `▸` and drew `Trace m-6 · correlation v-1`, `ReleaseLedger:main → DigestWriter:main release.vanished rejected: unknown_message ◀`. First run drew the trace below the fold; fixed by drawing it above the mailboxes (hot-reloaded), then confirmed. | pass |
| A4 | Contracts: `✓ actors check passed (0 warning(s))` and the five messages at version 1 with their routes. | pass |
| A5 | Evidence: `actors verify: pass · standard`, Proved locally (8), Stub only (1), Not guaranteed (3) with statements. | pass |
| A6 | `npx vitest run tests/duplicates.test.ts` from another shell: FeedPoller 3→5 and ReleaseLedger 4→9 while the pane stayed open. First attempt showed no change: the mod's hot reload had ended the follower; fixed (session.start restarts it when `$.ui.panes()` still lists the pane; mod test added), then confirmed. | pass |
| A7 | Appending a comment to `system.ts`: status line `check stale` within ~2 s; Contracts said "Stale: actor files changed since the last check". Restoring the file returned `check ✓`. | pass |
| A8 | `/clear`: transcript cleared; the pane redrew the project (Topology) and the status line stayed. | pass |
| A9 | Not run: holding a deploy needs Claude to call Bash, which is one model turn; deferred to the owner with the eval lane. The same paths (hold, Refuse, dismiss, failure, headless) are covered by `claude plugin test`. | not run: needs a model turn (owner) |
| A10 | Not run: needs the Desktop app. The SVG branch is covered by the desktop-surface mod tests. | not run: needs the Desktop app (owner) |
| A11 | Closing the pane (its close mark) ended the `actors room --follow --json` child: `pgrep -fl "room --follow"` found none. | pass |
