# Decisions and extractions on Clef and Clairic (plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any actor can declare a typed **decision** effect (Clef, a probability for every allowed answer) or **extraction** effect (Clairic, typed values with confidence). Every call is recorded. The actor can later label what it did and what really happened. `actord scorecard` reports how well each decision is calibrated. A decision can run in **shadow** mode, where it is recorded but can never steer the actor.

**Architecture:**
- **New effect kinds.** Decisions and extractions are ordinary effects with two new kinds, `"decision"` and `"extraction"`. They go through the outbox, retries, budgets, usage and `trace` like any other effect.
  - **The call.** A new subpath, `@actord/toolkit/decisions`, turns a system's decision and extraction declarations into `EffectAdapter`s over the Workers AI binding, `env.AI.run`.
  - **No new peers.** The subpath needs no peer dependency: the AI binding and the R2 bucket are typed structurally.
- **Records.**
  - **Where.** The runtime records each delivered decision or extraction in a new table, `_actors_decisions`, and emits `decision.recorded`.
  - **Labels.** `ctx.acted(decisionId, action)` and `ctx.outcome(decisionId, actual)` label a record later, and emit `decision.acted` and `decision.outcome`.
  - **The scorecard.** `actord scorecard` computes calibration from those events in the local log, the same source `actord trace` reads.
