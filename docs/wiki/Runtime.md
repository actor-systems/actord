# The runtime and its guarantees

Actors stay native Durable Object classes that install `Lifecycle` and compose `actorRuntime(...)`. What it
guarantees, each backed by tests in workerd (see `examples/release-radar/tests/`):

| Guarantee | How |
| --- | --- |
| Refuses malformed, unauthorized-route, wrong-version, and invalid-payload messages | Envelope checks against `system.ts`; Standard Schema validation |
| Handles a message id at most once per actor | SQLite inbox, retained 7 days |
| A handler's writes, its outgoing messages, and its effect intents commit together or not at all | `ctx.storage.transaction()` around each handler |
| A handler that awaits I/O fails its delivery, and nothing it wrote commits | A `setTimeout(0)` sentinel is queued before the handler runs. If it fires before the handler settles, the handler awaited I/O or a timer, so the transaction throws `<Actor>.<type>: handlers may not await I/O; use ctx.effect` and rolls back. The delivery then fails like any other. Microtasks and most storage awaits finish before it without letting another writer in. A few awaits let one in and still finish first, so they aren't caught (below). Once the delivery ends, every `ctx` method throws `<Actor>.<type>: this handler's delivery has ended; its ctx can't be used`, `ctx.sql.exec` included; `self`, `key` and `now` stay readable. #80 |
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

**Handlers may not await I/O.** Request I/O with `ctx.effect`, and handle its result message.

- **What fails.** Anything that crosses an event-loop turn fails the delivery with `handlers may not await I/O; use
  ctx.effect`: a `fetch`, a timer, a container call, a model. Any await still pending at the next event-loop turn
  fails the delivery, even `setTimeout(0)` and libraries that use timers internally.
- **What a handler may await.** Microtasks, and these storage calls: `get`, `put`, `list` and `delete`, the alarm
  calls, `ctx.sql`, `kv`, `transactionSync` and Lifecycle's `jobs.push`. `[storage-await-no-macrotask]` shows they
  keep a writer waiting beside the handler out of its transaction.
- **What a handler must not await, though the sentinel misses it.** A nested `transaction()`, `sync()`,
  `getCurrentBookmark()`, and a `Request` or `Response` body read (`text()`, `json()`). Each lets a waiting writer
  run inside the handler's transaction, yet finishes before the sentinel fires. If the handler then throws, the
  writer's rows roll back with it, and the delivery fails with the handler's own error (#82).

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
