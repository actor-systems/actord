# Decisions and extractions

A decision puts typed questions to Clef on Workers AI and gets a probability for every allowed answer. An extraction
asks Clairic for typed values, each with a confidence. Both are effects: keyed, retried, budgeted and traced like
any other, and every confirmed answer is recorded for `actord scorecard` (decision 0020). The adapters come from
`@actord/toolkit/decisions`, which needs no peer dependency.

```ts
// actord:check system
import { defineSystem, message } from "@actord/toolkit/system";
import { z } from "zod";

const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional() });
const ROUTE = { ready: "Clear enough to implement now", needs_info: "Missing information the factory must ask for", not_for_factory: "Needs a human: design, policy, or out of scope" };

export default defineSystem({
  name: "triage",
  messages: {
    "issue.filed": message({ version: 1, description: "An issue to triage", payload: z.object({ number: z.number().int(), text: z.string(), filedOn: z.string() }) }),
    "issue.resolved": message({ version: 1, description: "What the issue turned out to be", payload: z.object({ number: z.number().int(), route: z.enum(["ready", "needs_info", "not_for_factory"]), runIdRight: z.boolean() }) }),
    // Each decision's result message is its own, routed only from Triage to itself.
    "issue.routed": message({ version: 1, description: "decide.route's outcome", payload: Outcome }),
    "issue.extracted": message({ version: 1, description: "extract.facts's outcome", payload: Outcome }),
  },
  actors: {
    Triage: {
      binding: "TRIAGE",
      kind: "model-assisted",
      purpose: "Routes one issue (one instance per number) and extracts its facts",
      justification: ["identity", "state"],
      budget: { maxAttempts: 3, timeoutMs: 20_000 },
      effects: ["decide.route", "decide.route.next", "extract.facts"],
    },
  },
  effects: {
    "decide.route": {
      description: "Route an issue",
      kind: "decision",
      model: "@cf/cloudflare/clef-flash",
      idempotency: "key",
      result: "issue.routed",
      questions: {
        route: { type: "choice", instructions: "How should a software factory handle this issue?", criteria: ROUTE },
        one_line: { type: "noul", instructions: "Is the issue only a one-line description with no acceptance criteria?" },
        risk: { type: "score", instructions: "How risky is merging this change?", criteria: ["No risk", "Low", "Medium", "High"] },
      },
    },
    // A candidate in shadow: recorded for the scorecard, never delivered, so it declares no result.
    "decide.route.next": {
      description: "Route an issue with the full Clef model, in shadow",
      kind: "decision",
      model: "@cf/cloudflare/clef",
      idempotency: "key",
      mode: "shadow",
      questions: { route: { type: "choice", instructions: "How should a software factory handle this issue?", criteria: ROUTE } },
    },
    "extract.facts": {
      description: "Extract an issue's facts",
      kind: "extraction",
      model: "@cf/cloudflare/clairic",
      idempotency: "key",
      result: "issue.extracted",
      fields: {
        run_id: { type: "number", integer: true, instructions: "The CI run id", null_threshold: 0.3 },
        reported_on: { type: "date", instructions: "The date the failure happened", null_threshold: 0.3 },
      },
    },
  },
  routes: [
    { from: "@ingress", message: "issue.filed", to: "Triage" },
    { from: "@ingress", message: "issue.resolved", to: "Triage" },
    { from: "Triage", message: "issue.routed", to: "Triage" },
    { from: "Triage", message: "issue.extracted", to: "Triage" },
  ],
});
```

```ts
// actord:check
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { decisionAdapters } from "@actord/toolkit/decisions";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import { z } from "zod";
import system from "./system";

// The answers, verbatim from the model, checked again before acting: model output is untrusted input.
const Routed = z.object({ answers: z.object({ route: z.object({ choice: z.enum(["ready", "needs_info", "not_for_factory"]) }) }) });
const Field = z.object({ value: z.number().nullable(), confidence: z.number(), p_null: z.number() });
const Extracted = z.object({ answers: z.object({ run_id: Field }) });

export class Triage extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS issues (number INTEGER PRIMARY KEY, route TEXT, run_id INTEGER)");
  }

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "Triage", {
    "issue.filed": ({ payload }, ctx) => {
      const key = String(payload.number); // the record's id is "<effect>:<key>", per instance
      ctx.sql.exec("INSERT INTO issues (number) VALUES (?) ON CONFLICT (number) DO NOTHING", payload.number);
      ctx.effect("decide.route", { state: payload.text }, { key });
      ctx.effect("decide.route.next", { state: payload.text }, { key });
      ctx.effect("extract.facts", { state: payload.text, referenceDate: payload.filedOn }, { key }); // only an extraction takes referenceDate
    },
    // ctx.approve and ctx.deny throw in this handler: a decision's result can't approve.
    "issue.routed": ({ payload }, ctx) => {
      const routed = Routed.safeParse(payload.value);
      if (payload.status !== "confirmed" || !routed.success) return ctx.note("route unknown: a person decides", { key: payload.key });
      const route = routed.data.answers.route.choice;
      ctx.sql.exec("UPDATE issues SET route = ? WHERE number = ?", route, Number(payload.key));
      ctx.acted(`decide.route:${payload.key}`, `routed:${route}`); // what the actor did; a later call replaces it
    },
    "issue.extracted": ({ payload }, ctx) => {
      const facts = Extracted.safeParse(payload.value);
      if (payload.status !== "confirmed" || !facts.success) return;
      const runId = facts.data.answers.run_id;
      // Clairic guesses, and can misread a long number: act only on a confident value, and check it against the source.
      if (runId.value !== null && runId.confidence >= 0.8) ctx.sql.exec("UPDATE issues SET run_id = ? WHERE number = ?", runId.value, Number(payload.key));
    },
    // What really was so, for the scorecard. Labels merge, and throw for an unknown id, question, option or level.
    "issue.resolved": ({ payload }, ctx) => {
      const key = String(payload.number);
      ctx.outcome(`decide.route:${key}`, { route: payload.route });
      ctx.outcome(`decide.route.next:${key}`, { route: payload.route });
      ctx.outcome(`extract.facts:${key}`, { run_id: payload.runIdRight });
    },
  }, {
    // An adapter for every decision and extraction, by effect name. `inputs` (optional) keeps each request body in R2.
    effects: { ...decisionAdapters(system, { ai: this.env.AI, inputs: this.env.DECISION_INPUTS }) },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }
}
```

