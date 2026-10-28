import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineSystem } from "../src/system.ts";
import { PRICE_PER_MILLION_INPUT_TOKENS, decisionAdapters, type DecisionValue } from "../src/decisions/index.ts";

// The adapters' own rejection class: the runtime recognises any error with `rejected === true`.
const rejected = (e: unknown) => e instanceof Error && (e as { rejected?: unknown }).rejected === true;
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const clefResponse = fixture("clef-flash-response.json");
clefResponse.answers.clarity = { type: "score", score: 1.4, legend: ["murky", "ok", "clear"], probabilities: { "0": 0.1, "1": 0.5, "2": 0.4 }, confidence: 0.5 };
const clairicResponse = fixture("clairic-response.json");

const questions = {
  route: { type: "choice", instructions: "How should a software factory handle this issue?", criteria: { ready: "Clear", needs_info: "Missing", not_for_factory: "Human" } },
  one_line: { type: "noul", instructions: "Is the issue only one line?" },
  clarity: { type: "score", instructions: "How clear?", criteria: ["murky", "ok", "clear"] },
} as const;
const fields = {
  failing_check: { type: "text", instructions: "The verify check that failed" },
  run_id: { type: "number", integer: true },
} as const;

const system = defineSystem({
  name: "t",
  messages: {},
  actors: {},
  effects: {
    triage: { kind: "decision", model: "@cf/cloudflare/clef-flash", questions },
    parse: { kind: "extraction", model: "@cf/cloudflare/clairic", fields },
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
    expect(Object.keys(decisionAdapters(system, { ai: fakeAI({}).ai })).sort()).toEqual(["parse", "triage"]);
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
});
