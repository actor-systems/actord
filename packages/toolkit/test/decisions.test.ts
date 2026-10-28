import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineSystem } from "../src/system.ts";
import { PRICE_PER_MILLION_INPUT_TOKENS, decisionAdapters, type DecisionValue } from "../src/decisions/index.ts";

// The adapters' own rejection class: the runtime recognises any error with `rejected === true`.
const rejected = (e: unknown) => e instanceof Error && (e as { rejected?: unknown }).rejected === true;
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const clefResponse = fixture("clef-flash-response.json");
clefResponse.answers.clarity = { type: "score", score: 1.4, legend: { "0": "murky", "1": "ok", "2": "clear" }, probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 }, confidence: 0.5 };
const clairicResponse = fixture("clairic-response.json");
const scoreResponse = fixture("clef-flash-score-response.json");
// The questions of the live call that produced the score fixture.
const scoreQuestions = {
  risk: { type: "score", instructions: "How risky is merging this change?", criteria: ["No risk", "Low", "Medium", "High"] },
  area: { type: "choice", instructions: "Which area does it touch?", criteria: { ci: "CI and workflows", runtime: "Runtime code", docs: null } },
};

const questions = {
  route: { type: "choice", instructions: "How should a software factory handle this issue?", criteria: { ready: "Clear", needs_info: "Missing", not_for_factory: "Human" } },
  one_line: { type: "noul", instructions: "Is the issue only one line?" },
  clarity: { type: "score", instructions: "How clear?", criteria: ["murky", "ok", "clear"] },
} as const;
const fields = {
  failing_check: { type: "text", instructions: "The verify check that failed" },
  run_id: { type: "number", integer: true },
} as const;
// One field of every Clairic type, for the value checks. Spike 7's live call (clairic-response.json) answered text,
// number, list and date; the other types' answers are written in the published schema's { type, value } shape.
const typedFields = {
  failing_check: { type: "text" },
  run_id: { type: "number", integer: true },
  files: { type: "list", items: "text" },
  reported_on: { type: "date" },
  at_time: { type: "time" },
  at: { type: "datetime" },
  took: { type: "duration" },
  cost: { type: "estimate", min: 0, max: 1000 },
  ships_on: { type: "estimate", min: "2026-01-01", max: "2027-12-31" },
  load: { type: "forecast", min: 0, max: 100, horizon: 4 },
} as const;
const typedAnswers = {
  failing_check: clairicResponse.answers.failing_check,
  run_id: clairicResponse.answers.run_id,
  files: clairicResponse.answers.files,
  reported_on: clairicResponse.answers.reported_on,
  at_time: { type: "time", value: "14:05", confidence: 0.81, p_null: 0.12 },
  at: { type: "datetime", value: "2026-10-28T14:05:00Z", confidence: 0.77, p_null: 0.14 },
  took: { type: "duration", value: 5400, confidence: 0.66, p_null: 0.2 },
  cost: { type: "estimate", value: 120.5, mean: 130, median: 120.5, p10: 80, p90: 210, confidence: 0.4 },
  ships_on: { type: "estimate", value: "2026-12-01", confidence: 0.35 },
  load: { type: "forecast", value: 42, confidence: 0.3 },
};

const system = defineSystem({
  name: "t",
  messages: {},
  actors: {},
  effects: {
    triage: { kind: "decision", model: "@cf/cloudflare/clef-flash", questions },
    parse: { kind: "extraction", model: "@cf/cloudflare/clairic", fields },
    risk: { kind: "decision", model: "@cf/cloudflare/clef-flash", questions: scoreQuestions },
    typed: { kind: "extraction", model: "@cf/cloudflare/clairic", fields: typedFields },
    mail: { target: "mail" },
  },
  routes: [],
} as never);

