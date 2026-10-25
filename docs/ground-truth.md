# G0 — Ground truth: platform compatibility notes

Recorded 2026-10-24. Re-verify at each gate: read the relevant pages of
https://code.claude.com/docs/llms.txt and https://developers.cloudflare.com/workers/llms.txt, and re-run
`npm run versions`. The verification report records the versions each run actually used.

## Installed versions (this machine, 2026-10-24)

| Tool | Version | Notes |
| --- | --- | --- |
| Claude Code | 2.1.310 | above every floor below |
| Node.js / npm | 24.22.1 / 11.19.1 | npm 11 gates install scripts (`allowScripts`); esbuild works without its postinstall |
| wrangler | 4.152.0 | |
| `cf` CLI | 1.0.0-beta.20 | |
| workerd | 1.20261019.1 | resolved through wrangler 4.152.0 (npm `latest` is 1.20261024.1) |
| vitest | 5.0.5 | |
| @cloudflare/vitest-plugin | 1.4.7 | replaces `@cloudflare/vitest-pool-workers` |
| TypeScript | 7.0.2 | native compiler; `tsc --noEmit` only, no compiler API used |
| @anthropic-ai/sandbox-runtime | 0.0.81 | the library behind Claude Code's Bash sandbox (`srt`) |
| agents (Agents SDK) | 0.30.1 (npm) | not used in v0.1 (decision 0003) |
| void | 1.2.1 (npm) | not used (decision 0002) |

## Claude Code feature availability

| Feature | Floor | Available on 2.1.310 | Source |
| --- | --- | --- | --- |
| Mods (hooks module, panes, `tool.call`) | terminal 2.1.287, Desktop 2.1.286, VS Code ext 2.1.299 | yes | mods overview |
| `claude plugin test` | ships with mods | yes (`claude plugin test --help`) | mods test |
| `claude plugin eval` | 2.1.269 | yes | plugin-evals |
| `claude plugin details` (always-on cost) | — | yes | plugins/measure |
| `claude plugin tag` | — | yes: `{name}--v{version}`, `--push` optional (denied by our rules) | cli help |
| Monitors | — | yes, under **`experimental.monitors`**; default file `monitors/monitors.json` | manifest reference |
| Workflows in plugins | — | yes (`workflows/`) | manifest reference |
| `userConfig.options` pickers | 2.1.271 | yes | manifest reference |
| Plugin `bin/` on Bash `PATH` | — | yes; claude.ai and Cowork refuse plugins with `bin/` | manifest reference |

## Corrections to the charter (intent kept; replacement tested)

1. **Workers test package renamed.** `@cloudflare/vitest-plugin` (1.x) replaces `@cloudflare/vitest-pool-workers`.
   Configuration is the `cloudflareTest()` Vite plugin. `cloudflare:workers` exports `env` and `exports`
   (`exports` replaces `SELF`). Integration across Workers uses `createTestHarness()` from wrangler.
   Evidence: `spikes/do-messaging` passes in workerd.
2. **Monitors are experimental in the manifest.** The manifest key is `experimental.monitors`. The charter's
   `monitors/monitors.json` path is the default and needs no manifest key.
3. **`claude plugin eval` publishes its HTML report to claude.ai by default.** Every run must pass
   `--no-publish`; `.claude/settings.json` denies `--publish-report`.
4. **workerd tests do not run inside Claude Code's default sandbox.** Miniflare must listen on loopback, and
   the macOS sandbox refuses `listen` (`EPERM`) unless `network.allowLocalBinding` is true. Reproduced
   without a model by `spikes/do-messaging/sandbox/run.sh` (srt: default → `listen-eperm`, local-binding →
   `passes`), and observed directly in this Claude Code session with `sandbox.enabled: true`. The eval docs
   don't say whether eval runs allow local binding, so runtime evidence inside eval runs is assumed
   **blocked** until a real run shows otherwise (decision 0004).
5. **DO SQLite `cursor.rowsWritten` counts index writes.** An `INSERT` into a table with a primary key
   reports 2, not 1. Detect first delivery with `INSERT … ON CONFLICT DO NOTHING RETURNING`.
