# 0014 — One repository for the core and both plugins

- **Date:** 2026-10-25 · **Gate:** G7 · **Status:** accepted (owner) · **Reversibility:** moderate

## Context
The core (`@actord/toolkit`: CLI, runtime, test helpers) and the Claude Code plugin lived in one repository,
and the Codex plugin in another, which vendored built copies of the core and both reference apps, pinned
by source and artifact hashes (decision 0012). Every core change needed a sync round: twice on
2026-10-25 alone (the inbox race and `tick()` fix, then Mermaid output). Nothing was published yet, so no
install path depended on either layout.

Both hosts install a plugin from a marketplace file whose entry points at a subdirectory, and the two files
live at different paths: `.claude-plugin/marketplace.json` for Claude Code and
`.agents/plugins/marketplace.json` for Codex. Neither host needs a plugin at a repository's root.

## Decision
1. **One repository, `actord`,** holding `packages/toolkit/` (the core and CLI: one package), `plugins/claude/`,
   `plugins/codex/`, and `examples/`. The Codex plugin uses the core in place; its vendored copies, provenance
   pins, and sync scripts go away.
2. **One version** for the toolkit and both plugins, starting at 0.2.0, and one release tag. `claude plugin
   tag` names tags `{plugin name}--v{version}`, and both plugins are named `actord`, so separate versions
   would collide. `tests/release.test.mjs` checks that the versions agree.
3. **Apache-2.0 throughout.** The Codex plugin was MIT; it becomes Apache-2.0 with the move, under the
   repository's `LICENSE`.
4. **Who moves what.** This repository was restructured for the layout (`plugin/` to `plugins/claude/`,
   `packages/cli` to `packages/toolkit`). The Codex plugin's own agent moves it into `plugins/codex/` and adds
   the Codex marketplace file, since it owns that plugin's build and tests.

## Alternatives
- *Separate repositories per plugin, or for the core.* Worth it for a separate team or release schedule, a
  host that requires a plugin at a repository's root, or a repository heavy enough to slow plugin installs.
  None applies: one team, one schedule, subdirectory installs on both hosts, and 3.5 MB of history.
- *Separate packages for the CLI and the runtime.* The CLI is a view of the same model the runtime enforces;
  they stay one package, `@actord/toolkit`.

## Consequences
The charter's repository tree (`plugin/` at the root, one marketplace entry) is superseded by this layout.
The release tag `actord--v0.1.0` marks the last commit of the old layout. Installed copies need their
marketplace re-added from the new location; nothing was published, so no one else is affected.
