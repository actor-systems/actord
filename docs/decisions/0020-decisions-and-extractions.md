# 0020 — Decisions and extractions: Clef and Clairic calls are recorded effects, and shadow never steers

- **Date:** 2026-10-28 · **Gate:** plan 4 (decisions and extractions) · **Status:** accepted · **Reversibility:**
  moderate (two new effect kinds, `"decision"` and `"extraction"`, a new entry point, `@actord/toolkit/decisions`,
  and a new table, `_actors_decisions`; other effects are unchanged)

## Context
The factory triages issues and judges merge risk with Clef, and pulls facts out of issues and CI failures with Clairic
(spec §9 and §10). These are model calls, and the machinery never calls a model (charter), so they have to be effects.
The owner wants to learn how far to trust them. That needs a record of every answer, and a later label of what really
happened.

Spec §9 was written before the models' schemas were read. Spike 7 (`docs/evidence/spike-7-clef-clairic.md`) read them
with wrangler, and ran each request three times on Workers AI. Where §9 differs from the spike, this decision follows
the spike: plan 4's design corrections 1 to 5. Source paths below are relative to `packages/toolkit/`.

## Decisions
1. **Two effect kinds, through the outbox.** `kind: "decision"` puts typed questions to Clef (`@cf/cloudflare/clef`
   or `@cf/cloudflare/clef-flash`), which answers each with a probability for every allowed answer.
   `kind: "extraction"` asks Clairic (`@cf/cloudflare/clairic`, a preview) for typed values, each with a confidence.
   - Both are call effects: keyed, retried under the effect's budget, with usage, events and `trace` like any other.
   - The input, as `ctx.effect` takes it, is `{ state, referenceDate? }`. `referenceDate` is Clairic's
     `reference_date`, and only an extraction sends it.
   - The result message's payload is the usual `{ key, status, value | error, usage? }`. `value` is the adapter's
     `DecisionValue`: `{ model, answers, truncated, inputDigest, inputRef, usage }`, with `answers` the model's,
     verbatim.
