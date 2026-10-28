// Adapters that run decision (Clef) and extraction (Clairic) effects on the Workers AI binding.
// Both models are deterministic, so a malformed response is rejected, not retried; a throw from `ai.run` propagates and is retried.
import type { EffectAdapter } from "../runtime/index.ts";
import type { ClairicField, ClefQuestion, EffectSpec, System } from "../system.ts";

/** The Workers AI binding (`env.AI`), as far as these adapters use it. */
export interface WorkersAI { run(model: string, body: unknown): Promise<unknown> }
/** An R2 bucket, as far as these adapters use it: where the exact request body is kept when given. */
export interface DecisionInputs { put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> }

/** USD per million input tokens, by full model id. There is no output charge. */
export const PRICE_PER_MILLION_INPUT_TOKENS: Readonly<Record<string, number>> = {
  "@cf/cloudflare/clef": 0.24,
  "@cf/cloudflare/clef-flash": 0.038,
  "@cf/cloudflare/clairic": 0.1,
};

/** The value an adapter returns, and the runtime records. */
export interface DecisionValue {
  /** The full model id, e.g. "@cf/cloudflare/clef-flash". */
  model: string;
  /** The model's `answers`, verbatim. */
  answers: Record<string, unknown>;
  /** Clairic's `truncated`; null for Clef, which doesn't report it. */
  truncated: boolean | null;
  /** Hex SHA-256 of the exact request body sent. */
  inputDigest: string;
  /** "decisions/inputs/<inputDigest>.json" when `inputs` is given. */
  inputRef: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/**
 * The runtime treats any error with `rejected === true` as a final rejection (it duck-types, as it does for
 * EffectRejected). This is a local class because importing the runtime's would pull the Agents SDK into this bundle.
 */
class EffectRejected extends Error {
  readonly rejected = true;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function sha256Hex(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validateAnswers(effect: string, answers: Record<string, unknown>, questions: Readonly<Record<string, ClefQuestion>> | undefined, fields: Readonly<Record<string, ClairicField>> | undefined): void {
  for (const [id, question] of Object.entries(questions ?? {})) {
    const answer = answers[id];
    if (!isRecord(answer)) throw new EffectRejected(`${effect}: the model gave no answer for question "${id}"`);
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice))
        throw new EffectRejected(`${effect}: question "${id}" answered ${JSON.stringify(answer.choice)}, which is not one of its options`);
    } else if (question.type === "noul") {
      if (typeof answer.noul !== "number" || !(answer.noul >= 0 && answer.noul <= 1))
        throw new EffectRejected(`${effect}: question "${id}" answered ${JSON.stringify(answer.noul)}, which is not a number from 0 to 1`);
    }
  }
  for (const id of Object.keys(fields ?? {}))
    if (!isRecord(answers[id])) throw new EffectRejected(`${effect}: the model gave no value for field "${id}"`);
}

function adapterFor(name: string, spec: EffectSpec, options: { ai: WorkersAI; inputs?: DecisionInputs }): EffectAdapter {
  const model = spec.model as string;
  const short = model.split("/").pop() as string;
  return {
    async run(input, ctx) {
      if (!isRecord(input) || input.state === undefined) throw new EffectRejected(`${name}: the input needs a "state" to decide or extract from`);
      const body: Record<string, unknown> =
        spec.kind === "extraction"
          ? { model: short, state: input.state, fields: spec.fields, ...(typeof input.referenceDate === "string" ? { reference_date: input.referenceDate } : {}) }
          : { model: short, state: input.state, questions: spec.questions };
      const text = JSON.stringify(body);
      const inputDigest = await sha256Hex(text);
      let inputRef: string | null = null;
      if (options.inputs) {
        inputRef = `decisions/inputs/${inputDigest}.json`;
        await options.inputs.put(inputRef, text, { httpMetadata: { contentType: "application/json" } });
      }
      const response = await options.ai.run(model, body);
      if (!isRecord(response) || !isRecord(response.answers)) throw new EffectRejected(`${name}: the model's response has no "answers"`);
      validateAnswers(name, response.answers, spec.questions, spec.fields);
      let usage: DecisionValue["usage"] = null;
      if (isRecord(response.usage) && typeof response.usage.input_tokens === "number") {
        usage = { inputTokens: response.usage.input_tokens, outputTokens: typeof response.usage.output_tokens === "number" ? response.usage.output_tokens : 0 };
        const price = PRICE_PER_MILLION_INPUT_TOKENS[model];
        ctx.reportUsage({ ...usage, ...(price === undefined ? {} : { costUsd: (usage.inputTokens * price) / 1e6 }) });
      }
      const value: DecisionValue = {
        model,
        answers: response.answers,
        truncated: typeof response.truncated === "boolean" ? response.truncated : null,
        inputDigest,
        inputRef,
        usage,
      };
      return value;
    },
  };
}

/** One adapter per decision or extraction effect in `system`, by effect name; other kinds are ignored. */
export function decisionAdapters(system: System, options: { ai: WorkersAI; inputs?: DecisionInputs }): Record<string, EffectAdapter> {
  const adapters: Record<string, EffectAdapter> = {};
  for (const [name, spec] of Object.entries(system.effects ?? {}))
    if ((spec.kind === "decision" || spec.kind === "extraction") && spec.model) adapters[name] = adapterFor(name, spec, options);
  return adapters;
}
