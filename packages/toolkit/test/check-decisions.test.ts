// The decision and extraction check rules, on in-memory declarations. fixtures/negative/<code> covers each
// error end to end through the shipped CLI; these pin the exact cases, and the warnings a fixture can't.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkProject } from "../src/model/check.ts";
import type { Project } from "../src/model/load.ts";
import { normalize } from "../src/model/manifest.ts";
import { defineSystem, type EffectSpec, type MessageSpec, message } from "../src/system.ts";

const Start = message({ version: 1, description: "Start", payload: z.object({}) });
const Answer = message({ version: 1, description: "The answer", payload: z.object({}) });

function codes(fx: EffectSpec, opts: { routeResult?: boolean } = {}) {
  const { routeResult = true } = opts;
  const system = defineSystem({
    name: "decisions",
    messages: { "go": Start, "answered": Answer } as Record<string, MessageSpec>,
    actors: { Judge: { binding: "JUDGE", kind: "deterministic", purpose: "Asks a model", justification: ["state"], effects: ["ask"] } },
    effects: { ask: fx },
    routes: [{ from: "@ingress", message: "go", to: "Judge" }, ...(routeResult ? [{ from: "Judge" as const, message: "answered", to: "Judge" as const }] : [])],
  });
  const project: Project = { root: "/nowhere", system, manifest: normalize(system), loadError: null, config: null, configFile: null, entryFile: null, entryExports: null, committedManifest: null, committedManifestRaw: null };
  return checkProject(project)
    .filter((d) => /^(DECISION|EXTRACTION)_/.test(d.code))
    .map((d) => `${d.severity}:${d.code}`);
}

const CLEF = "@cf/cloudflare/clef";
const FLASH = "@cf/cloudflare/clef-flash";
const CLAIRIC = "@cf/cloudflare/clairic";
const base = { description: "Ask", idempotency: "key", result: "answered" } as const;
const decision = (over: Partial<EffectSpec> = {}): EffectSpec => ({
  ...base,
  kind: "decision",
  model: CLEF,
  questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
  ...over,
});
const extraction = (over: Partial<EffectSpec> = {}): EffectSpec => ({
  ...base,
  kind: "extraction",
  model: CLAIRIC,
  fields: { total: { type: "number" } },
  ...over,
});
const q = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "Is it?" }]));
const options = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
const levels = (n: number) => Array.from({ length: n }, (_, i) => `level ${i}`);

const MODEL = ["error:DECISION_MODEL_UNKNOWN"];
const QUESTIONS = ["error:DECISION_QUESTIONS_INVALID"];
const FIELDS = ["error:EXTRACTION_FIELDS_INVALID"];
const MISPLACED = ["error:DECISION_FIELD_MISPLACED"];

