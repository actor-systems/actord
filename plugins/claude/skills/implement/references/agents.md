# Agent actors

An actor declared `kind: "agent"` runs Pi sessions in its own Durable Object (decision 0019), with an optional Computer
workspace whose commands run in a container (decision 0022). The runtime code comes from `@actord/toolkit/agents`, the
only entry point that loads Pi or Computer. `system.ts` imports nothing from it: `agentFailed` and `agentExhausted`
come from `@actord/toolkit/system`, because `actord check` loads `system.ts` under Node.

```ts
// actord:check system
import { agentExhausted, agentFailed, computer, containerBackend, defineSystem, message, pi } from "@actord/toolkit/system";
import { z } from "zod";

const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional() });

export default defineSystem({
  name: "factory",
  messages: {
    "task.assigned": message({ version: 1, description: "Start work on an issue", payload: z.object({ issue: z.number().int(), title: z.string() }) }),
    "task.hint": message({ version: 1, description: "Steer the running session", payload: z.object({ text: z.string() }) }),
    "task.cancelled": message({ version: 1, description: "Stop the running session", payload: z.object({}) }),
    "task.done": message({ version: 1, description: "The session's result", payload: z.object({ branch: z.string(), summary: z.string().min(1) }) }),
    "agent.failed": message({ version: 1, description: "A session ended without a result", payload: agentFailed }),
    "agent.exhausted": message({ version: 1, description: "A session ran out of budget", payload: agentExhausted }),
    "push.done": message({ version: 1, description: "The git.push outcome", payload: Outcome }),
  },
  actors: {
    Coder: {
      binding: "CODER",
      kind: "agent",
      purpose: "Implements one issue (one instance per issue) on its own factory/ branch",
      justification: ["state", "lifecycle", "isolation"],
      harness: pi({
        workspace: computer({
          backend: containerBackend({ image: "./Dockerfile" }),
          localOnly: ["**/node_modules"], // required with a container: these paths stay on the container's disk
          egress: "registry-read", // GET and HEAD to the npm and Yarn registries; the default is "none"
          execTimeoutMs: 600_000, // each tool command's timeout; 10 minutes is the default
        }),
      }),
      model: { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", reasoning: "high" },
      instructions: "agents/coder.txt", // a file next to system.ts
      effects: ["git.push"],
      tools: ["workspace.*", "git.push"], // workspace tools, and effects the model may request
      on: { "task.assigned": "start", "task.hint": "steer", "task.cancelled": "stop" },
      returns: "task.done", // the model's `finish` tool takes this message's payload
      budget: { usd: 2, turns: 40, wallClock: "45m" },
    },
  },
  effects: {
    // A tool effect needs `input`: the model sees it as the tool's parameters.
    "git.push": { description: "Push the session's factory/ branch", idempotency: "key", input: z.object({ branch: z.string() }), result: "push.done" },
  },
  routes: [
    { from: "@ingress", message: "task.assigned", to: "Coder" },
    { from: "@ingress", message: "task.hint", to: "Coder" },
    { from: "@ingress", message: "task.cancelled", to: "Coder" },
    // returns, agent.failed and agent.exhausted come from the actor to itself.
    { from: "Coder", message: "task.done", to: "Coder" },
    { from: "Coder", message: "agent.failed", to: "Coder" },
    { from: "Coder", message: "agent.exhausted", to: "Coder" },
    { from: "Coder", message: "push.done", to: "Coder" },
  ],
});
```

The class and the Worker's exports:

```ts
// actord:check
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { type AgentRuntime, agentRuntime, gitClone, gitPushEffect, withWorkspaceContainer } from "@actord/toolkit/agents";
import type { Envelope } from "@actord/toolkit/runtime";
import instructions from "./agents/coder.txt"; // a wrangler Text module: .txt needs no rule
import system from "./system";

// The Worker must export WorkspaceProxy: the container's computerd connection and its egress reach the object through it.
export { WorkspaceProxy } from "@actord/toolkit/agents";

const REPO = "https://github.com/example/app.git"; // pinned by the app; never read from the workspace
const DIR = "/workspace/app";
declare function installationToken(env: Env): Promise<string>; // yours: a GitHub App token, minted per call

export class Coder extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly lifecycle = Lifecycle.install(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS results (branch TEXT NOT NULL, summary TEXT NOT NULL)");
  }

  // Typed: git.push reads this.actor.workspace inside the initializer.
  readonly actor: AgentRuntime = agentRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "Coder", {
    // Every message except the `on` messages, which drive sessions. A tool effect's result handler is optional.
    "task.done": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO results (branch, summary) VALUES (?, ?)", payload.branch, payload.summary);
    },
    "agent.failed": ({ payload }, ctx) => ctx.note("session failed", { reason: payload.reason }),
    "agent.exhausted": ({ payload }, ctx) => ctx.note("session ran out of budget", { budget: payload.budget }),
  }, {
    instructions,
    transcripts: this.env.TRANSCRIPTS, // each session's messages, at transcripts/<actor>/<key>/<session>.json
    container: this,
    effects: {
      "git.push": gitPushEffect({
        workspace: () => this.actor.workspace!,
        dir: DIR,
        url: REPO,
        token: () => installationToken(this.env),
        allow: (branch) => branch === `factory/issue-${this.ctx.id.name}`, // this instance's own branch only
      }),
    },
  });

  /** The container's computerd connection and egress arrive here. */
  async fetch(request: Request): Promise<Response> {
    return this.actor.fetch(request);
  }

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  /** A clone awaits the network, so it never runs in a handler: the Worker calls this before it sends task.assigned. */
  async prepare(): Promise<void> {
    await gitClone(this.actor.workspace!, { url: REPO, dir: DIR, token: () => installationToken(this.env) });
  }
}
```