## The declaration

- A decision's `model` is `@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash`; an extraction's is
  `@cf/cloudflare/clairic`. `questions` and `fields` are Clef's and Clairic's own vocabulary, passed through.
- A question is `noul` (yes or no), `choice` (each option described, or `null`) or `score` (levels, lowest first).
  A field takes Clairic's types and options (`text`, `number`, `date`, `list`, …).
- The input is `{ state, referenceDate? }`. `state` is a string or structured data.
- `mode: "act"` (the default) delivers the answer; `mode: "shadow"` records it and delivers nothing, so it declares
  no `result` (`DECISION_SHADOW_RESULT`). At runtime an unknown `mode` is shadow; `actord check` refuses one.
- `actord check` also warns on `idempotency: "none"`, an act-mode decision without a `result`, and a `result` type
  another effect or sender shares (`DECISION_RESULT_SHARED`): give each decision a result message of its own.

## The result

- `value` is `{ model, answers, truncated, inputDigest, inputRef, usage }`. `answers` is the model's:
  `answers.route.choice` and `answers.route.probabilities`, `answers.one_line.noul`, `answers.risk`, or a field's
  `answers.run_id.value`, with its `confidence` and `p_null`.
- A response that misses an answer or has the wrong type fails the effect and isn't retried. A throw from `ai.run` is
  retried under the effect's budget. The cost is `input_tokens` times the toolkit's price table.

## Records and labels

- Each confirmed answer is recorded in `_actors_decisions` as `<effect>:<key>`, with a `decision.recorded` event.
  The id is per instance: label it in the instance that recorded it.
- `ctx.acted(id, action)` records what the actor did. `ctx.outcome(id, actual)` records what was so: an option for
  `choice`, a boolean for `noul`, a level index for `score`, `true` or `false` for a field. Both are synchronous,
  part of the handler's transaction, and checked against the effect as declared now.
- Don't read `_actors_decisions` to decide: a shadow answer is there, and acting on it defeats shadow mode.

## No approvals from a decision

In every handler of a decision's or an extraction's result message, `ctx.approve` and `ctx.deny` throw, and
`ActorRuntime.decide` throws in any handler. The guard goes by message type, so it can't see an answer a handler
relays in a message of its own. Don't build an approval on a decision's answer (Limitations, "A decision can't
approve directly, but a handler can relay its answer").

## The scorecard

`actord scorecard [--effect <name>] [--file <events.ndjson>] [--json]` reads the local event log, as `actord trace`
does. Per effect it prints the recorded, shadow, labelled and acted counts, then accuracy and the Brier score for a
`choice`, the Brier score for a `noul`, mean absolute error for a `score`, and the share labelled correct for a
field. A statistic with no labels is `-`. It sees local logs only: tests and local runs, never production.

## Clairic guesses (spike 7)

Clairic doesn't always come back empty when the input doesn't say: in spike 7 a date the issue never gave came back
as the `referenceDate`, with confidence 0.97 and `p_null` 0.32, under the default `null_threshold` of 0.5.
`null_threshold` is the probability of null above which the value is null, so lowering it turns more guesses into
`null`. Set it on a field where a guess is worse than nothing, read `confidence` and `p_null`, and check an extracted
id or long number against the source before acting on it. Limitations lists the rest: list confidences, forecasts, datetimes without an
offset, Clef's silent truncation, the price table, and the R2 inputs bucket's contents.

## Testing

Pass a stub `{ run(model, body) }` as `ai` to `decisionAdapters` and script its responses, as
`packages/toolkit/test-runtime/src/index.ts` does (`stubAi`). The recorded responses in
`packages/toolkit/test/fixtures/` show the real shapes.
