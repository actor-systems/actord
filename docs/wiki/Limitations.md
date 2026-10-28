# Limitations and unverified claims

- **Not guaranteed by the runtime:** exactly-once external effects, global message ordering, transactions
  across actors, or a route as a security boundary. An effect without an idempotency key that loses its
  acknowledgment is reported `in_doubt`, never delivered. Nothing here undoes an external action.
- **A larger install.** `@actord/toolkit` requires `agents` 0.30.1 (pinned) as a peer dependency. With its
  dependencies and required peers, that adds about 170 packages to every project that installs the toolkit: this
  repository's lockfile grew from 197 to 348 packages when the runtime moved onto the Agents SDK. This is accepted
  (#12), because the runtime is a Lifecycle capability of that SDK.
  - **Agent actors add more**, as optional peers: Pi (`@earendil-works/pi-durable`, `pi-ai` and `chord`, 1.4.0),
    `@cloudflare/computer` 0.8.0, `@platformatic/vfs` 0.4.0 and zod. With pi-ai's provider SDKs (OpenAI, Anthropic,
    Google, AWS Bedrock) and their helpers, Pi and Computer grew this repository's lockfile from 356 to 439 packages
    (spike 3). npm warns that two of them, `@google/genai` and `protobufjs`, have install scripts.
  - **`@platformatic/vfs` isn't imported by the toolkit.** It is a peer of Computer's git client, which loads it
    lazily and fails without it.
  - Accepted on the same ruling (#12): an app without agent actors installs none of them.
- **Local evidence only.** Tests run in workerd through Cloudflare's Vitest integration; `actord events` and
  `actord trace` read logs from local runs and never see production. The suites deploy nothing. Spikes 2, 4, 5 and 6
  ran on Workers the owner deployed for them, and their evidence is in `docs/evidence/`.
- **No container runs in tests.** Under `@cloudflare/vitest-plugin` 1.4.7 a Durable Object has no `ctx.container`:
  the plugin turns containers off, so neither a `containers` entry nor Computer's `ContainerBackend` gets one
  (spike 3). Container tests run against a stub of `ctx.container` (`start`, `getTcpPort`, `destroy`, `running`),
  not a real container. What a real container does when it is lost, when a command runs long, or during an install
  was seen only in spikes 2 and 4, on one image, one instance size and one region. A command outrunning
  `execTimeoutMs` has never been observed live: the spikes' longest ran 185 s. Tracked: none.
- **The Container backend is experimental.** Computer marks its Container backend, its sync protocol and computerd
  "unsuitable for production use"; its filesystem, git client and Pi tools are stable. The toolkit pins Computer at
  exactly 0.8.0. An upgrade can change what the spikes measured, so it needs the spikes' checks again, by hand.
  Computer doesn't accept unsolicited pull requests, so fixes go through its issues. Tracked: none.
- **Container commands don't get the image's `ENV`.** computerd gives a command only `HOME`, `OLDPWD`, `PATH`, `PWD`
  and that exec's own `env` (spike 2). Anything a command needs goes in that exec's `env`. With `registry-read`, the
  toolkit passes `NODE_EXTRA_CA_CERTS` on every exec through `workspace.runtime` itself, but a client that ignores it
  (curl, pip) still distrusts the gateway until the image adds its certificate to the system bundle, which needs a
  start command. Tracked: none.
- **An exec through `workspace.stub()` doesn't get the egress CA.** The toolkit adds `NODE_EXTRA_CA_CERTS` to every
  exec through `workspace.runtime`, but Computer's RPC stub (`workspace.stub()`, for handing the workspace to another
  Worker) runs execs on the unwrapped Workspace. Pass `NODE_EXTRA_CA_CERTS` in such an exec's `env`. Tracked: none.
- **Large tarballs through the registry gateway.** In spike 2, the `workerd` and `wrangler` tarballs arrived corrupt
  once ("zlib: invalid distance too far back"), and npm's retry fixed them. The cause is unknown: the gateway's
  streaming or the HTTPS interception. If it happens again, the gateway may need to buffer a tarball before
  answering. Tracked: none.
- **`@actord/toolkit/agents` loads Computer and zod at import.** So every app with an agent actor installs
  `@cloudflare/computer` and zod, even one whose agents have no workspace. Every planned agent has a workspace, so
  phase one pays nothing for it; splitting out an `agents/workspace` entry point would end it. Tracked: none.
