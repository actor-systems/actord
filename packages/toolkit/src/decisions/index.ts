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

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const article = (word: string) => (/^[aeiou]/.test(word) ? "an" : "a");
/** What kind of value `v` is, for an error that mustn't echo it: an extracted value may be personal data. */
const kindOf = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "number" && !Number.isFinite(v) ? "a number that isn't finite" : typeof v === "object" ? "an object" : `${article(typeof v)} ${typeof v}`;

/** Whether `value` is what Clairic gives for a field of this type. Null, "not determined", is every type's. */
function valueFits(field: ClairicField, value: unknown): boolean {
  if (value === null) return true;
  switch (field.type) {
    case "number":
    case "duration":
      return isFiniteNumber(value);
    case "list":
      return Array.isArray(value);
    case "estimate":
    case "forecast":
      // A range of dates (min given as a date string) estimates a date; any other range, a number.
      return typeof field.min === "string" ? typeof value === "string" : isFiniteNumber(value);
    default: // text, date, time, datetime
      return typeof value === "string";
  }
}

/**
 * A choice's or a score's probabilities: a non-empty map of finite numbers, over declared options or levels only,
 * with the chosen option's (a choice) or every level's (a score).
 */
function checkProbabilities(effect: string, id: string, question: ClefQuestion, answer: Record<string, unknown>): void {
  const p = answer.probabilities;
  if (!isRecord(p) || Object.keys(p).length === 0) throw new EffectRejected(`${effect}: question "${id}" has no probabilities`);
  if (!Object.values(p).every(isFiniteNumber)) throw new EffectRejected(`${effect}: question "${id}" has a probability that is not a finite number`);
  if (question.type === "choice") {
    for (const option of Object.keys(p))
      if (!Object.hasOwn(question.criteria, option)) throw new EffectRejected(`${effect}: question "${id}"'s probabilities name ${JSON.stringify(option)}, which is not one of its options`);
    if (!Object.hasOwn(p, answer.choice as string)) throw new EffectRejected(`${effect}: question "${id}"'s probabilities leave out its answer, ${String(answer.choice)}`);
  } else if (question.type === "score") {
    const top = question.criteria.length - 1;
    const levels = new Set(question.criteria.map((_, i) => String(i)));
    for (const level of Object.keys(p))
      if (!levels.has(level)) throw new EffectRejected(`${effect}: question "${id}"'s probabilities name ${JSON.stringify(level)}, which is not one of its levels (0 to ${top})`);
    for (const level of levels) if (!Object.hasOwn(p, level)) throw new EffectRejected(`${effect}: question "${id}"'s probabilities leave out level ${level}`);
  }
}

function validateAnswers(effect: string, answers: Record<string, unknown>, questions: Readonly<Record<string, ClefQuestion>> | undefined, fields: Readonly<Record<string, ClairicField>> | undefined): void {
  for (const [id, question] of Object.entries(questions ?? {})) {
    const answer = answers[id];
    if (!isRecord(answer)) throw new EffectRejected(`${effect}: the model gave no answer for question "${id}"`);
    if (answer.type !== question.type)
      throw new EffectRejected(`${effect}: question "${id}" is a ${question.type} question but the answer's type is ${String(answer.type)}`);
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice))
        throw new EffectRejected(`${effect}: question "${id}" answered ${String(answer.choice)}, which is not one of its options`);
    } else if (question.type === "noul") {
      if (!isFiniteNumber(answer.noul) || answer.noul < 0 || answer.noul > 1)
        throw new EffectRejected(`${effect}: question "${id}" answered ${String(answer.noul)}, which is not a number from 0 to 1`);
    } else if (!isFiniteNumber(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1)
      throw new EffectRejected(`${effect}: question "${id}" scored ${String(answer.score)}, which is not a number from 0 to ${question.criteria.length - 1}`);
    if (question.type !== "noul") checkProbabilities(effect, id, question, answer);
  }
  for (const [id, field] of Object.entries(fields ?? {})) {
    const answer = answers[id];
    if (!isRecord(answer)) throw new EffectRejected(`${effect}: the model gave no value for field "${id}"`);
    if (!("value" in answer)) throw new EffectRejected(`${effect}: field "${id}" has no "value" key`);
    if (answer.type !== field.type)
      throw new EffectRejected(`${effect}: field "${id}" is declared ${field.type} but the answer's type is ${String(answer.type)}`);
    if (!valueFits(field, answer.value))
      throw new EffectRejected(`${effect}: field "${id}" is ${article(field.type)} ${field.type} field, but its value is ${kindOf(answer.value)}`);
  }
}

function adapterFor(name: string, spec: EffectSpec, options: { ai: WorkersAI; inputs?: DecisionInputs }): EffectAdapter {
  const model = spec.model as string;
  const short = model.split("/").pop() as string;
  return {
    async run(input, ctx) {
      if (!isRecord(input) || input.state === undefined) throw new EffectRejected(`${name}: the input needs a "state" to decide or extract from`);
      if (input.referenceDate !== undefined && typeof input.referenceDate !== "string") throw new EffectRejected(`${name}: referenceDate must be a string`);
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
      if (!isRecord(response)) throw new EffectRejected(`${name}: the model's response has no "answers"`);
      // The call is paid for whether or not the answers are usable, so usage is reported before anything is checked.
      let usage: DecisionValue["usage"] = null;
      if (isRecord(response.usage) && isFiniteNumber(response.usage.input_tokens)) {
        usage = { inputTokens: response.usage.input_tokens, outputTokens: isFiniteNumber(response.usage.output_tokens) ? response.usage.output_tokens : 0 };
        const price = PRICE_PER_MILLION_INPUT_TOKENS[model];
        ctx.reportUsage({ ...usage, ...(price === undefined ? {} : { costUsd: (usage.inputTokens * price) / 1e6 }) });
      }
      if (!isRecord(response.answers)) throw new EffectRejected(`${name}: the model's response has no "answers"`);
      validateAnswers(name, response.answers, spec.questions, spec.fields);
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
    if (spec.kind === "decision" || spec.kind === "extraction") {
      if (!spec.model) throw new Error(`effect "${name}" is a ${spec.kind} without a model`);
      adapters[name] = adapterFor(name, spec, options);
    }
  return adapters;
}
