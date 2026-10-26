# Room acceptance run

Script: `docs/acceptance/room.md`. Run 2026-10-25T01:40Z–01:59Z by the implementing agent, driving a real
interactive session through tmux (160×50 terminal, fullscreen layout, pane docked): Claude Code 2.1.310,
Node v24.22.1, macOS (Darwin 25.6.0), `claude --plugin-dir ../../plugin` in `examples/release-radar`.
Steps A1–A8 and A11 used only slash commands, pane keys, and files. Step A9 sent one prompt to Sonnet 5.5 (owner-approved).

| Step | Observed | Result |
| --- | --- | --- |
| A1 | Status line under the prompt: `actord: 3 actors · 5 routes · check ✓`. | pass |
| A2 | `/actord-room` answered "The actord Room is open: 3 actors · 5 routes · check ✓"; the pane docked beside the transcript with the five routes and three actors as text. | pass |
| A3 | Mailboxes listed DigestWriter (16), FeedPoller (39), ReleaseLedger (25). Selecting `release.vanished` marked it `▸` and drew `Trace m-6 · correlation v-1`, `ReleaseLedger:main → DigestWriter:main release.vanished rejected: unknown_message ◀`. First run drew the trace below the fold; fixed by drawing it above the mailboxes (hot-reloaded), then confirmed. | pass |
| A4 | Contracts: `✓ actord check passed (0 warning(s))` and the five messages at version 1 with their routes. | pass |
| A5 | Evidence: `actord verify: pass · standard`, Proved locally (8), Stub only (1), Not guaranteed (3) with statements. | pass |
| A6 | `npx vitest run tests/duplicates.test.ts` from another shell: FeedPoller 3→5 and ReleaseLedger 4→9 while the pane stayed open. First attempt showed no change: the mod's hot reload had ended the follower; fixed (session.start restarts it when `$.ui.panes()` still lists the pane; mod test added), then confirmed. | pass |
| A7 | Appending a comment to `system.ts`: status line `check stale` within ~2 s; Contracts said "Stale: actor files changed since the last check". Restoring the file returned `check ✓`. | pass |
| A8 | `/clear`: transcript cleared; the pane redrew the project (Topology) and the status line stayed. | pass |
| A9 | Separate session 2026-10-25T03:44Z, `claude --plugin-dir ../../plugin --model claude-sonnet-5-5`, one prompt: "Run exactly this command in this project and tell me what happened: npx wrangler deploy --dry-run". Claude called Bash; the Room held it in a "Room guard" question showing the command, "release-radar: no architectural changes against git:HEAD", the two-step deploy plan, and "Claude Code's own permission check still runs after this. Run it?", with **1. Refuse** first and selected. Choosing Refuse: the command didn't run, and Claude reported that the actord guard blocked it, didn't retry or rephrase it, and suggested `actord diff`. | pass |
| A10 | Run by the owner, 2026-10-26 about 00:10Z: the Desktop app 3.6556.2 (which runs its own Claude Code 2.1.308), a local Code-tab session on `examples/release-radar`, the plugin installed from this repository's marketplace. `/actord-room` opened the actord Room, and the Topology tab drew the SVG diagram: pills for `@clock` and `@ingress`, boxes for the three actors, and the five labelled routes. Mailboxes, Contracts, and Evidence drew as in the terminal. Seen and fixed afterwards (`1a80691`): actor names nearly invisible on the dark theme, the `feed.fetched` label clipped at the top, labels running into boxes, and the reply "it shows once the window is wide enough" although the pane was open. The first `/actord-room` was flagged "isn't a command here" and missing from the slash menu, yet it ran; after that it was listed. | pass |
| A11 | Closing the pane (its close mark) ended the `actord room --follow --json` child: `pgrep -fl "room --follow"` found none. | pass |
