# `system.ts` cheat sheet (`@actord/toolkit/system`)

A small system with a source, a decision, a job and a timer. Each pull request GitHub reports gets its own instance,
which rates the change's risk with a decision, runs CI as a job when the risk is Medium or High, and sets itself a
timer that nudges if CI stays quiet. The actor is `deterministic`: requesting a decision doesn't make it
model-assisted.

```ts
// actord:check system
import { defineSystem, message, webhook } from "@actord/toolkit/system";
import { z } from "zod";

// An effect's result message carries { key, status, value?, error?, usage? }.
const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional() });
type PullRequestEvent = { pull_request: { number: number; title: string; body: string | null } };

export default defineSystem({
  name: "pr-gate",
  description: "Rates each pull request's risk, runs CI on the risky ones, and nudges when CI stays quiet",
  // Inline here; a project from `actord init` keeps them in src/messages/index.ts (below).
  messages: {
    "pr.opened": message({ version: 1, description: "A pull request was opened", payload: z.object({ number: z.number().int(), title: z.string(), body: z.string() }) }),
    "pr.rated": message({ version: 1, description: "decide.risk's outcome", payload: Outcome }),
    "ci.settled": message({ version: 1, description: "ci.run's outcome", payload: Outcome }),
    "ci.nudge": message({ version: 1, description: "CI has been quiet for an hour", payload: z.object({ number: z.number().int() }) }),
  },
  sources: {
    // The name is the route sender: @github. `secret` names an env entry, never the value.
    github: webhook({
      path: "/webhooks/github",
      verify: "github",
      secret: "GITHUB_WEBHOOK_SECRET",
      events: {
        "pull_request.opened": {
          message: "pr.opened",
          key: (e: PullRequestEvent) => String(e.pull_request.number), // picks the instance
          map: (e: PullRequestEvent) => ({ number: e.pull_request.number, title: e.pull_request.title, body: e.pull_request.body ?? "" }),
        },
      },
    }),
  },
  actors: {
    PullRequest: {
      binding: "PULL_REQUEST",
      kind: "deterministic",
      purpose: "Gates one pull request (one instance per number): rates its risk, and runs CI when it is risky",
      justification: ["identity", "state"],
      effects: ["decide.risk", "ci.run"],
    },
  },
  effects: {
    "decide.risk": {
      description: "Rate a pull request's risk",
      kind: "decision",
      model: "@cf/cloudflare/clef-flash",
      idempotency: "key",
      result: "pr.rated",
      questions: { risk: { type: "score", instructions: "How risky is merging this change?", criteria: ["No risk", "Low", "Medium", "High"] } },
      budget: { maxAttempts: 3, timeoutMs: 20_000 }, // this effect's own bounds, ahead of the actor's
    },
    "ci.run": {
      description: "Run CI on the pull request, which finishes minutes later",
      kind: "job",
      idempotency: "key",
      deadline: "2h", // unsettled by then: in_doubt
      probe: { every: "5m" },
      result: "ci.settled",
    },
  },
  routes: [
    { from: "@github", message: "pr.opened", to: "PullRequest" },
    { from: "PullRequest", message: "pr.rated", to: "PullRequest" }, // effect results: self-routes
    { from: "PullRequest", message: "ci.settled", to: "PullRequest" },
    { from: "@timer", message: "ci.nudge", to: "PullRequest" }, // ctx.after("1h", "ci.nudge", …, { key })
  ],
});
```

Message contracts, in `src/messages/index.ts` (zod 4 or any Standard Schema library):

```ts
// actord:check
import { agentExhausted, agentFailed, approvalDecided, message } from "@actord/toolkit/system";
import { z } from "zod";

export const PrOpened = message({ version: 1, description: "A pull request was opened", payload: z.object({ number: z.number().int(), title: z.string(), body: z.string() }) });

// Messages the runtime delivers itself have ready-made schemas. Import them from /system, never from /sources or
// /agents: `actord check` loads system.ts under Node, which can't load those entry points.
export const ApprovalDecided = message({ version: 1, description: "The owner answered an approval request by email", payload: approvalDecided });
export const AgentFailed = message({ version: 1, description: "A session ended without a result", payload: agentFailed });
export const AgentExhausted = message({ version: 1, description: "A session ran out of budget", payload: agentExhausted });
```

## Route senders

| `from` | What delivers it | Needs |
| --- | --- | --- |
| `@ingress` | The Worker's own code: `ingress(env, system, "Actor", type, payload, { key, id })` | Nothing more |
| `@clock` | A schedule's tick, with `payload.at` the time it was due | A `schedules` entry for that message on the receiving actor |
| `@timer` | A timer the actor set for itself: `ctx.after(delay, …)` or `ctx.at(epochMs, …)` | `to` is that actor; without the route the call is a type error |
| `@<source>` | A declared source (`@github` above) | The source under `sources`; each message the source maps needs exactly one route |
| An actor name | `ctx.send(type, payload, { to?, key? })`, or an effect's `result` (a self-route) | Both actors declared |

`clock`, `ingress`, `timer` and `rpc` can't name a source (`SOURCE_NAME_RESERVED`). Any other `@name` without a
source is `ROUTE_INVALID_SENDER`.

## Actors

