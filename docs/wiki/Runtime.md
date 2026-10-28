# The runtime and its guarantees

Actors stay native Durable Object classes that install `Lifecycle` and compose `actorRuntime(...)`. What it
guarantees, each backed by tests in workerd (see `examples/release-radar/tests/`):

| Guarantee | How |
| --- | --- |
| Refuses malformed, unauthorized-route, wrong-version, and invalid-payload messages | Envelope checks against `system.ts`; Standard Schema validation |
| Handles a message id at most once per actor | SQLite inbox, retained 7 days |
| A handler's writes, its outgoing messages, and its effect intents commit together or not at all | `ctx.storage.transaction()` around each handler |
| A handler that awaits I/O fails its delivery, and nothing it wrote through `ctx` commits (an abandoned handler's own storage writes aside: Limitations) | Just before the handler runs, a no-op canary transaction is requested inside the handler's transaction. It is first in that transaction's queue, so it runs at the handler's first yield to the event loop, before any other writer could run nested in the handler's transaction. The transaction then throws `<Actor>.<type>: handlers may not await I/O; use ctx.effect` and rolls back, and the delivery fails like any other. A writer that was waiting runs after the rollback, and commits. If the handler finishes first, the canary runs after the transaction and does nothing. Once the delivery ends, every `ctx` method throws `<Actor>.<type>: this handler's delivery has ended; its ctx can't be used`, `ctx.sql.exec` included; `self`, `key` and `now` stay readable. #80, #82 |
| Delivers at least once, then dead-letters | SQLite outbox; alarm retries with backoff, up to 6 attempts |
| Never reports an unacknowledged external effect as delivered | Retries only with an idempotency key; otherwise `in_doubt` |
| A timer set by a handler is delivered after its delay, even across restarts, and handled at most once; it is set only if the handler commits, and cancelling it or setting its key again before it fires wins. A handler that keeps failing is retried with backoff, and after 6 attempts the timer is dropped (`retry.exhausted`), not delivered | `_actors_timers` row, written in the handler's transaction and removed in the transaction that handles it; id derived from the key, the due time and the message that set it |
| A schedule that was missed while the object slept ticks once, then re-arms from now | Per-message due time in `_actors_meta`; the tick carries the missed time as `payload.at` and a derived id |
| A job is settled once, by its completion message, its probe, its deadline (in_doubt), or a cancel reported honestly | The outbox row waits as `awaiting_job` with its handle and deadline. `ctx.settleJob` returns false only once the job is settled: a completion that arrives before the job is waiting settles it at once if its start was already tried, and is otherwise kept and settles it when its start returns, never starting it again. A probe that finds the job done settles it even while a cancel is pending. Decision 0018 |
| An effect interrupted 5 times without settling is parked as in_doubt | A keyed orphan is retried until its 5th interruption (`parkAfterInterruptions`), then marked `in_doubt` with `parked: interrupted N times without settling`, an `effect.parked` event, and never run again. A cancel cut off by 5 restarts is parked the same way (`parked: cancel interrupted N times without settling`). An attempt that fails outside the runner's own handling still ends `in_doubt` with its result message. While any attempt runs, actord also keeps a wake 30 s away so a lost instance is noticed |
| An approval request expires (default 3 days); the actor receives a failed result, and a late approval does nothing | A parked effect's `next_at` is its expiry (`expires` on the effect, default `"3d"`) and holds the alarm. When it passes, the row becomes `denied` with `approval expired`, an `effect.denied` event is emitted, and the result message says `failed`, even for a job whose completion arrived early. `ctx.approve` and `ctx.deny` then return false. Approvals and denials record `{ messageId, from, by }`, with `via` the sender (`@rpc` for `decide()`). Approval requests parked by toolkit 0.2.x have no expiry time and are treated as expired on the first wake after upgrading |
| A webhook delivery is verified and delivered once | The HMAC of the raw body is checked first, in constant time. The provider's delivery id is the envelope id, so a redelivery is `duplicate`. Bad signature `401`, unmapped event `204`, invalid `400`, failed `500`; each refusal is a `source.*` event. Decision 0017 |
| An email reply approves only for the owner, by plain code | In order: envelope sender and header `From` are the owner's (else no reply); no `dmarc=fail`; with `authserv` set, authenticated as `"pass"` (else no reply); not an auto-reply; one `Subject` and at most one `Message-ID`; then a valid, unexpired subject token and a first line of `approve` or `deny`. With authentication `unknown`, an effect declared `publishes: true` can't be approved by email. Every answer that gets this far is acknowledged by reply. Decision 0021 |
| One notification per parked approval | The `approvals.notify` effect is queued with the row id `fx:<notify>:approval:<effect>:<effectKey>`, so parking again sends nothing new. If it fails, the effect stays parked and still expires |
| An agent session starts once per start message, and settles once, as the actor's `returns` message, `agent.failed` or `agent.exhausted` | The session is the internal job effect `agent.session`, keyed by the start message's id, which is also Pi's `operationId`. The model calls `finish` with the `returns` payload, and the job's probe settles it: at once when `finish` asks, otherwise every 30 s. A start while a session runs replaces it, and the replaced session's result is only a note. Decision 0019 |
| A session stops within two model requests of its `usd` (the one that crosses it, and one in flight), within one response of its `turns`, and at its `wallClock` | A watcher of Pi's events aborts the session from outside its run; a request's cost is known only when it ends. A timer and every probe check `wallClock`. The job's deadline is `wallClock` plus 10 minutes; past it the job is `in_doubt`, and the session is aborted. Decision 0019 |
| A tool call is one effect request, and an unkeyed one never runs twice | The request is keyed `<session>:<callId>`, which Pi keeps across a restart. A keyed effect's rerun finds its row; any other is reported to the model as interrupted, and recorded `in_doubt`. Decision 0019 |
| A tool that needs approval answers at once, and its result reaches the session later, or is a note once the session ended | The tool answers "waiting". The result is steered in as a user message, and the probe steers in a denial, which sends no result message. A stop or a replacement denies the session's open approvals. Decision 0019 |
| A running session keeps the instructions it started with | The text is stored on the session row when it starts. Decision 0019 |
| A workspace's edits outlive its container and restarts, and local-only paths never reach the object | Computer's `Workspace` in the object's SQLite; `localOnly` is Computer's `ignore`. A command cut off by a lost container is reported as one that "may have partly run", and never run again by itself. Decision 0022 |
| A push authenticates from the Durable Object, and the token never enters the container | `gitPushEffect`: the app's pinned `https` URL, Basic `x-access-token`, a token minted for each attempt and scrubbed from errors, and `factory/` branches only by default. Decision 0022 |
| A shadow decision's answer is never delivered | `actord check` refuses a shadow decision with a `result` (`DECISION_SHADOW_RESULT`). The runtime never queues a result message for one, whatever its spec says, and its outbox row doesn't keep the answer, so `requestEffect` and an agent's tools get `confirmed` with no value. The answer is kept only in `_actors_decisions`, which handlers must not read to decide. At runtime an unknown `mode` is shadow. Decision 0020 |
| A decision's result can't approve or deny | In every handler of a message type that is a decision's or an extraction's `result`, `ctx.approve` and `ctx.deny` throw, even if another effect shares that type. The guard goes by message type, so it can't see an answer a handler relays in a message of its own (Limitations). Decision 0020 |

**Handlers may not await I/O.** Request I/O with `ctx.effect`, and handle its result message.

- **What fails.** A `fetch`, a timer, a container call or a model fails the delivery with `handlers may not await
  I/O; use ctx.effect`. So does any other await that yields to the event loop, I/O or not: `setTimeout(0)`,
  libraries that use timers internally, `sync()`, `getCurrentBookmark()`, a nested `transaction()`, and a `Request`
  or `Response` body read (`text()`, `json()`).
- **What a handler may await.** Microtasks, and these storage calls: `get`, `put`, `list` and `delete`, the alarm
  calls, `ctx.sql`, `kv`, `transactionSync` and Lifecycle's `jobs.push`. They don't yield: `[storage-awaits-allowed]`
  shows a writer waiting beside the handler stays out of its transaction, and the delivery is handled.
- **The abandoned handler.** A handler whose delivery failed keeps running until its await returns, and can still
  write outside the delivery. Limitations has what it can do.
- **Storage fakes.** A storage fake's `transaction()` must queue behind an open transaction, as workerd's does, or
  every handler that awaits fails with #80's message.

**Effect keys.** An effect key identifies one effect for the actor's lifetime. Requesting it again records `effect.duplicate` and runs nothing. A new attempt at the same logical work needs a new key, for example one that includes an attempt or generation number.

Not guaranteed: exactly-once external effects, global ordering, cross-actor transactions, or a route as a
security boundary. Effect usage is best effort: usage from an attempt that crashed the Durable Object is lost, and usage
reported after an attempt has timed out or ended is dropped. A usage value that isn't a finite number at or above 0 is ignored. Decision 0007 has the details and the platform behavior they rest on.

## Sources

A source is declared in `system.ts` as `sources: { github: webhook({...}), mail: inboundEmail({...}) }`. Its name is
a route sender (`@github`), and routes deliver its messages like any other. Actors never subscribe.

- **`webhook({ path, verify: "github", secret, events })`** names an `env` entry for the secret, never the value.
  `events` maps `<X-GitHub-Event>.<action>` to `{ message, key, map }`: `key` chooses the receiving actor's
  instance, `map` builds the payload, which is validated against the message's schema. Call
  `handleWebhook(request, env, system)` first in `fetch()`; it returns `null` for other paths.
- **`inboundEmail({ secret, owner, from, send, authserv?, message })`** names `env` entries. `actord check` warns
  when wrangler `vars` and `.dev.vars.example` don't name one of them, or `send_email` doesn't declare `send`.
  Call `handleEmail(message, env, system)` from `email()`. It accepts only the owner's reply to an approval request.
  `authserv` is optional: the name of the entry holding the trusted authserv-id. Cloudflare Email Routing's is
  `mx.cloudflare.net` (spike 6 and issue #68; see Limitations). With it, mail from the owner's address that doesn't
  authenticate as `"pass"` is refused without a reply (`source.rejected`, `unauthenticated`), and a missing or empty
  value refuses all mail (`authserv_missing`). Without it every reply is `"unknown"`, an effect that publishes must
  be approved in GitHub, and mail forging the owner's address can get a reply, which goes to the owner.
- **Approval emails.** Declare `approvals: { notify: "<effect>" }` and give that effect the `approvalEmail`
  adapter, with `idempotency: "none"`. The default email includes the effect's input as JSON; supply `describe()`
  if inputs are sensitive. `approvalEmail`'s `to` and `secret` must be the same values as the email source's
  `env[owner]` and `env[secret]`, byte for byte (don't trim one side): the token is signed with one and verified
  with the other, and replies are accepted only from the owner.
- **The owner always hears back.** After a delivered answer (or a duplicate of one), `handleEmail` replies
  `Received: <approve|deny> for <effect> (<effectKey>). …`. A delivery that throws or whose handler fails is tried
  twice more under the same envelope id; if all three fail, the reply asks the owner to answer again. An answer the
  actor rejects gets a reply saying it couldn't be applied, and why.
- **Finding a missed event.** GitHub doesn't redeliver failed deliveries automatically (a timeout, `4xx` or `5xx` is a failure); they can be redelivered by hand for a limited period. `source.invalid` and
  `source.failed` events carry the delivery id; `actord events` shows them.

Not guaranteed: GitHub signs only the body, so a captured delivery replayed under a new `X-GitHub-Delivery` is
treated as a new event. Keep the secret, use HTTPS, and keep handlers idempotent on business keys.

## Agent actors

An actor declared `kind: "agent"` runs a Pi session in its own Durable Object (decision 0019), with an optional
Computer workspace (decision 0022). Import from `@actord/toolkit/agents`, the only entry point that loads Pi or
Computer.

- **The declaration.** `harness: pi({ workspace })`, `model: { id, reasoning }`, `instructions` (a file next to
  `system.ts`), `tools`, `on`, `returns` and `budget: { usd, turns, wallClock }`.
  - `tools` lists `workspace.*` or `workspace.<name>`, and effects in the actor's `effects`. Each effect tool needs
    `input`, a Standard Schema, which the model is shown as the tool's parameters.
  - `on` maps a message to `"start"`, `"steer"` or `"stop"`.
  - Routes deliver each `on` message to the actor, and `returns`, `agent.failed` and `agent.exhausted` from the actor
    to itself. Declare the last two with the exported schemas `agentFailed` and `agentExhausted`.
- **The class.** `agentRuntime(host, system, actor, handlers, options)`. `handlers` cover every message except the
  `on` messages, which drive sessions; a handler for a tool effect's result message is optional.
  - `options.instructions` is the instructions text, imported as a wrangler Text module.
  - `options.transcripts` is an R2 bucket. Each session's messages are written to
    `transcripts/<actor>/<key>/<session>.json` when it ends.
  - `options.render` turns an `on` message into a prompt. The default is the type, then the payload as indented JSON.
  - The Worker needs the Workers AI binding, `AI`.
- **A container workspace.** `computer({ backend: containerBackend({ image }), localOnly, egress, execTimeoutMs })`.
  - The class extends Computer's `withWorkspaceContainer(...)` and passes `container: this` to `agentRuntime`.
  - Its `fetch` returns `this.actor.fetch(request)`.
  - **The Worker must export `WorkspaceProxy`** (re-exported by `@actord/toolkit/agents`). The container's computerd
    connection and its egress reach the object through it.
  - Wrangler's `containers` needs an entry for the class with `scheduling_policy: "durable_object"` and `images`.
  - `localOnly` is required; `["**/node_modules"]` is the usual choice. `egress` is `"none"` unless it is
    `"registry-read"`: `GET` and `HEAD` to the npm and Yarn registries. Each exec the tools run is given
    `execTimeoutMs`, 10 minutes by default, as its timeout. A command outrunning it has never been observed live.
- **Git.** `gitClone(workspace, { url, dir, token })` clones on the object's side. `gitPushEffect({ workspace, dir,
  url, token, allow })` is the adapter for a push effect; declare it `idempotency: "key"`. `allow` defaults to any
  `factory/` branch: bind it to the instance's own branch.
- **Testing.** `scriptedModel(...)` in `options.model` replaces Workers AI with a script, and reports the tokens and
  cost the script gives it. It ships in the agents bundle as a test seam, not for production. Containers don't run
  under Cloudflare's Vitest integration, so container tests use a stub of `ctx.container`.
- **Checks.** `actord check` reports an agent without `harness`, `model`, `returns` or a complete `budget`; an `on`
  message with no route to it; a missing self-route; a tool that isn't a listed effect or lacks `input`; workspace
  tools without a workspace; a container workspace without `localOnly`, with an invalid pattern or timeout, or
  without wrangler's container entry; a missing instructions file; and a declared `agent.session` or
  `agent.session.*` name. It warns when `workspace.exec` has no container to run on, and when an approval-gated tool
  effect has no `result` message. Each has an `AGENT_*` code, except a missing budget (`ACTOR_BUDGET_MISSING`).

Not guaranteed: `budget.usd` for a model pi-ai doesn't price (its cost is 0), or a pause in `wallClock` while a tool
waits for a person. A session's `usd` counts the model cost pi-ai reports, not container seconds, so the factory
counts container time itself. A handler that awaits I/O fails its delivery, on every attempt (#80). In each such
delivery, a pi or Computer write that was already waiting to start still joins the handler's transaction, and rolls
back with it. [Limitations](Limitations) has the rest.

## Decisions and extractions

A decision puts typed questions to Clef on Workers AI, and gets a probability for every allowed answer. An extraction
asks Clairic for typed values, each with a confidence. Both are effects, keyed, retried, budgeted and traced like any
other, and every answer is recorded for `actord scorecard` (decision 0020).

- **The declaration.** Two effects from the runtime tests (`packages/toolkit/test-runtime/src/index.ts`), with fewer
  fields:

  ```ts
  "decide.route": {
    description: "Route an issue",
    kind: "decision",
    model: "@cf/cloudflare/clef-flash",
    idempotency: "key",
    result: "probe.decided",
    questions: {
      route: {
        type: "choice",
        instructions: "How should a software factory handle this issue?",
        criteria: {
          ready: "Clear enough to implement now",
          needs_info: "Missing information the factory must ask for",
          not_for_factory: "Needs a human: design, policy, or out of scope",
        },
      },
      one_line: { type: "noul", instructions: "Is the issue only a one-line description with no acceptance criteria?" },
      risk: {
        type: "score",
        instructions: "How risky is merging this change?",
        criteria: ["No risk", "Low", "Medium", "High"],
      },
    },
  },
  "extract.facts": {
    description: "Extract an issue's facts",
    kind: "extraction",
    model: "@cf/cloudflare/clairic",
    idempotency: "key",
    result: "probe.extracted",
    fields: {
      failing_check: { type: "text", instructions: "The verify check that failed" },
      run_id: { type: "number", integer: true },
      done_when: { type: "list", items: "text", instructions: "The acceptance criteria" },
      reported_on: { type: "date", instructions: "The date the failure happened" },
    },
  },
  ```

  - A decision's `model` is `@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash`. An extraction's is
    `@cf/cloudflare/clairic`.
  - `questions` and `fields` are Clef's and Clairic's own request vocabulary, passed through. A question is `noul`,
    `choice` (each option described, or `null`) or `score` (levels, lowest first). A field takes Clairic's types and
    options.
  - The input is `{ state, referenceDate? }`, as in `ctx.effect("decide.route", { state: issue }, { key })`. `state`
    is a string or structured data. Only an extraction sends `referenceDate`.
  - Clairic guesses. Set `null_threshold` on a field where a guess is worse than nothing, and read `confidence` and
    `p_null`.
- **The wiring.** `decisionAdapters(system, { ai: env.AI, inputs? })`, from `@actord/toolkit/decisions`, returns an
  adapter for every decision and extraction, by effect name. Put them in `RuntimeOptions.effects`:

  ```ts
  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "Triage", handlers, {
    effects: { ...decisionAdapters(system, { ai: this.env.AI, inputs: this.env.DECISION_INPUTS }), ...otherAdapters },
  });
  ```

  - The Worker needs the Workers AI binding. `inputs` is an optional R2 bucket: each request body is written to
    `decisions/inputs/<sha256>.json`, named by the hash of its own bytes.
  - The subpath needs no peer dependency.
  - A response that misses an answer, or answers with the wrong type, fails the effect, and isn't retried. A throw
    from `ai.run` is retried under the effect's budget.
  - The cost is `input_tokens` times the toolkit's price table. A response without `usage` reports no cost.
- **The result.** The result message's `value` is `{ model, answers, truncated, inputDigest, inputRef, usage }`.
  `answers` is the model's, verbatim: `answers.route.choice` and `answers.route.probabilities`, `answers.one_line.noul`,
  or `answers.reported_on.value`, with its `confidence` and `p_null`.
- **Records and labels.** Each answer that settles `confirmed` is recorded in `_actors_decisions` as
  `<effect>:<key>`, with a `decision.recorded` event. An extraction's event never carries its values.
  - `ctx.acted("decide.route:<key>", "routed:ready")` records what the actor did. A later call replaces it.
  - `ctx.outcome("decide.route:<key>", { route: "needs_info", one_line: false, risk: 2 })` records what really was
    so: an option for `choice`, a boolean for `noul`, a level index for `score`, and `true` (correct) or `false`
    (wrong) for a field. Labels merge with earlier ones.
  - Both are synchronous, like the other `ctx` methods. They throw for an unknown id, question, field, option or
    level, so a labelling bug fails its handler. A label is checked against the effect as declared now.
- **Shadow mode.** A decision with `mode: "shadow"` is recorded and never delivered. It declares no `result`
  (`DECISION_SHADOW_RESULT`), and `requestEffect` answers it `confirmed` with no value. Its answer is only in
  `_actors_decisions`: don't read that table to decide. At runtime an unknown `mode` is shadow, and `actord check`
  refuses one.
- **No approvals.** A decision never approves (spec §9.3). In a handler of a decision's or an extraction's result
  message, `ctx.approve` and `ctx.deny` throw.
- **`actord scorecard [--effect <name>] [--file <events.ndjson>]`** reads the local event log, as `trace` does. Per
  effect, it prints the recorded, shadow, labelled and acted counts, then:
  - for a `choice`, the accuracy, the Brier score, and how often each option was wrong when chosen;
  - for a `noul`, the Brier score;
  - for a `score`, the mean absolute error;
  - for a field, the share labelled correct, and the correct count by confidence.

  A statistic with no labels shows `-`. `--json` adds the calibration bins for `choice` and `noul`.
- **Checks.** `actord check` reports a model of the wrong family; invalid questions or fields; a `mode` other than
  `act` or `shadow`; a shadow decision with a `result`; a field of another kind; and `publishes: true`. It warns when
  an act-mode decision or an extraction has no `result`, and on `idempotency: "none"`. Each has a `DECISION_*` code,
  except invalid fields (`EXTRACTION_FIELDS_INVALID`).

Not guaranteed: that a handler doesn't act on a decision's answer it relays in its own message, or on a shadow answer
it reads from `_actors_decisions` itself. The scorecard sees local logs only. [Limitations](Limitations) has the rest.