2. **The models' own vocabulary (corrections 1 and 2).** The declaration passes Clef's and Clairic's published request
   shapes through, untranslated (spike 7's ruling).
   - **`questions`, not `question`.** A decision declares a map of question id to a `ClefQuestion`: `noul` (yes or
     no), `choice` (`criteria` maps each option to a description or `null`) or `score` (`criteria` lists the levels,
     lowest first). Each has its own `instructions`. The spec's `question: { route: [...] }` is gone.
   - **`fields`, not `schema`.** An extraction declares a map of field name to a `ClairicField`, in Clairic's types
     (`text`, `number`, `date`, `time`, `datetime`, `duration`, `list`, `estimate`, `forecast`) and options. The spec's
     `schema: IssueFacts` is gone: a Standard Schema can't say `null_threshold`, `decimals` or an estimate's range.
   - `mode` is a decision's only. `model` is required on both.
3. **The adapters.** `decisionAdapters(system, { ai, inputs? })`, from `@actord/toolkit/decisions`, returns one
   `EffectAdapter` per decision or extraction effect, by name, over the Workers AI binding (`ai.run`).
   - **Validation of questions.** Every declared question must be answered with its declared type: a `choice` with
     one of its options, a `noul` with a number from 0 to 1, a `score` with a number from 0 to its top level.
     - **Probabilities.** A `choice` or `score` needs `probabilities`: a non-empty map of finite numbers.
     - **Their keys.** A `choice`'s must include the chosen option, and a `score`'s every level (`"0"` to the top).
       Neither may name an option or level the question doesn't declare.
   - **Validation of fields.** Every declared field must be answered with its `type`, which must be the field's, and
     a `value` key whose value fits that type:
     - `number` and `duration`: a finite number;
     - `list`: an array;
     - `text`, `date`, `time` and `datetime`: a string;
     - `estimate`: a number, or a string when the field's `min` is a date string;
     - `forecast`: an array, one entry per step, of numbers, or of strings when the field's `min` is a date string. Its
       length isn't checked against `horizon`;
     - any type: `null`, which Clairic gives when the input doesn't determine the value.

     A rejection names the field and what kind of value it got, never the value, which may be personal data. The
     shapes are spike 7's: `text`, `number`, `list` and `date` from its first extraction, and `time`, `datetime`,
     `duration`, `estimate` and `forecast` from a call through the binding (R10). A forecast's value there was an array
     of 3 numbers for `horizon: 3`, with each step's detail in `steps`.
   - **A malformed response is rejected, never retried.** The error names the question or field. The models are
     deterministic (spike 7), so a retry would get the same answer. A throw from `ai.run` (the network, a `429`, a
     `5xx`) is retried under the effect's budget, which is safe because the call is keyed and only reads.
   - **Usage is reported before validation.** It is read as soon as the response is an object, before `answers` is
     looked for, so a rejected call's cost still counts.
   - **No peers.** The AI binding and the R2 bucket are typed structurally. The bundle-isolation test checks that
     `dist/decisions.mjs` imports neither `agents`, nor `@earendil-works/*`, nor `@cloudflare/computer`, nor `zod`, and
     that the runtime, system and sources bundles don't contain the adapters.
4. **Rejections carry a flag (R4).** The adapters throw their own `EffectRejected`, with `rejected = true`. The runtime
   recognizes a rejection by that flag, not by class identity (`src/runtime/index.ts:1239-1241`). Importing the
   runtime's class would pull a copy of the runtime, and the Agents SDK, into `decisions.mjs`. So code that checks
   `instanceof` the runtime's `EffectRejected` gets `false` for an adapter's rejection.
5. **The input is content-addressed (correction 5).**
   - `inputDigest` is the hex SHA-256 of the exact request body sent: `JSON.stringify` of `{ model, state, questions }`
     or `{ model, state, fields, reference_date? }`.
   - Given `inputs`, an R2 bucket, the adapter writes that body to `decisions/inputs/<inputDigest>.json` before each
     call (`src/decisions/index.ts:145-148`), and `inputRef` names it. Identical requests share one object, and the
     pointer doubles as the digest.
   - Without a bucket, `inputRef` is `null`, and the digest is still recorded.
   - Neither the record nor its events copy the input. The effect's outbox row keeps it, as every effect's row keeps
     its input.
6. **Prices are a table in the code.** `PRICE_PER_MILLION_INPUT_TOKENS` (`src/decisions/index.ts:12-16`) holds USD
   per million input tokens: Clef 0.24, Clef-flash 0.038, Clairic 0.10. These models have no output charge
   (spike 7).
   - **The cost** is `input_tokens` × price / 10⁶, reported as the effect's usage.
   - **No usage, no cost.** A response with no `usage`, or no finite `input_tokens`, reports no usage, and its record
     keeps `usage: null`. It is never reported as $0.
   - **Updating it.** Read the price on the model's Workers AI page, change the table and the test that pins it
     (`test/decisions.test.ts`, "prices the three models"), rebuild the plugin dists, whose toolkit tarball carries the
     table, and release. Until a release ships, apps keep the old price.
7. **Records (spec §9.2).** Every decision or extraction that settles `confirmed` is recorded in the actor's own
   SQLite, in `_actors_decisions`, in the same transaction that settles its effect, and `decision.recorded` is emitted.
   - **The row.** One per decision id, `<effect>:<key>`: its kind, model, mode, input digest and pointer, `truncated`,
     usage, the full `answers`, and later its labels.
   - **A decision id is unique per actor instance.** Effect keys are per instance, so two instances of one actor (per
     repository, say) can each record `decide.triage:77`. Each record is in its own instance's SQLite.
   - **`truncated`** is Clairic's flag. It is `null` for Clef, which truncates long `state` without saying so.
   - **The event** carries a summary. For a decision, it has each question's answer, probabilities and confidence. For
     an extraction, it has each field's confidence and `p_null`, and whether it is null. It never has an extracted
     value, since those may be personal data (`src/runtime/decisions.ts:12`).
   - **Clairic guesses (correction 3).** Spike 7's `reported_on` came back as the `reference_date` with confidence 0.97
     and `p_null` 0.32, though the issue never said when. So the record keeps `confidence` and `p_null` for every field,
     and a caller sets `null_threshold` where a guess is worse than nothing.
   - A failed or rejected call isn't recorded.
8. **Labels.** Both calls are synchronous and part of the handler's transaction. A label names a record in the
   labelling instance's own table, so it must be applied in the instance that recorded the decision.
   - **`ctx.acted(decisionId, action)`** records what the actor did, emitting `decision.acted`. A later call replaces
     the earlier action.
   - **`ctx.outcome(decisionId, actual)`** records what really was so, emitting `decision.outcome`. For a decision,
     it maps a question id to an option (`choice`), a boolean (`noul`) or a level index (`score`). For an extraction,
     it maps a field name to `true` (correct) or `false` (wrong).
   - **Labels merge (R6).** `ctx.outcome` merges with the earlier labels: a question labelled again takes the newer
     label. The event carries the merged set, so the latest event per decision matches the row.
   - **A bad label throws.** An unknown decision id, question, field, option or level, an empty outcome, or an empty
     action throws, so a labelling bug fails its handler instead of skewing the scorecard.
   - **Labels follow the current declaration.** `ctx.outcome` checks a label against the effect as declared now, not
     as it was when the record was made (`src/runtime/decisions.ts:157-167`).
     - Once the effect is removed, or is no longer the same kind, labelling any of its old records throws.
     - Once a question or field is removed, labelling it throws.
     - An option renamed since takes only its new name.
     - `ctx.acted` takes any non-empty string and checks no declaration.
9. **Shadow mode.** A decision declares `mode: "act"` (the default) or `"shadow"`. A shadow decision is recorded for
   the scorecard and never delivered. Three places enforce it:
   - **`actord check`** refuses a shadow decision with a `result` (`DECISION_SHADOW_RESULT`).
   - **The runtime** never queues a result for a shadow decision, whatever its spec says. It notes `shadow decision:
     its result <type> is never delivered` instead (`src/runtime/index.ts:1438-1442`).
   - **The outbox row (R5)** doesn't keep a shadow answer (`src/runtime/index.ts:1162-1163`). That row is what
     `requestEffect` and an agent's tools read, so `requestEffect` answers `confirmed` with no `value`, and an agent
     tool can't see the answer either.

   **Why a shadow decision has no `result`.** A result message is how an effect's answer reaches the actor's handlers.
   A shadow decision with one would hand its answer to code that can act on it, and spec §9.4's "cannot change the
   actor's path" would rest on every handler ignoring it. With no result, nothing delivers it. The answer is kept only
   in the record and its `decision.recorded` event, for the scorecard.

   - **An unknown `mode` fails safe.** At runtime, any `mode` other than `"act"` or none is shadow
     (`decisionMode`, `src/runtime/decisions.ts:44-46`). `actord check` refuses it (`DECISION_MODE_INVALID`), because
     a typo must not silently act. So the fallback matters only when the check is skipped.
   - **The guarantee is "never delivered".** A handler can still `SELECT` from `_actors_decisions` with `ctx.sql`, and
     nothing stops it. Handlers must not read that table to decide what to do.
   - **What "phase one ships shadow mode only" means (correction 4).** It means the graduation machinery (§9.4). The
     toolkit supports both modes. Triage acts (§10). The merge-risk decision runs in shadow. Per-lane graduation,
     switching a lane to `act` when its scorecard earns it, is factory code, later.
10. **A decision can't approve (spec §9.3).** In a handler of a message type that is the `result` of a decision or an
    extraction, `ctx.approve` and `ctx.deny` throw "a decision's result can't approve or deny (spec §9.3)"
    (`src/runtime/index.ts:541-545`, `795-807`).
    - **The guard goes by message type.** Such a type loses `ctx.approve` and `ctx.deny` in every handler of it, even
      if another effect shares it as its result, or another sender routes it. `actord check` warns of either
      (`DECISION_RESULT_SHARED`).
    - **`ActorRuntime.decide` is refused in a handler.** Called while a handler runs or is pending in its transaction,
      it throws at once, as `requestEffect` does (`src/runtime/index.ts:1670`). Otherwise a handler of a decision's
      result could approve by calling it, even without awaiting it, past the guard and outside its own transaction.
    - **An agent's own withdrawals pass.** An agent's `start` and `stop` deny the replaced or stopped session's parked
      approvals. That is the runtime withdrawing the session's own requests, not a decision deciding them, and an
      agent's `on` may start a session from a decision's result. So they take an internal path that skips the guard
      (`WITHDRAW_APPROVAL`, `src/runtime/index.ts:810`), and `ctx.deny` still throws there.
    - **The limit.** A handler can still pass a decision's answer on in a message of its own, and that message's
      handler can approve. The runtime can't follow the answer into the handler's own messages, so nothing refuses
      that approval. The event log's causation ids still link it back to the result message, which `actord trace`
      follows.
    - A decision or extraction can't be declared `publishes: true` (`DECISION_PUBLISHES`), and publishing stays
      human-gated as before.
11. **Check codes.** `actord check` reports, for a decision or an extraction:
    - **Errors:**
      - `DECISION_MODEL_UNKNOWN`: a decision whose `model` isn't a Clef id, or an extraction whose `model` isn't
        Clairic.
      - `DECISION_QUESTIONS_INVALID`: no `questions`, a list, fewer than 1 or more than 64, or a bad question (an id
        outside `^[A-Za-z0-9_.-]{1,100}$`, no `instructions`, an unknown type, a `choice` without 2 to 255 options, a
        `score` without 2 to 10 levels).
      - `EXTRACTION_FIELDS_INVALID`: no `fields`, a list, or a bad field (a name outside
        `^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$`, an unknown type, a `list` without `items`, an `estimate` or `forecast`
        without `min` and `max`, or `decimals`, `null_threshold` or `horizon` out of range).
      - `DECISION_MODE_INVALID`: a `mode` other than `"act"` or `"shadow"`. Task 1's review added it.
      - `DECISION_SHADOW_RESULT`: a shadow decision with a `result`.
      - `DECISION_FIELD_MISPLACED`: `fields` on a decision; `questions` or `mode` on an extraction; `deadline`, `probe`
        or `completes` on either; or `model`, `questions`, `fields` or `mode` on a call or job.
      - `DECISION_PUBLISHES`: either declared `publishes: true`.
    - **Warnings:**
      - `DECISION_RESULT_MISSING`: an act-mode decision, or an extraction, with no `result`, which the actor would
        never hear from. It doesn't fire when every actor that requests the effect lists it in its agent `tools`: a
        tool's answer is its return value.
      - `DECISION_RESULT_SHARED`: a decision's or an extraction's `result` type is also another effect's `result`, or is
        routed from any sender other than the receiver itself. Either turns off `ctx.approve` and `ctx.deny` in those
        handlers (decision 10). The final review added it (its Recommendation 4).
      - `DECISION_IDEMPOTENCY_NONE`: `idempotency: "none"` on a deterministic read, where a retry is always safe.
12. **Diff (R2).** A change of `model`, `questions` or `fields` is risky: answers already recorded were to the old
    declaration, and probabilities aren't comparable across models. `mode` going to `act` is risky, since the answer
    now steers the actor. `act` → `shadow` is compatible. There is no "behaviour" class, so a reworded question shows
    as risky.
13. **The manifest (R3).** `ManifestEffect` gains `model`, `questions`, `fields` and `mode`, verbatim, with `mode`
    `"act"` by default on a decision. They are `null` on other kinds, as `completes`, `deadline` and `probe` already
    are on a call. Every project regenerates its manifest once (`actord graph --write`), alongside plan 3's manifest
    changes, in the next release.
14. **The scorecard reads the local log.** `actord scorecard [--effect <name>] [--file <events.ndjson>]` computes
    calibration from `decision.recorded`, `decision.acted` and `decision.outcome` in `.actord/events.ndjson`, the same
    source `actord trace` reads.
    - **Why.** The event log is one of the toolkit's two sources of truth, and every view reads it rather than computing
      its own answer (`docs/architecture.md`). The events carry everything the statistics need, and no extracted value.
      Reading the log needs no credentials and never contacts Cloudflare. Production records live in each actor's
      `_actors_decisions`, and nothing reads them from outside yet: ingestion is later.
    - **Per effect.** Spike 7's Clef and Clef-flash agreed on the answer but not on the certainty (0.92 against
      0.71), so a threshold tuned on one model doesn't carry over. A card is per effect, and an effect names one model
      at a time.
    - **By instance.** A decision id is unique only within its actor instance (decision 7), and the log holds every
      instance's events. So a record and its labels are keyed by the event's `actor` (`<Actor>:<key>`) and the id. Two
      instances' decisions with the same key are two records, and a label counts only for its own instance's record.
    - **The counts:** recorded, shadow, labelled and acted, per effect. The first `decision.recorded` per instance and
      id counts; the latest `decision.outcome` holds its labels. Records are read before labels, so a label finds its
      record wherever it sits in the file.
    - **What it can't count.** It reports the log's unreadable lines (`unparseable`) and the labels with no
      `decision.recorded` for their instance and id in the log (`orphanLabels`), in `--json` and in the text. A lost
      line may have held a record, and an orphan label is left out of every statistic.
    - **`choice`:** accuracy (the top option against the label); the multi-class Brier score, the sum over options of
      (p − y)², with y 1 for the labelled option and 0 for the others, averaged over decisions; calibration bins over
      the top option's probability, with the share that was right; and `wrongWhenChosen`, how often each option was
      wrong when it was the top one. A `choice` answer without probabilities counts toward accuracy and
      `wrongWhenChosen` only, and is skipped by the Brier score and the bins. The adapter rejects such an answer, or
      one with empty probabilities, so it can't come from a real response.
    - **`noul`:** the Brier score, (p − y)² averaged, with y 1 for a `true` label and 0 for `false`; and bins over p,
      with the share labelled `true`.
    - **`score`:** the mean absolute error between the score and the labelled level.
    - **Fields:** the share labelled correct, and the correct count per confidence bin. A field answer without a
      confidence counts toward the share only.
    - **The bins** are [0, 0.5), [0.5, 0.7), [0.7, 0.9) and [0.9, 1]. Every mean is rounded to four places.