Every actor has `binding`, `kind`, `purpose` and `justification` (at least one of identity, state, lifecycle,
isolation, scheduling, permissions; `ACTOR_UNJUSTIFIED` otherwise), and optionally `schedules` and `effects`.

| `kind` | Control flow | Also required |
| --- | --- | --- |
| `deterministic` | Plain handlers. It may request any effect, a decision or an extraction included | Nothing. A `budget` is optional and bounds its effects |
| `model-assisted` | Plain handlers that request a model through an effect, then validate what comes back | `budget: { maxAttempts, timeoutMs }`: the bounds of each model effect |
| `agent` | A Pi session: the model picks its tools until it calls `finish` | `harness: pi({ workspace? })`, `model: { id, reasoning? }`, `returns`, `budget: { usd, turns, wallClock }`, usually `instructions`, `on` and `tools` |

- An agent's budget bounds each session: `usd` (dollars), `turns`, and `wallClock` (a duration such as `"45m"`).
  It's `AGENT_BUDGET_INCOMPLETE` without all three, and `ACTOR_BUDGET_MISSING` without a budget. The budget type
  also accepts `maxTokens`, but nothing enforces it. It can overshoot, and `usd` isn't enforced for an unpriced
  model: see Limitations.
- `schedules: [{ every: "15m", message }]` or `[{ cron: "0 9 * * *", message }]` (UTC), each on a route from `@clock`.
  They run per instance, and each instance ticks once it has started, so an instance nothing has reached never
  ticks.
- Agents in full, with the routes `returns`, `agent.failed` and `agent.exhausted` need: `../../implement/references/agents.md`.

## Effects

Every effect has `description` and `idempotency`. Its `kind` is `"call"` unless it says otherwise.

| Field | Applies to | Meaning |
| --- | --- | --- |
| `idempotency: "key" \| "none"` | All | `"key"`: the destination deduplicates by key, so a retry is safe. `"none"`: a lost acknowledgment is `in_doubt`, never retried blindly (`EFFECT_IN_DOUBT` warns) |
| `reconcile: true` | `"none"` effects | The adapter can look up an unacknowledged attempt's outcome |
| `result: "<message>"` | All | The outcome comes back as this message, on a route from each requesting actor to itself |
| `budget: { maxAttempts, timeoutMs }` | All | This effect's bounds, ahead of the actor's (defaults: 6 attempts, 30 s each) |
| `approval: "human"`, `expires` | All | Parked until a person approves or denies, or until `expires` (default `"3d"`) passes and it fails |
| `publishes: true` | Calls and jobs | It makes something public, so it needs `approval: "human"` (`PUBLISHES_WITHOUT_APPROVAL`) |
| `input: <schema>` | Agent tools | The tool's parameters, as the model sees them. Required for an effect listed in an agent's `tools` |
| `kind: "job"`, `deadline`, `probe: { every }`, `completes: { message }` | Jobs | Outside work that runs minutes or hours. `deadline` is required; with neither `probe` nor `completes`, every run ends `in_doubt` (`JOB_UNOBSERVABLE`) |
| `kind: "decision"`, `model`, `questions`, `mode` | Decisions | Clef (`@cf/cloudflare/clef` or `clef-flash`) answers 1–64 questions (`noul`, `choice` or `score`) with a probability for each answer. `mode: "shadow"` records the answer and delivers nothing, so it declares no `result` |
| `kind: "extraction"`, `model`, `fields` | Extractions | Clairic (`@cf/cloudflare/clairic`) returns typed values, each with a confidence |

A decision or extraction is a read: declare it `idempotency: "key"` (`none` warns), with no `deadline`, `probe`,
`completes` or `publishes`. Its result can't approve anything. In depth: jobs and timers in
`../../implement/references/timers-and-jobs.md`, decisions in `../../implement/references/decisions.md`, adapters
and outcomes in `../../implement/references/runtime.md`.

## Sources and approvals

- `webhook({ path, verify: "github", secret, events })` maps `"<X-GitHub-Event>.<action>"` to `{ message, key, map }`.
  The delivery id is the envelope id, so a redelivery is a duplicate.
- `inboundEmail({ secret, owner, from, send, authserv?, message })` accepts only the owner's reply to an approval
  request. `secret`, `owner`, `from`, `send` and `authserv` name env entries or bindings; `message` is the
  declared message, which uses the `approvalDecided` schema.
- `approvals: { notify: "<effect>" }` names the effect that tells a person an approval is waiting. That effect
  has `idempotency: "none"` and no approval of its own, and every actor with an approval-gated effect lists it. With
  an email source, each such actor also needs a route from it.
- In full, with the Worker entry and the secrets: `../../implement/references/sources.md`.

## Conventions the checks enforce

- Actor names are PascalCase class names, and message names are lowercase and dotted (`release.observed`).
- Routes are the only source of who sends and receives what. An undeclared actor, message, effect, or schedule
  message is a TypeScript error.
- `wrangler.jsonc` needs a binding `{ name: <binding>, class_name: <Actor> }` and
  `exports.<Actor> = { type: "durable-object", storage: "sqlite" }` for each actor, and the Worker entry must export
  each class.
- `package.json` has `"type": "module"`. `system.ts` uses only erasable TypeScript, has no side effects, and imports
  relative files with `.ts`.
- `actord graph --write` regenerates the derived `actord.manifest.json`; commit it.