- **A budget can overshoot by two model requests.** actord aborts a session from outside its run once its `turns` or
  `usd` is reached (Pi has no budgets, and a Pi hook can't stop a run), and a request's cost is known only when it
  ends. So the overshoot is at most two model requests: the one that crosses the limit, and one already in flight when
  the abort lands. For `turns`, that is at most one response past the limit. In the tests, `usd: 1` with $0.40
  requests stopped between $1.20 and $1.60. Tracked: none.
- **`budget.usd` counts only model cost that pi-ai prices.** For a model it doesn't price, pi-ai reports a cost of 0,
  so the `usd` budget is silently unenforced. The pinned model, DeepSeek V4.1 Flash, is priced. A model swap could
  switch the `usd` budget off with no error; `turns` and `wallClock` still hold. A session's `usd` counts the model
  cost pi-ai reports, not container seconds, so the factory counts container time itself. Tracked: none.
- **Approvals come back as user messages.** A Pi tool can't defer its result, so a tool that needs approval answers
  "waiting" at once, and the result arrives later as a user message (`Result of <effect> (request <key>): …`), not
  as the tool's result. The model reads it as new input in the conversation, and may have moved on or ended its turn
  by then. The session's `wallClock` keeps running while it waits: the session's job ends at `wallClock` plus 10
  minutes, though the approval stays open for its expiry (3 days by default), so a later approval's result is only a
  note. An app whose approvals take long needs a longer `wallClock`. Tracked: none.
- **An abandoned handler can still write.** A handler that yields to the event loop fails its delivery ("handlers may
  not await I/O; use ctx.effect", #80, #82), on every attempt: up to 6 for a message before it dead-letters, or until
  `retry.exhausted` for a timer. The handler itself keeps running until its await returns, so each attempt reruns its
  post-await code and its I/O. Its `ctx` refuses every call, but it can still write outside the failed delivery:
  - a nested `transaction()` it was awaiting runs after the rollback, as a transaction of its own, and commits
    (`[abandoned-handler-limits]`);
  - its `this.actor.requestEffect` calls are accepted, and their effects run (`[request-effect-in-handler]`);
  - its direct `this.ctx.storage` writes are accepted (`[abandoned-handler-limits]`).

  Writers beside it, such as pi's session store, Computer's vfs sync-back, Lifecycle's job rows and actord's drain
  settlements, are safe: the delivery rolls back before any of them runs, and they commit (`[canary-ordering]`). The
  fix is #80's: don't await I/O in a handler; use `ctx.effect`. Measured in local workerd. This applies to every
  actor. Tracked: none.
- **The `corsProxy` residual.** Computer 0.8.0's push ignores the `corsProxy` it is passed, and reads `http.corsProxy`
  from the workspace's `.git/config`, which the agent can write with `exec`. The toolkit refuses a push when one is
  set, checking just before the push, and only storage, never the network, runs between that check and Computer's
  read. If a write ever landed in between, one push's `Authorization` header could go through a proxy the agent
  named. The owner accepted the gap; #79 researches the fix in Computer.
- **Transcripts hold everything the model saw.** A session's transcript in R2 has every tool argument and result, so
  it holds the workspace contents the model read or wrote. The bucket needs restricted access and a retention policy;
  the toolkit sets neither. Tracked: none.
- **A deploy reaches a busy agent late.** A running Durable Object keeps its version until it restarts. In spike 4 a
  deploy reached a busy agent object five minutes late, between two commands, and earlier objects stayed on their
  first version through several deploys. To roll new code to a running agent now, the object must restart (spike 4
  evicted it with `ctx.abort()`). Tracked: none.
- **Clairic is a preview, and guesses.** Cloudflare marks Clairic a preview, so its interface can change, and
  declarations pass its vocabulary through, so they would change with it. It doesn't always come back empty when the
  input doesn't say. In spike 7, `reported_on` came back as the `reference_date` it was given, with confidence 0.97
  and `p_null` 0.32, under the default `null_threshold` of 0.5, though the issue never said when. Set `null_threshold`
  on a field where a guess is worse than nothing, and read `confidence` and `p_null`. A list's confidence is low even
  when the list is right (0.15 for an exact one), so it can't be compared with a scalar's.
  - **An extracted identifier can be misread.** Through the binding, spike 7 got the 11-digit run id 40454645115 back
    as 4045464511, a digit dropped, with no warning; only its confidence, 0.12, was low. Check an extracted id or long
    number against the source before acting on it.
  - **A forecast's value is a list, one entry per step** (`horizon: 3` gave 3), with each step's detail in `steps`.
    The adapter accepts a list of numbers, or of date strings when the field's `min` is a date, of any length.
  - **A `datetime` loses its offset.** Spike 7's input said `2026-10-27T19:15:45Z`, and the value came back as
    `2026-10-27T19:15:45`, with no `Z`. Treat an extracted datetime as having no time zone, and supply the zone yourself
    when it matters.
  - **Tracked:** none.
- **Clef truncates long `state` silently.** Text `state` too long for the context window is cut to fit, and the
  response doesn't say so. The window is 65,536 tokens for Clef, and 24,576 for Clef-flash on its model page. A Clef
  record's `truncated` is `null`. Clairic reports `truncated`, and its record keeps it. The input digest and the R2
  object record what was sent, not what the model read. Tracked: none.
- **Prices are a table in the code.** The cost is `input_tokens` times `PRICE_PER_MILLION_INPUT_TOKENS` in
  `@actord/toolkit/decisions`: $0.24 per million for Clef, $0.038 for Clef-flash, and $0.10 for Clairic. A price
  change needs a toolkit release, and until then costs use the old price. A response without `usage`, or without a
  finite `input_tokens`, reports no cost, and its record keeps `usage: null`. A sum of costs leaves it out rather than
  counting $0. Tracked: none.
- **The scorecard reads local logs only,** as `trace` does: `.actord/events.ndjson` from tests and local runs, or the
  file given with `--file`. Production decisions are recorded in each actor's `_actors_decisions`, and nothing collects
  them yet. Production ingestion is later. A line of the log that can't be read may have held a record, whose labels
  then count for nothing. The scorecard reports how many lines it couldn't read, and how many labels have no record
  for their instance in the log, but can't recover them. Tracked: none.
- **A scorecard mixes models when an effect's model changes.** Cards are per effect. An effect whose `model` changed
  puts both models' records in one card, under the first record's model, though their probabilities aren't
  comparable. `actord diff` reports the change as risky. A new effect for the new model keeps them apart. Tracked:
  none.
- **The R2 inputs bucket holds every decision's full input.** Given `inputs`, the adapters write each request body,
  `state` included, to `decisions/inputs/<sha256>.json`, for shadow decisions and extractions too. That is whatever
  the actor passed, such as an issue's text or a CI log. The bucket needs restricted access and a retention policy, as
  transcripts do; the toolkit sets neither. Tracked: none.
- **A decision can't approve directly, but a handler can relay its answer.** In a handler of a decision's result
  message, `ctx.approve` and `ctx.deny` throw. That handler can still put the answer in a message of its own, whose
  handler can approve. The runtime can't follow the answer that far, so it refuses nothing. The event log's causation
  ids link the approval back to the result message (`actord trace`), but nothing flags it. Don't build an approval on a
  decision's answer (spec §9.3). The handler can't approve through `ActorRuntime.decide` instead: it throws in any
  handler, as `requestEffect` does. Tracked: none.
- **A handler can read a shadow answer with its own SQL.** The guarantee is that a shadow answer is never delivered:
  not by a result message, not in its outbox row, and not through `requestEffect` or an agent's tool. A handler can
  still `SELECT` it from `_actors_decisions` with `ctx.sql`. Handlers must not read that table to decide what to do.
  Tracked: none.
- **Extraction values are kept indefinitely.**
  - **Where:** in `_actors_decisions`, with the full answers. An extraction's value is delivered, so it is also in its
    effect's outbox row and in its result message's outbox row. Every effect's outbox row keeps its input too.
  - **Deletion:** there is no retention or deletion path yet.
  - **What follows:** treat the object's storage as holding whatever the extraction pulled out of its input.
  - **Tracked:** none. A retention option is future work.
- **An unknown `mode` is shadow at runtime.** A decision whose `mode` is neither `"act"` nor `"shadow"` is recorded and
  never delivered. `actord check` refuses it (`DECISION_MODE_INVALID`), so this matters only when the check is
  skipped. Tracked: none.
- **Labels follow the current declaration.** `ctx.outcome` checks a label against the effect as declared now, not as
  it was when the record was made. Once an effect is removed or changes kind, labelling any of its old records throws,
  and so does labelling a question or field that was removed. See decision 0020. Tracked: none.
- **The approval guard is per message type.** A message type that is any decision's or extraction's `result` loses
  `ctx.approve` and `ctx.deny` in every handler of it, even when another effect, one that isn't a decision, shares it
  as its result, or another sender routes it, to this actor or another. `actord check` warns of either
  (`DECISION_RESULT_SHARED`). Give a decision a result message of its own, routed only from its actor to itself. See
  decision 0020. Tracked: none.
- **Inside Claude Code's default sandbox, workerd tests can't run** (the sandbox denies the loopback port
  Miniflare needs), so `actord verify` reports `blocked` there rather than passing (decision 0004).
- **Measured contribution is modest and uneven.** Two release eval runs on this version: mean `Δ` +0.09 and
  +0.06, clearest on orientation, trace questions, and evolving a running system; near zero where the
  baseline already behaves well. Every safety case held. Inside eval runs agents can't run workerd tests, so
  an agent can't see its own failing test; re-run on the host, plugin runs passed 47 of 48 (baseline 45 of 48).
- **The Desktop app's first `/actord-room`** in a session can be flagged "isn't a command here" and be missing
  from the slash menu; it runs anyway and is listed after that.
- **Approver identity is whatever the approving sender supplies** over RPC. By email it is the verified sender
  address, but the record is evidence, not proof.
- **Email authentication is `"unknown"` unless the app sets `authserv`.**
  - **What spike 6 showed:** Cloudflare Email Routing writes one `Authentication-Results` header, the topmost one, with
    authserv-id `mx.cloudflare.net`. A Gmail reply carried `dmarc=pass` there.
  - **Setting it:** an app may set `authserv` to an env entry holding `mx.cloudflare.net`. Then a reply is `"pass"`
    only when that topmost header has at least one `dmarc` result, every one `pass` with `header.from` the owner's
    domain, and such a reply can approve an effect declared `publishes: true`. Any other reply is refused without
    an answer.
  - **Leaving it unset:** every reply is `"unknown"`. An email can then approve mid-run tool calls but never a
    `publishes: true` effect; approve those in GitHub.
  - **Forged headers (issue #68):** Cloudflare doesn't strip an inbound header that claims `mx.cloudflare.net`. It
    adds its own above it, and only the topmost header is read. In five messages over three MX hosts, signed and
    unsigned, Cloudflare's header was always topmost. That isn't proof that it always will be.
  - **The hardening has landed:** every `dmarc` result must be `pass`, `header.from` must be the owner's domain, and
    the authserv-id compares case-insensitively. The factory sets `authserv` to `mx.cloudflare.net`.
  - **Without `authserv`, forging the owner's address gets the owner a reply.** For an unaligned message from a
    `p=none` domain such as `gmail.com`, Cloudflare writes `dmarc=none`, not `dmarc=fail`. So mail forging the
    owner's address on both envelope and `From` passes the sender check and gets the handler's reply, which goes to
    the owner. It can't approve anything without a valid token. With `authserv`, such mail is refused without a
    reply (#69).
  - **With `authserv`, an owner's reply that isn't `"pass"` is dropped silently.** The owner hears nothing back;
    only a `source.rejected` (`unauthenticated`) event records it. A missing or empty `authserv` value refuses all
    mail and records `authserv_missing`.
  - **The owner's acknowledgement says what arrived, not what it did.** After a delivered answer the reply reads
    `Received: approve for <effect> (<key>). If it had already been decided or had expired, this changed nothing.`
    Whether `ctx.approve` or `ctx.deny` changed anything isn't reported back by email.
  - **Other edges:** strict envelope-sender equality refuses an owner whose provider rewrites MAIL FROM (VERP, SRS); it
    fails closed. An auto-responder that sets none of `Auto-Submitted`, `Precedence: bulk|junk|list|auto_reply`,
    `X-Autoreply` or `X-Autorespond` isn't detected, and its text is read like a person's.
- **GitHub doesn't redeliver failures automatically.** Failed deliveries can be redelivered manually (UI or API) for a limited period; a timeout counts as a failure, as do a `4xx` and `5xx`. `source.invalid` and `source.failed`
  records (with the delivery id) are how a missed event is found. A captured signed delivery can be replayed
  under a new `X-GitHub-Delivery` and is then a new event: keep the secret, use HTTPS, make handlers idempotent
  on business keys.
- **The default approval email includes the effect's input as JSON.** Supply `describe()` for sensitive inputs.
  Declare the notify effect with `idempotency: "none"`; with `"key"`, a notify still retrying after the decision can still send.
- **Guards are conveniences.** The effect guard and the generated `ask` rules match command text; other
  spellings slip past. Token scopes are the enforceable layer.
- **Mods are an early-access Claude Code API** (2.1.287+); the Room is tested against 2.1.310 in the terminal
  and 2.1.308 in the Desktop app, and may need
  changes as the API moves. The core works without it (`scripts/no-hooks-smoke.sh`).
- Monitors run only in interactive sessions, and not on Bedrock, Google Cloud's Agent Platform, or Foundry
  before Claude Code 2.1.310.
