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
1. `actord verify` classifies a runtime suite failing with `listen EPERM` as **blocked (sandbox: local port
   binding denied)**, never as passed or as a product failure.
2. Static evidence (typecheck, `actord check`, graph, diff) is graded inside eval runs.
3. Runtime verification for eval workspaces is re-run outside the sandbox on `--keep-temp` copies by
   `scripts/rerun-eval-workspaces.sh`, and reports label each result with where it ran (`eval-sandbox` or
   `host`).
4. We don't ask users to loosen their sandbox. Generated projects document `allowLocalBinding` as the
   setting that lets runtime tests run sandboxed, and leave the choice to them.

## Settled by calibration (2026-10-25, owner-approved, Sonnet 5.5, $1.49)
Five calibration runs (`docs/evidence/evals/calibration/`) settled the open question and found two more
limits of the eval sandbox on macOS:
- **Eval runs deny local binding.** `npx vitest run` in a run: `listen EPERM: operation not permitted
  127.0.0.1`. Runtime claims inside eval runs are `blocked`, as planned.
- **Eval runs refuse to start `npm` and `npx` from a child process** (`spawnSync npm EPERM`), though the
  agent's own shell can run them. `actord verify` had recorded this as "type errors". Fixed: verify runs
  vitest and tsc under the running node, runs the project's `typecheck` script in `sh` with
  `node_modules/.bin` and that node first on PATH, and classifies a refused spawn as `blocked`. Confirmed in
  a run: typecheck pass, check pass, tests blocked, verdict blocked.
- **Eval runs can't start git** (the macOS `/usr/bin/git` shim can't write its cache). `actord diff` now
  says so and compares against `actord.manifest.json` on disk; the evolve skill classifies before
  regenerating the manifest.
- **Host re-runs matter.** One run graded 1.0 inside the sandbox (static evidence, runtime blocked) failed
  3 runtime tests on the host. `scripts/rerun-eval-workspaces.sh` re-runs every kept workspace by case and
  arm, and the report shows those host verdicts beside the sandbox scores.
- In don't-ask mode an agent that hits a denied command can conclude all Bash is denied; the release lane
  grants a few read-only commands (`ls`, `cat`, `head`, `tail`, `wc`, `git log|show|ls-files`) to both arms.

## Revisited (2026-10-26): letting eval runs bind loopback isn't available
The Codex implementation's evals ran workerd inside the agent's session, so its agents could see their own
runtime failures. Porting that needs `sandbox.network.allowLocalBinding` in eval runs, and `claude plugin
eval` (2.1.310) offers no way to set it: no case.yaml field (`execution:` takes model, turns, timeout,
tools, a system prompt suffix, and `EVAL_*` env), no flag or variable, and the run loads no `.claude/`
settings from the workspace, even ones a scaffold wrote (code.claude.com/docs/en/plugin-evals.md, "How runs
are isolated"). Host re-runs stay the runtime evidence. The Worker itself is now also exercised under
`wrangler dev` by `scripts/dev-smoke.mjs` (`g3.radar.dev`, `g4.desk.dev`).
