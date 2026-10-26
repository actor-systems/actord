# The Claude Code plugin

| Component | Job |
| --- | --- |
| Skills `start`, `setup`, `design`, `implement`, `reliability`, `inspect`, `evolve` | The workflow in [`docs/workflow.md`](https://github.com/actor-systems/actord/blob/main/docs/workflow.md), namespaced `/actord:<name>` |
| Subagents `boundary-critic`, `delivery-auditor` | Read-only critics: one argues for fewer actors, the other audits idempotency, reentrancy, and in-doubt honesty. Each objection comes with the test that would settle it |
| Hooks | Edit-time contract feedback (`check_on_edit`, on by default); an opt-in evidence gate before stopping (`strict_evidence`) |
| The Room (a mod) | `/actord-room`: a pane with the topology, mailboxes, contracts, and evidence; a status line; a guard that asks before deploy and remote-write commands run (see [The Room](The-Room)) |
| Monitor | While `inspect` or `reliability` is in use, notable local events (rejections, failures, exhausted retries, in-doubt effects) reach Claude as notifications, one line each |
| Options (`userConfig`) | `check_on_edit` (true), `strict_evidence` (false), `fault_profile` (`standard` or `extended`); no credentials |
| `bin/actord` | The deterministic machine interface, on `PATH` while the plugin is enabled. It prefers a project's pinned `@actord/toolkit` (`node_modules/.bin/actord`), so Claude and CI run the same version; otherwise it runs the bundled single-file build in `dist/` |
