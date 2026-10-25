# 0004 — workerd tests and the eval sandbox: split and label the evidence

- **Date:** 2026-10-24 · **Gate:** G0 · **Status:** accepted (eval behavior pending G5) ·
  **Reversibility:** easy

## Finding
Granted Bash in `claude plugin eval` runs under Claude Code's OS sandbox. On macOS that sandbox refuses
`listen()` on loopback unless `network.allowLocalBinding` is true, and Miniflare/workerd must listen.
- Observed in this Claude Code session with `sandbox.enabled: true`: `Error: listen EPERM: operation not
  permitted 127.0.0.1` from `@cloudflare/vitest-plugin`.
- Reproduced without a model: `spikes/do-messaging/sandbox/run.sh` runs the spike under srt 0.0.81 →
  `default 1 listen-eperm`, `local-binding 0 passes`.
- Writes must also reach srt's `TMPDIR` (`/tmp/claude-<uid>`), where Miniflare creates its state dir.

## Decision
1. `actors verify` classifies a runtime suite failing with `listen EPERM` as **blocked (sandbox: local port
   binding denied)**, never as passed or as a product failure.
2. Static evidence (typecheck, `actors check`, graph, diff) is graded inside eval runs.
3. Runtime verification for eval workspaces is re-run outside the sandbox on `--keep-temp` copies by
   `scripts/rerun-eval-workspaces.sh`, and reports label each result with where it ran (`eval-sandbox` or
   `host`).
4. We don't ask users to loosen their sandbox. Generated projects document `allowLocalBinding` as the
   setting that lets runtime tests run sandboxed, and leave the choice to them.

## Open
Whether eval runs allow local binding is unverified until the first approved eval run (G5).
