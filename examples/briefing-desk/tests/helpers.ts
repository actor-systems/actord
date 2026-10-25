import { env } from "cloudflare:workers";
import { EffectNotDelivered, type EffectAdapter, ingress } from "@actord/toolkit/runtime";
import { overrideEffect } from "@actord/toolkit/testing";
import system from "../system.ts";
import type { Analysis, AnalyzeInput } from "../src/model.ts";

// Durable Object storage persists across the tests in one file (each file starts empty), and effects
// dedupe by key per instance: give each test its own instance keys and ids. An instance every test
// shares, such as one at `main`, keeps what earlier tests left: assert only on what this test added.

/** A model double that answers from a table keyed by item title; unknown titles throw. */
export function scriptedModel(answers: Record<string, Analysis | Error | unknown>) {
  const calls: string[] = [];
  const adapter: EffectAdapter<AnalyzeInput, unknown> = {
    async run(input) {
      calls.push(input.title);
      const answer = answers[input.title];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`no scripted answer for "${input.title}"`);
      return answer;
    },
  };
  overrideEffect("model.analyze", adapter as EffectAdapter);
  return calls;
}

/** A model double whose answer the test releases, to hold an analysis in flight. */
export function deferredModel() {
  let resolve!: (a: Analysis) => void;
  const answer = new Promise<Analysis>((r) => (resolve = r));
  const state = { calls: 0 };
  overrideEffect("model.analyze", {
    async run() {
      state.calls++;
      return answer;
    },
  });
  return { state, resolve };
}

/** A gateway double: records each delivery attempt; `mode` decides what the caller sees. */
export function gateway(mode: "accept" | "lost-ack" | "unreachable" = "accept") {
  const attempts: string[] = [];
  overrideEffect("notify.brief", {
    async run(input) {
      attempts.push((input as { itemId: string }).itemId);
      if (mode === "unreachable") throw new EffectNotDelivered("gateway unreachable (connection refused)");
      if (mode === "lost-ack") throw new Error("gateway accepted the request, then the connection dropped before it answered");
      return { status: 202 };
    },
  });
  return attempts;
}

export const analysis = (category: Analysis["category"], priority: Analysis["priority"], summary = `${category}/${priority}`): Analysis => ({
  category,
  priority,
  summary,
  rationale: `scripted: ${category} at ${priority}`,
});

export function submit(itemId: string, title: string, body = "details") {
  return ingress(env, system, "Intake", "item.submitted", { itemId, source: "test", title, body });
}

export function decide(itemId: string, decision: "approve" | "deny", by = "owner") {
  return ingress(env, system, "Analyst", "briefing.decided", { itemId, decision, by }, { key: itemId });
}

export async function board() {
  return env.DESK.getByName("main").board();
}

export async function status(itemId: string) {
  return (await board()).find((r) => r.item_id === itemId)?.status;
}
