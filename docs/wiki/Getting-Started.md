# Getting started

actord works three ways: as a Claude Code plugin, as a Codex plugin, or as the `@actord/toolkit` package on
its own. All three need Node.js 22.18+.

## Claude Code

From your shell:

```sh
claude plugin marketplace add actor-systems/actord     # or a local clone: claude plugin marketplace add ./actord
claude plugin install actord@actord
```

Or inside a Claude Code session: `/plugin marketplace add actor-systems/actord`, then `/plugin install actord@actord`.

Requirements: Claude Code 2.1.287+ (2.1.269+ without the Room). Works in the terminal, the Desktop app's
Code tab, and the VS Code extension. claude.ai and Cowork don't install plugins that ship a `bin/`
directory, so this plugin doesn't run there.

Then run `/actord:start` in a session. It runs `actord doctor`, explains what it found, and offers one next
step. See [The Claude Code plugin](Claude-Code-Plugin) for what's in it.

Recommended companions, not dependencies:
- `cloudflare@cloudflare`: Cloudflare's platform skills and MCP servers.
- `typescript-lsp@claude-plugins-official`: compiler diagnostics after each edit, so contract violations
  in `system.ts` reach Claude at edit time.

**Update.** Refresh the marketplace, update the plugin, then reload it in a running session:

```sh
claude plugin marketplace update actord
claude plugin update actord@actord
```

In a session, run `/reload-plugins`. A project created by `actord init` pins its own `@actord/toolkit`, so
Claude and CI keep running that version until you change the pin; `actord doctor` reports when the plugin
bundles a different version than the project pins.

**Uninstall.** `claude plugin uninstall actord@actord` (add `--keep-data` to keep caches), then
`claude plugin marketplace remove actord`. Projects keep working without the plugin: their tests,
`actord` CLI pin, verify skill, and permission rules live in the project.

## Codex

```sh
codex plugin marketplace add actor-systems/actord  # or an absolute local checkout path
codex plugin add actord@actord
```

Requires npm, tar, and Codex plugin CLI support (tested 0.164.0). Open a fresh chat and invoke
`setup-actor-project`. The plugin ships six workflow skills and its launcher, without hooks or MCP. See the
[Codex plugin's details](https://github.com/actor-systems/actord/blob/main/plugins/codex/README.md).

**Update (Codex).** Remove and re-add the plugin and marketplace, then start a fresh chat:

```sh
codex plugin remove actord@actord
codex plugin marketplace remove actord
codex plugin marketplace add actor-systems/actord
codex plugin add actord@actord
```

**Uninstall (Codex).** Run `codex plugin remove actord@actord`, then
`codex plugin marketplace remove actord`. Projects retain their own toolkit pins and tests.

## The toolkit on its own

```sh
npx @actord/toolkit init my-app   # a tested starter: system.ts, two actors, workerd tests
cd my-app && npm install && npm test
```

To add it to an existing Worker project: `npm install -D @actord/toolkit zod`, then `npx actord init --adopt`.
See [The actord CLI](CLI) and [The runtime and its guarantees](Runtime).

## Which agent a project is set up for

`actord init --host codex` writes `AGENTS.md` and `.agents/skills/verify/SKILL.md`; `--host claude` writes
Claude Code's guidance and permission rules; `--host none` writes neither. Adoption preserves existing
files, and each plugin's launcher picks its own profile. Runtime, type contracts, checks, events, and
reliability claims are the same for every host.
