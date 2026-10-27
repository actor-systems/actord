# Agent actors on Pi and Computer (plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An actor declared `kind: "agent"` runs a Pi agent session in its own Durable Object. Messages start, steer and stop the session; the system's declared effects are its tools; the session returns a typed message; and actord enforces its budget.

**Architecture:**
- **One Durable Object class, two capabilities.** The agent actor's class installs Lifecycle with two capabilities: `actord` and the Agents SDK's `PiHarness`. They share the object's one alarm (decision 0016, amended by #45).
- **A session is a job effect.** Each session runs as an internal job effect, `agent.session`, with the effect key as Pi's `operationId`. That reuses the outbox's deadline, probe, cancel, honest `in_doubt` and trace.
- **Tools are effects.** Each declared effect an agent lists becomes a Pi tool that requests that effect from outside a handler, through a new runtime entry point.
- **The workspace is Computer.** It is a `@cloudflare/computer` `Workspace` in the same object's SQLite, with an optional Container backend for commands.
- **Isolation of dependencies.** Everything Pi- or Computer-specific lives in a new subpath, `@actord/toolkit/agents`. Apps without agents never load Pi or Computer.

**Tech Stack:**
- `agents` 0.30.1 (`PiHarness`, `Lifecycle`).
- `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord`, each 1.4.0.
- `@cloudflare/computer` 0.8.0 (`Workspace`, `ContainerBackend`, `createPiTools`, `createGitClient`).
- Workers AI, with DeepSeek V4.1 Flash for the spikes.
- Vitest with `@cloudflare/vitest-plugin`, as before.

**Spec:** `docs/superpowers/specs/2026-10-25-agents-sdk-foundation-design.md`:
- §7 (agent actors): 7.1 declaration, 7.2 runtime, 7.3 tools and approvals, 7.4 Pi and Computer;
- §5.4 job effects;
- §11, the agent-actor and workspace rows;
- §12, spikes 2–5;
- §13, decisions 0019 and 0022;
- §15, risks.

The research behind the corrections below was read from the installed and published packages on 2026-10-27.

