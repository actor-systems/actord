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
    "task.assigned": message({ version: 1, description: "Work on an issue", payload: z.object({ issue: z.number().int(), title: z.string() }) }),
    "repo.cloned": message({ version: 1, description: "The repo.clone outcome", payload: Outcome }),
    "task.start": message({ version: 1, description: "Start a session on the cloned issue", payload: z.object({ issue: z.number().int(), title: z.string() }) }),
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
      effects: ["repo.clone", "git.push"],
      tools: ["workspace.*", "git.push"], // workspace tools, and effects the model may request
      on: { "task.start": "start", "task.hint": "steer", "task.cancelled": "stop" },
      returns: "task.done", // the model's `finish` tool takes this message's payload
      budget: { usd: 2, turns: 40, wallClock: "45m" },
    },
  },
  effects: {
    // Not a tool: the actor requests it before the session starts. A clone can outlast the default 30 s attempt.
    "repo.clone": { description: "Clone the repository into the workspace", idempotency: "key", result: "repo.cloned", budget: { timeoutMs: 300_000, maxAttempts: 3 } },
    // A tool effect needs `input`: the model sees it as the tool's parameters.
    "git.push": { description: "Push the session's factory/ branch", idempotency: "key", input: z.object({ branch: z.string() }), result: "push.done" },
  },
  routes: [
    { from: "@ingress", message: "task.assigned", to: "Coder" },
    { from: "Coder", message: "repo.cloned", to: "Coder" },
    { from: "Coder", message: "task.start", to: "Coder" },
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
import type { EffectAdapter, Envelope } from "@actord/toolkit/runtime";
import instructions from "./agents/coder.txt"; // a wrangler Text module: .txt needs no rule
import system from "./system";

// The Worker must export WorkspaceProxy: the container's computerd connection and its egress reach the object through it.
export { WorkspaceProxy } from "@actord/toolkit/agents";

const REPO = "https://github.com/example/app.git"; // pinned by the app; never read from the workspace
const DIR = "/workspace/app";
const CLONED = `${DIR}/.git/actord-cloned`; // written by the clone adapter once gitClone returns
declare function installationToken(env: Env): Promise<string>; // yours: a GitHub App token, minted per call

export class Coder extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly lifecycle = Lifecycle.install(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task (id INTEGER PRIMARY KEY CHECK (id = 1), issue INTEGER NOT NULL, title TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS results (branch TEXT NOT NULL, summary TEXT NOT NULL)");
  }

  /**
   * repo.clone's adapter: the clone awaits the network, so it runs as an effect, never in a handler, as gitPushEffect
   * does. Not yet exercised by a test or an app; the factory's design will settle it (see "Cloning before the session").
   */
  readonly #clone: EffectAdapter<Record<string, never>, { dir: string }> = {
    run: async (_input, { signal }) => {
      const workspace = this.actor.workspace!;
      // Keyed, so it may run again after a lost acknowledgment: a clone that finished isn't repeated. The marker is
      // written only once gitClone returns, since a clone cut off partway leaves .git behind.
      if (await workspace.fs.lstat(CLONED).catch(() => null)) return { dir: DIR };
      signal.throwIfAborted();
      await gitClone(workspace, { url: REPO, dir: DIR, token: () => installationToken(this.env) });
      await workspace.fs.writeFile(CLONED, "");
      return { dir: DIR };
    },
  };

  // Typed: git.push reads this.actor.workspace inside the initializer.
  readonly actor: AgentRuntime = agentRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "Coder", {
    // Every message except the `on` messages, which drive sessions. A tool effect's result handler is optional.
    "task.assigned": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO task (id, issue, title) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING", payload.issue, payload.title);
      ctx.effect("repo.clone", {}, { key: `clone:${payload.issue}` });
    },
    // The session starts on the clone's result, and only when it is confirmed: an `on` message can't be gated itself.
    "repo.cloned": ({ payload }, ctx) => {
      const task = ctx.sql.exec<{ issue: number; title: string }>("SELECT issue, title FROM task WHERE id = 1").toArray()[0];
      if (payload.status !== "confirmed" || !task) return ctx.note("clone did not land; no session", { status: payload.status, error: payload.error });
      ctx.send("task.start", { issue: task.issue, title: task.title }, { key: ctx.key }); // this issue's instance, not "main"
    },
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
      "repo.clone": this.#clone,
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
  client imports `node:` modules), the Durable Object binding and `exports` entry, and with a container the entry
  below (`AGENT_CONTAINER_CONFIG_MISSING`; wrangler rejects `image` for that policy):

  ```jsonc
  "containers": [{ "class_name": "Coder", "scheduling_policy": "durable_object", "images": { "app": { "dockerfile": "./Dockerfile" } } }]
  ```
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
- `gitClone(workspace, { url, dir, ref?, token? })` clones one branch (`ref`) at full depth (never shallow), on the
  object's side. It awaits the network, so it runs in an effect's adapter, never in a handler.
