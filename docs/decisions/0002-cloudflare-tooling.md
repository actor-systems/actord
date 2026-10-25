# 0002 — Cloudflare tooling: Wrangler; `cf` and Void are not dependencies

- **Date:** 2026-10-24 · **Gate:** G0 · **Status:** accepted · **Reversibility:** moderate (generated
  projects carry `wrangler.jsonc`)

## Decision
Generated projects and reference apps use **Wrangler** (`wrangler.jsonc`, `wrangler types`, `wrangler dev`)
and `@cloudflare/vitest-plugin`, which reads the same config. Deploy plans name `wrangler deploy` as the
command a human runs after approval. The toolkit never runs it.

## Comparison against the same app (`spikes/do-messaging`)
| Tool | Local start | Types | Tests | Result |
| --- | --- | --- | --- | --- |
| Wrangler 4.152 | `wrangler dev` → `Ready on http://127.0.0.1:8799`, curl returned `spike` | `wrangler types` generated `worker-configuration.d.ts` | vitest plugin reads `wrangler.jsonc`; 3/3 pass | chosen |
| `cf` 1.0.0-beta.20 | no local dev command (`cf cli search` found none) | — | — | `cf build` refused: "wrangler is declared … but is not installed" (it doesn't see a workspace-hoisted wrangler). `cf` is a broad account-API CLI |
| Void 1.2.1 | Vite dev server for full-stack apps | — | — | built on `cf`; its announcement covers Vite web apps and doesn't mention DOs. Not installed: it targets frontends the reference apps don't have |

## Consequences
- No deployment adapter, and no dependency on `cf` or Void. The application model (`system.ts`) stays
  intelligible without any of them.
- If Void or `cf` gain first-class DO local dev, revisit; the declaration doesn't depend on this choice.
