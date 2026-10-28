# Spike 7: Clef and Clairic on Workers AI

**Run:** 2026-10-28.
- **Schemas** came from `npx wrangler ai models schema @cf/cloudflare/<model>` (wrangler 4.152.0).
- **Live calls** were made with `cf ai run @cf/cloudflare/<model> --body @request.json` (cf 1.0.0-beta.20) from this machine, against the owner's account.
- **Coverage:** three runs of each request. Nothing was deployed.

## The interfaces (from the published schemas)

**Clef and Clef-flash** (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`), the "System One" decision API.

- **The request** is `{ model: "clef" | "clef-flash", state, questions, images? }`.
  - **`state`.** A string, or structured data (an object or an array).
  - **`questions`.** A map of question id to a question, with 1 to 64 questions per request.
    - Ids match `[A-Za-z0-9_.-]`, up to 100 characters.
  - **`noul`.** `{ type: "noul", instructions, criteria?: { true, false } }`, a yes or no question.
  - **`choice`.** `{ type: "choice", instructions, criteria: { <option>: description | null } }`, with 2 to 255 options.
  - **`score`.** `{ type: "score", instructions, criteria: [level, …] }`.
    - The levels are ordered lowest first, indexed from 0, 2 to 10 of them.
  - **Images.** Up to 4. They're out of scope here.
- **The response** is `{ model, answers, usage: { input_tokens, output_tokens } }`. One answer per question id:
  - **`noul`** is `{ type, noul }`, the probability of yes.
  - **`choice`** is `{ type, choice, probabilities: { <option>: p }, confidence }`.
    - `choice` is the highest-probability option, and the probabilities sum to 1.
  - **`score`** is `{ type, score, legend, probabilities, confidence }`.
    - `score` is probability-weighted and can land between levels.
  - **`confidence`** is "derived from the probabilities".
- **State that's too long.** Text state is truncated to fit the context window, and the response doesn't say so.
- **The context window** is 65,536 tokens for Clef, but 24,576 for Clef-flash on its model page. The launch post said 64K for both.

**Clairic** (`@cf/cloudflare/clairic`, preview), the extraction API.

- **The request** is `{ model: "clairic", state, fields, reference_date?, options?, images? }`.
  - **`fields`.** A map of field name (`^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$`) to a spec, with no upper limit on the count.
  - **The spec** has `type`, one of `text`, `number`, `date`, `time`, `datetime`, `duration`, `list`, `estimate` or `forecast`.
  - **Optional on a spec:** `instructions`, `unit`, `integer`, `decimals` (0–6), `items` (required for `list`: `text`, `number` or `date`), `min` and `max` (required for `estimate` and `forecast`), `step`, `scale`, `horizon` and `interval`.
  - **`null_threshold`.** The probability of null above which the value is null. The default is 0.5.
  - **Passes.** Fields that don't fit beside the state in one 8,192-token pass go to parallel passes.
- **The response** is `{ model, answers, truncated, state_text?, usage }`.
  - **`usage`** is `{ state_tokens, image_tokens, schema_tokens, input_tokens, output_tokens, passes }`.
  - **Each answer** has `{ type, value }`, plus, by type, `guess`, `confidence`, `p_null`, `span` or `spans`, and the estimate fields (`mean`, `median`, `p10`, `p90`, …).
  - **`value`** is null when the input doesn't determine it.

**Prices.** These models charge for input tokens only; there is no output charge.

| Model | Price |
| --- | --- |
| Clef | $0.24 per million input tokens |
| Clef-flash | $0.038 per million |
| Clef-omni | $0.15 per million |
| Clairic | $0.10 per million |

## The live calls

**The decision.** It is the factory's own triage question, asked about issue #77, as a JSON `state` holding `title`, `body` and `labels`. There are two questions:
- `route`, a choice of `ready`, `needs_info` or `not_for_factory`, each option described;
- `one_line`, a `noul` asking whether the issue is a one-liner with no acceptance criteria.

| | Clef-flash | Clef |
| --- | --- | --- |
| `route` | `ready`, p 0.71 (needs_info 0.12, not_for_factory 0.17), confidence 0.32 | `ready`, p 0.92 (0.03, 0.05), confidence 0.76 |
| `one_line` (p yes) | 0.11 | 0.10 |
| usage | 335 input tokens, 0 output | 335, 0 |
| cost per call | about $0.000013 | about $0.00008 |
| wall time, 3 runs (incl. the CLI's own start) | 776, 807, 1004 ms (2,385 ms on a cold first call) | 1358, 796, 598 ms |

**The extraction.** Clairic was given issue #77's text and `reference_date: "2026-10-28"`, and asked for six fields:
- `failing_check` and `commit` (text);
- `run_id` (an integer number);
- `files` and `done_when` (lists of text);
- `reported_on` (a date).

| Field | Value | Confidence | `p_null` |
| --- | --- | --- | --- |
| `failing_check` | `g7.clean-checkout` | 0.94 | 0.07 |
| `commit` | `5326650` | 0.98 | 0.07 |
| `run_id` | `40454645115` | 0.67 | 0.003 |
| `files` | `.github/workflows/verify.yml`, `scripts/clean-checkout.sh lines` | 0.008 | — |
| `done_when` | the three criteria, verbatim | 0.15 | — |
| `reported_on` | `2026-10-28` | 0.97 | 0.32 |

The usage was 897 input tokens (137 state, 486 schema) over 3 passes, about $0.00009 per call. Wall time was 852, 871 and 753 ms.

## What this changes

- **Determinism.** Every response was byte-identical across its three runs. A decision or an extraction is a pure function of its request here, so a retry, or a replay keyed by the same input, gives the same answer.
- **Clairic does guess.** The issue never says when the failure happened, yet `reported_on` came back as the `reference_date` I passed, with confidence 0.97 and `p_null` 0.32, under the default 0.5 threshold.
  - The design spec's "returns empty rather than guessing" is too strong.
  - A caller must read `confidence` and `p_null`, and set `null_threshold` per field where a guess is worse than nothing.
- **List confidence is low even when the list is right.** `done_when` was exact at 0.15. `files` included a fragment ("scripts/clean-checkout.sh lines") at 0.008. List confidence isn't comparable with scalar confidence.
- **Clef-flash and Clef disagree on certainty, not on the answer.** On the same question both chose `ready`, but at 0.71 and 0.92. A threshold tuned on one model doesn't carry over to the other, so the scorecard has to be per effect, which means per model.
- **Cost is negligible beside an agent session.** It is about $0.00001 to $0.0001 per call, against cents to dollars for a session. Usage reports `input_tokens`, and cost is the price table times that.
- **Silent truncation.** Clef truncates long `state` without saying so, and Clairic reports `truncated`. The decision record should keep Clairic's flag, and the input digest records exactly what was sent.

Ruling: the toolkit passes Clef's and Clairic's own request vocabulary through (`questions` with `noul`/`choice`/`score` and `criteria`; `fields` with Clairic's types and options) instead of inventing its own, because both are published schemas and translating them would lose options (`null_threshold`, `score` rubrics) and add a layer to get wrong — cost if wrong: declarations change shape if Cloudflare changes the System One API.