- **Shadow mode.** It is a property of the declaration. A shadow decision has no `result` message (`actord check` enforces this), so its answer can't reach the actor's handlers. It is only recorded.
- **Faithful vocabulary.** Requests use Clef's and Clairic's own published vocabulary (`questions`, `fields`), passed through, not translated (spike 7's ruling).

**Tech Stack:**
- **The models,** on Workers AI: `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash` and `@cf/cloudflare/clairic` (preview).
- **The existing toolkit:** the runtime, checks, manifest, diff and CLI.
- **Tests:** Vitest, with `@cloudflare/vitest-plugin` for runtime tests and a stub `ai.run`.

**Spec:** `docs/superpowers/specs/2026-10-25-agents-sdk-foundation-design.md`. The relevant parts are:
- §9 in full;
- §10, the `decide` and `extract` rows;
- §12, spike 7;
- §13, decision 0020;
- §15, the Clairic-preview risk.

**Evidence:** `docs/evidence/spike-7-clef-clairic.md`. Spike 7 ran before this plan, and is committed with it. It has:
- the exact request and response schemas, from `wrangler ai models schema`;
- live calls, with their latency and cost;
- the corrections below.

**Where this plan sits:** plan 4 of 5. Plans 1–3 are merged, and so are #77, #80 and #82. Plan 5 updates the plugin skills, templates and eval scaffolds to the new foundation.

## Design corrections this plan makes

The spec's §9 was written before the models' schemas were read. Where they differ, this plan follows spike 7, and decision 0020 records the change:

1. **`questions`, not `question`.** Clef takes a map of typed questions (`noul`, `choice`, `score`), each with its own `instructions` and `criteria`. The spec's `question: { route: [...] }` becomes `questions: { route: { type: "choice", instructions, criteria: { ready: "…", … } } }`.
2. **`fields`, not `schema`.** Clairic takes a map of typed fields in its own types (`text`, `number`, `date`, `list`, `estimate`, …). The spec's `schema: IssueFacts` becomes `fields: { … }`. A Standard Schema can't express `null_threshold`, `decimals` or an estimate's range.
3. **Clairic does guess.** The spec says it "returns empty rather than guessing", but spike 7 got a confident guess. The record keeps `confidence` and `p_null` for every field, and the docs tell callers to set `null_threshold` where a guess is worse than nothing.
4. **"Phase one ships shadow mode only" means the graduation machinery.** The toolkit supports both modes. Triage acts (§10). The merge-risk decision runs in shadow. Per-lane graduation, switching a lane to `act` when its scorecard earns it, is factory code, later (§9.4).
5. **Where the input lives.** The pointer to the full input in R2 is content-addressed: `decisions/inputs/<sha256>.json`, where the hash is over the exact request body. Identical inputs share one object, and the pointer doubles as the input digest.

## Global Constraints

- **Models.**
  - A decision's `model` is `@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash`.
  - An extraction's `model` is `@cf/cloudflare/clairic`.
  - Clef-omni and images are later (spec §10 "Later").
- **Prices,** in USD per million input tokens, with no output charge:
  - `@cf/cloudflare/clef` 0.24;
  - `@cf/cloudflare/clef-flash` 0.038;
  - `@cf/cloudflare/clairic` 0.10.
- **Clef's limits:**
  - 1 to 64 questions;
  - question ids match `^[A-Za-z0-9_.-]{1,100}$`;
  - `choice` takes 2 to 255 options;
  - `score` takes 2 to 10 levels.
- **Clairic's limits:**
  - at least 1 field;
  - field names match `^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$`;
  - types are `text`, `number`, `date`, `time`, `datetime`, `duration`, `list`, `estimate` and `forecast`;
  - `list` requires `items` (`text`, `number` or `date`);
  - `estimate` and `forecast` require `min` and `max`;
  - `decimals` is 0–6;
  - `null_threshold` is in (0, 1];
  - `horizon` is 1–64.
- **The machinery never calls a model** (charter). Only a declared decision or extraction effect calls Workers AI, through its adapter.
- **Isolation.** `src/decisions/**` imports neither `agents`, nor `@earendil-works/*`, nor `@cloudflare/computer`, nor `zod`. `@actord/toolkit/runtime`, `/system` and `/sources` don't import `src/decisions/**`. The bundle-isolation test enforces both.
- **Handlers.** Handlers may not await I/O (#80, #82). `ctx.acted` and `ctx.outcome` are synchronous, like the other `ctx` methods.
- **No plugin skill edits** (plan 5). No npm release and no paid eval run.
- **Commits.**
  - Plugin dists are rebuilt (`npm run build -w @actord/toolkit`) and committed in their own commit. CI checks that they reproduce.
  - Never `git stash`. Never commit `.superpowers/`.
- **Node.** `engines.node` stays `>=22.19`.

## Review Focus

1. **A response missing an answer for a declared question or field, or answering with the wrong type.** The effect is rejected (`EffectRejected`), with a message naming the question or field. It is never delivered as a partial value. The model is deterministic (spike 7), so retrying wouldn't help.
2. **`ai.run` throws** (network, 429, 5xx). It is retried under the effect's budget, which is safe because decisions are keyed and pure. After `maxAttempts`, it fails like any effect.
3. **A label for an unknown decision id, or naming an unknown question, option or level.** `ctx.outcome` and `ctx.acted` throw, so a labelling bug fails the handler loudly instead of skewing the scorecard.
4. **A shadow decision's answer reaching the actor.** It can't. `actord check` refuses a shadow decision with a `result`, and the runtime also never enqueues a result for one, even if the declaration and the check disagree.
5. **A response with no `usage`, or no `input_tokens`.** No cost is reported for it, the record notes `usage: null`, and the docs say so. It isn't reported as $0.

---

### Task 1: Declaring decision and extraction effects

**Files:**
- Modify: `packages/toolkit/src/system.ts`, near the `EffectSpec` at line 128;
- Modify: `packages/toolkit/src/model/manifest.ts`, near `ManifestEffect` (55) and `normalize` (150–167);
- Modify: `packages/toolkit/src/model/check.ts`, in the per-effect loop (174–200) and beside the job block (185–196);
- Modify: `packages/toolkit/src/model/diff.ts`, near `EFFECT_FIELDS` (203) and `diffEffect` (230–251);
- Create: `packages/toolkit/test/check-decisions.test.ts`;
- Create: `fixtures/negative/<code>/` for each new error code below, holding `system.ts` and `expected.json`.

**Interfaces:**
- Produces, in `system.ts`:

```ts
export type ClefQuestion =
  | { readonly type: "noul"; readonly instructions: string; readonly criteria?: { readonly true?: string; readonly false?: string } }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string | null>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] };

export interface ClairicField {
  readonly type: "text" | "number" | "date" | "time" | "datetime" | "duration" | "list" | "estimate" | "forecast";
  readonly instructions?: string;
  readonly unit?: string;
  readonly integer?: boolean;
  readonly decimals?: number;
  readonly items?: "text" | "number" | "date";
  readonly min?: number | string;
  readonly max?: number | string;
  readonly step?: number | "month" | "year";
  readonly scale?: "linear" | "log";
  readonly null_threshold?: number;
  readonly horizon?: number;
  readonly interval?: "step" | "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";
}

// EffectSpec gains:
readonly kind?: "call" | "job" | "decision" | "extraction";
readonly model?: string;                                   // decision and extraction only
readonly questions?: Readonly<Record<string, ClefQuestion>>; // decision only
readonly fields?: Readonly<Record<string, ClairicField>>;    // extraction only
readonly mode?: "act" | "shadow";                          // decision only; default "act"
```

  - **The input.** An effect's input, as `ctx.effect` takes it, is `{ state: unknown; referenceDate?: string }`. The `referenceDate` applies to extraction only.
  - **The manifest.** `ManifestEffect` carries `model`, `questions`, `fields` and `mode` verbatim, with `mode` defaulting to `"act"` for a decision. They are `null` for other kinds.

- [ ] **Step 1: Write the failing check tests.** In `test/check-decisions.test.ts`, one `it` per code, asserting the exact code and severity.
  - **Errors:**
    - `DECISION_MODEL_UNKNOWN`: a decision whose `model` isn't one of the two Clef ids, or an extraction whose model isn't Clairic.
    - `DECISION_QUESTIONS_INVALID`. It fires for:
      - no `questions`;
      - 0 questions, or 65;
      - an id that fails the pattern;
      - an unknown `type`;
      - empty `instructions`;
      - a `choice` with 1 or 256 options;
      - a `score` with 1 or 11 levels.
    - `EXTRACTION_FIELDS_INVALID`. It fires for:
      - no `fields`;
      - a name that fails the pattern;
      - an unknown `type`;
      - a `list` without `items`;
      - an `estimate` without `min` or `max`;
      - `decimals: 7`;
      - `null_threshold: 0` or `1.5`;
      - `horizon: 65`.
    - `DECISION_SHADOW_RESULT`: `mode: "shadow"` with a `result`.
    - `DECISION_FIELD_MISPLACED`. It fires for:
      - `questions` or `mode` on a non-decision;
      - `fields` on a non-extraction;
      - `model` on a call or a job;
      - `deadline`, `probe` or `completes` on a decision or an extraction.
    - `DECISION_PUBLISHES`: `publishes: true` on a decision or an extraction. They are pure reads.
  - **Warnings:**
    - `DECISION_RESULT_MISSING`: an act-mode decision, or an extraction, without a `result`. The actor would never see the answer.
    - `DECISION_IDEMPOTENCY_NONE`: `idempotency: "none"` on a decision or an extraction. They are deterministic reads, so `"key"` is always safe.
  - **A valid system.** It holds a Clef-flash decision with a `choice` and a `noul` question, a shadow Clef decision, and a Clairic extraction. It yields none of these codes.
  - **The fixtures.** Add one negative fixture per error code, in the existing `fixtures/negative/` format, so `test/fixtures.test.ts` covers them through the built CLI.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run test/check-decisions.test.ts` in `packages/toolkit`. They fail with "expected [] to contain …".
- [ ] **Step 3: Implement.** Add the types to `system.ts`, then:
  - **The manifest.** In `normalize`, carry the fields over, with the `mode` default.
  - **The checks.** Add them in `check.ts`'s per-effect loop. Put the kind-specific blocks beside the `job` block. Messages and fixes follow the style of the existing codes.
  - **The diff.** Add `model`, `questions`, `fields` and `mode` to `EFFECT_FIELDS`. Classify each in `diffEffect`:
    - **Risky:** a change of `model`, and `mode` going from `shadow` to `act`.
    - **Behaviour:** a change of `questions` or `fields`.
    - **Safe:** `mode` going from `act` to `shadow`.
- [ ] **Step 4: Add diff tests.** Add a case to `test/diff.test.ts` for each classification above.
- [ ] **Step 5: Run.**
  - `npx vitest run` in `packages/toolkit`, then `npm run typecheck -w @actord/toolkit`: all pass.
  - `npm run build -w @actord/toolkit`, then `npx vitest run test/fixtures.test.ts`: the new negative fixtures pass.
- [ ] **Step 6: Commit.** Commit the source and tests as `Decision and extraction effects can be declared and checked (plan 4)`, then the rebuilt dists separately.

### Task 2: The Workers AI adapters (`@actord/toolkit/decisions`)

**Files:**
- Create: `packages/toolkit/src/decisions/index.ts`;
- Modify: `packages/toolkit/package.json`. Add the `exports["./decisions"]` entry, shaped like `./sources`.
- Modify: `packages/toolkit/build.mjs`. Add a `decisions` entry point, platform `neutral`, beside `sources` (line 35).
- Modify: `packages/toolkit/test/bundle-isolation.test.ts`. `dist/decisions.mjs` must contain no `agents`, `@earendil-works`, `@cloudflare/computer` or `zod` import, and `runtime.mjs`, `system.mjs` and `sources.mjs` must not contain the decisions code.
- Create: `packages/toolkit/test/decisions.test.ts`.

**Interfaces:**
- Consumes: Task 1's `EffectSpec` fields, and `EffectAdapter` and `EffectRejected` from `@actord/toolkit/runtime`.
- Produces:

```ts
export interface WorkersAI { run(model: string, body: unknown): Promise<unknown> }
export interface DecisionInputs { put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> }
export const PRICE_PER_MILLION_INPUT_TOKENS: Readonly<Record<string, number>>; // the three prices above
/** One adapter per decision or extraction effect in `system`, by effect name; other kinds are ignored. */
export function decisionAdapters(system: System, options: { ai: WorkersAI; inputs?: DecisionInputs }): Record<string, EffectAdapter>;

/** The value an adapter returns, and the runtime records (Task 3). */
export interface DecisionValue {
  model: string;                       // the full model id, e.g. "@cf/cloudflare/clef-flash"
  answers: Record<string, unknown>;    // the model's `answers`, verbatim
  truncated: boolean | null;           // Clairic's `truncated`; null for Clef, which doesn't report it
  inputDigest: string;                 // hex SHA-256 of the exact request body sent
  inputRef: string | null;             // "decisions/inputs/<inputDigest>.json" when `inputs` is given
  usage: { inputTokens: number; outputTokens: number } | null;
}
```

- [ ] **Step 1: Write failing tests** in `test/decisions.test.ts`, with a fake `ai` that records its calls and returns spike 7's recorded responses.
  - **The decision request body.** It is `{ model: "clef-flash", state, questions }`, with the short model name Clef's schema requires, and `questions` exactly as declared. The call goes to `"@cf/cloudflare/clef-flash"`.
  - **The extraction request body.** It is `{ model: "clairic", state, fields, reference_date }`. The `reference_date` comes from the input's `referenceDate`, and is omitted when absent.
  - **The value returned** has the `DecisionValue` shape. `inputDigest` is the SHA-256 of `JSON.stringify(body)`, where `body` is the exact object passed to `ai.run`.
  - **Usage.** `reportUsage` is called with `{ inputTokens: 335, outputTokens: 0, costUsd: 335 * 0.038 / 1e6 }` for spike 7's Clef-flash response.
  - **No usage.** For a response without `usage`, `reportUsage` isn't called, and `value.usage === null`.
  - **The input in R2.** With `inputs`, `put` is called once with `decisions/inputs/<digest>.json`, the body JSON, and `contentType: "application/json"`, before `ai.run`. Without `inputs`, `inputRef` is `null`.
  - **Rejections.** Each of these is an `EffectRejected` whose message names the question or field:
    - a missing answer for a declared question;
    - a `choice` answer whose `choice` isn't a declared option;
    - a `noul` answer outside 0–1;
    - a missing answer for a declared field.
  - **A throw** from `ai.run` propagates as itself, not as `EffectRejected`, so it is retried.
  - **Input without `state`.** It is rejected before any call.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run test/decisions.test.ts`. It fails with "Cannot find module".
- [ ] **Step 3: Implement** `decisionAdapters` in `src/decisions/index.ts`.
  - Map the full model id to Clef's or Clairic's `model` field, with `.split("/").pop()`.
  - Use `crypto.subtle.digest` for the digest.
  - Validate responses against the declared questions and fields only. Pass extra keys through untouched.
- [ ] **Step 4: Wire the subpath.** Add the `package.json` export and the `build.mjs` entry. Extend the bundle-isolation test.
- [ ] **Step 5: Run.** Run `npx vitest run`, `npm run typecheck -w @actord/toolkit`, `npm run build -w @actord/toolkit`, and `npx vitest run test/bundle-isolation.test.ts`. All pass.
- [ ] **Step 6: Commit.** Commit as `@actord/toolkit/decisions: Clef and Clairic adapters over the Workers AI binding`, with the dists separately.

### Task 3: Decision records, shadow mode and labels in the runtime

**Files:**
- Create: `packages/toolkit/src/runtime/decisions.ts`, for the table, the record writer and the label helpers. It is a small module, because `runtime/index.ts` is already large.
- Modify: `packages/toolkit/src/runtime/index.ts`:
  - `EventKind` (128–162): add `decision.recorded`, `decision.acted` and `decision.outcome`;
  - `HandlerContext` (282–321) and `handlerContext` (692–819): add `acted` and `outcome`;
  - `finishEffect` (1095): write the record;
  - `enqueueResult` (1371): never for a shadow decision;
  - `approve` and `deny` in `handlerContext`: refuse when the message being handled is a decision's or an extraction's result.
- Modify: `packages/toolkit/test-runtime/src/index.ts`: a probe actor with a decision (act), a shadow decision and an extraction, wired to `decisionAdapters` over a stub `ai`.
- Modify: `packages/toolkit/test-runtime/wrangler.jsonc`, only if a new binding is needed. The stub `ai` is a plain object, so none should be.
- Create: `packages/toolkit/test-runtime/decisions.test.ts`.

**Interfaces:**
- Consumes: Task 2's `DecisionValue`, and Task 1's manifest fields.
- Produces:

```ts
// HandlerContext gains (decisionId is `${effectName}:${key}`):
acted(decisionId: string, action: string): void;
outcome(decisionId: string, actual: Readonly<Record<string, string | number | boolean>>): void;

// Event details:
// decision.recorded: { decision, effect, key, kind: "decision" | "extraction", model, mode, inputDigest, inputRef, truncated, usage,
//                      answers: per question { type, choice?, noul?, score?, probabilities?, confidence? }   (decision)
//                               per field    { type, isNull: boolean, confidence?, p_null? }                 (extraction: no values in events) }
// decision.acted:    { decision, action }
// decision.outcome:  { decision, actual }
```

- **The table.** `_actors_decisions` holds:
  - `id TEXT PRIMARY KEY` (the decision id), `effect`, `key`, `kind`, `model` and `mode`;
  - `input_digest`, `input_ref`, `truncated`, `usage` and `answers` (JSON, values included);
  - `created_at`;
  - `action` and `acted_at`;
  - `outcome` (JSON) and `outcome_at`.
- **What a label must name.**
  - For a decision, `actual` maps each labelled question id to:
    - a declared option, for `choice`;
    - a boolean, for `noul`;
    - a level index, for `score`.
  - For an extraction, it maps each labelled field name to `true` (correct) or `false` (wrong).

- [ ] **Step 1: Write the failing runtime tests** in `test-runtime/decisions.test.ts`:
  - **`[decision-recorded]`.**
    - An act-mode decision's result message reaches the actor, carrying `value: DecisionValue`.
    - One `_actors_decisions` row exists with the answers, the digest and `mode: "act"`.
    - `decision.recorded` is emitted with the per-question summary.
  - **`[decision-shadow-silent]`.** A shadow decision is recorded with `mode: "shadow"`, and no result message is enqueued. Even with `result` forced onto the spec at runtime, bypassing the check, nothing is delivered.
  - **`[extraction-recorded]`.** The row holds the values. The event holds `isNull`, `confidence` and `p_null` per field, but no values.
  - **`[decision-labels]`.** `ctx.acted(id, "routed:ready")` and `ctx.outcome(id, { route: "needs_info" })` update the row and emit their events. Each of these throws, and the handler's delivery fails:
    - an unknown id;
    - an unknown question;
    - an option that isn't declared;
    - a `score` level out of range;
    - an extraction label that isn't a boolean.
  - **`[decision-cannot-approve]`.** In the handler of a decision's result message, `ctx.approve(...)` and `ctx.deny(...)` throw `a decision's result can't approve or deny (spec §9.3)`. The same calls work in other handlers.
  - **`[decision-retry]`.**
    - A stub `ai.run` that throws twice and then answers is delivered on attempt 3, and is recorded once.
    - A stub that returns a malformed response is rejected without retry, and nothing is recorded.
  - **`[decision-failed-not-recorded]`.** A failed or `in_doubt` decision writes no record and emits no `decision.recorded`.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --config vitest.runtime.config.ts test-runtime/decisions.test.ts` in `packages/toolkit`.
- [ ] **Step 3: Implement.**
  - **Creating the table.** It is created like the other `_actors_` tables.
  - **Writing the record.** `finishEffect` writes it, in the same transaction that settles the row, only for status `delivered` and kind `decision` or `extraction`.
  - **The approve and deny guard.** The handler's envelope type is in the set of result messages of decision and extraction effects. Compute that set once, from the system spec.
  - **No awaits.** None of this awaits I/O inside a handler (#80, #82).
- [ ] **Step 4: Run the whole runtime suite** with `npx vitest run --config vitest.runtime.config.ts`, three times. All pass.
- [ ] **Step 5: Commit.** Commit as `Decision records, shadow mode, and labels: ctx.acted and ctx.outcome`, with the dists separately.

### Task 4: The scorecard (`actord scorecard`)

**Files:**
- Create: `packages/toolkit/src/cli/commands/scorecard.ts`;
- Create: `packages/toolkit/src/model/scorecard.ts`, the pure computation over events;
- Modify: `packages/toolkit/src/cli/main.ts`. Add the command to the map (57) and the usage text (14).
- Create: `fixtures/events/decisions.ndjson`;
- Create: `packages/toolkit/test/scorecard.test.ts`.

**Interfaces:**
- Consumes: Task 3's event shapes, and `readEvents` / `parseEvents` from `src/model/events.ts`.
- Produces: `scorecard(events: LoggedEvent[], opts?: { effect?: string }): Scorecard`, and the CLI `actord scorecard [--effect <name>] [--json] [--file <path>]`.

```ts
interface Scorecard { effects: Array<{ effect: string; model: string; recorded: number; shadow: number; labelled: number; acted: number;
  questions: Array<
    | { id: string; type: "choice"; labelled: number; accuracy: number | null; brier: number | null;
        bins: Array<{ from: number; to: number; n: number; meanP: number; observed: number }>;
        wrongWhenChosen: Record<string, { chosen: number; wrong: number }> }
    | { id: string; type: "noul"; labelled: number; brier: number | null; bins: Array<{ from: number; to: number; n: number; meanP: number; observed: number }> }
    | { id: string; type: "score"; labelled: number; meanAbsError: number | null }
    | { id: string; type: "field"; labelled: number; correct: number | null; byConfidence: Array<{ from: number; to: number; n: number; correct: number }> }> }> }
```

- **What each statistic means:**
  - **Accuracy** is the share of labelled choices whose top choice equals the label.
  - **Brier, for a choice question,** is the mean over labelled decisions of Σ over options (p_option − [option = label])².
  - **Brier, for a noul question,** is the mean of (p − label)².
  - **Bins** split the top probability (choice) or `p` (noul) into [0, 0.5), [0.5, 0.7), [0.7, 0.9) and [0.9, 1].
  - **`wrongWhenChosen`** gives, per option, how often it was the top choice and the label differed. This is the spec's "how often 'safe' turned out wrong".
- **The rules for counting:**
  - The latest `decision.outcome` per decision wins.
  - Unlabelled decisions count in `recorded`, not in the statistics.
  - `null` means there were no labelled cases.

- [ ] **Step 1: Write the fixture and failing tests.**
  - **The fixture.** `fixtures/events/decisions.ndjson` holds four labelled Clef-flash triage decisions, with hand-computed probabilities, plus one shadow decision and one extraction with two fields labelled.
  - **The tests.** `test/scorecard.test.ts` asserts the exact values:
    - accuracy 0.75 (3 of 4);
    - the Brier score, computed by hand in a comment and given as a number to 4 places;
    - the bin counts;
    - `wrongWhenChosen.ready` = `{ chosen: 3, wrong: 1 }`;
    - a shadow count of 1;
    - field `correct` = 0.5.
  - **The CLI.** `actord scorecard --json --file fixtures/events/decisions.ndjson` returns the same object. Without `--json`, it prints one table per effect.
- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run test/scorecard.test.ts`.
- [ ] **Step 3: Implement** the computation, then the command, following `events()` in `cli/commands/events.ts`, which returns a `CommandResult`.
- [ ] **Step 4: Run.** Run `npx vitest run`, `npm run typecheck -w @actord/toolkit` and `npm run build -w @actord/toolkit`. All pass.
- [ ] **Step 5: Commit.** Commit as `actord scorecard: calibration for decision effects from the event log`, with the dists separately.

### Task 5: Decision 0020, documentation, and verification

**Files:**
- Create: `docs/decisions/0020-decisions-and-extractions.md`. It records:
  - corrections 1–5;
  - shadow mode, and the reason a shadow decision has no `result`;
  - the rule that a decision can't approve (§9.3), and its limit: a handler can still pass a decision's answer on in its own message, and the runtime can't trace that;
  - the content-addressed input;
  - the price table, and how to update it;
  - why the scorecard reads the local log.
- Modify:
  - `docs/wiki/Runtime.md`: a "Decisions and extractions" section, plus the guarantees-table rows;
  - `docs/wiki/Limitations.md`;
  - the spec §9: an *Amended* note pointing to 0020 and spike 7;
  - `docs/architecture.md`, `docs/progress.md` and `packages/toolkit/README.md`: the new subpath and the CLI command.

`Limitations.md` gets these entries:
- **Clairic is a preview, and guesses.** Spike 7 got a guess. Use `null_threshold`, and read `confidence` and `p_null`.
- **Clef truncates long `state` silently.** Clairic reports `truncated`.
- **Prices are a table in the code.** A price change needs a release, and a response without `usage` reports no cost.
- **The scorecard reads local logs only,** as `trace` does. Production ingestion is later.
- **The R2 inputs bucket holds every decision's full input.** It needs restricted access and a retention policy, as transcripts do.
- **A decision can't approve directly, but a handler can relay its answer.** That relay is not traced.

- [ ] **Step 1: Write the documents.**
- [ ] **Step 2: Verify from a clean clone.** Clone the final pushed commit into a fresh scratch directory, then run `npm ci`, `npm run build -w @actord/toolkit` and `npm run verify`.
  - Every gate passes. `g6.mod.typecheck` may be blocked locally; any other blocked gate needs a reason.
  - Copy back `verify-report.json`, `docs/verification-report.md` and the clean-checkout evidence.
- [ ] **Step 3: Commit.** Commit as `Verification for plan 4 (decisions and extractions): <N> pass, <F> fail, <B> blocked`.
