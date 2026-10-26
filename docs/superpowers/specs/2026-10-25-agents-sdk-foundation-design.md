# actord on the Agents SDK: foundation and agent actors

Design, 2026-10-25. Status: draft for review.

The running example throughout is a personal software factory. It is described here only as far as it drives the toolkit. The factory gets a design document of its own.

## 1. Intent

actord should be the place to build durable, event-driven systems in which programs and agents work together. The target covers software factories, knowledge work, and general automation: monitors, triage, daily briefings, research pipelines. Today actord handles short request/reply effects well. It has no way to host a long-running agent, wait on outside events, or set its own timers, and it cannot share a Durable Object with the Cloudflare Agents SDK, because both want the object's single alarm.

This design puts actord on the Agents SDK's `Lifecycle` layer and adds what the factory needs:
- timers
- effects that finish later
- inbound sources such as webhooks and email
- agent actors with declared tools and approvals
- typed calls to Cloudflare's decision and extraction models

actord keeps the part only it provides: one typed declaration of the whole system, plus guarantees that are honest and tested.

The project is brand new and has no users, so breaking changes are acceptable.

## 2. Goals, non-goals, anti-goals

**Goals**
- An actord actor can host an Agents SDK harness (Pi first) in the same Durable Object, without conflicts over the alarm.
- Everything the factory needs from the toolkit is declared in `system.ts`:
  - an agent's harness, model, instructions, tools, approval rules, lifecycle messages, result, and budget;
  - inbound sources;
  - timers;
  - long-running jobs;
  - decision and extraction calls.
- Every new guarantee is backed by a fault test in workerd, or marked as not guaranteed. This follows the existing rule in `docs/wiki/Runtime.md`.
- Phase one ends when the factory opens its first pull request and merges it after the owner approves it in GitHub (§10).

**Non-goals**
- A general workflow engine.
- A replacement for the Agents SDK's own scheduling, harnesses, or chat features.
- Multi-cloud.
- A hosted service.
- Exactly-once external effects. These stay impossible, and the toolkit says so.
- Auto-merge in phase one. The design must allow for it later (§9.4), but phase one always requires the owner's review.
- Polling backstops for webhooks. Deferred until a missed webhook is actually observed.

**Anti-goals**: things that would count as failure even if everything else works.
- Publishing to a package registry without human approval, by any path (§9.3).
- An agent able to act on the outside world other than through a declared effect.
- A model interpreting a human approval, or acting as a guard.
- Spending without a hard stop.
- A guarantee claimed in docs that no test exercises.

## 3. Decisions so far

**The owner's decisions:**
- The first application is a personal software factory driven by GitHub issues on repos the owner owns. GitHub Actions is the CI.
- Every open issue in an active repo is eligible unless it carries the label `not-for-factory`.
- The factory stops at a PR for the owner's review. Once the owner approves in GitHub, the factory merges on its own when the approval webhook arrives. Autonomy will later graduate per lane, using a Cloudflare decision model; phase one always requires review.
- Inbound events come from webhooks only, with no polling until missed webhooks prove to be a problem.
- Publishing to a package manager always needs human approval.
- At most 7 factory PRs may wait for review at once. This is configurable.
- The coding agent is Pi, and it must stay swappable. Its model is `@cf/deepseek-ai/deepseek-v4.1-flash-1017` on Workers AI.
- The second LLM is `@cf/zai-org/glm-5.3-flash`. The factory should use the Clef family (Clef, Clef-flash, Clef-omni) and Clairic; the owner wants to learn them.
- Spend alerts at $10 a day, and work stops hard at $30 a day.
- The factory acts as a GitHub App.
- Mid-run approvals and escalations go to email first. Telegram, Discord, Slack and SMS come later.
- **Agent workspaces use `@cloudflare/computer`,** with its Container backend for commands that need Linux (§7.4).
- **The factory lives in a separate private repo.** It uses the toolkit through a local package or git dependency, so nothing is published to npm first.
  - Planning of the toolkit work (§5–9) can start now.
  - The factory's own design doc is written before the factory is planned.
- **The Claude and Codex plugins are updated in phase one, as its last step.** That covers skills, `actord init` templates and Codex references, so nothing teaches the old `alarm()` style. There is no npm release and no paid eval run without separate approval from the owner.
- **The pilot repo is actord itself, starting with issue #1.** The builder has standing approval to create and deploy on the owner's accounts:
  - a GitHub App;
  - Containers;
  - Workers AI;
  - R2;
  - email routing on the owner's Cloudflare domain.

  The spike budget is about $20 in total. Once the factory runs, its $10 alert and $30 stop apply. The domain and the approval address are still to be supplied by the owner before spike 6.
