// Decision and extraction effects in the runtime: records, shadow mode, labels, and the approval guard (plan 4, Task 3).
// The probe's decide.route, decide.shadow and extract.facts run on decisionAdapters over a stub Workers AI that each
// test scripts (globalThis.__probeAi, test-runtime/src/index.ts).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { type ActorEvent, ingress } from "../src/runtime/index.ts";
import { captureEvents, overrideEffect, overrideEffectBudget, resetSeams, settle } from "../src/testing.ts";
import { system } from "./src/index.ts";

const ai = globalThis as { __probeAi?: (model: string, body: unknown) => unknown };
afterEach(() => {
  resetSeams();
  delete ai.__probeAi;
});

const probe = (key: string) => env.PROBE.getByName(key);
const STATE = "Issue #77: CI doesn't upload the clean clone's reports, so a failure inside it can't name its test.";
const decide = (instance: string, effect: "decide.route" | "decide.shadow" | "extract.facts", key = instance) => ingress(env, system, "Probe", "probe.decide", { effect, key, state: STATE }, { key: instance });
const label = (instance: string, payload: { decision: string; action?: string; actual?: Record<string, string | number | boolean> }) => ingress(env, system, "Probe", "probe.label", payload, { key: instance });

type DecisionRow = {
  id: string;
  effect: string;
  key: string;
  kind: string;
  model: string;
  mode: string;
  input_digest: string;
  input_ref: string | null;
  truncated: number | null;
  usage: string | null;
  answers: string;
  created_at: number;
  action: string | null;
  acted_at: number | null;
  outcome: string | null;
  outcome_at: number | null;
};
const records = (instance: string) => runInDurableObject(probe(instance), (_i, s) => s.storage.sql.exec<DecisionRow>("SELECT * FROM _actors_decisions ORDER BY id").toArray());
const messageRows = (instance: string) => runInDurableObject(probe(instance), (_i, s) => s.storage.sql.exec<{ id: string; body: string }>("SELECT id, body FROM _actors_outbox WHERE kind = 'message'").toArray());
const of = (events: ActorEvent[], kind: string, effectKey?: string) => events.filter((e) => e.kind === kind && (effectKey === undefined || e.effectKey === effectKey));

// Clef-flash's answers (spike 7): route and one_line from clef-req.resp1.json, risk from score-resp.json.
const CLEF_ANSWERS = {
  route: { type: "choice", choice: "ready", probabilities: { ready: 0.7106, needs_info: 0.1192, not_for_factory: 0.1702 }, confidence: 0.3222 },
  one_line: { type: "noul", noul: 0.1129 },
  risk: { type: "score", score: 0.9138, legend: { "0": "No risk", "1": "Low", "2": "Medium", "3": "High" }, probabilities: { "0": 0.1842, "1": 0.7414, "2": 0.0507, "3": 0.0237 }, confidence: 0.4491 },
};
const CLEF = { model: "clef-flash", answers: CLEF_ANSWERS, usage: { input_tokens: 335, output_tokens: 0 } };
// Clairic's answers (spike 7, clairic-req.resp1.json). Spike 7 had no null field, so owner is made up in the shape
// Clairic gives one: value null with its p_null.
const CLAIRIC_ANSWERS = {
  failing_check: { type: "text", p_null: 0.06727045774459839, span: [142, 159], guess: "g7.clean-checkout", confidence: 0.943854808807373, value: "g7.clean-checkout" },
  commit: { type: "text", p_null: 0.06689061969518661, span: [127, 134], guess: "5326650", confidence: 0.9810506701469421, value: "5326650" },
  run_id: { type: "number", p_null: 0.002508664969354868, span: [221, 232], source: "input", guess: 40454645115, confidence: 0.6706129004798811, value: 40454645115 },
  files: { type: "list", value: [".github/workflows/verify.yml", "scripts/clean-checkout.sh lines"], spans: [[368, 396], [410, 441]], confidence: 0.00803403754768601 },
  done_when: { type: "list", value: ["the ruling is recorded", "a CI run's artifact contains both clean-checkout reports", "npm run verify passes"], spans: [[256, 278], [280, 336], [338, 359]], confidence: 0.15239261651716898 },
  reported_on: { type: "date", p_null: 0.3158010244369507, guess: "2026-10-28", confidence: 0.9663599268199503, value: "2026-10-28" },
  owner: { type: "text", p_null: 0.9712, value: null },
};
const CLAIRIC = { model: "clairic", answers: CLAIRIC_ANSWERS, truncated: false, usage: { state_tokens: 137, image_tokens: 0, schema_tokens: 486, input_tokens: 897, output_tokens: 0, passes: 3 } };
/** The per-question summary decision.recorded carries for CLEF_ANSWERS: no legend. */
const CLEF_SUMMARY = {
  route: { type: "choice", choice: "ready", probabilities: CLEF_ANSWERS.route.probabilities, confidence: 0.3222 },
  one_line: { type: "noul", noul: 0.1129 },
  risk: { type: "score", score: 0.9138, probabilities: CLEF_ANSWERS.risk.probabilities, confidence: 0.4491 },
};
const DIGEST = expect.stringMatching(/^[0-9a-f]{64}$/);