function fakeAI(response: unknown) {
  const calls: Array<{ model: string; body: any }> = [];
  const log: string[] = [];
  return { calls, log, ai: { async run(model: string, body: unknown) { log.push("run"); calls.push({ model, body: body as any }); if (response instanceof Error) throw response; return response; } } };
}
const ctx = () => {
  const usage: unknown[] = [];
  return { usage, ctx: { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage: (u: unknown) => void usage.push(u) } };
};
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("decisionAdapters", () => {
  it("makes adapters only for decisions and extractions", () => {
    expect(Object.keys(decisionAdapters(system, { ai: fakeAI({}).ai })).sort()).toEqual(["parse", "risk", "triage", "typed"]);
  });

  it("prices the three models", () => {
    expect(PRICE_PER_MILLION_INPUT_TOKENS).toEqual({ "@cf/cloudflare/clef": 0.24, "@cf/cloudflare/clef-flash": 0.038, "@cf/cloudflare/clairic": 0.1 });
  });

  it("sends the decision body to the full model id with the short name inside", async () => {
    const f = fakeAI(clefResponse);
    const { ctx: c, usage } = ctx();
    const value = (await decisionAdapters(system, { ai: f.ai }).triage!.run({ state: { title: "x" } }, c)) as DecisionValue;
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.model).toBe("@cf/cloudflare/clef-flash");
    expect(f.calls[0]!.body).toEqual({ model: "clef-flash", state: { title: "x" }, questions });
    expect(value).toEqual({
      model: "@cf/cloudflare/clef-flash",
      answers: clefResponse.answers,
      truncated: null,
      inputDigest: await sha(JSON.stringify(f.calls[0]!.body)),
      inputRef: null,
      usage: { inputTokens: 335, outputTokens: 0 },
    });
    expect(usage).toEqual([{ inputTokens: 335, outputTokens: 0, costUsd: (335 * 0.038) / 1e6 }]);
  });

  it("sends the extraction body, with reference_date only when given", async () => {
    const f = fakeAI(clairicResponse);
    const adapter = decisionAdapters(system, { ai: f.ai }).parse!;
    const { ctx: c, usage } = ctx();
    const value = (await adapter.run({ state: "Issue 77", referenceDate: "2026-10-28" }, c)) as DecisionValue;
    expect(f.calls[0]!.model).toBe("@cf/cloudflare/clairic");
    expect(f.calls[0]!.body).toEqual({ model: "clairic", state: "Issue 77", fields, reference_date: "2026-10-28" });
    expect(value.truncated).toBe(false);
    expect(value.answers).toEqual(clairicResponse.answers);
    expect(value.usage).toEqual({ inputTokens: 897, outputTokens: 0 });
    expect(usage).toEqual([{ inputTokens: 897, outputTokens: 0, costUsd: (897 * 0.1) / 1e6 }]);
    await adapter.run({ state: "Issue 77" }, ctx().ctx);
    expect("reference_date" in f.calls[1]!.body).toBe(false);
  });

  it("reports no usage when the response has none", async () => {
    const { usage: _u, ...bare } = clefResponse;
    const f = fakeAI(bare);
    const { ctx: c, usage } = ctx();
    const value = (await decisionAdapters(system, { ai: f.ai }).triage!.run({ state: "s" }, c)) as DecisionValue;
    expect(usage).toEqual([]);
    expect(value.usage).toBeNull();
  });

  it("reports no usage when the response's usage has no input_tokens", async () => {
    for (const bad of [{ output_tokens: 0 }, { input_tokens: "335", output_tokens: 0 }, { input_tokens: Number.NaN }]) {
      const { ctx: c, usage } = ctx();
      const value = (await decisionAdapters(system, { ai: fakeAI({ ...clefResponse, usage: bad }).ai }).triage!.run({ state: "s" }, c)) as DecisionValue;
      expect(usage, JSON.stringify(bad)).toEqual([]);
      expect(value.usage, JSON.stringify(bad)).toBeNull();
    }
  });

  it("stores the exact input in R2 before calling the model", async () => {
    const f = fakeAI(clefResponse);
    const puts: unknown[][] = [];
    const inputs = { async put(...args: unknown[]) { f.log.push("put"); puts.push(args); return {}; } };
    const value = (await decisionAdapters(system, { ai: f.ai, inputs: inputs as never }).triage!.run({ state: "s" }, ctx().ctx)) as DecisionValue;
    const body = JSON.stringify(f.calls[0]!.body);
    const digest = await sha(body);
    expect(puts).toEqual([[`decisions/inputs/${digest}.json`, body, { httpMetadata: { contentType: "application/json" } }]]);
    expect(value.inputRef).toBe(`decisions/inputs/${digest}.json`);
    expect(f.log).toEqual(["put", "run"]);
  });

  it("rejects input without state before any call", async () => {
    const f = fakeAI(clefResponse);
    await expect(decisionAdapters(system, { ai: f.ai }).triage!.run({}, ctx().ctx)).rejects.toSatisfy(rejected);
    await expect(decisionAdapters(system, { ai: f.ai }).triage!.run(null, ctx().ctx)).rejects.toSatisfy(rejected);
    expect(f.calls).toHaveLength(0);
  });

  describe("rejects a malformed response, naming the question or field", () => {
    const run = (name: string, response: unknown) => decisionAdapters(system, { ai: fakeAI(response).ai })[name]!.run({ state: "s" }, ctx().ctx);
    const reject = async (p: Promise<unknown>, text: string) => {
      const error = await p.then(() => null, (e) => e);
      expect(rejected(error)).toBe(true);
      expect((error as Error).message).toContain(text);
    };
    it("a missing answer", () => reject(run("triage", { answers: { route: clefResponse.answers.route } }), "one_line"));
    it("a choice outside the options", () =>
      reject(run("triage", { answers: { ...clefResponse.answers, route: { type: "choice", choice: "bogus", probabilities: {} } } }), "route"));
    it("a noul outside 0 to 1", () => reject(run("triage", { answers: { ...clefResponse.answers, one_line: { type: "noul", noul: 1.5 } } }), "one_line"));
    it("a missing field", () => reject(run("parse", { answers: { failing_check: clairicResponse.answers.failing_check }, truncated: false }), "run_id"));
    it("a NaN noul", () => reject(run("triage", { answers: { ...clefResponse.answers, one_line: { type: "noul", noul: NaN } } }), "NaN"));
    it("a real score out of range", () => reject(run("risk", { ...scoreResponse, answers: { ...scoreResponse.answers, risk: { ...scoreResponse.answers.risk, score: 3.5 } } }), "risk"));
    it("a real score below 0", () => reject(run("risk", { ...scoreResponse, answers: { ...scoreResponse.answers, risk: { ...scoreResponse.answers.risk, score: -0.1 } } }), "risk"));
    it("a real score that is not a number", () => reject(run("risk", { ...scoreResponse, answers: { ...scoreResponse.answers, risk: { ...scoreResponse.answers.risk, score: "0.9" } } }), "risk"));
    it("a score out of range", () => reject(run("triage", { answers: { ...clefResponse.answers, clarity: { ...clefResponse.answers.clarity, score: 3 } } }), "clarity"));
    it("a score that is not a number", () => reject(run("triage", { answers: { ...clefResponse.answers, clarity: { type: "score" } } }), "clarity"));
    it("probabilities that are not numbers", () =>
      reject(run("triage", { answers: { ...clefResponse.answers, clarity: { ...clefResponse.answers.clarity, probabilities: { "0": "x" } } } }), "clarity"));
    it("an answer of the wrong type", () => reject(run("triage", { answers: { ...clefResponse.answers, one_line: { type: "choice", noul: 0.2 } } }), "one_line"));
    it("an empty answers", () => reject(run("triage", { answers: {} }), "route"));
    it("a field without a value key", () =>
      reject(run("parse", { answers: { ...clairicResponse.answers, run_id: { type: "number", guess: 1 } }, truncated: false }), "run_id"));
    it("a field of the wrong type", () =>
      reject(run("parse", { answers: { ...clairicResponse.answers, run_id: { type: "text", value: "1" } }, truncated: false }), "run_id"));
    it("a non-string referenceDate", () => reject(decisionAdapters(system, { ai: fakeAI(clairicResponse).ai }).parse!.run({ state: "s", referenceDate: 5 }, ctx().ctx), "referenceDate"));
    it("extraction input without state", () => reject(decisionAdapters(system, { ai: fakeAI(clairicResponse).ai }).parse!.run({}, ctx().ctx), "state"));
    it("no answers at all", () => reject(run("triage", {}), "answers"));

    // Probabilities: non-empty, the chosen option's (a choice) or every level's (a score), and only declared ones.
    const route = clefResponse.answers.route;
    const risk = scoreResponse.answers.risk;
    const withRoute = (probabilities: unknown) => run("triage", { ...clefResponse, answers: { ...clefResponse.answers, route: { ...route, probabilities } } });
    const withRisk = (probabilities: unknown) => run("risk", { ...scoreResponse, answers: { ...scoreResponse.answers, risk: { ...risk, probabilities } } });
    it("a choice with empty probabilities", () => reject(withRoute({}), 'question "route" has no probabilities'));
    it("a choice with no probabilities", () => reject(withRoute(undefined), 'question "route" has no probabilities'));
    it("a choice whose probabilities leave out its answer", () => reject(withRoute({ needs_info: 0.5, not_for_factory: 0.5 }), 'question "route"\'s probabilities leave out its answer, ready'));
    it("a choice whose probabilities name an undeclared option", () => reject(withRoute({ ...route.probabilities, maybe: 0 }), 'question "route"\'s probabilities name "maybe", which is not one of its options'));
    it("a choice whose probabilities name an Object.prototype key", () => reject(withRoute(JSON.parse('{"ready":0.9,"constructor":0.1}')), '"constructor", which is not one of its options'));
    it("a score with empty probabilities", () => reject(withRisk({}), 'question "risk" has no probabilities'));
    it("a score whose probabilities leave out a level", () => reject(withRisk({ "0": 0.2, "1": 0.7, "3": 0.1 }), 'question "risk"\'s probabilities leave out level 2'));
    it("a score whose probabilities name an undeclared level", () => reject(withRisk({ ...risk.probabilities, "4": 0 }), 'question "risk"\'s probabilities name "4", which is not one of its levels (0 to 3)'));

    // Field values, by Clairic type. An error names the field and the value's kind, never the value: it reaches the log.
    const typed = (name: string, answer: unknown) => run("typed", { ...clairicResponse, answers: { ...typedAnswers, [name]: answer } });
    for (const [name, value, kind] of [
      ["run_id", "40454645115", "a string"],
      ["run_id", Number.POSITIVE_INFINITY, "a number that isn't finite"],
      ["files", ".github/workflows/verify.yml", "a string"],
      ["failing_check", 7, "a number"],
      ["reported_on", 20261028, "a number"],
      ["at_time", ["14:05"], "a list"],
      ["at", { iso: "2026-10-28T14:05:00Z" }, "an object"],
      ["took", "90m", "a string"],
      ["cost", "120.5", "a string"],
      ["ships_on", 20261201, "a number"],
      ["load", [42, 43], "a list"],
      ["load", true, "a boolean"],
    ] as const)
      it(`${/^[aeiou]/.test((typedFields as Record<string, { type: string }>)[name]!.type) ? "an" : "a"} ${(typedFields as Record<string, { type: string }>)[name]!.type} field whose value is ${kind}`, async () => {
        const answer = { ...(typedAnswers as Record<string, object>)[name], value };
        await reject(typed(name, answer), `field "${name}" is ${/^[aeiou]/.test((typedFields as Record<string, { type: string }>)[name]!.type) ? "an" : "a"} ${(typedFields as Record<string, { type: string }>)[name]!.type} field, but its value is ${kind}`);
        const error = await typed(name, answer).then(() => null, (e: Error) => e.message);
        if (typeof value === "string") expect(error).not.toContain(value);
      });
    it("a field answer without a type", async () => {
      const { type: _t, ...untyped } = clairicResponse.answers.run_id;
      await reject(run("parse", { ...clairicResponse, answers: { ...clairicResponse.answers, run_id: untyped } }), 'field "run_id" is declared number but the answer\'s type is undefined');
    });
  });

  it("accepts every Clairic type's value, and null for any of them", async () => {
    const adapter = decisionAdapters(system, { ai: fakeAI({ ...clairicResponse, answers: typedAnswers }).ai }).typed!;
    expect(((await adapter.run({ state: "s" }, ctx().ctx)) as DecisionValue).answers).toEqual(typedAnswers);
    const nulls = Object.fromEntries(Object.entries(typedAnswers).map(([name, a]) => [name, { type: a.type, value: null, p_null: 0.93 }]));
    const parsed = (await decisionAdapters(system, { ai: fakeAI({ ...clairicResponse, answers: nulls }).ai }).typed!.run({ state: "s" }, ctx().ctx)) as DecisionValue;
    expect(parsed.answers).toEqual(nulls);
  });

  it("reports usage before looking for answers: a response with usage and no answers still costs", async () => {
    const { ctx: c, usage } = ctx();
    const error = await decisionAdapters(system, { ai: fakeAI({ model: "clef-flash", usage: { input_tokens: 335, output_tokens: 0 } }).ai }).triage!.run({ state: "s" }, c).then(() => null, (e) => e);
    expect(rejected(error)).toBe(true);
    expect((error as Error).message).toContain('has no "answers"');
    expect(usage).toEqual([{ inputTokens: 335, outputTokens: 0, costUsd: (335 * 0.038) / 1e6 }]);
  });

  it("lets a throw from ai.run propagate as itself", async () => {
    const boom = new Error("network");
    const error = await decisionAdapters(system, { ai: fakeAI(boom).ai }).triage!.run({ state: "s" }, ctx().ctx).then(() => null, (e) => e);
    expect(error).toBe(boom);
    expect(rejected(error)).toBe(false);
  });

  it("passes extra answers through and accepts a null field value", async () => {
    const answers = { ...clefResponse.answers, extra: { type: "noul", noul: 2 } };
    const value = (await decisionAdapters(system, { ai: fakeAI({ ...clefResponse, answers }).ai }).triage!.run({ state: "s" }, ctx().ctx)) as DecisionValue;
    expect(value.answers).toEqual(answers);
    const parsed = (await decisionAdapters(system, { ai: fakeAI({ answers: { ...clairicResponse.answers, run_id: { type: "number", value: null } } }).ai }).parse!.run({ state: "s" }, ctx().ctx)) as DecisionValue;
    expect((parsed.answers.run_id as { value: unknown }).value).toBeNull();
  });

  it("still reports the cost of a response it rejects", async () => {
    const { ctx: c, usage } = ctx();
    await decisionAdapters(system, { ai: fakeAI({ ...clefResponse, answers: {} }).ai }).triage!.run({ state: "s" }, c).catch(() => {});
    expect(usage).toEqual([{ inputTokens: 335, outputTokens: 0, costUsd: (335 * 0.038) / 1e6 }]);
  });

  it("throws at construction for a decision without a model", () => {
    const bad = { effects: { oops: { kind: "decision", questions } } } as never;
    expect(() => decisionAdapters(bad, { ai: fakeAI({}).ai })).toThrow(/oops/);
  });

  it("accepts a real Clef-flash score response", async () => {
    const value = (await decisionAdapters(system, { ai: fakeAI(scoreResponse).ai }).risk!.run({ state: "s" }, ctx().ctx)) as DecisionValue;
    expect(value.answers).toEqual(scoreResponse.answers);
    expect(value.usage).toEqual({ inputTokens: 263, outputTokens: 0 });
  });
});
