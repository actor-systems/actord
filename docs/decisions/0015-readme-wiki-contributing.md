# 0015 — A landing-page README, a wiki for reference, CONTRIBUTING for the repository

- **Date:** 2026-10-25 · **Gate:** G7 · **Status:** accepted (owner) · **Reversibility:** easy

## Context
With the repository public, the README was the only document: install for two hosts, the CLI, the runtime,
the Room, the full trust listing, limitations, evaluations, and how to develop the repository, about 300
lines. The owner wants the README to work as a landing page that says what actord is, why it matters, and
how to start, with the detail in a GitHub wiki and contributor material in `CONTRIBUTING.md`.

Some of that detail is checked: the charter requires the trust section to list every hook, mod event, mod
call, and monitor command (`tests/trust-section.test.mjs`), and tests require a CLI row per command and
complete install, update, and uninstall instructions. A GitHub wiki is a separate repository that CI never
sees.

## Decision
1. **README:** a landing page: what it is, why, getting started on Claude Code, Codex, or the toolkit alone,
   one system shown as `actord graph --format mermaid`, what you get, status, and links into the wiki.
2. **Wiki:** its pages are written in `docs/wiki/` (versioned and tested with the code) and published with
   `scripts/publish-wiki.sh`, which makes the wiki match that folder. The checks that read the README now read
   these pages: the trust listing is `docs/wiki/Trust-and-Safety.md`, the CLI rows `docs/wiki/CLI.md`, and
   install, update, and uninstall `docs/wiki/Getting-Started.md`; links between pages and the sidebar are
   checked too. This satisfies the charter's trust-section requirement on the wiki page instead.
3. **CONTRIBUTING.md:** the repository layout, setup, verification lanes, conventions (built `dist/` committed,
   one version, decision records, portable evidence), the eval lane, and the release steps.

## Consequences
A wiki edit made on GitHub is overwritten by the next publish; edits belong in `docs/wiki/`, as the wiki's
Home page says. The npm package keeps its own README (`packages/toolkit/README.md`).
