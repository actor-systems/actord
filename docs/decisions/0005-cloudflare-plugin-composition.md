# 0005 — Cloudflare's plugin: recommended companion, not a dependency

- **Date:** 2026-10-24 · **Gate:** G0 · **Status:** accepted · **Reversibility:** easy

## Decision
Don't declare `cloudflare@cloudflare` in `dependencies`. The README recommends it, along with
`typescript-lsp@claude-plugins-official` for edit-time compiler diagnostics. Our skills refer to its skills by
name (`durable-objects`, `agents-sdk`, `wrangler`, `workers-best-practices`) for platform detail.

## Why
Cloudflare's plugin (v1.0.2, Apache-2.0) ships an MCP server that wants OAuth. A hard dependency would make
our install depend on it and break the "offline-capable, no credentials" core. Plugin dependencies would
also need `allowCrossMarketplaceDependenciesOn`.

## Verification plan
The eval suite includes one co-installed case (Cloudflare skills present) to check that our skills don't
fight Cloudflare's on a generic Cloudflare question.