it("[decision-recorded] an act-mode decision's answer reaches the actor as a DecisionValue, is recorded once, and decision.recorded carries the per-question summary", async () => {
  const events = captureEvents();
  const models: string[] = [];
  ai.__probeAi = (model) => {
    models.push(model);
    return CLEF;
  };
  expect(await decide("rec-1", "decide.route")).toMatchObject({ status: "handled" });
  await settle(env, system);
  expect(models).toEqual(["@cf/cloudflare/clef-flash"]);
  const value = { model: "@cf/cloudflare/clef-flash", answers: CLEF_ANSWERS, truncated: null, inputDigest: DIGEST, inputRef: null, usage: { inputTokens: 335, outputTokens: 0 } };
  const answers = await probe("rec-1").answers();
  expect(answers).toEqual([{ message: "probe.decided", key: "rec-1", status: "confirmed", value, error: null, tried: {} }]);
  const digest = (answers[0]!.value as { inputDigest: string }).inputDigest;

  const [row, ...more] = await records("rec-1");
  expect(more).toEqual([]);
  expect(row).toMatchObject({ id: "decide.route:rec-1", effect: "decide.route", key: "rec-1", kind: "decision", model: "@cf/cloudflare/clef-flash", mode: "act", input_digest: digest, input_ref: null, truncated: null, action: null, acted_at: null, outcome: null, outcome_at: null });
  expect(JSON.parse(row!.answers)).toEqual(CLEF_ANSWERS);
  expect(JSON.parse(row!.usage!)).toEqual({ inputTokens: 335, outputTokens: 0 });
  expect(row!.created_at).toBeTypeOf("number");

  expect(of(events, "decision.recorded")).toEqual([
    expect.objectContaining({
      actor: "Probe:rec-1",
      effect: "decide.route",
      effectKey: "rec-1",
      detail: { decision: "decide.route:rec-1", effect: "decide.route", key: "rec-1", kind: "decision", model: "@cf/cloudflare/clef-flash", mode: "act", inputDigest: digest, inputRef: null, truncated: null, usage: { inputTokens: 335, outputTokens: 0 }, answers: CLEF_SUMMARY },
    }),
  ]);
  // Recorded as the effect settles, before its result is sent.
  const kinds = events.filter((e) => e.effectKey === "rec-1").map((e) => e.kind);
  expect(kinds.indexOf("effect.confirmed")).toBeLessThan(kinds.indexOf("decision.recorded"));
  expect(kinds.indexOf("decision.recorded")).toBeLessThan(kinds.indexOf("sent"));
});

