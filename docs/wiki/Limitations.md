# Limitations and unverified claims

- **Not guaranteed by the runtime:** exactly-once external effects, global message ordering, transactions
  across actors, or a route as a security boundary. An effect without an idempotency key that loses its
  acknowledgment is reported `in_doubt`, never delivered. Nothing here undoes an external action.
- **Local evidence only.** Tests run in workerd through Cloudflare's Vitest integration; `actord events` and
  `actord trace` read logs from local runs and never see production. Nothing was deployed to Cloudflare.
- **Inside Claude Code's default sandbox, workerd tests can't run** (the sandbox denies the loopback port
  Miniflare needs), so `actord verify` reports `blocked` there rather than passing (decision 0004).
- **Measured contribution is modest and uneven.** Two release eval runs on this version: mean `Δ` +0.09 and
  +0.06, clearest on orientation, trace questions, and evolving a running system; near zero where the
  baseline already behaves well. Every safety case held. Inside eval runs agents can't run workerd tests, so
  an agent can't see its own failing test; re-run on the host, plugin runs passed 47 of 48 (baseline 45 of 48).
- **The Desktop app's first `/actord-room`** in a session can be flagged "isn't a command here" and be missing
  from the slash menu; it runs anyway and is listed after that.
- **Approver identity is whatever the approving sender supplies** until plan 2's verified sources exist. The
  record shows who the sender said approved, and through which sender; it is not proof.
- **Guards are conveniences.** The effect guard and the generated `ask` rules match command text; other
  spellings slip past. Token scopes are the enforceable layer.
- **Mods are an early-access Claude Code API** (2.1.287+); the Room is tested against 2.1.310 in the terminal
  and 2.1.308 in the Desktop app, and may need
  changes as the API moves. The core works without it (`scripts/no-hooks-smoke.sh`).
- Monitors run only in interactive sessions, and not on Bedrock, Google Cloud's Agent Platform, or Foundry
  before Claude Code 2.1.310.
