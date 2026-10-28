# Contributing to actord

Thanks for working on actord. This page covers how the repository is laid out, how to verify a change, and
how a release is made. What actord is and how to use it are in the
[README](README.md) and the [wiki](https://github.com/actor-systems/actord/wiki).

## The repository

| Path | What it is |
| --- | --- |
| `packages/toolkit/` | `@actord/toolkit`: the `actord` CLI, the runtime, and the test helpers (one package, for npm) |
| `plugins/claude/` | The Claude Code plugin; `.claude-plugin/marketplace.json` points here |
| `plugins/codex/` | The Codex plugin; `.agents/plugins/marketplace.json` points here |
| `examples/` | Release Radar and Briefing Desk, the reference apps and integration tests for both plugins |
| `fixtures/` | Valid and negative declarations with their expected diagnostics, and recorded event logs |
| `docs/` | The charter, architecture, decisions, the wiki's source (`docs/wiki/`), and recorded evidence |
| `scripts/`, `tests/` | The verification lanes and the repository's own tests |

The toolkit and both plugins share one version and one release tag, and the plugins use the toolkit in
place: a change to the core and to either plugin lands in one commit and one verification run
([decision 0014](docs/decisions/0014-one-repository.md)). The design and the reasons behind it are in
[docs/architecture.md](docs/architecture.md) and [docs/decisions/](docs/decisions/).

## Setting up

Node.js 22.19+ (CI uses 24), then:

```sh
npm install
npm run verify      # offline: writes verify-report.json and docs/verification-report.md
```

The full run also uses the Claude Code CLI and the Codex CLI (CI pins both in
`.github/workflows/verify.yml`), Docker for the Linux install lane, and macOS for the sandbox
checks. A check whose prerequisite is missing reports `blocked` rather than passing.

## Verifying a change

`npm run verify` runs every gate (G0 to G7) and must pass before a change is merged. Other lanes, each a script
you can run alone:

| Script | What it shows |
| --- | --- |
| `scripts/clean-checkout.sh` | What CI runs: a fresh clone (with a stray `.DS_Store` in every directory) installs from the lockfile, rebuilds both plugins' `dist/` byte-for-byte, and passes `npm run verify` |
| `scripts/container-install.sh` | A clean Linux container installs Claude Code from npm, installs the plugin from this marketplace, creates and verifies a starter project, and uninstalls (network: npm only) |
| `scripts/install-smoke.sh`, `scripts/no-hooks-smoke.sh` | Install and uninstall in a throwaway config; the core path with `disableAllHooks` |
| `node scripts/codex/install-test.mjs`, `node scripts/codex/clean-install.mjs` | The Codex plugin installed in a throwaway Codex config; a fresh consumer scaffolding and verifying all three apps |
| `claude plugin test plugins/claude` | The Room's mod tests (terminal and desktop surfaces) |
| `node scripts/typecheck-mod.mjs` | The Room against this Claude Code build's mod declarations |
| `node scripts/record-room-fixtures.mjs [--check]` | Re-record (or check) the CLI output the mod tests stub with |

CI (`.github/workflows/verify.yml`) runs the offline lane on every push. Model-backed evals stay manual.

## Making a change

- **Build what ships.** `npm run build -w @actord/toolkit` writes the CLI bundle, its version, and the toolkit
  tarball into both `plugins/claude/dist/` and `plugins/codex/dist/`. Commit them; CI checks that a fresh
  build reproduces them byte for byte. `npm test -w @actord/toolkit` builds first (its `pretest`), because the CLI
  tests run the built bundles; a fresh clone has none.
- **One version.** Bump `packages/toolkit/package.json` and both plugin manifests together; a test fails if
  they differ.
- **Skill code must compile.** A fenced `ts` block in a skill or agent whose first line is `// actord:check` is
  typechecked against the built toolkit and the Workers runtime types `wrangler types` generates (`node --test
  tests/skill-snippets.test.mjs`, gate `g5.skills.snippets`). `// actord:check system` names a block `system.ts`
  that sibling blocks in the same file import as `./system`, and the built `actord check` must load it. A block
  that reads a new binding from `env` needs it added to the test's wrangler config.
  Mark every example a reader will copy; leave a marker off only a sketch. The Codex `workflow.md` copies are
  hand-copied: edit all twins (`tests/codex-workflows.test.mjs` fails if they drift), and rebuild with
  `npm run build -w @actord/toolkit`.
- **Record decisions.** A change to the design gets a record in `docs/decisions/`, linked from
  `docs/architecture.md` (a test checks every record is linked).
- **Keep the docs true.** The README is the landing page; reference documentation lives in `docs/wiki/` and is
  published to the wiki. Tests check that every CLI command has a row in `docs/wiki/CLI.md` and that
  `docs/wiki/Trust-and-Safety.md` lists every hook, mod event, mod call, and monitor command.
- **Evidence is public.** Recorded evidence names paths portably (`<repo>`, `<temp>`, `~`), never a machine's
  own.
- **No credentials, no deploys.** Nothing in this repository deploys, reads Cloudflare credentials, or calls a
  model outside the eval lane. `.claude/settings.json` denies deploy, secret, remote-write, publish, tag-push,
  and force-push commands for any Claude Code session working here.

## Evaluations

`plugins/claude/evals/` holds the `claude plugin eval` suite. Run it from this repository, because the scaffolds
build offline workspaces from `examples/`:

```sh
scripts/eval-suite.sh <label> <max-cost-usd>   # e.g. scripts/eval-suite.sh 2026-10-25-run1 11
```

It runs `claude plugin eval plugins/claude --scaffold --no-publish --trust-plugin --keep-temp` with pinned
models (`claude-sonnet-5-5`, judged by `claude-haiku-5-5`), the cost ceiling, and the tool grants the cases
need. It writes `docs/evidence/evals/<label>.json`, then re-runs each kept workspace's runtime tests on the host
(`<label>.host.json`), because eval runs deny the loopback port workerd needs
([decision 0004](docs/decisions/0004-workerd-and-the-eval-sandbox.md)). A full run of the 15 cases costs about $12–13. Model-backed
runs spend real usage, so they're a separate, explicit lane, never part of `npm run verify`; record each run in
[docs/evidence/evals/README.md](docs/evidence/evals/README.md).

## Releasing

1. `npm run verify` passes on the release commit, and CI is green.
2. `claude plugin tag plugins/claude` creates the annotated tag `actord--v<version>` (one tag covers the toolkit
   and both plugins); push it.
3. Publish the toolkit from the tarball the plugins ship, so npm carries the same bytes:
   `npm publish plugins/claude/dist/actord-toolkit-<version>.tgz --access public`.
4. Publish the wiki from `docs/wiki/`: `scripts/publish-wiki.sh`.

## License

actord is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contributions are
licensed under the same terms.