describe("decision and extraction checks", () => {
  it("a valid system yields none of these codes", () => {
    const flash = decision({
      model: FLASH,
      questions: {
        kind: { type: "choice", instructions: "Which kind?", criteria: { bug: "A defect", feature: null } },
        urgent: { type: "noul", instructions: "Is it urgent?", criteria: { true: "yes" } },
        sev: { type: "score", instructions: "How severe?", criteria: levels(3) },
      },
    });
    expect(codes(flash)).toEqual([]);
    expect(codes(decision({ model: FLASH, mode: "shadow", result: undefined }))).toEqual([]);
    expect(codes(extraction())).toEqual([]);
    expect(codes(extraction({ fields: { when: { type: "date" }, items: { type: "list", items: "text" }, e: { type: "estimate", min: 0, max: 10 }, f: { type: "forecast", min: 0, max: 1, horizon: 64 } } }))).toEqual([]);
  });

  it("DECISION_MODEL_UNKNOWN: a decision needs a Clef id, an extraction Clairic", () => {
    expect(codes(decision({ model: "@cf/meta/llama" }))).toEqual(MODEL);
    expect(codes(decision({ model: undefined }))).toEqual(MODEL);
    expect(codes(decision({ model: CLAIRIC }))).toEqual(MODEL);
    expect(codes(extraction({ model: CLEF }))).toEqual(MODEL);
    expect(codes(extraction({ model: undefined }))).toEqual(MODEL);
  });

  it("DECISION_QUESTIONS_INVALID", () => {
    const noul = { type: "noul", instructions: "Is it?" } as const;
    expect(codes(decision({ questions: undefined }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: {} }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: q(64) }))).toEqual([]);
    expect(codes(decision({ questions: q(65) }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: { "bad id": noul } }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: { [`${"a".repeat(101)}`]: noul } }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: { x: { type: "rank", instructions: "?" } as never } }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: { x: { type: "noul", instructions: "" } } }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: { x: { type: "choice", instructions: "?", criteria: options(1) } } }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: { x: { type: "choice", instructions: "?", criteria: options(2) } } }))).toEqual([]);
    expect(codes(decision({ questions: { x: { type: "choice", instructions: "?", criteria: options(255) } } }))).toEqual([]);
    expect(codes(decision({ questions: { x: { type: "choice", instructions: "?", criteria: options(256) } } }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: { x: { type: "score", instructions: "?", criteria: levels(1) } } }))).toEqual(QUESTIONS);
    expect(codes(decision({ questions: { x: { type: "score", instructions: "?", criteria: levels(10) } } }))).toEqual([]);
    expect(codes(decision({ questions: { x: { type: "score", instructions: "?", criteria: levels(11) } } }))).toEqual(QUESTIONS);
  });

  it("EXTRACTION_FIELDS_INVALID", () => {
    expect(codes(extraction({ fields: undefined }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: {} }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { "1bad": { type: "text" } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "money" } as never } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "list" } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "list", items: "duration" as never } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "estimate", max: 5 } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "estimate", min: 5 } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "forecast", min: 0 } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "number", decimals: 6 } } }))).toEqual([]);
    expect(codes(extraction({ fields: { x: { type: "number", decimals: 7 } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "number", null_threshold: 0 } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "number", null_threshold: 1.5 } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "number", null_threshold: 1 } } }))).toEqual([]);
    expect(codes(extraction({ fields: { x: { type: "forecast", min: 0, max: 1, horizon: 65 } } }))).toEqual(FIELDS);
    expect(codes(extraction({ fields: { x: { type: "forecast", min: 0, max: 1, horizon: 0 } } }))).toEqual(FIELDS);
  });

  it("DECISION_SHADOW_RESULT: a shadow decision's answer is never delivered", () => {
    expect(codes(decision({ mode: "shadow" }))).toEqual(["error:DECISION_SHADOW_RESULT"]);
    expect(codes(decision({ mode: "shadow", result: undefined }))).toEqual([]);
  });

  it("DECISION_FIELD_MISPLACED", () => {
    const call: EffectSpec = { description: "Notify", idempotency: "key" };
    expect(codes({ ...call, questions: q(1) })).toEqual(MISPLACED);
    expect(codes({ ...call, mode: "shadow" })).toEqual(MISPLACED);
    expect(codes({ ...call, fields: { x: { type: "text" } } })).toEqual(MISPLACED);
    expect(codes({ ...call, model: CLEF })).toEqual(MISPLACED);
    expect(codes({ ...call, kind: "job", deadline: "1h", completes: { message: "answered" }, model: CLEF })).toEqual(MISPLACED);
    expect(codes(extraction({ questions: q(1) }))).toEqual(MISPLACED);
    expect(codes(extraction({ mode: "act" }))).toEqual(MISPLACED);
    expect(codes(decision({ fields: { x: { type: "text" } } }))).toEqual(MISPLACED);
    expect(codes(decision({ deadline: "1h" }))).toEqual(MISPLACED);
    expect(codes(decision({ probe: { every: "1m" } }))).toEqual(MISPLACED);
    expect(codes(extraction({ completes: { message: "answered" } }))).toEqual(MISPLACED);
  });

  it("DECISION_PUBLISHES: a decision or extraction is a pure read", () => {
    expect(codes(decision({ publishes: true }))).toContain("error:DECISION_PUBLISHES");
    expect(codes(extraction({ publishes: true }))).toContain("error:DECISION_PUBLISHES");
  });

  it("DECISION_RESULT_MISSING: an act decision or an extraction nobody hears from is a warning", () => {
    expect(codes(decision({ result: undefined }))).toEqual(["warning:DECISION_RESULT_MISSING"]);
    expect(codes(extraction({ result: undefined }))).toEqual(["warning:DECISION_RESULT_MISSING"]);
    expect(codes(decision({ mode: "shadow", result: undefined }))).toEqual([]);
  });

  it("DECISION_IDEMPOTENCY_NONE: they are deterministic reads, so key is always safe", () => {
    expect(codes(decision({ idempotency: "none" }))).toEqual(["warning:DECISION_IDEMPOTENCY_NONE"]);
    expect(codes(extraction({ idempotency: "none" }))).toEqual(["warning:DECISION_IDEMPOTENCY_NONE"]);
  });

  it("a call or job is never checked as a decision", () => {
    expect(codes({ description: "Notify", idempotency: "key" })).toEqual([]);
  });
});