6. **Miniflare fetches `request.cf` data from the network** on first use and caches it in
   `.wrangler/cache/cf.json`. Offline runs still pass; the cache is a derived, ignored artifact.
7. **The `cf` CLI's `build` defers to the project's wrangler** and doesn't resolve a wrangler hoisted into
   an npm workspace root. `cf` is a broad account-API CLI (beta), not a local dev/test tool.
8. **Void is a Vite full-stack framework** ("Full-stack framework and deployment CLI for Cloudflare
   Workers, powered by Vite") built on `cf`. Its announcement covers web apps and doesn't mention Durable
   Objects.
9. **TypeScript 7 is the current compiler and is native.** The CLI evaluates `system.ts` by bundling it with
   esbuild and importing the result; it doesn't depend on a TypeScript compiler API.
10. **Plugin path variables aren't exported to Bash tool commands.** `bin/` is on `PATH`; skills reference
    `${CLAUDE_PLUGIN_ROOT}` inline in Markdown (substituted at load).
11. **Mod type declarations for the installed build** are written to `.claude-plugin/types/` when the mod is
    loaded with `--plugin-dir` in an interactive session; `claude plugin validate` prints the `hooks:` and
    `calls:` listing.

12. **Durable Object lifecycle uses the declarative `exports` map** (`"exports": { "Class": { "type":
    "durable-object", "storage": "sqlite" } }`). The `migrations` array the charter era assumed is now
    "legacy" and can't be combined with `exports`. Deleting a class through `exports` destroys data with
    no trash. Verified locally: `wrangler types`, vitest-plugin, `wrangler dev` (decision 0006).
13. **Node 24 loads `.ts` files natively** when the package is `"type": "module"`; without it, a `.ts`
    file using `import` fails with "Cannot use import statement outside a module".
14. **zod 4.6.7 implements Standard Schema `validate` and Standard JSON Schema** (`~standard.jsonSchema`).

15. **Vitest 5 hides console output from passing tests by default**; `silent: false` restores it and lets
    `onConsoleLog` capture DO event lines (decision 0007).
16. **An async `ctx.storage.transaction()` on a SQLite DO holds the input gate across awaits and rolls back
    on throw**, while plain awaits on other DOs let calls interleave (probes; decision 0007).
17. **An RPC method can't be named `name`**; the stub's own property shadows it.

18. **A monitor's `when` names one skill.** `on-skill-invoke:<skill>` takes a single skill, so "starts with
    `inspect` or `reliability`" is two entries running the same follower. `actors events --follow
    --exclusive` holds a per-session lock (keyed by the Claude Code process) so a session that runs both
    skills gets one follower (`tests/monitor.test.mjs`).
19. **A mod's spawned children end when the module reloads**, and a reload re-runs `session.start` while the
    pane stays up. `$.ui.panes()` lists panes that survived the reload; the Room restarts its follower from
    there (found in the acceptance run, then tested).
20. **The terminal has no `Svg` element**; Desktop, VS Code, and mobile do. The Room draws text on the
    terminal and the CLI's SVG elsewhere (mod tests on both surfaces).

## Assumptions not yet verified (each has an owner gate)

| Assumption | How it will be settled | Gate |
| --- | --- | --- |
| Eval runs deny local binding, as the default sandbox does | **Settled: yes** (`listen EPERM` in eval runs); they also refuse to start `npm`/`npx` from a child process and can't start git (decision 0004) | G5 |
| The plugin's `bin/actors` is on `PATH` inside eval runs | **Settled: not for skill injection** (`!actors … || true` printed `command not found: actors`); agents used `npx actors`. Interactive sessions: unverified | G5 |
| In `-p`/eval runs the mod's `tool.call` guard runs and `$.ui.ask` cannot be answered | **Settled: yes**: the Room refused every deploy attempt in headless eval runs without asking | G5/G6 |
| The Desktop app draws the Room's SVG as the desktop-surface test expects | `claude plugin test` validates the desktop tree (settled for the tree); acceptance step A10 in the Desktop app | G6 (owner) |
| Clean install from the marketplace in a container | G7 clean-container script | G7 |