## The declaration

- `harness: pi({ workspace? })`, `model: { id, reasoning? }`, `returns` and a complete `budget: { usd, turns,
  wallClock }` are required (`actord check`: `AGENT_*`, and `ACTOR_BUDGET_MISSING`). `instructions` names a file next
  to `system.ts`, which must exist (`AGENT_INSTRUCTIONS_MISSING`).
- `on` maps each message to `"start"` (a new session; a start while one runs replaces it), `"steer"` (joins the
  running turn) or `"stop"`. Each `on` message needs a route to the actor.
- `tools` lists `workspace.*` or `workspace.<name>`, and effects in the actor's `effects`, each with `input`. A tool
  call is one effect request keyed `<session>:<callId>`; an unkeyed one never runs twice.
- A tool effect with `approval: "human"` answers the model "waiting" at once; the result arrives later as a user
  message. Give it a `result` message (`AGENT_TOOL_APPROVAL_RESULT_MISSING` warns otherwise).
- The session settles once, as `returns`, `agent.failed` or `agent.exhausted`. A running session keeps the
  instructions it started with.

## Wiring

- `agentRuntime(host, system, actor, handlers, options)`: `options.instructions` (the text), `transcripts` (an R2
  bucket, optional), `render(type, payload)` (the prompt an `on` message becomes; default: the type, then the payload
  as indented JSON), `effects`, and for a container, `container: this`.
- wrangler: `"ai": { "binding": "AI" }` (sessions run on Workers AI), the R2 bucket, `nodejs_compat` (Computer's git
  client imports `node:` modules), the Durable Object binding and `exports` entry, and with a container
  `"containers": [{ "class_name": "Coder", "scheduling_policy": "durable_object", "images": { "app": { "dockerfile": "./Dockerfile" } } }]`
  (`AGENT_CONTAINER_CONFIG_MISSING`; wrangler rejects `image` for that policy).
- The optional peers an agent app installs: `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and
  `@earendil-works/chord` at 1.4.0, `@cloudflare/computer` at exactly 0.8.0, `@platformatic/vfs` 0.4.0 (Computer's
  git client loads it lazily, and fails without it), and `zod`. An app without agent actors installs none.

## Workspaces and git

- The workspace lives in the object's SQLite: edits outlive the container and restarts. Reading, searching and
  editing run in the object; `exec` runs in the container. A command cut off by a lost container is reported to the
  model as one that "may have partly run", and is never run again by itself.
- `localOnly` is required with a container backend (`["**/node_modules"]` is the usual choice; `[]` syncs everything);
  each pattern starts with `/` or `**/`.
- Container commands get only `HOME`, `OLDPWD`, `PATH`, `PWD` and the exec's own `env`, never the image's `ENV`.
- `gitClone(workspace, { url, dir, ref?, token? })` clones in full, on the object's side. `gitPushEffect({ workspace,
  dir, url, token, allow })` is a push effect's adapter: declare it `idempotency: "key"`. The URL is the app's, `https`
  with no credentials in it. The token is minted per attempt, sent as Basic `x-access-token`, never enters the
  container, and is scrubbed from errors.
- `allow` defaults to any valid `factory/` branch (the toolkit's `factoryBranch`, not exported), so an agent could
  push another issue's branch. Bind it to the instance's own branch, as above. A disallowed branch is
  `EffectRejected`.

## Testing

- `options.model: scriptedModel(turns | (request) => turn)` replaces Workers AI with a script, and reports the tokens
  and cost it gives. It is a test seam, not for production.
- Containers don't run under `@cloudflare/vitest-plugin`: container tests run against a stub of `ctx.container`
  (`ContainerStub` in `packages/toolkit/test-runtime/src/agent.ts`). `overrideBudget(actor, { usd, turns, wallClock:
  "50ms" })` shrinks a budget.

## Limits that matter here

Read Limitations before you rely on these: a budget can overshoot by two model requests; `budget.usd` is silently
unenforced for a model pi-ai doesn't price; approvals come back as user messages while `wallClock` keeps running;
transcripts hold everything the model saw; a deploy reaches a busy agent late; no container runs in tests; the
`corsProxy` residual; and `@actord/toolkit/agents` loads Computer and zod at import. A handler that awaits I/O fails
here too (`runtime.md`).