- `gitPushEffect({ workspace, dir, url, token, allow })` is a push effect's adapter: declare it `idempotency: "key"`.
  The URL is the app's, `https` with no credentials in it. The token is minted per attempt, sent as Basic
  `x-access-token`, never enters the container, and is scrubbed from errors.
- `allow` defaults to any valid `factory/` branch (the toolkit's `factoryBranch`, not exported), so an agent could
  push another issue's branch. Bind it to the instance's own branch, as above. A disallowed branch is
  `EffectRejected`.

## Cloning before the session

Not yet exercised by a test or an app; the factory's design will settle it. The example declares `repo.clone`, a
keyed call effect whose adapter calls `gitClone`, as `gitPushEffect` wraps the push:

1. `task.assigned` stores the task and requests `repo.clone` with `ctx.effect`.
2. Its result, `repo.cloned`, starts the session only when it is `confirmed`, by sending `task.start` (the `on` start
   message) to the actor itself. An `on` message goes straight to the agent runtime, so mapping `repo.cloned` to
   `"start"` would start a session on a failed clone too.
3. The adapter writes a marker once `gitClone` returns, and skips a clone whose marker is there, so a retry after a
   lost acknowledgment doesn't repeat it and a clone cut off partway is never confirmed.
4. `gitClone` takes no signal, so an attempt cut off by its timeout (300 s here) keeps cloning, and the retry clones
   into the same directory while it does. The design has to settle that too.

## Testing

Tests never call the real model, and never need Cloudflare credentials.

- `options.model: scriptedModel(turns | (request) => turn)` replaces Workers AI with a script, and reports the tokens
  and cost it gives. It is a test seam, not for production.
- Set `remoteBindings: false` on `cloudflareTest` in `vitest.config.ts`. Workers AI has no local mode, so the declared
  `ai` binding is remote even when every session is scripted. Without the option, vitest opens a remote Workers AI
  session on whatever Cloudflare credentials it finds, and a session no test scripts calls the real model; with no
  credentials, no test starts. With it, that call fails locally (`Binding AI needs to be run remotely`) and never
  reaches Cloudflare. `decisions.md` shows the same setting for decisions.
- Containers don't run under `@cloudflare/vitest-plugin`: container tests run against a stub of `ctx.container`, as
  the toolkit's own do ([`ContainerStub`](https://github.com/actor-systems/actord/blob/main/packages/toolkit/test-runtime/src/agent.ts)).
  `overrideBudget(actor, { usd, turns, wallClock: "50ms" })` shrinks a budget.

```ts
// actord:check
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { actorEvents } from "@actord/toolkit/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, remoteBindings: false }), actorEvents()],
});
```

## Limits that matter here

Read Limitations before you rely on these: a budget can overshoot by two model requests; `budget.usd` is silently
unenforced for a model pi-ai doesn't price; approvals come back as user messages while `wallClock` keeps running;
transcripts hold everything the model saw; a deploy reaches a busy agent late; no container runs in tests; the
`corsProxy` residual; and `@actord/toolkit/agents` loads Computer and zod at import. A handler that awaits I/O fails
here too (`runtime.md`).
