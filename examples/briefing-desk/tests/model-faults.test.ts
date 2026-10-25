import { env } from "cloudflare:workers";
import { EffectNotDelivered } from "actors-toolkit/runtime";
import { overrideBudget, overrideEffect, resetSeams, settle } from "actors-toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "../system.ts";
import { board, gateway, scriptedModel, status, submit } from "./helpers.ts";

afterEach(() => resetSeams());

it("[model-unavailable][budget] an unreachable model is tried exactly maxAttempts times, then the item goes to a person", async () => {
  const calls = scriptedModel({ "Login page blank": new EffectNotDelivered("model API unreachable") });
  gateway("accept");
  await submit("mu-1", "Login page blank");
  await settle(env, system);
  expect(calls).toHaveLength(system.actors.Analyst.budget.maxAttempts);
  const row = (await board()).find((r) => r.item_id === "mu-1");
  expect(row).toMatchObject({ status: "needs_human" });
  expect(row?.reason).toMatch(/model failed: model API unreachable/);
});

it("[model-timeout] a model that never answers is cut off by the budget's timeout and the item goes to a person", async () => {
  overrideBudget("Analyst", { timeoutMs: 30 });
  let calls = 0;
  overrideEffect("model.analyze", {
    run: () => {
      calls++;
      return new Promise(() => {}); // never settles
    },
  });
  await submit("mt-1", "Cache hit rate dropped");
  await settle(env, system);
  expect(calls).toBe(2);
  const row = (await board()).find((r) => r.item_id === "mt-1");
  // Retried (a model call has no side effects), then unknown: reported as in doubt, never as an answer.
  expect(row).toMatchObject({ status: "needs_human" });
  expect(row?.reason).toMatch(/model in_doubt: effect timed out after 30ms/);
});

it("[model-output-invalid] model output that fails the schema is never acted on", async () => {
  scriptedModel({ "Weird request": { category: "urgent!!", priority: "HIGH", summary: 42 } });
  const sent = gateway("accept");
  await submit("mi-1", "Weird request");
  await settle(env, system);
  expect(await status("mi-1")).toBe("needs_human");
  expect((await board()).find((r) => r.item_id === "mi-1")?.reason).toMatch(/model output failed validation/);
  expect(sent).toEqual([]);
});
