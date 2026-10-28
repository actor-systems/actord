// Decision and extraction effects in the runtime: records, shadow mode, labels, and the approval guard (plan 4, Task 3).
// The probe's decide.route, decide.shadow and extract.facts run on decisionAdapters over a stub Workers AI that each
// test scripts (globalThis.__probeAi, test-runtime/src/index.ts).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { type ActorEvent, ingress } from "../src/runtime/index.ts";
import { captureEvents, overrideEffect, overrideEffectBudget, resetSeams, settle } from "../src/testing.ts";
import type { LoggedEvent } from "../src/model/events.ts";
import { scorecard } from "../src/model/scorecard.ts";
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
  // Each decision.outcome carries the outcome as merged after its call (R6): route, labelled in one handler, is still
  // there when one_line is labelled in a later one, so the latest event per decision matches the table.
  expect(of(events, "decision.outcome").map((e) => e.detail)).toEqual([
    { decision: "decide.route:lab-1", actual: { route: "needs_info" } },
    { decision: "decide.route:lab-1", actual: { route: "needs_info", one_line: false, risk: 3 } },
    { decision: "decide.route:lab-1", actual: { route: "needs_info", one_line: false, risk: 0 } },
    { decision: "extract.facts:lab-1", actual: { commit: true, run_id: false } },
  ]);
  const latest = (id: string) => of(events, "decision.outcome").filter((e) => e.detail?.decision === id).at(-1)?.detail?.actual;
  expect(latest("decide.route:lab-1")).toEqual(JSON.parse(decision.outcome!));
  expect(latest("extract.facts:lab-1")).toEqual(JSON.parse(extraction.outcome!));

  const before = await records("lab-1");
  const bad: Array<[{ decision: string; action?: string; actual?: Record<string, string | number | boolean> }, RegExp]> = [
    [{ decision: "decide.route:nope", action: "routed:ready" }, /no decision or extraction is recorded as "decide\.route:nope"/],
    [{ decision: "decide.route:nope", actual: { route: "ready" } }, /no decision or extraction is recorded as "decide\.route:nope"/],
    [{ decision: "lab-1", actual: { route: "ready" } }, /no decision or extraction is recorded as "lab-1"/],
    [{ decision: "decide.route:lab-1", action: "" }, /decide\.route:lab-1: an action must be a non-empty string/],
    [{ decision: "decide.route:lab-1", actual: { nope: "ready" } }, /decide\.route:lab-1: "nope" is not a question of decide\.route \(route, one_line, risk\)/],
    // A label is checked whole before anything is written: a valid question beside a bad one isn't written either.
    [{ decision: "decide.route:lab-1", actual: { route: "ready", nope: "ready" } }, /"nope" is not a question of decide\.route/],
    // ctx.acted's write and its decision.acted lands, then ctx.outcome throws: the failed delivery rolls the write back
    // and drops the event (the records and the event counts below are unchanged).
    [{ decision: "decide.route:lab-1", action: "rolled-back", actual: { risk: 9 } }, /level from 0 to 3/],
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

it("[decision-usage-absent] a response without usage is recorded with usage NULL, and its result and events carry no usage or cost", async () => {
  const events = captureEvents();
  ai.__probeAi = () => ({ model: "clef-flash", answers: CLEF_ANSWERS });
  await decide("nousage-1", "decide.route");
  await settle(env, system);
  const [answer] = await probe("nousage-1").answers();
  expect(answer).toMatchObject({ status: "confirmed", value: { answers: CLEF_ANSWERS, usage: null } });
  const [row] = await records("nousage-1");
  expect(row).toMatchObject({ id: "decide.route:nousage-1", usage: null });
  expect(of(events, "decision.recorded", "nousage-1")).toMatchObject([{ detail: { usage: null } }]);
  // No usage was reported, so the effect has none, and none is invented as $0: the result's payload has no usage, the
  // effect's row body none, and effect.confirmed no detail.
  const [result] = (await messageRows("nousage-1")).map((r) => JSON.parse(r.body) as { type: string; payload: Record<string, unknown> });
  expect(result).toMatchObject({ type: "probe.decided", payload: { key: "nousage-1", status: "confirmed" } });
  expect(result!.payload).not.toHaveProperty("usage");
  const [fx] = await runInDurableObject(probe("nousage-1"), (_i, s) => s.storage.sql.exec<{ body: string }>("SELECT body FROM _actors_outbox WHERE id = ?", "fx:decide.route:nousage-1").toArray());
  expect(JSON.parse(fx!.body)).not.toHaveProperty("usage");
  const [confirmed] = of(events, "effect.confirmed", "nousage-1");
  expect(confirmed).toBeDefined();
  expect(confirmed).not.toHaveProperty("detail");
  // The same decision with usage reports the cost: 335 input tokens at $0.038 per million.
  ai.__probeAi = () => CLEF;
  await decide("usage-1", "decide.route");
  await settle(env, system);
  const [paid] = (await messageRows("usage-1")).map((r) => JSON.parse(r.body) as { payload: Record<string, unknown> });
  expect(paid!.payload.usage).toEqual({ inputTokens: 335, outputTokens: 0, costUsd: (335 * 0.038) / 1e6 });
});

it("[decision-inputs] with an R2 inputs bucket, the request body is written under its digest before the call, and the row, the event and the value name it", async () => {
  const events = captureEvents();
  const shared = globalThis as { __probeInputs?: Record<string, { value: string; options: unknown }> };
  delete shared.__probeInputs;
  const seen: string[] = [];
  ai.__probeAi = () => {
    seen.push(...Object.keys(shared.__probeInputs ?? {}));
    return CLEF;
  };
  try {
    await decide("inputs-1", "decide.route");
    await settle(env, system);
    const [row] = await records("inputs-1");
    const ref = `decisions/inputs/${row!.input_digest}.json`;
    expect(row).toMatchObject({ id: "decide.route:inputs-1", input_ref: ref });
    expect(of(events, "decision.recorded", "inputs-1")).toMatchObject([{ detail: { inputDigest: row!.input_digest, inputRef: ref } }]);
    expect(await probe("inputs-1").answers()).toMatchObject([{ status: "confirmed", value: { inputDigest: row!.input_digest, inputRef: ref } }]);
    // Put before ai.run was called, as the exact body sent, which hashes to the digest.
    expect(seen).toEqual([ref]);
    const kept = shared.__probeInputs![ref]!;
    expect(kept.options).toEqual({ httpMetadata: { contentType: "application/json" } });
    expect(JSON.parse(kept.value)).toEqual({ model: "clef-flash", state: STATE, questions: system.effects["decide.route"].questions });
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(kept.value)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(digest).toBe(row!.input_digest);
    // Without the bucket the digest is the same, and nothing names an object.
    await decide("noinputs-1", "decide.route", "inputs-1");
    await settle(env, system);
    expect(await records("noinputs-1")).toMatchObject([{ input_digest: row!.input_digest, input_ref: null }]);
  } finally {
    delete shared.__probeInputs;
  }
});

it("[decide-in-handler] ActorRuntime.decide called from a handler, even one that doesn't await it, is refused, synchronously or after an await; the approval stays parked", async () => {
  overrideEffect("gateway.approval", { run: async () => "ran" });
  ai.__probeAi = () => CLEF;
  const refused = "decide can't be called from inside a handler (its approval would escape the handler's transaction and the guard on a decision's result); use ctx.approve or ctx.deny";
  for (const [instance, key] of [
    ["decin-1", "try-decide-1"],
    ["decin-2", "try-decide-late-1"],
  ] as const) {
    await ingress(env, system, "Probe", "probe.effect", { effect: "gateway.approval", key: instance }, { key: instance });
    await settle(env, system);
    await decide(instance, "decide.route", key);
    await settle(env, system);
    expect((await probe(instance).answers()).map((a) => ({ key: a.key, status: a.status, tried: a.tried })), instance).toEqual([{ key, status: "confirmed", tried: { decide: refused } }]);
    const [parked] = await runInDurableObject(probe(instance), (_i, s) => s.storage.sql.exec<{ status: string }>("SELECT status FROM _actors_outbox WHERE id = ?", `fx:gateway.approval:${instance}`).toArray());
    expect(parked, instance).toEqual({ status: "awaiting_approval" });
    // From outside a handler, decide still approves.
    expect(await probe(instance).decide(instance, "approve")).toMatchObject({ status: "confirmed", key: instance });
  }
});

// The runtime's own events, through actord scorecard: two instances decide with the same key, so both records are
// decide.route:77, and each instance labels its own. CLEF_B is a second Clef-flash answer, its risk score Σ level·p:
// .15 + 2·.45 + 3·.35 = 2.1.
//   route (choice ready|needs_info|not_for_factory)
//     sc-a  P .7106/.1192/.1702  top ready       label ready       Σ(p-1[label])² = .2894²+.1192²+.1702²
//                                                                    = .08375236+.01420864+.02896804 = .12692904
//     sc-b  P .2/.7/.1           top needs_info  label needs_info  Σ = .2²+.3²+.1² = .04+.09+.01 = .14
//     accuracy 2/2 = 1; Brier (.12692904+.14)/2 = .13346452 → .1335
//     bins on top p: .7106 and .7 → [.7,.9) n2 meanP (.7106+.7)/2 = .7053 observed 1
//     wrongWhenChosen: ready 1/0, needs_info 1/0
//   one_line (noul): sc-a .1129, false → .1129² = .01274641; sc-b .8, true → .2² = .04
//     Brier (.01274641+.04)/2 = .026373205 → .0264; bins: .1129 → [0,.5) n1 observed 0; .8 → [.7,.9) n1 observed 1
//   risk (score): sc-a .9138, level 1 → .0862; sc-b 2.1, level 2 → .1; mean (.0862+.1)/2 = .0931
//   recorded 2, shadow 0, labelled 2, acted 1 (sc-a)
const CLEF_B = {
  model: "clef-flash",
  answers: {
    route: { type: "choice", choice: "needs_info", probabilities: { ready: 0.2, needs_info: 0.7, not_for_factory: 0.1 }, confidence: 0.4127 },
    one_line: { type: "noul", noul: 0.8 },
    risk: { type: "score", score: 2.1, legend: CLEF_ANSWERS.risk.legend, probabilities: { "0": 0.05, "1": 0.15, "2": 0.45, "3": 0.35 }, confidence: 0.3014 },
  },
  usage: { input_tokens: 335, output_tokens: 0 },
};

it("[decision-scorecard-pipeline] the runtime's decision events, from two instances deciding with the same key, score as two records", async () => {
  const events = captureEvents();
  ai.__probeAi = () => CLEF;
  await decide("sc-a", "decide.route", "77");
  await settle(env, system);
  ai.__probeAi = () => CLEF_B;
  await decide("sc-b", "decide.route", "77");
  await settle(env, system);
  expect(await label("sc-a", { decision: "decide.route:77", action: "routed:ready", actual: { route: "ready", one_line: false } })).toMatchObject({ status: "handled" });
  expect(await label("sc-a", { decision: "decide.route:77", actual: { risk: 1 } })).toMatchObject({ status: "handled" });
  expect(await label("sc-b", { decision: "decide.route:77", actual: { route: "needs_info", one_line: true, risk: 2 } })).toMatchObject({ status: "handled" });
  expect(of(events, "decision.recorded").map((e) => [e.actor, e.detail?.decision])).toEqual([
    ["Probe:sc-a", "decide.route:77"],
    ["Probe:sc-b", "decide.route:77"],
  ]);
  const empty = { meanP: 0, n: 0, observed: 0 };
  expect(scorecard(events as LoggedEvent[])).toEqual({
    orphanLabels: 0,
    effects: [
      {
        effect: "decide.route",
        model: "@cf/cloudflare/clef-flash",
        recorded: 2,
        shadow: 0,
        labelled: 2,
        acted: 1,
        questions: [
          {
            id: "route",
            type: "choice",
            labelled: 2,
            accuracy: 1,
            brier: 0.1335,
            bins: [
              { from: 0, to: 0.5, ...empty },
              { from: 0.5, to: 0.7, ...empty },
              { from: 0.7, to: 0.9, n: 2, meanP: 0.7053, observed: 1 },
              { from: 0.9, to: 1, ...empty },
            ],
            wrongWhenChosen: { ready: { chosen: 1, wrong: 0 }, needs_info: { chosen: 1, wrong: 0 } },
          },
          {
            id: "one_line",
            type: "noul",
            labelled: 2,
            brier: 0.0264,
            bins: [
              { from: 0, to: 0.5, n: 1, meanP: 0.1129, observed: 0 },
              { from: 0.5, to: 0.7, ...empty },
              { from: 0.7, to: 0.9, n: 1, meanP: 0.8, observed: 1 },
              { from: 0.9, to: 1, ...empty },
            ],
          },
          { id: "risk", type: "score", labelled: 2, meanAbsError: 0.0931 },
        ],
      },
    ],
  });
});
