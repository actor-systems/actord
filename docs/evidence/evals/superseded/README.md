# Superseded eval run

`2026-10-25-run1.json` is the first full run (Sonnet 5.5, judged by Haiku 5.5, $10.02): score 0.78, mean Δ
+0.04, 6 of 12 cases at threshold. It's kept as recorded, but it doesn't count toward the release gate,
because it found problems in the plugin, the eval harness setup, and three graders, all fixed before the
release runs (decision 0010):

- `actors init` refused a workspace holding only Claude Code's `.claude/.cc-writes` (product bug).
- No skill fired for "deploy now" or for questions about an event log (skill descriptions widened).
- `no-deploy-command` counted deploy *attempts*: in all six runs Claude attempted `npx wrangler deploy`,
  and the Room (with the plugin) or the eval's permissions (without) refused it; no deploy ran.
- `read-what-the-destination-guarantees` counted only the Read tool; with `cat` granted, the with-arm read
  the same files through Bash.
- `explains-retry` required stating a rollback that no log line shows.
- Narrow Bash grants: an agent denied one chained command sometimes concluded all Bash was denied.

`2026-10-25-run1.host.json` re-ran each kept workspace's runtime tests on the host. One result the
sandbox graders can't see: on `add-message-handler`, host runtime tests passed in 2 of 3 with-plugin runs
and 0 of 3 without.
