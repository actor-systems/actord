# The Room

`/actord-room` opens a pane beside the transcript (or above the prompt in a narrow terminal) with four tabs,
pressed with the mouse or, once the pane has the keyboard (ctrl+x, then Tab), with `1`–`4`; `r` refreshes:

- **Topology:** actors and routes, with additions (green, `+`) and removals (red, `-`) against the last
  commit. The Desktop app and VS Code draw an SVG diagram; the terminal draws text.
- **Mailboxes:** each actor's latest messages with their outcomes, refreshed while tests run. Selecting a
  message shows its causal path from `actord trace`, including *unknown* where recorded coverage ends.
- **Contracts:** every message with its version and routes, and whether the last `actord check` passed or
  is stale.
- **Evidence:** the latest `actord verify` report: proved locally, stub only, not guaranteed, blocked.

In an actor project a status line under the prompt summarizes the system, for example
`3 actors · 5 routes · check ✓`. The Room also holds deploy, secret, and remote-write commands Claude tries
to run in an actor project and asks you first, showing the semantic diff and deploy plan; the default is
Refuse, and approving hands the command to Claude Code's normal permission check. It draws only what the
CLI prints, calls no model, and is optional: everything it shows is available as `actord room`, `actord
trace`, and `actord guard`, and the plugin's skills and hooks don't depend on it.
