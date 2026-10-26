# 0012 — One core, thin coding-host adapters

- Date: 2026-10-25. Status: implemented locally. Scope: shared core and Codex consolidation; schema comparator corrections have a separate owner.

`packages/toolkit` supplies the core consumed by both hosts. The existing Claude plugin stays in `plugins/claude/`. The sibling `actord/` repository is the Codex adapter and pins built artifacts and generated reference apps with source/artifact hashes. Consumers never need a sibling checkout.

`actord init --host claude|codex|none` selects project guidance independently from declarations, native runtime, tests and reliability claims. Direct CLI calls infer the project profile from `package.json` (`actord.host`) or Codex guidance; a new unprofiled directory defaults to Claude. The Codex launcher sets `ACTORD_HOST=codex`, and the Claude launcher sets `ACTORD_HOST=claude`. An explicit init flag overrides the environment. Adoption preserves existing host files. Codex doctor findings do not ask for Claude permission settings.

The core is built once and copied by the Codex release synchronization command. It has one source owner; a bundled distribution copy is not a maintained runtime fork. Projects retain independent pins. The Codex adapter's old v0.1 sources and evaluation evidence are archived rather than reinterpreted as acceptance of the new core.

Both authoring adapters emphasize preserving public read APIs and existing tests, adding a focused test for the requested behavior, and reporting blocked runtime checks as unverified. This addresses the recorded handler-edit regression signal; it is not a claim of improved model-eval performance. New model-backed and desktop checks remain separate acceptance work.

The compatibility classifier in `src/model/diff.ts` is deliberately outside this change. Its separately owned correction is incorporated into Codex by explicitly refreshing the core pin.
