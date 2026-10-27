// Agents in workerd: a Pi session and actord in one Durable Object, against the Scribe probe (test-runtime/src/agent.ts).
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { ingress } from "../src/runtime/index.ts";
import { eventually } from "../src/testing.ts";
import { scribeSystem } from "./src/agent.ts";

const scribe = (key: string) => env.SCRIBE.getByName(key);

it("[pi-and-actord-share-alarm] a Pi session and actord's timers run in one Durable Object, on its one alarm", async () => {
  const gate = globalThis as { __scribeGate?: Promise<void> };
  let open!: () => void;
  gate.__scribeGate = new Promise((r) => (open = r));
  const s = scribe("share");
  try {
    // The model holds its answer until the gate opens, so Pi's run, and its wake job, are still going.
    expect(await s.submit("Say hello", "op-1")).toMatchObject({ operationId: "op-1", accepted: true });
    await ingress(env, scribeSystem, "Scribe", "scribe.tick", { key: "t1", delayMs: 20 }, { key: "share" });
    // Fired by the alarm, which Pi's wake job, waiting on its run, doesn't hold.
    await eventually(async () => expect(await s.fired()).toEqual(["t1"]));
    expect(await s.pending()).toMatchObject([{ operationId: "op-1", status: "running" }]);
  } finally {
    open();
    delete gate.__scribeGate;
  }
  expect(await s.wait("op-1")).toMatchObject({ status: "done", text: "hello" });
  // Each set of jobs the table held as one was added or changed: Pi's wake and actord's drive were due together.
  expect(await s.jobSets()).toContainEqual(expect.arrayContaining(["actord", "pi-wake"]));
});

it("[scripted-model-tool-call] a scripted turn calls a registered tool, then answers, and usage is what the script reported", async () => {
  const s = scribe("echo-1");
  await s.submit("Echo one", "op-echo");
  expect(await s.wait("op-echo")).toMatchObject({ status: "done", text: "echoed" });
  const calls = await s.echoCalls();
  expect(calls).toEqual([{ callId: expect.any(String), args: { v: 1 } }]);
  expect(calls[0]!.callId).not.toBe("");
  const results = (await s.messages()).flatMap((e) => e.model ?? []).filter((m) => m.role === "toolResult");
  expect(results).toMatchObject([{ toolCallId: calls[0]!.callId, toolName: "echo", isError: false, content: [{ type: "text", text: "echo 1" }] }]);
  expect((await s.usage()).models).toEqual({
    "scripted/scripted": expect.objectContaining({ input: 30, output: 8, totalTokens: 38, cost: expect.objectContaining({ total: 0.003 }) }),
  });
});

it("[json-schema-tool] pi takes a tool whose parameters are plain JSON Schema (z.toJSONSchema), and validates calls against it", async () => {
  const s = scribe("json-1");
  await s.submit("Echo twice", "op-json");
  expect(await s.wait("op-json")).toMatchObject({ status: "done", text: "done" });
  // The call with { v: "one" } failed validation before execute; the call with { v: 2 } ran.
  expect((await s.echoCalls()).map((c) => c.args)).toEqual([{ v: 2 }]);
  const results = (await s.messages()).flatMap((e) => e.model ?? []).filter((m) => m.role === "toolResult");
  expect(results.map((r) => r.isError)).toEqual([true, false]);
});