it("[decision-shadow-silent] a shadow decision is recorded with mode shadow and nothing is delivered, even with a result forced onto its spec", async () => {
  const events = captureEvents();
  ai.__probeAi = () => ({ ...CLEF, answers: { route: CLEF_ANSWERS.route } });
  // "forced-…" instances run the system with result: "probe.decided" forced onto decide.shadow, past actord check.
  for (const instance of ["sh-1", "forced-sh-1"]) {
    expect(await decide(instance, "decide.shadow")).toMatchObject({ status: "handled" });
    await settle(env, system);
    expect(await messageRows(instance)).toEqual([]);
    expect(await probe(instance).answers()).toEqual([]);
    const rows = await records(instance);
    expect(rows).toMatchObject([{ id: `decide.shadow:${instance}`, kind: "decision", mode: "shadow", input_digest: DIGEST }]);
    expect(JSON.parse(rows[0]!.answers)).toEqual({ route: CLEF_ANSWERS.route });
    expect(of(events, "decision.recorded", instance)).toMatchObject([{ detail: { decision: `decide.shadow:${instance}`, mode: "shadow", answers: { route: CLEF_SUMMARY.route } } }]);
    expect(of(events, "sent", instance)).toEqual([]);
  }
  // The effect's row doesn't keep the answer (only its record does), so nothing that reads the row hears it:
  // requestEffect, as an agent's tool calls it, learns the decision settled, and nothing more.
  for (const instance of ["sh-1", "forced-sh-1"]) {
    const [fx] = await runInDurableObject(probe(instance), (_i, s) => s.storage.sql.exec<{ status: string; body: string }>("SELECT status, body FROM _actors_outbox WHERE id = ?", `fx:decide.shadow:${instance}`).toArray());
    expect(fx!.status).toBe("confirmed");
    expect(JSON.parse(fx!.body)).not.toHaveProperty("outcome");
  }
  type Requester = { actor: { requestEffect(n: string, i: unknown, o: { key: string }): Promise<{ status: string; outcome?: Promise<Record<string, unknown>> } & Record<string, unknown>> } };
  const asked = await runInDurableObject(probe("sh-1"), async (instance: Requester) => {
    const state = await instance.actor.requestEffect("decide.shadow", { state: STATE }, { key: "sh-asked" });
    return state.outcome ? await state.outcome : state;
  });
  expect(asked).toMatchObject({ status: "confirmed", key: "sh-asked" });
  expect(asked).not.toHaveProperty("value", expect.anything());
  expect((await records("sh-1")).map((r) => r.id)).toEqual(["decide.shadow:sh-1", "decide.shadow:sh-asked"]);
  // A shadow decision that fails sends nothing either, forced result or not.
  ai.__probeAi = () => ({ model: "clef-flash", answers: {} });
  for (const instance of ["sh-2", "forced-sh-2"]) {
    await decide(instance, "decide.shadow");
    await settle(env, system);
    expect(of(events, "effect.failed", instance)).toHaveLength(1);
    expect(await messageRows(instance)).toEqual([]);
    expect(await probe(instance).answers()).toEqual([]);
    expect(await records(instance)).toEqual([]);
  }
});

it("[extraction-recorded] an extraction's record keeps the values; decision.recorded carries isNull, confidence and p_null per field, never a value", async () => {
  const events = captureEvents();
  ai.__probeAi = () => CLAIRIC;
  await decide("ex-1", "extract.facts");
  await settle(env, system);
  expect(await probe("ex-1").answers()).toEqual([
    { message: "probe.extracted", key: "ex-1", status: "confirmed", value: { model: "@cf/cloudflare/clairic", answers: CLAIRIC_ANSWERS, truncated: false, inputDigest: DIGEST, inputRef: null, usage: { inputTokens: 897, outputTokens: 0 } }, error: null, tried: {} },
  ]);
  const [row, ...more] = await records("ex-1");
  expect(more).toEqual([]);
  expect(row).toMatchObject({ id: "extract.facts:ex-1", effect: "extract.facts", key: "ex-1", kind: "extraction", model: "@cf/cloudflare/clairic", mode: "act", input_digest: DIGEST, truncated: 0 });
  expect(JSON.parse(row!.answers)).toEqual(CLAIRIC_ANSWERS);
  expect(JSON.parse(row!.usage!)).toEqual({ inputTokens: 897, outputTokens: 0 });

  const recorded = of(events, "decision.recorded", "ex-1");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]!.detail).toEqual({
    decision: "extract.facts:ex-1",
    effect: "extract.facts",
    key: "ex-1",
    kind: "extraction",
    model: "@cf/cloudflare/clairic",
    mode: "act",
    inputDigest: row!.input_digest,
    inputRef: null,
    truncated: false,
    usage: { inputTokens: 897, outputTokens: 0 },
    answers: {
      failing_check: { type: "text", isNull: false, confidence: 0.943854808807373, p_null: 0.06727045774459839 },
      commit: { type: "text", isNull: false, confidence: 0.9810506701469421, p_null: 0.06689061969518661 },
      run_id: { type: "number", isNull: false, confidence: 0.6706129004798811, p_null: 0.002508664969354868 },
      files: { type: "list", isNull: false, confidence: 0.00803403754768601 },
      done_when: { type: "list", isNull: false, confidence: 0.15239261651716898 },
      reported_on: { type: "date", isNull: false, confidence: 0.9663599268199503, p_null: 0.3158010244369507 },
      owner: { type: "text", isNull: true, p_null: 0.9712 },
    },
  });
  // No extracted value, guess or span reaches any event.
  const logged = JSON.stringify(events);
  for (const v of ["g7.clean-checkout", "5326650", "40454645115", "verify.yml", "the ruling is recorded", "2026-10-28", "span"]) expect(logged, v).not.toContain(v);
});