## Rejected alternatives
- **Our own vocabulary** (§9.1's `question: { route: [...] }` and `schema: IssueFacts`). It would lose
  `null_threshold`, the `score` rubrics and the option descriptions, and add a translation to get wrong.
- **Retrying a malformed response.** Spike 7's responses were byte-identical across runs, so a retry gets the same one.
- **Shadow as a runtime switch over a declared `result`.** Then the declaration would name a message that never comes.
  `actord check` makes the declaration say what happens.
- **Keeping the input in the record or in its events.** An input can be large and personal. The digest and the R2
  pointer identify it without copying it into the record or the log.
- **Keying the input object by effect and key.** Content addressing shares one object between identical requests.
- **Importing the runtime's `EffectRejected`** into the adapters. It would bring the Agents SDK into `decisions.mjs`.
- **A scorecard over production storage now.** It needs credentials and a way to reach every actor's records. The
  local log needs neither.

## Consequences
- **Clairic is a preview.** Its interface can change, and with the vocabulary passed through, declarations change with
  it.
- **The scorecard is per effect, not per model.** An effect whose `model` changed mixes both models' records in one
  card, under the first record's model. `actord diff` reports the change as risky. Declaring a new effect for a new
  model keeps the cards apart.
- **Old records are labelled against the new declaration** (decision 8). A change of an effect's questions can make
  its old records impossible to label.
- **Data stays.** The R2 inputs bucket holds every decision's full input. Extraction values stay in
  `_actors_decisions`, and an extraction's value also stays in its outbox rows. No retention or deletion path exists
  yet. Limitations has the details.
- **Prices change only with a release** (decision 6).