- **If the Worker can't see email authentication results, an email reply can still approve mid-run tool calls,** on a valid signed token plus the owner's From address, with that limit documented. Anything that publishes needs approval in GitHub until authentication is confirmed (§8.2).

**The designer's calls**, each marked "(designer's call)" where it appears below:
- actord joins `Lifecycle` through an adapter first (§5.1).
- Sources are declared at the system level, not on actors (§6).
- Approval belongs to effects, not agents (§7.3).
- Pi's loop runs in the Durable Object (§7.4).
- `node_modules` and build output stay local to the container, never synced (§7.4).
- Approvals by email are made by reply, never by link (§8.2).
- Decision models run in shadow mode before they act (§9.4).
- The phase-one scope in §10.
- The $30 stop is a true ceiling, enforced by reservations (§10).
- At most 3 Coder sessions run at once (§10).
- Containers may read from package registries but never publish to them (§7.4).
- An edited issue is triaged again, and steers the Coder only when its checklist changes (§7.1).

## 4. Constraints that shape everything

**Platform.** Each fact was checked in documentation or in source at the version noted. The Agents SDK facts come from a checkout of `cloudflare/agents` at commit `321814b` (`agents@0.30.1`, 2026-10-23). A copy installed elsewhere may be older, so re-check the cited line numbers against 0.30.1 before spike 1.