it("[decision-labels] ctx.acted and ctx.outcome label a record and emit their events; a label naming an unknown id, question, field, option or level throws and fails the delivery", async () => {
  ai.__probeAi = (_model, body) => ((body as { fields?: unknown }).fields ? CLAIRIC : CLEF);
  await decide("lab-1", "decide.route");
  await decide("lab-1", "extract.facts");
  await settle(env, system);
  const events = captureEvents();
  const row = async (id: string) => (await records("lab-1")).find((r) => r.id === id)!;

  expect(await label("lab-1", { decision: "decide.route:lab-1", action: "routed:ready" })).toMatchObject({ status: "handled" });
  expect(await label("lab-1", { decision: "decide.route:lab-1", actual: { route: "needs_info" } })).toMatchObject({ status: "handled" });
  // A later label adds to the outcome, and a question labelled again takes the newer label.
  expect(await label("lab-1", { decision: "decide.route:lab-1", actual: { one_line: false, risk: 3 } })).toMatchObject({ status: "handled" });
  expect(await label("lab-1", { decision: "decide.route:lab-1", actual: { risk: 0 } })).toMatchObject({ status: "handled" });
  expect(await label("lab-1", { decision: "extract.facts:lab-1", action: "filed", actual: { commit: true, run_id: false } })).toMatchObject({ status: "handled" });

  const decision = await row("decide.route:lab-1");
  expect(decision).toMatchObject({ action: "routed:ready", acted_at: expect.any(Number), outcome_at: expect.any(Number) });
  expect(JSON.parse(decision.outcome!)).toEqual({ route: "needs_info", one_line: false, risk: 0 });
  const extraction = await row("extract.facts:lab-1");
  expect(extraction).toMatchObject({ action: "filed", acted_at: expect.any(Number) });
  expect(JSON.parse(extraction.outcome!)).toEqual({ commit: true, run_id: false });

  expect(of(events, "decision.acted")).toEqual([
    expect.objectContaining({ actor: "Probe:lab-1", effect: "decide.route", effectKey: "lab-1", detail: { decision: "decide.route:lab-1", action: "routed:ready" } }),
    expect.objectContaining({ actor: "Probe:lab-1", effect: "extract.facts", effectKey: "lab-1", detail: { decision: "extract.facts:lab-1", action: "filed" } }),
  ]);
  expect(of(events, "decision.outcome").map((e) => e.detail)).toEqual([
    { decision: "decide.route:lab-1", actual: { route: "needs_info" } },
    { decision: "decide.route:lab-1", actual: { one_line: false, risk: 3 } },
    { decision: "decide.route:lab-1", actual: { risk: 0 } },
    { decision: "extract.facts:lab-1", actual: { commit: true, run_id: false } },
  ]);

  const before = await records("lab-1");
  const bad: Array<[{ decision: string; action?: string; actual?: Record<string, string | number | boolean> }, RegExp]> = [
    [{ decision: "decide.route:nope", action: "routed:ready" }, /no decision or extraction is recorded as "decide\.route:nope"/],
    [{ decision: "decide.route:nope", actual: { route: "ready" } }, /no decision or extraction is recorded as "decide\.route:nope"/],
    [{ decision: "lab-1", actual: { route: "ready" } }, /no decision or extraction is recorded as "lab-1"/],
    [{ decision: "decide.route:lab-1", action: "" }, /decide\.route:lab-1: an action must be a non-empty string/],
    [{ decision: "decide.route:lab-1", actual: { nope: "ready" } }, /decide\.route:lab-1: "nope" is not a question of decide\.route \(route, one_line, risk\)/],
    // Valid labels before the bad one don't land either: the handler's writes roll back.
    [{ decision: "decide.route:lab-1", actual: { route: "ready", nope: "ready" } }, /"nope" is not a question of decide\.route/],
    [{ decision: "decide.route:lab-1", actual: { route: "maybe" } }, /decide\.route:lab-1: question route's label must be one of its options \(ready, needs_info, not_for_factory\)/],
    [{ decision: "decide.route:lab-1", actual: { route: true } }, /question route's label must be one of its options/],
    [{ decision: "decide.route:lab-1", actual: { one_line: "yes" } }, /decide\.route:lab-1: question one_line is noul; label it true or false/],
    [{ decision: "decide.route:lab-1", actual: { risk: 4 } }, /decide\.route:lab-1: question risk's label must be a level from 0 to 3/],
    [{ decision: "decide.route:lab-1", actual: { risk: -1 } }, /question risk's label must be a level from 0 to 3/],
    [{ decision: "decide.route:lab-1", actual: { risk: 1.5 } }, /question risk's label must be a level from 0 to 3/],
    [{ decision: "decide.route:lab-1", actual: {} }, /decide\.route:lab-1: an outcome must label at least one question/],
    [{ decision: "extract.facts:lab-1", actual: { commit: "5326650" } }, /extract\.facts:lab-1: field commit's label must be true \(correct\) or false \(wrong\), not a string/],
    [{ decision: "extract.facts:lab-1", actual: { commit: 1 } }, /field commit's label must be true \(correct\) or false \(wrong\), not a number/],
    [{ decision: "extract.facts:lab-1", actual: { nope: true } }, /extract\.facts:lab-1: "nope" is not a field of extract\.facts/],
    [{ decision: "extract.facts:lab-1", actual: {} }, /extract\.facts:lab-1: an outcome must label at least one field/],
  ];
  for (const [payload, error] of bad) {
    const receipt = await label("lab-1", payload);
    expect(receipt, JSON.stringify(payload)).toMatchObject({ status: "failed" });
    expect((receipt as { error: string }).error, JSON.stringify(payload)).toMatch(error);
  }
  expect(await records("lab-1")).toEqual(before);
  expect(of(events, "failed").filter((e) => e.type === "probe.label")).toHaveLength(bad.length);
  // An extraction's wrong label isn't echoed into the log: it may be an extracted value.
  expect(JSON.stringify(of(events, "failed"))).not.toContain("5326650");
  expect(of(events, "decision.acted")).toHaveLength(2);
  expect(of(events, "decision.outcome")).toHaveLength(4);
});

it("[decision-cannot-approve] in the handler of a decision's or an extraction's result, ctx.approve and ctx.deny throw; the same calls work in other handlers", async () => {
  overrideEffect("gateway.approval", { run: async () => "ran" });
  const park = (key: string) => ingress(env, system, "Probe", "probe.effect", { effect: "gateway.approval", key }, { key: "noapp" });
  await park("noapp");
  await park("noapp-2");
  await settle(env, system);
  ai.__probeAi = (_model, body) => ((body as { fields?: unknown }).fields ? CLAIRIC : CLEF);
  await decide("noapp", "decide.route", "try-approve-d");
  await decide("noapp", "extract.facts", "try-approve-x");
  await settle(env, system);
  const refused = "a decision's result can't approve or deny (spec §9.3)";
  expect((await probe("noapp").answers()).map((a) => ({ message: a.message, status: a.status, tried: a.tried }))).toEqual([
    { message: "probe.decided", status: "confirmed", tried: { approve: refused, deny: refused } },
    { message: "probe.extracted", status: "confirmed", tried: { approve: refused, deny: refused } },
  ]);
  const parked = () => runInDurableObject(probe("noapp"), (_i, s) => s.storage.sql.exec<{ id: string; status: string }>("SELECT id, status FROM _actors_outbox WHERE id LIKE 'fx:gateway.approval:%' ORDER BY id").toArray());
  expect(await parked()).toEqual([
    { id: "fx:gateway.approval:noapp", status: "awaiting_approval" },
    { id: "fx:gateway.approval:noapp-2", status: "awaiting_approval" },
  ]);
  // Other handlers approve and deny as before.
  expect(await ingress(env, system, "Probe", "probe.approve", { key: "noapp", by: "owner" }, { key: "noapp" })).toMatchObject({ status: "handled" });
  expect(await ingress(env, system, "Probe", "probe.deny", { key: "noapp-2", by: "owner" }, { key: "noapp" })).toMatchObject({ status: "handled" });
  await settle(env, system);
  expect(await probe("noapp").approvals()).toEqual([
    { key: "noapp", ok: true },
    { key: "noapp-2", ok: true },
  ]);
  expect(await parked()).toEqual([
    { id: "fx:gateway.approval:noapp", status: "confirmed" },
    { id: "fx:gateway.approval:noapp-2", status: "denied" },
  ]);
});

it("[decision-retry] ai.run that throws is retried and recorded once when it answers; a malformed response is rejected without retry and not recorded", async () => {
  const events = captureEvents();
  let calls = 0;
  ai.__probeAi = () => {
    calls++;
    if (calls <= 2) throw new Error("429 Too Many Requests");
    return CLEF;
  };
  await decide("retry-1", "decide.route");
  await settle(env, system);
  expect(calls).toBe(3);
  expect(await probe("retry-1").answers()).toMatchObject([{ key: "retry-1", status: "confirmed", value: { answers: CLEF_ANSWERS } }]);
  expect(of(events, "retry.scheduled", "retry-1")).toHaveLength(2);
  expect(of(events, "effect.confirmed", "retry-1")).toMatchObject([{ attempt: 3 }]);
  expect(await records("retry-1")).toMatchObject([{ id: "decide.route:retry-1" }]);
  expect(of(events, "decision.recorded", "retry-1")).toHaveLength(1);

  calls = 0;
  ai.__probeAi = () => {
    calls++;
    return { model: "clef-flash", answers: { route: CLEF_ANSWERS.route, risk: CLEF_ANSWERS.risk }, usage: { input_tokens: 335, output_tokens: 0 } };
  };
  await decide("malformed-1", "decide.route");
  await settle(env, system);
  expect(calls).toBe(1);
  const [answer] = await probe("malformed-1").answers();
  expect(answer).toMatchObject({ key: "malformed-1", status: "failed", value: null });
  expect(answer!.error).toMatch(/the model gave no answer for question "one_line"/);
  expect(of(events, "retry.scheduled", "malformed-1")).toEqual([]);
  expect(of(events, "effect.failed", "malformed-1")).toMatchObject([{ attempt: 1 }]);
  expect(await records("malformed-1")).toEqual([]);
  expect(of(events, "decision.recorded", "malformed-1")).toEqual([]);
});

it("[decision-failed-not-recorded] a decision that fails or ends in doubt writes no record and emits no decision.recorded", async () => {
  const events = captureEvents();
  overrideEffectBudget("decide.route", { maxAttempts: 2 });
  overrideEffectBudget("extract.facts", { maxAttempts: 2 });
  // Provably never sent, every attempt: failed once retries run out.
  ai.__probeAi = () => {
    throw Object.assign(new Error("connection refused"), { notDelivered: true });
  };
  await decide("fail-1", "decide.route");
  await decide("fail-x", "extract.facts");
  await settle(env, system);
  // Sent, but the answer was lost, every attempt: in doubt once retries run out.
  ai.__probeAi = () => {
    throw new Error("socket hang up");
  };
  await decide("doubt-1", "decide.route");
  await settle(env, system);
  expect(await probe("fail-1").answers()).toMatchObject([{ message: "probe.decided", status: "failed", error: "connection refused" }]);
  expect(await probe("fail-x").answers()).toMatchObject([{ message: "probe.extracted", status: "failed", error: "connection refused" }]);
  expect(await probe("doubt-1").answers()).toMatchObject([{ message: "probe.decided", status: "in_doubt", error: "socket hang up" }]);
  for (const instance of ["fail-1", "fail-x", "doubt-1"]) expect(await records(instance), instance).toEqual([]);
  expect(of(events, "decision.recorded")).toEqual([]);
});
