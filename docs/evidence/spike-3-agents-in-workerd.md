# Spike 3: Pi and actord share one Durable Object in workerd

**Run:** 2026-10-26, locally, under `@cloudflare/vitest-plugin` 1.4.7 (wrangler 4.152.0, miniflare 5.20261019.2-beta,
vitest 5.0.5) on Node 24.22.1, macOS arm64. Docker Desktop 29.9.2 was running. Nothing was deployed, and no request
went to Workers AI: every model call is `scriptedModel`.

**Setup:**
- **Pins.** `agents` 0.30.1 (already pinned), `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and
  `@earendil-works/chord` 1.4.0, and `@cloudflare/computer` 0.8.0. They are optional peer dependencies of
  `@actord/toolkit`, and dev dependencies for its tests.
- **The probe.** `Scribe` (`packages/toolkit/test-runtime/src/agent.ts`) installs four things on one `Lifecycle`:
  - actord, an `actorRuntime` with one handler;
  - a `PiHarness`, whose factory opens Pi with `scriptedModel(…)`;
  - a per-object registry, with no tools except in the `echo-…` and `json-…` instances;
  - `JobLog`, a capability whose SQLite triggers record every set of ids `cf_agents_jobs` holds when a job is added
    or changed.
- **The tests.** `packages/toolkit/test-runtime/agents.test.ts`.

Ruling: `packages/toolkit/test-runtime/src/agent.ts` may import `@earendil-works/*` directly, because the rule that only `src/agents/**` imports `@earendil-works/*` or `@cloudflare/computer` is about shipped code, and `test-runtime/` is test code that is never bundled, declared or packed.

## Node

- **Pi's requirement.** pi-durable, pi-ai and chord all declare `engines.node >=22.19.0`.
- **Where it holds.** CI (`.github/workflows/verify.yml`) uses Node 24, and this machine runs 24.22.1.
- **What changed.** `packages/toolkit/package.json` `engines.node` goes from `>=22.18` to `>=22.19`.
- **What didn't.** The prose that says 22.18 is unchanged: the READMEs, `CONTRIBUTING.md`, the setup skills, the wiki
  and `actord doctor`. The doctor's check is about Node loading `system.ts` natively, which 22.18 still does.

Ruling: `@actord/toolkit` declares `engines.node` `>=22.19`, up from `>=22.18`, because the Pi packages that `@actord/toolkit/agents` runs on (pi-durable, pi-ai and chord 1.4.0) declare `>=22.19.0`, and the toolkit's floor shouldn't be lower than its agent peers'. CI's Node 24 already meets it.

## Dependency footprint

- **Size.** The install grew `package-lock.json` from **356 to 439 packages (+83)**.
- **What's new:**
  - the Pi packages themselves, plus `pi-codemode` and `pi-telemetry`;
  - `typebox`, and `@cloudflare/computer` with its own `capnweb`;
  - pi-ai's provider SDKs: `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@aws-sdk/client-bedrock-runtime` and the
    AWS credential chain, `google-auth-library`, `protobufjs`, and their helpers.
- **Audit.** `npm audit` reports the same 7 findings before and after (5 high, 2 moderate). None is in an added
  package.
- **Install scripts.** npm warned that two added packages have install scripts that `allowScripts` doesn't cover:
  - `@google/genai` (preinstall, a no-op echo);
  - `protobufjs` (postinstall).

## Results

| Question | Observed | Result |
| --- | --- | --- |
| Can a `PiHarness` share the object with actord? | Yes. Both are capabilities on one `Lifecycle`, and Pi opens over the object's SQLite (its `pi_` tables beside actord's `_actors_` tables) with no conflict. No compatibility flag was needed: the probe Worker has none, not even `nodejs_compat`. | **pass** |
| Does a prompt run to an answer? | `submit("Say hello", { operationId: "op-1" })` answered `{ operationId: "op-1", session: "1", accepted: true }`. Submitting `op-1` again answered `accepted: false`. `wait("op-1")` was `{ status: "done", text: "hello" }`. | pass |
| Does actord's timer fire while Pi's run is in flight? | Yes. The scripted model held its answer behind a test gate. A 20 ms timer set through actord fired by the alarm with no test driving it. In a run without the gate, the test saw it fire 24 ms after sending the message. While it fired, `pending()` still listed `op-1` as `running`. Pi's wake job waits on its run through `trackAlarmWork`, so it doesn't hold the alarm. | **pass** |
| Did `cf_agents_jobs` hold both jobs at once? | Yes, with the gate. The triggers recorded a set holding both `actord` and `pi-wake`. Without the gate, one run recorded `[pi-wake]` seven times, then `[actord]` three times: the scripted reply finished, and Pi's wake job completed, before actord's message arrived. So the overlap is a race unless the run is held. | pass, held |
| Does a scripted turn call a registered tool? | `echo({ v: 1 })` ran once, with `api.callId` set to the model's call id (`call_<uuid>`). The transcript's kinds were `pi.user`, `pi.system`, `pi.assistant`, `pi.tool-result`, `pi.assistant`. The tool result carried that `toolCallId` and the text `echo 1`, and the run answered `echoed`. | pass |
| Is usage what the script reported? | The script reported `{ input: 10, output: 5, costUsd: 0.001 }` for the first turn and `{ input: 20, output: 3, costUsd: 0.002 }` for the second. `(await harness.pi()).usage(BACKGROUND_CONTEXT)` was `{ models: { "scripted/scripted": { input: 30, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 38, cost: { …, total: 0.003 } } }, tools: {} }`. | pass |
| Why not pi-ai's own `faux` provider? | pi-ai 1.4.0 ships `fauxProvider`. It replaces each response's usage with an estimate from the text, and its cost is always 0, so it can't report a scripted budget. `scriptedModel` is a pi-ai provider built with `createProvider` instead. | — |
| Does Pi take plain JSON Schema tool parameters? | Yes. The `json-…` instance registers `echo` with `parameters: z.toJSONSchema(z.object({ v: z.number() }))`, the shape Computer's Pi tools use. Pi offered it to the model as given: the `pi.system` entry carries the draft 2020-12 schema. It also validated calls against it. `echo({ v: "one" })` never reached `execute`; its result was `isError: true`, with ``Validation failed for tool "echo": - v: must be number``. `echo({ v: 2 })` ran. | **pass; no `Type.Unsafe` needed** |
| Do containers run under the Vitest integration? | No. The three tries are below. | **no** |

Ruling: `scriptedModel` is a pi-ai provider of our own, built with `createProvider`, not pi-ai's `fauxProvider`, because faux replaces each response's usage with a text-length estimate and a cost of 0, and tests of budgets need the tokens and cost a script reports.

Ruling: Pi takes plain JSON Schema tool `parameters` and validates calls against them, so Task 6's tools pass Computer's JSON Schema through as given, with no `Type.Unsafe` wrapper.

## Containers under `@cloudflare/vitest-plugin`

Each try was a throwaway Worker with a Durable Object `Box`, run with `npx vitest run` under its own config. None of
it is committed.

1. **A `containers` entry in `wrangler.jsonc`.** `{ "class_name": "Box", "image": "./Dockerfile" }`, where the
   Dockerfile is `FROM node:24-bookworm`, an image present locally.
   - In `Box`, `ctx.container` was `undefined`.
   - The plugin reads the Wrangler config with `enableContainers: false` hard-coded
     (`@cloudflare/vitest-plugin/dist/pool/index.mjs`, the `unstable_getMiniflareWorkerOptions` call).
   - An image name rather than a Dockerfile path is refused at config load: "does not appear to be a valid path to a
     Dockerfile, or a valid image registry path".
2. **Miniflare's own Durable Object container option.** This passed
   `miniflare: { exports: { Box: { type: "durable-object", storage: "sqlite", container: { imageName: "node:24-bookworm" } } } }`
   through `cloudflareTest`. `ctx.container` was still `undefined`. The plugin wraps each Durable Object class in its
   own runner, and the option didn't reach the object.
3. **Computer's backend.** `class Box2 extends withWorkspaceContainer(DurableObject)`, with a `containers` entry.
   - `@cloudflare/computer/backends/container` loads in workerd.
   - `getWorkspaceContainer()` throws `WorkspaceContainerAPI: DO is not container-enabled (check wrangler.jsonc)`.
   - So a `ContainerBackend` can't start anything there.

Even if a workaround reached Miniflare's container support, the runtime suite would then need Docker. It would also
need Computer's `linux-x64` computerd image, which runs emulated on arm64. And it couldn't run in the sandboxes where
`actord verify` already reports `blocked`.

Ruling: containers don't run under @cloudflare/vitest-plugin 1.4.7, so later container tests use the `ContainerStub` stand-in for `ctx.container` (`start`, `getTcpPort`, `destroy`, `running`) in `packages/toolkit/test-runtime/src/agent.ts`, and `docs/wiki/Limitations.md` says so.

## What later tasks should know

- **Usage needs a Context.** `PiHarness` has no `usage()`. Read it from Pi:
  `(await harness.pi()).usage(BACKGROUND_CONTEXT)`, with `BACKGROUND_CONTEXT` from `@earendil-works/chord/context`.
- **Pi's wake job is short-lived when the model is fast.** The job completes as soon as Pi is idle. To observe Pi
  mid-run, hold the scripted model: `scriptedModel`'s function form may return a promise.
- **Tool results are entries of kind `pi.tool-result`.** Their `model[0]` is the `ToolResultMessage`.
- **Alarms fire on their own under the plugin.** A 20 ms actord timer fired without `runDurableObjectAlarm`.