- **One alarm per Durable Object.** Alarm handlers have a 15-minute wall-time limit.
  - Pending I/O keeps an object alive.
  - A deploy restarts every object.
  - [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- **The Agents SDK `Lifecycle` owns the alarm** (`agents@0.30.1`, `packages/agents/src/lifecycle/`).
  - Every timer is a row in `cf_agents_jobs`, and the alarm is set to the earliest row.
  - A 30 s fallback alarm is armed before each drive.
  - A job must return quickly. Long work goes through `trackAlarmWork`, and the job returns `{ rescheduleAt }`.
  - `Lifecycle.install(this)` skips installing `alarm` if the class already defines one (`durable-object-lifecycle.ts:274`). actord's templates do define it (`packages/toolkit/src/templates/project.ts:96`), and so does every example actor.
- **Harnesses** (`agents/harness/{pi,container,think,opencode,ai-sdk}`) are all `Lifecycle` capabilities that share one session shape: `session()`, `submit({ operationId })`, `wait`, `abort`, `messages`. All are experimental.
- **pi-durable 1.4.0** commits each model call and tool call before showing it.
  - After a crash, only tools declared `replay: "safe"` run again. The others return "interrupted" to the model.
  - A task interrupted 5 times without progress is parked.
  - Its tool environment interface, `ExecutionEnv`, is `FileSystem & Shell` (`pi/packages/durable/src/env/index.ts:374`). The only built-in implementation is Node.
- **Containers.**
  - `ctx.container.exec(argv, { env, user, cwd, stdin })` runs a process and returns its exit code and output.
  - Work running inside a container does not count as activity for the Durable Object.
  - The object is not woken when its container stops.
  - A deploy restarts the object, but a running container keeps going.
  - [Container lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)
- **Computer** (`@cloudflare/computer` 0.7.0, commit `2b23503`, 2026-10-23).
  - A filesystem stored in the Durable Object's SQLite, about 10 GB per workspace.
  - It comes with agent tools (including Pi tools), a git client, and execution backends:
    - Worker isolates;
    - a Container running `computerd`, which mounts the files through FUSE and syncs changes back.
  - The filesystem, git client and agent tools are marked stable. The Container backend, the sync protocol and `computerd` are experimental: "unsuitable for production use".
  - A full `npm install` on the FUSE mount took about 2× as long as on the container's own disk. That is before the larger cost of syncing `node_modules` into the Durable Object.
  - `MOUNT_IGNORE` keeps chosen paths on the container's disk and out of the sync. Its savings haven't been measured.
  - Git clone and push run on the Durable Object side, with auth passed as a header. A shallow clone can't be pushed safely.
  - [Blog post](https://blog.cloudflare.com/cloudflare-computer/), [repository](https://github.com/cloudflare/computer)
- **Email.**
  - The Agents SDK sends mail through Cloudflare Email Service and can HMAC-sign routing headers.
  - `createSecureReplyEmailResolver` checks the signature and its age on a reply (`agents/docs/agents/email.md`).
  - Inbound mail reaches the Worker's `email()` handler.
- **Chat SDK.** `agents/chat-sdk` stores [Chat SDK](https://chat-sdk.dev/) state durably. That makes future Telegram, Slack, Discord and Teams channels a matter of adapters.

**GitHub.**
- A PR's author cannot approve it, so the factory needs its own identity (the GitHub App).
- GitHub does not automatically redeliver failed webhook deliveries.
- The merge endpoint accepts a `sha` that the head must match.

**Models.** All run on Workers AI, through the AI binding.

| Model | Notes |
| --- | --- |
| DeepSeek V4.1 Flash | Tool calling, 1M context. $0.30 per million input tokens, $1.20 per million output. |
| GLM-5.3 Flash | Tool calling, 1M context. $0.15 per million input, $0.50 per million output. Reasoning cannot be turned off. |
| Clef (27B), Clef-flash (9B), Clef-omni (30B MoE, images; audio and video unconfirmed) | Return a probability for each allowed answer to typed questions. |
| Clairic (preview, Oct 19) | Extracts typed values. Returns empty rather than guessing, with a confidence score. |

The exact request and response shapes for Clef and Clairic still need checking against Cloudflare's model pages.

**The charter.**
- Native Durable Objects, with native behaviour still reachable.
- Programs before agents.
- Delivery semantics stated honestly.
- The machinery never calls a model, and never approves anything.
- Earn every abstraction.

This design changes charter §4, which says to favour the Agents SDK "when needed", into "actord runs on the Agents SDK's `Lifecycle`". That change goes in the decision log (§13).

## 5. The foundation: actord as a Lifecycle capability

### 5.1 How actord joins Lifecycle (designer's call: adapter first)

`actorRuntime(...)` registers a `LifecycleCapability` with the id `"actord"` on a `Lifecycle` the actor class installs. It does this the way the SDK documents capabilities, not through a shim on `ctx.storage` (refined while planning):

- Wherever actord used to call `setAlarm(when)`, it now pushes or reschedules the single job `{ id: "actord", fn: "drive", time: when }` through `this.lifecycle.jobs`.
- `onJob` runs the existing `alarm()` body (orphan recovery, schedule ticks, inbox GC, drain) and returns.
- `onStart` runs orphan recovery and arms schedules.

Actor classes stop defining `alarm()`. Templates and both reference apps change to match.

`receive(envelope)` stays a native RPC method. It must call `await lifecycle.ready()` before handling, because RPC bypasses `Lifecycle`'s startup.

actord's tables (`_actors_*`) and the SDK's (`cf_agents_*`) share the object's SQLite. Their names don't collide.

The alternative is to move actord's outbox rows into the SDK job table. That is left for later, if the adapter turns out to fight the SDK.

### 5.2 What actord keeps

These stay unchanged:
- typed contracts and routes;
- inbox dedupe;
- one transaction for a handler's writes, inbox mark, outgoing messages and effect requests;
- outbox delivery with backoff and dead letters;
- the effect outcomes `confirmed`, `failed` and `in_doubt`;
- approvals;
- `actord check`, `diff`, `graph` and `trace`.

### 5.3 What actord gains

1. **Timers handlers can set.**
   - `ctx.after(duration, type, payload, { key })` and `ctx.at(time, type, payload, { key })`.
   - Each is committed in the handler's transaction and stored as a row the alarm job considers.
   - When due, it is delivered as an ordinary message to the actor itself. It travels on a route from `@timer`, and its id is derived from the actor, the key and the due time, so a duplicate fire is dropped by the inbox.
   - `ctx.cancelTimer(key)` removes one.
   - This covers retries with backoff, deadlines, stall checks and approval expiry.
2. **Several schedules per actor.** `schedules: [{ every | cron, message }]` replaces the single `schedule`.
3. **Job effects** (§5.4).
4. **Per-effect budgets.**
   - `timeoutMs` and `maxAttempts` move from the actor onto each effect, with the actor's values as the default.
   - Effects report usage (tokens, cost) in their result.
5. **A heartbeat while effects are in flight.** While any effect is `running`, the capability keeps a job due every 30 s. An orphaned effect is then found without waiting for the next message. Today `armAlarm` doesn't arm for running rows (`index.ts:671`).
6. **Crash-loop parking.**
   - An effect interrupted N times without settling (default 5) is parked.
   - Parking is recorded as an `effect.parked` event. The actor gets the effect's own result message with status `in_doubt` and a reason starting with "parked", so it can escalate without declaring a new message (refined while planning).
7. **Reused effect keys made visible** (issue #2).
   - Requesting an effect whose key already exists records `effect.duplicate`, carrying the existing row's status, instead of `effect.requested`.
   - `trace` shows "already requested by message X".
   - `docs/wiki/Runtime.md` states that a key identifies one effect for the actor's lifetime.
8. **Approval expiry and approver identity.**
   - An `approval: "human"` effect carries an `expires` duration (default 3 days) and a timer.
   - On expiry the effect is denied with reason `expired`, and the actor gets its result message.
   - `ctx.approve` records an approver identity supplied by a verified source (§8), not a free string.

### 5.4 Job effects

A job is external work that outlives a request: an agent session, an Actions run, a deferred model response.

```ts
effects: {
  "ci.run": {
    kind: "job",
    idempotency: "key",
    completes: { message: "ci.finished" },   // its handler calls ctx.settleJob("ci.run", key, outcome)
    deadline: "2h",
    result: "ci.settled",
  },
}
```

- The adapter's `start(input, { key })` returns quickly with a JSON handle. The handle is stored on the outbox row, whose status becomes `awaiting_job`.
- Completion arrives in one of two ways:
  - **By message.** The completion message is routed to the requesting actor by key, as in §6.2. Its handler calls `ctx.settleJob(effect, key, outcome)`, which resolves the job inside that message's transaction. `completes: { message }` names that message for `actord check` and the graph. A matching function would make `system.ts` impossible to serialize, so there isn't one (refined while planning; decision 0018).
  - **By probe.** `probe: { every, adapter }` sets a timer that calls the adapter's `probe(handle)`.
- If the deadline passes first, the outcome is `in_doubt`.
- A cancel request calls the adapter's `cancel(handle)` if it has one. It is still reported honestly: `failed` if the cancel was confirmed, `in_doubt` if not.
- `trace` shows the job's handle, how long it waited, and what completed it.

## 6. Sources: webhooks and other inbound channels (designer's call: system level)

### 6.1 Why at the system level

A webhook arrives once per provider, at one URL. It needs a signature check and deduplication before any actor sees it, and the provider's payload format is not the system's contract. An alarm concerns an actor's own time. A webhook concerns the world. So sources are declared once for the system, and actors never subscribe.

### 6.2 The declaration

```ts
sources: {
  github: webhook({
    path: "/hooks/github",
    secret: "GITHUB_WEBHOOK_SECRET",                    // HMAC check (X-Hub-Signature-256) before anything else
    id: (req) => req.headers.get("x-github-delivery"),  // becomes the envelope id, so redeliveries are dropped
    events: {
      "issues.opened": { message: "issue.opened", key: (e) => issueKey(e.repository, e.issue.number), map: (e) => ({ ... }) },
      "pull_request_review.submitted": { message: "pr.reviewed", key: (e) => issueKeyFromBranch(e.repository, e.pull_request.head.ref), map: ... },
      "workflow_run.completed": { message: "ci.finished", key: (e) => issueKeyFromBranch(e.repository, e.workflow_run.head_branch), map: ... },
    },
  }),
  email: inboundEmail({ ... }),                          // §8
},
routes: [
  { from: "@github", message: "pr.reviewed", to: "WorkItem" },
]
```

- Each source becomes a named external sender (`@github`, `@email`), alongside `@clock`, `@ingress` and the new `@timer`.
- `map` turns the provider payload into the system's own versioned message, which is validated against its schema.
- `key` derives the receiving actor's key from the payload. Routing therefore needs naming conventions the system controls. Factory branches are named `factory/<issue-number>`, so a review or CI event finds its WorkItem without a lookup table.
- The toolkit generates the Worker's handler for each source:
  1. verify;
  2. derive the id;
  3. map and validate;
  4. deliver with `ingress`, using that id;
  5. answer quickly.
- An unmapped event is answered `204` and recorded as `source.ignored`.
- An event that fails verification is answered `401` and recorded.
- An event that fails mapping or validation is answered `400` and recorded with the delivery id. Because GitHub won't redeliver on its own, the record is what lets someone find and redeliver it.

### 6.3 Checks and derived configuration

`actord check` verifies that:
- every mapped event's message has a route;
- the secret binding exists;
- paths don't collide.

`actord graph` shows each source as an outside node. The GitHub App's subscribed events can be generated from the mapped events, in keeping with the charter's "infrastructure is derived".

Adding polling later means another source (`poll({ every, fetch, map, key })`) emitting the same messages. Actors don't change.

## 7. Agent actors

### 7.1 The declaration

```ts
actors: {
  Coder: {
    kind: "agent",
    binding: "CODER",
    purpose: "One per work item: makes the change described by the triage checklist and returns a proposal",
    justification: ["identity", "lifecycle", "isolation"],
    harness: pi({
      workspace: computer({
        backend: containerBackend({ image: "factory-node" }),
        localOnly: ["node_modules/**", "dist/**"],
        egress: "registry-read",
      }),
    }),
    model: { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", reasoning: "high" },
    instructions: "agents/coder.md",
    tools: ["workspace.*", "branch.push", "issue.comment"],
    on: { "work.assigned": "start", "checklist.revised": "steer", "issue.closed": "stop" },
    returns: "change.proposed",
    budget: { usd: 3, turns: 60, wallClock: "45m" },
  },
},
```

| Field | Meaning |
| --- | --- |
| `harness` | Which Agents SDK harness runs the session: `pi(...)` first; `container(claudeCode() \| codex())`, `think(...)` and `opencode(...)` later. All share the SDK's session interface, so a swap is local. |
| `model` | Pinned by exact id, with reasoning effort. |
| `instructions` | A file versioned with the system. Each session records the version it started with and keeps it. |
| `tools` | Workspace tools, which act only on the agent's own Computer workspace, plus names of declared effects for anything outside it. |
| `on` | Which messages start, steer or stop a session. This is what makes an agent event-driven. In the factory, an edited issue goes to `WorkItem`, which triages it again. If the checklist changes, `WorkItem` sends `checklist.revised` to steer the Coder (designer's call). |
| `returns` | The session's final answer, as a typed message. Its payload is validated, and it is delivered to the actor itself. |
| `budget` | Hard limits per session. Running out stops the session and delivers `agent.exhausted`, so the actor can escalate. |

### 7.2 Runtime behaviour

- The actor's class installs `Lifecycle` with both capabilities: `actord`, and the harness.
- An `on` message handled in a transaction maps to a harness operation through a job effect (§5.4):
  - `start` and `steer` are `submit` / `steer`, with `operationId` set to the effect key;
  - `stop` is `abort`.
  - The harness's completion settles the job, and the runtime then delivers the `returns` message, or `agent.failed` / `agent.exhausted`.
- Harness events (turns, tool calls, usage) are recorded as actord events with a session id.
  - Full transcripts go to R2, keyed by session.
  - `trace` shows a session as one node, with its turns and tool calls summarised, and links to the transcript.
- `actord check`:
  - requires `harness`, `model`, `returns` and `budget` for `kind: "agent"`;
  - requires every listed effect to be declared;
  - rejects an agent that lists any effect classed as publishing (§9.3) unless that effect has `approval: "human"`.

### 7.3 Tools and approvals (designer's call: approval lives on the effect)

- **Workspace tools** (Computer's `read`, `ls`, `find`, `grep`, `write`, `edit`, `delete` and `exec`) act only on the agent's own workspace. They are not effects. Their replay classification is Computer's (§7.4).
- **Every tool that acts outside the sandbox is a declared effect**, exposed to the harness as a tool.
  - The model's call goes through `ctx.effect` machinery: idempotency, approval, `in_doubt`, trace.
  - A tool's replay safety follows its effect. With `idempotency: "key"` it maps to Pi's `replay: "safe"`. Without, it maps to "interrupted", so the model is told the outcome is unknown.
- **Approval is declared on the effect**, so one rule covers every actor that uses it.
  - A call to an `approval: "human"` effect parks it and sends an approval request (§8).
  - The model is told "waiting for approval". The session either continues or ends its turn, per harness.
  - It resumes when the result message arrives.

### 7.4 Pi and the Computer workspace (the owner's decision)

- **Where things run.**
  - Pi's loop runs in the Durable Object through `PiHarness`, and model calls go through Workers AI.
  - The agent's files live in a `@cloudflare/computer` `Workspace`, stored in the same Durable Object's SQLite.
    - The workspace is the durable record of the agent's work. A container that dies, idles out or restarts in a deploy loses no edits, so there is no "commit at every turn" rule and no reliance on container snapshots.
  - Pi's tools come from Computer (`@cloudflare/computer/tools/pi-ai`), wired the way the Agents SDK's Pi example does it (`examples/next/harnesses/pi/src/workspace.ts`).
    - Reading, searching and editing run in the Durable Object, with no container.
  - Commands that need Linux run on Computer's **Container backend**: `npm install`, test runners, builds.
    - That is a Cloudflare Container running `computerd`, scheduled by the Durable Object (`scheduling_policy: "durable_object"`).
    - It mounts the workspace through FUSE and syncs changes back.
    - It is stopped when idle.
- **Local-only paths.**
  - `node_modules`, build output and tool caches are marked `MOUNT_IGNORE`. They stay on the container's disk and never sync into the Durable Object.
  - They are rebuilt when a new container starts.
  - The repo's own config can add paths to the list (designer's call).
- **Container setup.**
  - No secrets in the container.
  - Outbound network is denied by default through Computer's per-backend egress policy.
  - The exception is an allowlist for package-registry reads, so dependencies can be installed and tests run. Publish requests to registries (`PUT` and the registries' publish endpoints) stay blocked (designer's call).
  - Per-repo images are built on the `computerd` image, adding the repo's toolchain from its `devcontainer.json` when present, otherwise from a default Node image.
- **Git and pushing.**
  - Clone and push run on the Durable Object side, through Computer's git client (`@cloudflare/computer/git`). The GitHub App installation token is passed as an auth header, so it never enters the container.
  - The token is scoped to the single repo, with `contents: write`.
  - Branches that will be pushed are cloned in full: Computer's clone notes that a shallow clone can't be pushed safely.
  - `branch.push` is an effect whose adapter pushes the workspace's `factory/<issue>` branch with that client.
  - Branch protection on the default branch, requiring a PR with review, is the backstop. A misbehaving agent can at worst push to its own `factory/` branch.
- **Crash behaviour of tools.**
  - Computer's Pi tools carry their own replay classification. `read`, `ls`, `find`, `grep`, `write` and `delete` may run again after a crash; `edit` and `exec` come back to the model as "interrupted".
  - Commands the factory runs itself, such as verification, are job effects (§5.4), using Computer's exec handles (`getExec`, `killExec`) as the job handle.
- **Swappability.**
  - Changing `harness` to `container(...)` (`ContainerHarness`) still swaps the agent to Claude Code or Codex.
  - Those CLIs run in their own container with its own disk, not on a Computer workspace, so a swap also changes the workspace model: work in progress lives in the CLI's container and its snapshots, and pushes go through egress credential injection.
  - Bringing the two together is deferred until Cloudflare offers it or a need appears.
- **Fallback.** If the Container backend proves unusable (spike 2), Pi's tools run against `ctx.container.exec` through a tool environment we write ourselves, implementing pi-durable's `FileSystem & Shell`. The Computer workspace stays the durable store either way.

## 8. Approvals and channels

### 8.1 Shape

A channel is an inbound source plus an outbound effect.
- Sending an approval request is the `notify.approval` effect.
- The reply comes back through a source as `approval.decided { effectKey, decision, reason, by }`, routed to the actor that owns the parked effect.
- The actor's handler calls `ctx.approve` or `ctx.deny`.
- Later channels (Telegram, Slack, Discord, SMS) add source and effect pairs through Chat SDK adapters. Actors don't change.

### 8.2 Email first (designer's call: reply, never link)

- **Outbound.**
  - One email per request, sent through Cloudflare Email Service, with HMAC-signed routing headers that carry the effect key and a timestamp.
  - The body states:
    - the exact action, such as the comment text or the command;
    - why it is needed;
    - the issue or PR;
    - what happens on deny;
    - when it expires.
- **Inbound.** The `@email` source accepts a reply only if all of these hold:
  1. its routing signature verifies and isn't expired;
  2. the sender is the owner's address and the message passes email authentication. Which `Authentication-Results` details reach the Worker still needs checking (spike 6).
  3. its first line is exactly `approve`, or starts with `deny`. This is parsed by plain code, never by a model.

  Anything else gets a reply asking again.
- **If authentication results turn out to be invisible to the Worker** (spike 6): a reply with a valid signed token from the owner's address may still approve mid-run tool calls. The limit is written down in `docs/wiki/Limitations.md`. Any effect classed `publishes: true` then needs approval in GitHub, never by email, until authentication can be verified (the owner's decision).
- **No approve links.** Mail scanners open links to check them, so a link could approve on its own.
- The verified sender address becomes the approver identity (`by`).

### 8.3 Which asks go where

| Ask | Where |
| --- | --- |
| PR approval | A GitHub review. Merges are approved there, never by email. |
| Questions about an issue | Comments on that issue. The owner's reply arrives through `@github` (`issue_comment`, filtered to the owner). |
| Mid-run tool approvals and escalations (budget exhausted, stuck, parked, unresolved `in_doubt`) | Email |

## 9. Decision and extraction calls

### 9.1 Declaration

Clef-family and Clairic calls are typed effects any actor can use. They need no harness.

```ts
effects: {
  "decide.triage": {
    kind: "decision",
    model: "@cf/cloudflare/clef-flash",
    question: { route: ["ready", "needs_info", "not_for_factory"] },
    idempotency: "key",
    result: "triage.decided",
  },
  "extract.issue": {
    kind: "extraction",
    model: "@cf/cloudflare/clairic",
    schema: IssueFacts,
    idempotency: "key",
    result: "issue.extracted",
  },
}
```

- A decision returns a probability per option.
- An extraction returns typed values. Missing values come back empty, never guessed, each with a confidence score.
- Both are pure reads, so they are safe to retry.

### 9.2 Decision records

Every decision is recorded with:
- an input digest;
- a pointer to the full input in R2;
- its probabilities and model id;
- the action the actor took.

`ctx.outcome(decisionId, actual)` labels a decision later with what actually happened, for example "owner requested changes". `actord` can then report a scorecard per decision effect: calibration, and how often "safe" turned out wrong. This is how the owner learns these models, and the records become training data for Cloudflare's Clef fine-tuning service.

### 9.3 Rules that bind decisions

- **A decision never counts as evidence or approval.** It can't satisfy `approval: "human"`, and gates such as CI, tests and protected paths never depend on one.
- **Publishing is permanently human-gated.**
  - Any effect classed `publishes: true` must have `approval: "human"`, and `actord check` enforces it.
  - The factory additionally treats these as protected paths: `.github/workflows/**`, release configuration, and version fields.
  - It treats a merge as a release, and so keeps it human-gated whatever any decision says, in repos where a push to the default branch triggers publishing.

### 9.4 Shadow mode, then graduation (designer's call)

- A decision effect has `mode: "shadow" | "act"`. In shadow mode it is recorded but cannot change the actor's path.
- The factory's merge-risk decision (`decide.merge_risk`, Clef) runs in shadow mode from day one.
- **Graduation.** A lane is a repo plus a kind of change. The owner switches a lane to `act` only when its scorecard earns it, with a threshold set per lane.
- Phase one ships shadow mode only.

## 10. Phase one

**Exit criterion.** For one repo where the GitHub App is installed:
1. the factory picks up an open issue;
2. triages it;
3. Pi makes the change in a container;
4. Actions runs CI;
5. the factory opens a PR as its bot;
6. the owner approves it in GitHub;
7. the review webhook arrives, and the factory merges the exact commit that was approved.

**In scope (designer's call)**
- §5 in full: the adapter, timers, schedules, job effects, per-effect budgets, heartbeat, parking, issue #2, approval expiry.
- §6: `@github` and `@email` sources.
- §7: agent actors with Pi, using DeepSeek V4.1 Flash, on a Computer workspace with its Container backend.
- §8: email approvals and escalations.
- §9: `decide` (Clef-flash triage; Clef merge-risk in shadow mode), `extract` (Clairic, for issue facts and CI failures), and decision records.
- Release Radar and Briefing Desk migrated to the new foundation, with all their fault tests still passing.
- **As the last step:** the Claude and Codex plugin skills, the `actord init` templates, the Codex reference templates and the eval scaffolds, all updated to the new foundation.
  - The release checks (`scripts/codex/distribution.mjs`, `tests/release.test.mjs`) must pass.
  - No npm release and no paid eval run without the owner's separate approval.
- **The factory** is in a separate private repo, using the toolkit through a local package or git dependency. It is planned only after its own design doc is written.
- **The pilot** is the actord repo, starting with issue #1.

**The factory's minimum, as the toolkit sees it** (the factory's own document will refine this):

**Actors:**

| Actor | Owns |
| --- | --- |
| `Dispatcher` (singleton) | Concurrency (at most 3 Coder sessions at once by default, configurable; designer's call), back-pressure at 7 waiting PRs, the daily spend ledger with its $10 alert and $30 hard stop |
| `WorkItem` (one per issue) | The claim, the attempt generation, triage, the PR, CI and review state |
| `Coder` (agent) | Making the change |
| `Reviewer` (model-assisted, GLM-5.3 Flash) | One review comment on the PR, against the checklist |

**The $30 hard stop is a true ceiling (designer's call).**
- Every costed effect (agent session, decision, extraction, model-assisted call) reserves its budget from the `Dispatcher` before it starts. It starts only if today's spend plus outstanding reservations stays at or under $30.
- A session's reservation is its `budget.usd`, which the harness enforces, and container seconds count against it.
- Each effect settles from the usage it reports. A reservation whose effect is `in_doubt` counts as fully spent.
- The worst overshoot is one model call past a session's own budget.
- Raising the cap is an explicit owner message.
- This needs only the toolkit's per-effect budgets and usage reporting (§5.3). The ledger and reservations are factory code.
- It gets its own fault test (§11).

**Merge rules:**
- Merge only the head SHA the owner approved, passing `sha` to the merge endpoint.
- The review must come from the owner, and CI must be green on that SHA.
- If anything was pushed after approval, ask for review again.
- If a merge times out, check whether the PR merged before trying again.

**Triage:**
- The Clef-flash decision, followed by a checklist written by GLM.
- One-line issues get a "done when" comment on the issue before work starts.
- `not-for-factory` is honoured, and applied by triage itself, with a reason, when it declines an issue.

**Issue changes:** closing an issue stops its work. Editing an issue, or an owner reply to a question, starts a fresh triage.

**Later**
- Auto-merge lanes.
- Clef-omni for visual changes and screenshots.
- Polling sources.
- More channels.
- More repos.
- Production trace ingestion: today `trace` reads local logs only.

## 11. Verification

Each new guarantee gets a workerd fault test, in the style of the existing runtime tests:

| Area | Test |
| --- | --- |
| Lifecycle adapter | actord and a `PiHarness` in one class both fire on time, and neither silently overwrites the other's alarm. |
| Timers | A timer survives restart and eviction; a duplicate fire is dropped; cancel works. |
| Job effects | Completion by message, completion by probe, deadline gives `in_doubt`, cancel is honest, restart while awaiting a job. |
| Sources | A bad signature is rejected; a redelivered delivery id is dropped; an unmapped event is recorded; an invalid payload is recorded with its delivery id. |
| Agent actors | A restart mid-tool gives "interrupted" for an unkeyed tool and a replay for a keyed one; stop during a model call; duplicate start; budget exhaustion gives `agent.exhausted`; a stale result from a replaced session is ignored. |
| Approvals | Approve, deny, expiry, a spoofed reply rejected, a non-owner reply rejected, an ambiguous reply asked again. |
| Merge | A lost acknowledgment on merge is reconciled; a head that moved after approval is not merged. |
| Workspace | A container lost mid-command loses no workspace edits. Local-only paths never appear in the Durable Object's store. A push authenticates from the Durable Object side, and nothing credential-like is visible inside the container. |
| Spend ceiling | With reservations near $30, a new costed effect is refused. An `in_doubt` reservation counts as spent. A session over its own budget stops after the current model call. |
| Issue #2 | A reused key records `effect.duplicate`, and `trace` attributes it correctly. |

**Containers in tests are an unknown** (spike 3). If vitest and Miniflare can't run them, container behaviour is tested against a stub of `ctx.container`, and the documentation says so.

## 12. Spikes, in order

1. **Lifecycle adapter.** actord plus `PiHarness` on one plain Durable Object, through the shim. Do alarms, RPC `receive` and startup all behave?
2. **Computer on a real repo.** Pi with DeepSeek V4.1 Flash, using a Computer workspace and its Container backend, clones the pilot repo, runs `npm install` with `node_modules` local-only, and runs the tests. Measure:
   - install time;
   - the bytes synced into the Durable Object;
   - whether anything like computer issue #179 occurs (an install timeout followed by a storage timeout).
3. **Containers in workerd tests.** Do vitest and Miniflare support `ctx.container` and Computer's Container backend?
4. **A long run across a deploy.** Pi plus Computer on a 45-minute task, with a deploy and an eviction partway through, one of them during a running command. What is lost?
5. **Push from the Durable Object.** Computer's git client pushes a `factory/` branch with an installation token passed as a header. Confirm that nothing credential-like reaches the container.
6. **Email authenticity.** Which authentication results reach the `email()` handler, and does signed reply routing work from Gmail?
7. **Clef and Clairic interfaces.** Request and response shapes, latency, and cost on Workers AI.

## 13. Decision log entries to write

Following `docs/decisions/` numbering:
- 0016 actord runs on the Agents SDK `Lifecycle` (amends charter §4).
- 0017 sources are system-level senders.
- 0018 job effects.
- 0019 agent actors: harness, tools as effects, approval on effects.
- 0020 decision and extraction effects, and shadow mode.
- 0021 approvals by email reply.
- 0022 agent workspaces on `@cloudflare/computer`, with its Container backend.

## 14. Left to the builder

- API names and exact type signatures. The sketches here show shape, not final names.
- How timers and job rows are stored inside actord's tables.
- The heartbeat interval and parking threshold defaults, within the values above.
- How harness events are summarised in `trace`.
- The default container image contents.
- How the generated source handlers are laid out in the Worker.
- How decision records are stored and how the scorecard is computed.

## 15. Risks

- **Experimental dependencies.** `agents` is 0.x, harnesses and Tasks are experimental, pi-durable's API changes between releases, Computer's Container backend is experimental, and Clairic is a preview. Pin exact versions, keep adapters thin, and record each choice in the decision log.
- **The shim approach may fight `Lifecycle`'s assumptions**, for example around startup, RPC, or `deleteAlarm` when the SDK's queue empties. Spike 1 decides this. The fallback is separate classes for agents and coordinators, communicating by messages.
- **Computer's experimental parts.** The Container backend, the sync protocol and `computerd` are marked "unsuitable for production use". The filesystem, git client and Pi tools are marked stable.
  - Pin the exact version.
  - cloudflare/computer doesn't accept unsolicited pull requests, so fixes go through issues.
  - The fallback is in §7.4.
- **Install speed and sync.**
  - Container file access goes through FUSE: a full `npm install` took about 2× as long as on the container's own disk.
  - Syncing a dependency tree into the Durable Object is the larger cost, and has caused install and storage timeouts (computer issue #179).
  - Local-only paths are the mitigation, but their savings haven't been measured. Spike 2 measures them.
- **Workspace size.** About 10 GB per workspace, held in memory on the container side. That suits personal repos, not monorepos.
- **Cost.** Idle containers bill until they stop. Set idle timeouts short and count container seconds in the ledger.