**Where this plan sits:** plan 3 of 5. Plans 1 (Lifecycle foundation) and 2 (sources and email approvals) are merged, and so is the pre-plan-3 work (#4, #12, #24, #25, #32, #33, #37, #41, #42, #45). Plan 4 covers Clef and Clairic effects; plan 5 covers the plugin skills.

## Design corrections this plan makes

The spec was written before these packages were read. Where they differ, this plan follows the packages and records the change in decision 0019 or 0022:

1. **There is no completion callback.** `PiHarness` reports completion only by polling (`pending()`, `wait(operationId)`).
   - A session therefore ends when the model calls a `finish` tool, whose parameters are the `returns` message's schema.
   - The session job's probe settles it. A finished tool asks for an immediate probe, so nothing waits out a probe period.
   - Spec §7.2's "the harness's completion settles the job" becomes "the probe settles the job".
2. **Pi enforces no budget, and its hooks can't stop a run.**
   - actord enforces `usd` and `turns`. It watches the session's events (`turn_end`, `usage_changed`) and aborts the conversation from outside the run when a limit is reached, so the overshoot is at most the request in flight.
   - The probe enforces `wallClock`.
   - Spec §10's "`budget.usd`, which the harness enforces" becomes "which actord enforces".
3. **A Pi tool can't defer its result.** A tool for an `approval: "human"` effect answers at once, telling the model it is waiting for approval. The decision returns later as a steer input, which the model sees as a user message, not as the tool's result (spec §7.3).
4. **Effects used as tools need an input schema.** `EffectSpec` gains `input`, a Standard Schema. The tool's JSON Schema is derived the same way the manifest derives message payload schemas.
5. **Computer ships no replay classification.** We take the Pi example's split:
   - `read`, `ls`, `find`, `grep`, `write` and `delete` re-run after a restart;
   - `edit`, `exec` and `publish` come back to the model as interrupted.
6. **Computer has no egress allowlist.** `egress: "registry-read"` is the toolkit's own HTTP gateway, which allows `GET` and `HEAD` to the package registries and refuses everything else.
7. **Instructions are pinned per session.** The text is stored on the session row when the session starts and rendered from there, so a redeploy doesn't change a running session's instructions (spec §7.1).

## Global Constraints

- **Pins:** `agents` 0.30.1; `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` exactly `1.4.0`; `@cloudflare/computer` exactly `0.8.0`.
  - All are optional `peerDependencies` of `@actord/toolkit`, plus `devDependencies` for the tests.
  - `@cloudflare/computer` 0.8.0 is published under npm's `unreleased` tag, so pin the exact version, never a range.
- **Isolation:** only `src/agents/**` may import `@earendil-works/*` or `@cloudflare/computer`.
  - `@actord/toolkit/runtime`, `/system`, `/sources` and `/testing` stay free of them.
  - A test asserts this by scanning the built bundles (Task 4).
- **Names reserved by this plan:** the internal job effect `agent.session` and the internal message `agent.session.settled`.
  - A system may not declare either (`AGENT_NAME_RESERVED`).
  - `agent.failed` and `agent.exhausted` are ordinary messages that an app declares with the toolkit's exported schemas, like `approval.decided`.
- **Pi storage:** Pi's tables use the prefix `pi_`, and Computer's use `vfs_`. actord's own agent rows go in `_actors_agent_sessions`.
- **Delivery to self:**
  - `returns`, `agent.failed` and `agent.exhausted` are delivered to the agent actor itself, so each needs a self-route.
  - `on` messages are handled by the agent runtime; the app writes no handler for them.
- **Deploys, secrets and containers:** the owner runs every deploy, secret and container-push command with `!`. Permission rules deny them to agents.
- **Spend:**
  - Spikes stay within the standing phase-one budget (about $20 in total; Workers AI and Containers count).
  - Every spike records its cost.
  - No npm release, no paid eval run, and no plugin skill edits (plan 5).
- **Container safety:** no secrets in the container; egress `none` unless declared; registry publish requests refused; git credentials used only on the Durable Object side (spec §7.4).
- **Dependency footprint:** per #12's ruling, `docs/wiki/Limitations.md` records what Pi and Computer add to an app that uses agents (Task 11).

## Review Focus

These five cases are implied by the spec and most likely to bite someone, but no other task's tests reach them:

1. A `start` redelivered after its session finished must not start a second session. → Task 5, `[agent-duplicate-start]`
2. A `finish` call whose payload fails the `returns` schema gets an error result the model can correct, within budget. It does not fail the session. → Task 5, `[agent-finish-invalid]`
3. A tool effect's result that arrives after its session was replaced or ended is recorded, never steered into another session. → Task 6, `[agent-tool-result-stale]`
4. A budget that runs out while a tool waits for approval exhausts the session. The parked effect stays parked, and its later result is only recorded. → Task 7, `[agent-exhausted-awaiting-approval]`
5. Instructions redeployed mid-session leave the running session on the text it started with. → Task 5, `[agent-instructions-pinned]`

## File structure

| File | Responsibility |
| --- | --- |
| `packages/toolkit/src/system.ts` | Agent fields on `ActorSpec`; `pi()`, `computer()` and `containerBackend()` declaration helpers; `EffectSpec.input` |
| `packages/toolkit/src/model/{manifest,check,diff,mermaid}.ts` | Agent fields in the manifest, `AGENT_*` rules, diff classes, the graph |
| `packages/toolkit/src/runtime/index.ts` | `requestEffect()` from outside a handler; internal effects and messages; settle listeners |
| `packages/toolkit/src/agents/index.ts` (new) | `agentRuntime()`, the session job adapter, `finish`, the steer and stop mapping |
| `packages/toolkit/src/agents/tools.ts` (new) | Effects as Pi tools; workspace tools with replay classification |
| `packages/toolkit/src/agents/budget.ts` (new) | Turn, cost and wall-clock enforcement |
| `packages/toolkit/src/agents/workspace.ts` (new) | `Workspace` from a `WorkspaceSpec`; the container backend; the egress gateway |
| `packages/toolkit/src/agents/git.ts` (new) | Clone and push from the Durable Object; the `gitPushEffect` adapter |
| `packages/toolkit/src/agents/scripted-model.ts` (new) | `scriptedModel()`: a deterministic pi-ai model for tests |
| `packages/toolkit/test-runtime/src/agent.ts` (new) | `Scribe`, the test agent actor class |
| `packages/toolkit/test-runtime/agents.test.ts` (new) | Workerd fault tests for agent actors |
| `packages/toolkit/test/agents-model.test.ts` (new) | Declaration, manifest and check tests |
| `spikes/agent-workspace/` (new) | Spikes 2, 4 and 5: a deployable Worker |
| `docs/evidence/spike-{2,3,4,5}-*.md` (new) | What each spike measured |
| `docs/decisions/0019-agent-actors.md`, `0022-agent-workspaces.md` (new) | The decisions |

---

### Task 1: Pins, and spike 3 (agents in workerd)

**Files:**
- Modify: `packages/toolkit/package.json` (the optional peers and devDependencies above, plus the `./agents` export), `packages/toolkit/build.mjs` (an `agents` entry, `platform: "neutral"`, with `agents`, `@earendil-works/*`, `@cloudflare/computer` and `cloudflare:*` external), `packages/toolkit/tsconfig.build.json`, and `package-lock.json`.
- Create: `packages/toolkit/src/agents/scripted-model.ts`, `packages/toolkit/test-runtime/src/agent.ts`, `packages/toolkit/test-runtime/agents.test.ts`, and `docs/evidence/spike-3-agents-in-workerd.md`.

**Interfaces:**
```ts
// src/agents/scripted-model.ts — exported from @actord/toolkit/agents
export type ScriptedTurn = {
  text?: string;
  calls?: Array<{ name: string; args: unknown }>;
  usage?: { input: number; output: number; costUsd?: number };
};
/** A pi-ai model that answers each request with the next scripted turn (or what `next` returns); for tests only. */
export function scriptedModel(turns: ScriptedTurn[] | ((request: { turn: number; lastToolResults: unknown[] }) => ScriptedTurn)): {
  models: unknown /* pi-ai Models with the provider set */;
  model: unknown /* the PiModel to pass as the session default */;
};
```

- [ ] **Step 1: Install the pins and confirm Node.** pi requires Node ≥ 22.19.0. If the repo's CI or `engines` field is older, raise both, and say so in the evidence.
- [ ] **Step 2: Write `[pi-and-actord-share-alarm]`.** The `Scribe` class installs `Lifecycle`, `actord` (an `actorRuntime` with one handler) and a `PiHarness` whose factory opens pi with `scriptedModel([{ text: "hello" }])` and an empty registry. The test:
  1. submits a prompt with `operationId: "op-1"`;
  2. sends an actord message that sets a 20 ms timer;
  3. waits with the `eventually` helper from `runtime.test.ts`, moved to `src/testing.ts` and exported.

  Assert:
  - `wait("op-1")` → `{ status: "done", text: "hello" }`;
  - the timer fired;
  - `cf_agents_jobs` held both `actord` and `pi-wake` at some point.
- [ ] **Step 3: Write `[scripted-model-tool-call]`.** A scripted turn calls a registered tool `echo({ v: 1 })` and then answers with text.

  Assert:
  - the tool's `execute` ran once, with `api.callId` set;
  - `messages()` contains the tool result;
  - `harness.usage()` reports the scripted tokens and cost.
- [ ] **Step 4: Spike 3, containers in tests.** Try `ctx.container` and a Computer `ContainerBackend` under `@cloudflare/vitest-plugin`. Record what happens.
  - **If they run:** later container tests use them.
  - **If they don't:** later container tests use a stub of `ctx.container` (`start`, `getTcpPort`, `destroy`, `running`) built in `test-runtime/src/agent.ts`, and the evidence and `Limitations.md` say so (spec §11).

  Write the ruling in the evidence file, as a line beginning `Ruling:`.
- [ ] **Step 5: Confirm JSON Schema tools.** Confirm that pi accepts a tool whose `parameters` is plain JSON Schema (from `z.toJSONSchema`), as Computer's Pi tools do. Record the answer.
  - **If it doesn't:** the tools in Task 6 wrap the schema with TypeBox's `Type.Unsafe(schema)`.
- [ ] **Step 6: Run and commit.** Run `npx vitest run -c vitest.runtime.config.ts test-runtime/agents.test.ts` and expect PASS. Then run `npm run --silent build -w @actord/toolkit` and commit:

  `git commit -m "Spike 3: Pi and actord share one Durable Object in workerd; pins for plan 3"`

### Task 2: Spikes 2 and 5, a real session in a container (owner-assisted)

**This task needs the owner.** Agents may not deploy, set secrets or push containers; the owner runs those commands with `!`. The spike follows the shape of `spikes/email-approval` (spike 6): bearer-token endpoints, records in the Durable Object's SQLite, and a README listing the owner's commands in order.

**Files:**
- Create: `spikes/agent-workspace/{wrangler.jsonc,Dockerfile,package.json,tsconfig.json,.gitignore,README.md,src/index.ts}`.
- Create: `docs/evidence/spike-2-computer.md` and `docs/evidence/spike-5-push.md`.

- [ ] **Step 1: Build the spike Worker.** The `Bench` class is built from `withWorkspaceContainer(DurableObject)`. It holds:
  - a `Workspace` (`ContainerBackend`, `instance: "standard-2"`, `ignore: ["**/node_modules", "/dist"]`, egress `none`, except a registry-read gateway for the install);
  - a `PiHarness` on Workers AI DeepSeek V4.1 Flash (`createAI({ binding: env.AI })`), with Computer's Pi tools.

  Endpoints:
  - `POST /clone`: a full clone of `https://github.com/actor-systems/actord` through `createGitClient`, on the Durable Object side.
  - `POST /install`: `npm ci`, run through `exec`.
  - `POST /test`: `npm test -w @actord/toolkit`.
  - `POST /prompt`: a fixed small change. The model adds one line to `docs/progress.md` using workspace tools, then runs `git diff`.
  - `POST /push`: spike 5.
  - `GET /report`.

  Each command records:
  - its wall time and exit code;
  - the `vfs_*` table sizes (bytes synced into the Durable Object);
  - whether any `node_modules` path appears in `vfs_nodes`;
  - any storage-timeout reset (computer#179).
- [ ] **Step 2: Spike 5, pushing.** `POST /push` mints a GitHub App installation token on the Durable Object side. The token is a JWT signed with WebCrypto from the App's private key, which is a secret the owner sets, and is scoped to `actor-systems/actord` with `contents: write`. The endpoint pushes branch `factory/spike-5` with `headers: { Authorization: "Bearer <token>" }`.

  It then runs:
  - `exec("env")`;
  - a `grep -r` of the workspace for the token's first 8 characters;
  - a search of the container's process environment.

  It records that none of them find it.
- [ ] **Step 3: Write the README and commit.** The README lists the owner's commands in order:
  1. create the GitHub App, with permission `contents: write` and installed on `actor-systems/actord` only;
  2. `! npx wrangler secret put` for the App id, the private key and the bearer token;
  3. `! npx wrangler deploy -c spikes/agent-workspace/wrangler.jsonc`, which builds and pushes the container image;
  4. the `curl` calls for each endpoint, in order.

  Also list the expected cost (Container seconds and Workers AI tokens) and the teardown, which deletes the Worker, the image, the App and branch `factory/spike-5`. Commit:

  `git commit -m "Spike 2 and 5: an agent workspace Worker for the owner to deploy"`
- [ ] **Step 4: Stop and ask the owner** to run the README's commands. Wait.
- [ ] **Step 5: Record the evidence.** Read `GET /report` with read-only `curl`, and write both evidence files:
  - install time, with and without `ignore`;
  - bytes synced;
  - the test result;
  - whether the model's change appears in `git diff`;
  - whether the push landed;
  - the credential search results;
  - the cost.

  Settle these rulings, each as a `Ruling:` line in the evidence:
  - **If installs time out or storage resets (computer#179):** Task 9 makes `localOnly` required for container agents and sets the exec `timeoutMs` the spike shows to work.
  - **If the Container backend is unusable:** Task 9 implements the spec §7.4 fallback, Pi tools over `ctx.container.exec` through our own `FileSystem & Shell`. Stop and report the change before Task 9.
  - **If the token is found anywhere in the container:** stop and report BLOCKED. The spec's push model is wrong.
- [ ] **Step 6: Commit:** `git commit -m "Spikes 2 and 5: evidence"`

### Task 3: Spike 4, a long run across a deploy and an eviction (owner-assisted)

**Files:** Modify `spikes/agent-workspace/src/index.ts` and its README. Create `docs/evidence/spike-4-long-run.md`.

- [ ] **Step 1: Add the long task.** `POST /long` prompts a long task: work through the repository's open `TODO` comments one file at a time, running `npm test -w @actord/toolkit` after each, for at most 45 minutes, which the spike enforces. Add these endpoints:
  - `POST /evict`: `ctx.abort()`.
  - `GET /report`: extended with every `pi_` submission, task status, and each `exec`'s result and sync status.
- [ ] **Step 2: Write the README section and commit.** The README's new section has the owner:
  1. start `/long`;
  2. redeploy (`! npx wrangler deploy …`) about 10 minutes in, during a running command;
  3. `curl /evict` about 20 minutes in;
  4. let it finish.

  Commit.
- [ ] **Step 3: Stop and ask the owner. Wait.**
- [ ] **Step 4: Record the evidence.** For each disruption, record:
  - whether the running command came back interrupted or re-ran;
  - whether any workspace edit was lost (compare `git diff` before and after);
  - whether pi resumed by itself;
  - how long the gap lasted;
  - whether a sync was left `pending` and resumed.

  If any committed workspace edit was lost, record a `Ruling:` that Task 9 adds a `workspace.pull()` before every session resumes, and test it there.
- [ ] **Step 5: Commit:** `git commit -m "Spike 4: evidence"`

### Task 4: Declaring agent actors (manifest, checks, diff, graph)

**Files:**
- Modify: `src/system.ts`, `src/model/{manifest,check,diff,mermaid}.ts`, `test/__snapshots__/*`.
- Create: `test/agents-model.test.ts`, `test/bundle-isolation.test.ts`, and the negative fixtures `fixtures/negative/agent-{harness-missing,returns-unrouted,tool-input-missing}` (copied from `effect-budget-invalid`, manifests regenerated with `actord graph --write`).

**Interfaces:**
```ts
export type AgentVerb = "start" | "steer" | "stop";
export interface ContainerBackendSpec { readonly kind: "container"; readonly image: string; readonly instance?: string }
export interface WorkspaceSpec {
  readonly kind: "computer";
  /** Where commands run; without one the agent can read and edit files but not run commands. */
  readonly backend?: ContainerBackendSpec;
  /** Paths kept on the container's disk only (Computer's `ignore`): each starts with "/" or "**\/". */
  readonly localOnly?: readonly string[];
  readonly egress?: "none" | "registry-read";
}
export interface HarnessSpec { readonly kind: "pi"; readonly workspace?: WorkspaceSpec }
export function pi(spec?: { workspace?: WorkspaceSpec }): HarnessSpec;
export function computer(spec?: Omit<WorkspaceSpec, "kind">): WorkspaceSpec;
export function containerBackend(spec: { image: string; instance?: string }): ContainerBackendSpec;

// ActorSpec gains (meaningful for kind "agent"):
//   harness?: HarnessSpec; model?: { id: string; reasoning?: "low" | "medium" | "high" };
//   instructions?: string /* path from system.ts */; tools?: readonly string[] /* "workspace.*" or effect names */;
//   on?: Readonly<Record<string, AgentVerb>>; returns?: string;
// ActorSpec.budget becomes { maxAttempts?, timeoutMs?, maxTokens?, usd?: number, turns?: number, wallClock?: Duration }.
// EffectSpec gains: input?: StandardSchemaV1 — the parameters of the tool an agent sees for this effect.
```

**The manifest:**
- Each agent actor carries `harness`, `model`, `instructions`, `tools`, `on` and `returns`.
- Budget fields and effect `input`, as JSON Schema, are written only when present, so manifests for non-agent systems don't change.

**New rules.** Each gets a test in `agents-model.test.ts`. Errors unless marked warning:
- `AGENT_HARNESS_MISSING`, `AGENT_MODEL_MISSING` and `AGENT_RETURNS_MISSING`, for an agent actor;
- `AGENT_BUDGET_INCOMPLETE`: an agent without all of `usd`, `turns` and `wallClock`;
- `ACTOR_BUDGET_INVALID` extended:
  - `usd` must be a positive finite number;
  - `turns` must be a positive whole number;
  - `wallClock` must be a valid duration;
  - `maxAttempts` and `timeoutMs` are still required for `model-assisted` actors through `ACTOR_BUDGET_MISSING`'s hint;
- `AGENT_ON_UNROUTED`: an `on` message with no route that delivers it to the agent;
- `AGENT_SELF_ROUTE_MISSING`: `returns`, `agent.failed` or `agent.exhausted` with no route from the agent to itself;
- `AGENT_TOOL_UNDECLARED`: a tool that is neither `workspace.*`, `workspace.<name>` nor an effect in the actor's `effects`;
- `AGENT_TOOL_INPUT_MISSING`: a tool effect without `input`;
- `AGENT_WORKSPACE_TOOLS_WITHOUT_WORKSPACE`: `workspace.*` listed by an agent whose harness has no workspace;
- `AGENT_EXEC_WITHOUT_BACKEND` (warning): `workspace.exec` or `workspace.*` without a container backend, where `exec` is left out;
- `AGENT_LOCAL_ONLY_INVALID`: a pattern Computer would reject (it must start with `/` or `**/`; only `*` and `**`; no `{}[]?\,`);
- `AGENT_CONTAINER_CONFIG_MISSING`: a container backend with no wrangler `containers` entry for the actor's class, with `scheduling_policy: "durable_object"`;
- `AGENT_NAME_RESERVED`: a declared `agent.session` or `agent.session.settled`;
- `AGENT_INSTRUCTIONS_MISSING`: the instructions file doesn't exist next to `system.ts`.

**`actord diff` classifications:**
- a model `id` change is `risky`, requires approval;
- a budget increase is `risky`; a decrease is `compatible`;
- adding a tool is `risky`, requires approval; removing one is `compatible`;
- `instructions` changes are `compatible`, because sessions pin their text;
- an `on` verb change is `breaking`.

**The graph:** draws an agent as a hexagon, with its tools as dotted edges to effects.

- [ ] **Step 1: Write the failing tests.** Write `agents-model.test.ts`: one test per rule and per diff class, plus `[agent-manifest-unchanged-without-agents]`, which asserts every committed example manifest is byte-identical after `normalize`. Write `bundle-isolation.test.ts`, which asserts that `dist/{runtime,system,sources,testing}.mjs` contain neither `@earendil-works` nor `@cloudflare/computer`. Write the three fixtures. Run them and expect each to FAIL.
- [ ] **Step 2: Implement the types, helpers, manifest, rules, diff and graph.**
- [ ] **Step 3: Build, then rerun.** Run `npm run --silent build -w @actord/toolkit`, then `npx vitest run test/agents-model.test.ts test/bundle-isolation.test.ts test/fixtures.test.ts`, and expect PASS.
- [ ] **Step 4: Commit:** `git commit -m "Declare agent actors: harness, model, tools, on, returns, budget; AGENT_* checks"`

### Task 5: Sessions as job effects (start, steer, stop, finish)

**Files:**
- Modify: `src/runtime/index.ts`, which gains internal effects and messages, settle listeners and `probeNow`.
- Create: `src/agents/index.ts`.
- Modify: `test-runtime/src/agent.ts`, so `Scribe` becomes a full agent actor declared in the probe system; `test-runtime/agents.test.ts`.

**Interfaces:**
```ts
// src/runtime/index.ts
export interface RuntimeOptions {
  // …existing…
  /** Effects and messages the runtime adds for this actor only (agent sessions); not part of system.ts. */
  internal?: { effects?: Record<string, EffectSpec & { adapter: JobAdapter | EffectAdapter }>; messages?: Record<string, MessageSpec>; handlers?: Handlers };
}
export interface ActorRuntime {
  // …existing…
  /** Make a waiting job's next look due now and drive (a finished session needn't wait out its probe period). */
  probeNow(effect: string, key: string): Promise<void>;
}

// src/agents/index.ts — @actord/toolkit/agents
export const agentFailed: StandardSchemaV1<{ session: string; key: string; reason: string; usage?: EffectUsage }>;
export const agentExhausted: StandardSchemaV1<{ session: string; key: string; budget: "usd" | "turns" | "wallClock"; usage?: EffectUsage }>;
export interface AgentRuntimeOptions extends RuntimeOptions {
  /** The text of the actor's `instructions` file, imported by the Worker (a wrangler Text module). */
  instructions: string;
  /** Test seam: a scripted model instead of Workers AI (`scriptedModel`). */
  model?: ReturnType<typeof scriptedModel>;
  /** The prompt an `on` message becomes; default: "<type>\n\n" + JSON of the payload, indented. */
  render?(type: string, payload: unknown): string;
}
export interface AgentRuntime extends ActorRuntime { readonly harness: PiHarness }
/** Installs PiHarness on host.lifecycle beside actord; `handlers` cover every message except the actor's `on` messages. */
export function agentRuntime(host: ActorHost & { env: { AI?: Ai } }, system: AnySystem, actor: string, handlers: Handlers, options: AgentRuntimeOptions): AgentRuntime;
```

**Behaviour.** These are the tests, all in `agents.test.ts`. `Scribe` lists `on: { "scribe.task": "start", "scribe.hint": "steer", "scribe.halt": "stop" }`, `returns: "scribe.done"`, and `budget: { usd: 1, turns: 10, wallClock: "10m" }`.
- **Session state:** each start gets a new pi session (`sessions.create()`), recorded as `{ key, session, operation, generation, instructions, startedAt, result? }` in `_actors_agent_sessions`. The job effect `agent.session` is keyed by the start message's id, with `probe.every: "30s"` and `deadline: wallClock + 10m` as a backstop.
- `[agent-start-returns]`:
  - Script: one text turn, then `finish({ summary: "ok" })`.
  - The actor receives `scribe.done { summary: "ok" }` from itself.
  - The job is `confirmed` with `settledBy: "probe"`.
  - It took less than one probe period, because of `probeNow`.
- `[agent-finish-invalid]`:
  - The first `finish` payload fails the `scribe.done` schema. The tool result `isError` carries the schema issues.
  - The second, valid `finish` returns.
  - Exactly one `scribe.done` is delivered.
- `[agent-duplicate-start]`:
  - The same `scribe.task` envelope delivered twice → one session, one `submit` accepted.
  - A redelivery after `scribe.done` → nothing new.
- `[agent-steer]`:
  - `scribe.hint` during a running turn → `session.steer(render(...))` with `operationId` = the hint's id.
  - The scripted model's next request sees the hint as a user message.
  - A hint with no active session is recorded as a `note`.
- `[agent-stop-during-model-call]`:
  - The scripted turn waits on a gate. `scribe.halt` → `cancelJob` → the adapter's `cancel` → `harness.abort({ session })` → `true`.
  - The job is `failed`, `"cancelled"`.
  - The actor receives `agent.failed { reason: "stopped" }`.
- `[agent-start-replaces-session]`:
  - A second distinct `scribe.task` while a session runs aborts the first, and the generation increments.
  - The first session's late `finish` is recorded as `note` `"stale session result"` and is not delivered.
- `[agent-ended-without-result]`:
  - The run answers with text and no `finish`, and no tool effect awaits approval.
  - Result: `agent.failed { reason: "ended without returning a result" }`.
- `[agent-restart-awaiting]`:
  - `abortAllDurableObjects()` while the session runs, then `settle`.
  - Pi resumes the run, the job isn't restarted (`starts == 1`), and `scribe.done` arrives once.
- `[agent-instructions-pinned]`:
  - Start a session with instructions "v1". Restart the instance with the option set to "v2". The next model request's system section still contains "v1".
  - A new session gets "v2".
- **Settlement mapping** (`agent.session.settled` → messages, in the internal handler):
  - `confirmed` → validate against `returns` → `ctx.send(returns, value)` to self.
  - `failed` with an error starting `"exhausted:"` → `agent.exhausted`.
  - Any other `failed` or `in_doubt` → `agent.failed { reason }`.
  - A generation that has since been replaced → a `note` only.

- [ ] **Step 1: Write the failing tests above and run them.** Expect FAIL.
- [ ] **Step 2: Add the runtime pieces.** In `runtime/index.ts`, add `internal` and `probeNow`.
  - Internal effects resolve before `system.effects` in every lookup, internal messages validate like declared ones, and nothing internal appears in `actord check` or the manifest.
- [ ] **Step 3: Implement `src/agents/index.ts`.** It contains:
  - the session job adapter:
    - `start` → `sessions.create()` + `submit(render(...), { operationId: key })`, with handle `{ session, operation, generation }`;
    - `probe` → result recorded? confirmed : exhausted marker? failed `"exhausted:<budget>"` : pi `pending()` has work, or a tool effect of this session awaits approval? not done : failed;
    - `cancel` → `abort`.
  - the `finish` tool: parameters are the `returns` JSON Schema; `replay: "safe"`; it records the result and calls `probeNow`, and returns `{ control: { terminate: true } }`.
  - the `on` handlers;
  - the settlement handler;
  - instructions pinned through a `section("instructions", …)` that reads the session row;
  - the model: from the actor's `model`, `createAI({ binding: env.AI, reasoningEffort: model.reasoning })(model.id)` as the session default, unless `options.model` is given. Spec §7.1 pins the id exactly. Pi drops the reasoning level for DeepSeek models on some wires (a `cloudflare-compat` diagnostic); record what spike 2 saw in decision 0019.
- [ ] **Step 4: Run, build and commit.** Run `npx vitest run -c vitest.runtime.config.ts` (the whole suite, not only `agents.test.ts`) and expect PASS. Build, then commit:

  `git commit -m "Agent sessions run as job effects: start, steer, stop, finish, stale results"`

### Task 6: Declared effects as tools

**Files:**
- Modify: `src/runtime/index.ts` (`requestEffect`).
- Create: `src/agents/tools.ts`.
- Modify: `test-runtime/src/agent.ts` (Scribe's `tools: ["note.keyed", "note.plain", "note.approved"]`, with matching effects), `test-runtime/agents.test.ts`.

**Interfaces:**
```ts
// src/runtime/index.ts — uses the existing EffectOutcome (confirmed | failed | in_doubt, each with `key`); a denial,
// including an expired approval, arrives as { status: "failed", error } with the denial's reason, as the result message does.
export interface ActorRuntime {
  /**
   * Request an effect from outside a handler (an agent's tool), in its own transaction, as ctx.effect would: refused
   * unless the actor lists the effect; a key already used returns that row instead of a second one.
   */
  requestEffect(name: string, input: unknown, opts: { key: string; correlationId?: string; causationId?: string }): Promise<{
    status: "awaiting_approval"; expiresAt: number } | { status: "running"; outcome: Promise<EffectOutcome> } | EffectOutcome>;
}
// src/agents/tools.ts
/** One Pi tool per effect in `tools`: name = effect name with "." → "_", parameters from `input`, replay by idempotency. */
export function effectTools(runtime: ActorRuntime, system: AnySystem, actor: string, session: () => { session: string; generation: number }): unknown[];
```

**Behaviour:**
- The tool key is `"<session>:<api.callId>"`. `callId` is stable across reruns.
- `replay` is `"safe"` for `idempotency: "key"` and `"unsafe"` otherwise.
- The tool waits for `running` outcomes. A failed or in-doubt outcome is an `isError` result with the error text; an in-doubt one also says the outcome is unknown.
- `awaiting_approval` answers at once with this text: `Waiting for a person to approve <effect> (request <key>, expires <ISO time>). The result will arrive as a message; continue with other work or end your turn.`
- When that effect's result message arrives for the session's current generation, the agent runtime submits this to the session with `whenBusy: "steer"`, `entry: { kind: "actord.effect_result" }` and `operationId: "result:<key>"`: `Result of <effect> (request <key>): <status> <value or error>`. If the session is idle, the submit starts a new run in it.

**Tests:**
- `[agent-tool-runs-effect]`: the scripted model calls `note_keyed({ text: "a" })`. The adapter ran once, the model's next request contains the confirmed value, and the effect events carry `effectKey` `"<session>:<callId>"`.
- `[agent-restart-mid-tool-keyed]`:
  - The `note.keyed` adapter hangs; `abortAllDurableObjects()`; `settle`.
  - Pi re-runs the safe tool with the same `callId`, which finds the existing row. The adapter ran at most twice (keyed retry, per the call rules), and the model sees one confirmed result.
- `[agent-restart-mid-tool-unkeyed]`:
  - The same with `note.plain`.
  - The model's next request contains Pi's interrupted result (`"Tool note_plain was interrupted"`).
  - actord records the effect `in_doubt` and never re-runs it.
- `[agent-tool-approval]`:
  - `note_approved` answers "Waiting for a person to approve…" and the run ends its turn.
  - The job stays `awaiting_job`.
  - `decide(key, "approve")` → the effect runs → the result is steered in → a new run → `finish` → `scribe.done`.
- `[agent-tool-result-stale]`: the approval resolves after the session was replaced. The result is recorded as a `note` and nothing is submitted to either session.
- `[agent-tool-undeclared]`: a tool not in `tools` is never offered (`harness.pi()` registry), and `requestEffect` for an effect the actor doesn't list is refused.

- [ ] **Step 1: Write the failing tests and run them.** Expect FAIL.
- [ ] **Step 2: Implement `requestEffect`.** Share the code path with `ctx.effect`; don't copy it. Add a settle listener that resolves the `outcome` promise.
- [ ] **Step 3: Implement `effectTools` and the result steering.** Run the full runtime suite and expect PASS. Build, then commit:

  `git commit -m "Agents use declared effects as tools: replay by idempotency, approvals resume by steer"`

### Task 7: Budgets (usd, turns, wallClock)

**Files:** Create `src/agents/budget.ts`. Modify `src/agents/index.ts` and `test-runtime/agents.test.ts`.

**Interfaces:**
```ts
/** Watch a session's events; abort it from outside the run once turns or cost reach the budget. Returns a stop function. */
export function watchBudget(harness: PiHarness, session: string, budget: { usd: number; turns: number }, onExhausted: (which: "usd" | "turns") => Promise<void>): () => void;
```

**Behaviour:**
- Turns are counted from `turn_end` events. Cost is the sum of `usage.cost.total` over the session's models and tools (pi's `UsageDoc`).
- When a limit is reached, the session row is marked `exhausted: "<which>"`, then `harness.abort({ session })`, then `probeNow`.
- The probe re-checks both limits from `UsageDoc` and the transcript, so a watcher lost to eviction is covered, and enforces `wallClock` from `startedAt`.
- Each probe reports the usage delta through `reportUsage` (`inputTokens`, `outputTokens`, `costUsd`), so the job's events and `agent.*` messages carry it.

**Tests:**
- `[agent-exhausted-turns]`: `turns: 3`, with the script calling tools forever. The model makes 3 or 4 requests (at most one in flight past the limit), then `agent.exhausted { budget: "turns" }`.
- `[agent-exhausted-usd]`: each scripted turn costs $0.40, with `usd: 1`. Exhaustion comes after the third request, and `usage.costUsd` is between 1.2 and 1.6.
- `[agent-exhausted-wallclock]`: `overrideBudget` with `wallClock: "50ms"`, and a gated turn. Result: `agent.exhausted { budget: "wallClock" }`, and the session is aborted.
- `[agent-exhausted-after-restart]`: the turns budget is reached while the instance restarts. The probe finds it, and only one `agent.exhausted` is delivered.
- `[agent-exhausted-awaiting-approval]`: the budget runs out while `note_approved` is parked. The session is exhausted, the effect stays `awaiting_approval`, and its later result is only a `note`.

- [ ] **Step 1: Write the failing tests and run them.** Expect FAIL.
- [ ] **Step 2: Implement `budget.ts`, plus the probe checks and usage reporting.** Run the full runtime suite and expect PASS. Build, then commit:

  `git commit -m "actord enforces agent budgets: turns and cost by watching usage, wall clock by probe"`

### Task 8: Events, transcripts and trace

**Files:** Modify `src/runtime/index.ts` (`EventKind`), `src/agents/index.ts`, `src/model/events.ts` (trace), and `test/trace.test.ts`; create `test-runtime/agents-events.test.ts`.

**Behaviour:**
- **New event kinds:** `agent.started`, `agent.turn`, `agent.tool` and `agent.ended`. Each carries `detail.session`; `agent.turn` carries `{ turn, usage }` and `agent.tool` carries `{ tool, callId, effectKey? }`. They are recorded from the event watcher.
- **No transcripts in the event log:** the full transcript isn't copied into events.
- **R2 transcripts:** if `AgentRuntimeOptions.transcripts: R2Bucket` is given, `agent.ended` writes `messages()` as JSON to `transcripts/<actor>/<key>/<session>.json`, and the event's `detail.transcript` names the object.
- **Trace:** `actord trace` shows a session as one node (`agent.session <key>`) with its turn count, its tool calls summarised as `tool × n`, its usage, its outcome and the transcript key.

**Tests:**
- `[agent-events]`: a two-turn scripted session with one tool emits `agent.started`, two `agent.turn`, one `agent.tool` and one `agent.ended`, in order, each with the session id.
- `[agent-transcript-r2]`: with an R2 binding in the test config, the object exists and parses.
- A trace unit test renders a recorded agent event log into the one-node summary, as a snapshot.

- [ ] **Step 1: Write the failing tests and run them.** Expect FAIL.
- [ ] **Step 2: Implement, test, build and commit:** `git commit -m "Agent sessions in events and trace; transcripts to R2"`

### Task 9: Workspaces (Computer, the Container backend, local-only paths, egress)

This task applies the rulings recorded in Tasks 1–3.

**Files:** Create `src/agents/workspace.ts`. Modify `src/agents/tools.ts` and `src/agents/index.ts`; `test-runtime/src/agent.ts`, which gains a `Builder` agent with `computer(...)`, a stub or real container per Task 1's ruling, and a `containers` config; and `test-runtime/agents.test.ts`.

**Interfaces:**
```ts
/** A Workspace in the host's SQLite for `spec`; with a container backend, `container` is the host built by Computer's withWorkspaceContainer. */
export function workspaceFor(host: ActorHost, spec: WorkspaceSpec, options?: { container?: unknown; gateway?: Fetcher; binding?: string }): Workspace;
/** Workspace tools for Pi with this plan's replay classification: read, ls, find, grep, write, delete "safe"; edit, exec, publish "unsafe". */
export function workspaceTools(workspace: Workspace, select: readonly string[] /* "workspace.*" or "workspace.<name>" */): unknown[];
/** The registry-read egress gateway: GET and HEAD to registry.npmjs.org and registry.yarnpkg.com pass; any other method or host gets 403. */
export class RegistryReadGateway { fetch(request: Request): Promise<Response> }
```

**Tests:**
- `[workspace-tools-replay]`: the registry's workspace tools carry exactly the replay values above.
- `[workspace-edit-survives-restart]`: the scripted model `write`s, then `edit`s a file; `abortAllDurableObjects()`. The file has both changes in `workspace.fs`, and an interrupted `edit` is reported as interrupted, not repeated.
- `[workspace-container-lost-mid-command]`: an `exec` is running when the container is destroyed (stub `destroy()`, or the real container per the ruling). Edits made before it are intact in `vfs_*`, and the model sees the command as interrupted.
- `[workspace-local-only]`: the backend gets `ignore` equal to `localOnly`. With the real container, a command that creates `node_modules/x` leaves no `vfs_nodes` row under `node_modules`. With the stub, the evidence from spike 2 stands in, and the test says so in its name: `[workspace-local-only-passed-to-backend]`.
- `[egress-registry-read]`: `GET https://registry.npmjs.org/zod` passes, `PUT` to the same host gets 403, and `GET https://example.com` gets 403.
- `[workspace-no-exec-without-backend]`: `computer()` without a backend → `exec` is not among the tools.

- [ ] **Step 1: Write the failing tests and run them.** Expect FAIL.
- [ ] **Step 2: Implement, applying the Task 2 and 3 rulings.** Required `localOnly`, the exec `timeoutMs` and a `pull()` before resume apply if the spikes called for them. Run the full runtime suite and expect PASS. Build, then commit:

  `git commit -m "Agent workspaces on Computer: replay-classified tools, container backend, local-only paths, registry-read egress"`

### Task 10: Clone and push from the Durable Object

**Files:** Create `src/agents/git.ts`. Modify `test-runtime/agents.test.ts`.

**Interfaces:**
```ts
/** Clone in full (a branch that will be pushed must not be shallow) on the Durable Object side; the token never reaches the container. */
export function gitClone(workspace: Workspace, options: { url: string; dir: string; ref?: string; token?: () => Promise<string> }): Promise<void>;
/** An effect adapter that pushes `input.branch` from `dir`; declare it `idempotency: "key"` (pushing the same commit again is harmless). */
export function gitPushEffect(options: { workspace: () => Workspace; dir: string; remote?: string; token: () => Promise<string>; allow?: (branch: string) => boolean }): EffectAdapter;
```

**Behaviour:**
- `allow` defaults to `branch.startsWith("factory/")`. Anything else throws `EffectRejected("may push only factory/ branches")`.
- The token is passed only as `headers.Authorization`, to the git client.

**Tests:**
- `[git-push-header-only]`: the workspace's git client is replaced by a spy.
  - The push received the header.
  - The token appears in no `vfs_*` row, no container env (stub `start` options), and no event or `note`.
- `[git-push-only-factory-branches]`: `main` → `failed`, `"may push only factory/ branches"`; the spy wasn't called.

The real push is spike 5's evidence.

- [ ] **Step 1: Write the failing tests and run them.** Expect FAIL.
- [ ] **Step 2: Implement, test, build and commit:** `git commit -m "Clone and push from the Durable Object: gitClone, gitPushEffect"`

### Task 11: Decisions, documentation, and verification

**Files:**
- Create: `docs/decisions/0019-agent-actors.md`, which records corrections 1–4 and 7 and the session mapping.
- Create: `docs/decisions/0022-agent-workspaces.md`, which records corrections 5 and 6, the container rulings and the git model.
- Modify: `docs/wiki/Runtime.md` (an "Agent actors" section and the guarantees table rows), `docs/wiki/Limitations.md`, the spec (an *Amended* note in §7.2, §7.3, §7.4 and §10 pointing to the decisions), `docs/architecture.md`, and `docs/progress.md`.

`Limitations.md` gets:
- the dependency footprint;
- that the overshoot is at most one model request;
- that approvals resume as user messages;
- the container-test ruling;
- that the Container backend is experimental.

- [ ] **Step 1: Write the documents.**
- [ ] **Step 2: Verify from a clean clone.** Clone the final commit into a fresh scratch directory, then run `npm ci`, `npm run build -w @actord/toolkit` and `npm run verify`.
  - Every gate must pass. `blocked` is allowed only for a prerequisite missing on that machine (today, `g6.mod.typecheck`).
  - Copy `verify-report.json`, `docs/verification-report.md` and the `docs/evidence/` files back.
- [ ] **Step 3: Commit:** `git commit -m "Verification for plan 3 (agent actors): <N> pass, <F> fail, <B> blocked"`
