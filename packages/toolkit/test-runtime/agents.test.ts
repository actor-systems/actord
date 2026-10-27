// Agents in workerd: a Pi session and actord in one Durable Object, against the Scribe and Builder probes
// (test-runtime/src/agent.ts).
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { type BackendHandle, type DurableObjectStorageLike, Workspace, type WorkspaceBackend } from "@cloudflare/computer";
import { createGitClient, type GitClient } from "@cloudflare/computer/git";
import { afterEach, expect, it } from "vitest";
import { gitClone, gitPushEffect } from "../src/agents/git.ts";
import { RegistryReadGateway, type ScriptedRequest, type ScriptedTurn, workspaceFor, workspaceTools } from "../src/agents/index.ts";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { type ActorEvent, EffectRejected, ingress } from "../src/runtime/index.ts";
import { captureEvents, eventually, expireJobs, overrideBudget, overrideEffect, overrideEffectBudget, resetSeams, settle } from "../src/testing.ts";
import { computer, containerBackend } from "../src/system.ts";
import { type Builder, ContainerStub, type Scribe } from "./src/agent.ts";
import { system } from "./src/index.ts";

const scribe = (key: string) => env.SCRIBE.getByName(key);
type Script = (request: ScriptedRequest) => ScriptedTurn | Promise<ScriptedTurn>;
const shared = globalThis as { __scribeScripts?: Record<string, Script>; __scribeInstructions?: Record<string, string>; __scribeNotedThrows?: Record<string, number>; __scribes?: Record<string, Scribe> };

/** Answer each model request of instance `name` with `script` (Scribe reads it at every request). */
function script(name: string, fn: Script): void {
  shared.__scribeScripts = { ...shared.__scribeScripts, [name]: fn };
}
/**
 * A gate a scripted turn waits on, and `open` lets go. `reached` says a turn is waiting: a flag the test polls, not a
 * promise, since a promise the Durable Object resolves would carry the test's continuation into the object's I/O.
 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const g = { open, reached: false, wait: () => ((g.reached = true), opened) };
  return g;
}
const reached = (g: { reached: boolean }) => eventually(async () => expect(g.reached).toBe(true));
/**
 * Hold instance `name`'s next session start inside pi's sessions.create(): until `g` opens, after pi made the session
 * ("hold"), or by throwing before pi makes one ("fail"), so the start is retried after a backoff.
 */
async function holdStart(name: string, mode: "hold" | "fail", g?: ReturnType<typeof gate>): Promise<void> {
  await runInDurableObject(scribe(name), (instance: Scribe) => {
    const sessions = instance.actor.harness.sessions;
    const create = sessions.create.bind(sessions);
    let held = false;
    sessions.create = async () => {
      if (held) return create();
      held = true;
      if (mode === "fail") throw new Error("the test held this start");
      const session = await create();
      await g!.wait();
      return session;
    };
  });
}
const jobRow = async (name: string, key: string) => (await scribe(name).outbox()).find((r) => r.id === key);
const gates: Array<() => void> = [];
afterEach(() => {
  for (const open of gates.splice(0)) open();
  resetSeams();
});

const finish = (args: unknown): ScriptedTurn => ({ calls: [{ name: "finish", args }] });
const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : (m.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join(""));
/** The texts of a request's user messages, in order. */
const users = (r: ScriptedRequest) => r.messages.filter((m) => m.role === "user").map(text);
/** Everything a request's system messages say, sections included. */
const systemOf = (r: ScriptedRequest) => JSON.stringify(r.messages.filter((m) => m.role === "system"));
const task = (key: string, topic: string, id: string) => ingress(env, system, "Scribe", "scribe.task", { topic }, { key, id });
const notes = (events: ActorEvent[], actor: string, reason: string) => events.filter((e) => e.kind === "note" && e.actor === actor && e.reason === reason);

it("[pi-and-actord-share-alarm] a Pi session and actord's timers run in one Durable Object, on its one alarm", async () => {
  const gate = globalThis as { __scribeGate?: Promise<void> };
  let open!: () => void;
  gate.__scribeGate = new Promise((r) => (open = r));
  const s = scribe("share");
  try {
    // The model holds its answer until the gate opens, so Pi's run, and its wake job, are still going.
    expect(await s.submit("Say hello", "op-1")).toMatchObject({ operationId: "op-1", accepted: true });
    await ingress(env, system, "Scribe", "scribe.tick", { key: "t1", delayMs: 20 }, { key: "share" });
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

it("[agent-start-returns] a start runs a session whose finish returns the result to the actor, settled by probe within a period", async () => {
  const events = captureEvents();
  const requests: ScriptedRequest[] = [];
  script("returns-1", (r) => (requests.push(r), { text: "Here is the write-up.", ...finish({ summary: "ok" }) }));
  const s = scribe("returns-1");
  const started = Date.now();
  expect(await task("returns-1", "the release", "task-r1")).toMatchObject({ status: "handled" });
  await eventually(async () => expect(await s.done()).toEqual([{ id: expect.any(String), sender: "Scribe:returns-1", summary: "ok" }]), 4000);
  // Settled by probeNow, well inside the 30s probe period.
  expect(Date.now() - started).toBeLessThan(30_000);
  // The prompt is the start message, rendered: its type, then its payload as indented JSON.
  expect(users(requests[0]!)).toEqual(['scribe.task\n\n{\n  "topic": "the release"\n}']);
  // The model's declared reasoning, "high", is the session's thinking level.
  expect(requests[0]!.reasoning).toBe("high");
  const [row] = await s.sessions();
  expect(await s.job("task-r1")).toMatchObject({ settledBy: "probe", outcome: { summary: "ok" }, handle: { session: row!.session, operation: "task-r1", generation: 1 } });
  expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-r1")).toMatchObject({ status: "confirmed", attempts: 1 });
  expect(events.filter((e) => e.kind === "effect.confirmed" && e.effect === "agent.session")).toMatchObject([{ effectKey: "task-r1", detail: { settledBy: "probe" } }]);
  expect(row).toEqual({ key: "task-r1", session: expect.stringMatching(/^\d+$/), operation: "task-r1", generation: 1, instructions: expect.stringContaining("You are Scribe"), started_at: expect.any(Number), result: '{"summary":"ok"}', exhausted: null, stopped_at: null });
  expect((await s.piSessions()).map((p) => p.id)).toContain(row!.session);
});

it("[agent-finish-invalid] a finish whose payload fails the returns schema is an error the model sees; the next valid one returns", async () => {
  const requests: ScriptedRequest[] = [];
  // A blank summary passes the JSON Schema pi checks (pi would coerce a number to a string), and fails scribe.done's refinement.
  script("invalid-1", (r) => (requests.push(r), r.turn === 0 ? finish({ summary: " " }) : finish({ summary: "fixed" })));
  const s = scribe("invalid-1");
  await task("invalid-1", "the bug", "task-i1");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["fixed"]), 4000);
  const [result] = requests[1]!.lastToolResults as Array<{ toolName: string; isError: boolean; content: Array<{ text: string }> }>;
  expect(result).toMatchObject({ toolName: "finish", isError: true });
  expect(result!.content.map((c) => c.text).join("")).toBe("The result doesn't match scribe.done:\n- summary: summary must not be blank");
  await settle(env, system);
  expect((await s.done()).map((d) => d.summary)).toEqual(["fixed"]);
});

it("[agent-duplicate-start] one start envelope delivered twice runs one session, and a redelivery after its result does nothing", async () => {
  script("dup-1", () => finish({ summary: "once" }));
  const s = scribe("dup-1");
  const receipts = await Promise.all([task("dup-1", "the duplicate", "task-d1"), task("dup-1", "the duplicate", "task-d1")]);
  expect(receipts.map((r) => r.status).sort()).toEqual(["duplicate", "handled"]);
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["once"]), 4000);
  expect(await task("dup-1", "the duplicate", "task-d1")).toMatchObject({ status: "duplicate" });
  // Past the inbox's dedupe (its row expired): the handler runs again, and finds the session already started.
  await runInDurableObject(s, (_i, state) => state.storage.sql.exec("DELETE FROM _actors_inbox WHERE id = 'task-d1'"));
  expect(await task("dup-1", "the duplicate", "task-d1")).toMatchObject({ status: "handled" });
  await settle(env, system);
  expect((await s.done()).map((d) => d.summary)).toEqual(["once"]);
  expect((await s.sessions()).map((r) => r.key)).toEqual(["task-d1"]);
  // One session besides pi's root, and one prompt submitted to it.
  const [row] = await s.sessions();
  expect((await s.piSessions()).map((p) => p.id)).toEqual(["1", row!.session]);
  expect((await s.messages(row!.session as string)).filter((e) => e.kind === "pi.user")).toHaveLength(1);
});

it("[agent-steer] a steer message joins the running turn with the hint's id; with no session it is only a note", async () => {
  const events = captureEvents();
  const held = gate();
  gates.push(held.open);
  const requests: ScriptedRequest[] = [];
  script("steer-1", async (r) => {
    requests.push(r);
    if (r.turn === 0) {
      await held.wait();
      return { text: "Thinking it over." };
    }
    return finish({ summary: "with bullets" });
  });
  const s = scribe("steer-1");
  await task("steer-1", "the notes", "task-s1");
  await reached(held);
  expect(await ingress(env, system, "Scribe", "scribe.hint", { text: "use bullet points" }, { key: "steer-1", id: "hint-1" })).toMatchObject({ status: "handled" });
  // The steer is with pi before the turn it joins ends.
  await eventually(async () => expect((await s.outbox()).find((r) => r.id === "fx:agent.session.steer:hint-1")).toMatchObject({ status: "confirmed" }));
  held.open();
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["with bullets"]), 4000);
  expect(users(requests[1]!).at(-1)).toBe('scribe.hint\n\n{\n  "text": "use bullet points"\n}');
  const [row] = await s.sessions();
  expect(await s.wait("hint-1", row!.session as string)).toMatchObject({ operationId: "hint-1", session: row!.session, status: "done" });

  expect(await ingress(env, system, "Scribe", "scribe.hint", { text: "anyone?" }, { key: "steer-none", id: "hint-2" })).toMatchObject({ status: "handled" });
  expect(notes(events, "Scribe:steer-none", "no active session; not steered")).toHaveLength(1);
  expect((await scribe("steer-none").outbox()).filter((r) => r.kind === "effect")).toEqual([]);
});

it("[agent-stop-during-model-call] a stop during a model call aborts the session, fails the job as cancelled and tells the actor", async () => {
  const held = gate();
  gates.push(held.open);
  script("stop-1", async () => {
    await held.wait();
    return finish({ summary: "too late" });
  });
  const s = scribe("stop-1");
  await task("stop-1", "the long one", "task-x1");
  await reached(held);
  await eventually(async () => expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-x1")).toMatchObject({ status: "awaiting_job" }));
  expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: "stop-1", id: "halt-1" })).toMatchObject({ status: "handled" });
  const [row] = await s.sessions();
  await eventually(async () => expect(await s.failures()).toEqual([{ type: "agent.failed", payload: { session: row!.session, key: "task-x1", reason: "stopped" } }]), 4000);
  expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-x1")).toMatchObject({ status: "failed", lastError: "cancelled" });
  expect(await s.job("task-x1")).toMatchObject({ settledBy: "cancel" });
  expect(await s.wait("task-x1", row!.session as string)).toMatchObject({ status: "unanswered" });
  expect(await s.done()).toEqual([]);
});

it("[agent-start-replaces-session] a second start aborts the running session; the first session's late finish is only a note", async () => {
  const events = captureEvents();
  const held = gate();
  gates.push(held.open);
  script("replace-1", async (r) => {
    const prompt = users(r).at(-1) ?? "";
    if (prompt.includes("late")) return finish({ summary: "late" });
    if (prompt.includes('"first"')) {
      await held.wait();
      return finish({ summary: "first" });
    }
    return finish({ summary: "second" });
  });
  const s = scribe("replace-1");
  await task("replace-1", "first", "task-a");
  await reached(held);
  await eventually(async () => expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-a")).toMatchObject({ status: "awaiting_job" }));
  await task("replace-1", "second", "task-b");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["second"]), 4000);
  await eventually(async () => expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-a")).toMatchObject({ status: "failed", lastError: "cancelled" }));
  const [first, second] = await s.sessions();
  expect([first, second].map((r) => [r!.key, r!.generation])).toEqual([["task-a", 1], ["task-b", 2]]);
  expect(first!.session).not.toBe(second!.session);
  // The first session's cancel settled a replaced generation: a note, not agent.failed.
  await settle(env, system);
  expect(await s.failures()).toEqual([]);
  expect(notes(events, "Scribe:replace-1", "stale session result")).toMatchObject([{ detail: { key: "task-a", status: "failed" } }]);
  // The first session answers late (pi already discarded its aborted model call, so it gets new input): its finish is a note.
  await s.submit("A late answer", "late-1", first!.session as string);
  await eventually(async () => expect(notes(events, "Scribe:replace-1", "stale session result")).toHaveLength(2));
  expect(notes(events, "Scribe:replace-1", "stale session result")[1]).toMatchObject({ detail: { key: "task-a", session: first!.session, generation: 1, via: "finish" } });
  await settle(env, system);
  expect((await s.done()).map((d) => d.summary)).toEqual(["second"]);
  expect((await s.sessions()).find((r) => r.key === "task-a")).toMatchObject({ result: null });
});

it("[agent-start-replaces-pending] a start replaced while its job waits to start never opens a pi session; it settles as a note", async () => {
  const events = captureEvents();
  script("replace-2", () => finish({ summary: "second" }));
  // The first start fails once, so its job waits to be tried again when the second task arrives.
  await holdStart("replace-2", "fail");
  await task("replace-2", "first", "task-pa");
  await eventually(async () => expect(await jobRow("replace-2", "fx:agent.session:task-pa")).toMatchObject({ status: "pending", attempts: 1 }));
  await task("replace-2", "second", "task-pb");
  expect(notes(events, "Scribe:replace-2", "replaced session hasn't started yet; its start stops it")).toMatchObject([{ detail: { key: "task-pa" } }]);
  const s = scribe("replace-2");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["second"]), 4000);
  await settle(env, system); // the first start's retry runs now, and finds itself replaced
  expect(await jobRow("replace-2", "fx:agent.session:task-pa")).toMatchObject({ status: "failed", lastError: "replaced by a newer start" });
  expect(notes(events, "Scribe:replace-2", "stale session result")).toMatchObject([{ detail: { key: "task-pa", session: "", generation: 1, status: "failed" } }]);
  // pi never opened a session for the first start: only its root and the second start's.
  const [first, second] = await s.sessions();
  expect(first).toMatchObject({ key: "task-pa", generation: 1, session: null });
  expect((await s.piSessions()).map((p) => p.id)).toEqual(["1", second!.session]);
  expect(await s.failures()).toEqual([]);
  expect((await s.done()).map((d) => d.summary)).toEqual(["second"]);
});

it("[agent-ended-without-result] a run that answers without calling finish fails the session", async () => {
  script("ended-1", () => ({ text: "All done, nothing to return." }));
  const s = scribe("ended-1");
  await task("ended-1", "the quick one", "task-e1");
  await eventually(async () => expect(await s.failures()).toMatchObject([{ type: "agent.failed", payload: { key: "task-e1", reason: "ended without returning a result" } }]), 4000);
  expect((await s.failures())[0]!.payload.session).toBe((await s.sessions())[0]!.session);
  expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-e1")).toMatchObject({ status: "failed", lastError: "ended without returning a result" });
  expect(await s.done()).toEqual([]);
});

// see [crash-loop-parked]
it("[agent-restart-awaiting] a restart while the session runs: pi resumes it, the job isn't started again, and the result arrives once", async () => {
  const events = captureEvents();
  const held = gate();
  gates.push(held.open);
  let calls = 0;
  script("restart-1", async () => {
    // The first request is cut off by the restart; pi asks again once it resumes the run.
    if (calls++ === 0) await held.wait();
    return finish({ summary: "resumed" });
  });
  const s = scribe("restart-1");
  await task("restart-1", "the resumable one", "task-z1");
  await reached(held);
  await eventually(async () => expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-z1")).toMatchObject({ status: "awaiting_job" }));
  await abortAllDurableObjects();
  await settle(env, system);
  await eventually(async () => expect((await scribe("restart-1").done()).map((d) => d.summary)).toEqual(["resumed"]), 5000);
  await settle(env, system);
  expect((await scribe("restart-1").done()).map((d) => d.summary)).toEqual(["resumed"]);
  expect(calls).toBe(2);
  expect(events.filter((e) => e.kind === "job.started" && e.actor === "Scribe:restart-1")).toHaveLength(1);
  expect((await scribe("restart-1").outbox()).find((r) => r.id === "fx:agent.session:task-z1")).toMatchObject({ status: "confirmed", attempts: 1 });
}, 20_000);

// see [crash-loop-parked]
it("[agent-instructions-pinned] a session keeps the instructions it started with across a restart; a new session gets the new ones", async () => {
  const held = gate();
  gates.push(held.open);
  const requests: Array<{ topic: string; request: ScriptedRequest }> = [];
  let firstCalls = 0;
  script("pin-1", async (r) => {
    const topic = users(r)[0]?.includes('"one"') ? "one" : "two";
    requests.push({ topic, request: r });
    if (topic === "two") return finish({ summary: "two" });
    firstCalls++;
    if (firstCalls === 1) await held.wait(); // cut off by the restart
    // The resumed request was prepared before the restart; a failed finish makes pi prepare another, rendering again.
    if (firstCalls === 2) return finish({ summary: " " });
    return finish({ summary: "one" });
  });
  shared.__scribeInstructions = { "pin-1": "Instructions v1" };
  try {
    const s = scribe("pin-1");
    await task("pin-1", "one", "task-p1");
    await reached(held);
    await eventually(async () => expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-p1")).toMatchObject({ status: "awaiting_job" }));
    shared.__scribeInstructions = { "pin-1": "Instructions v2" };
    await abortAllDurableObjects();
    await settle(env, system);
    await eventually(async () => expect((await scribe("pin-1").done()).map((d) => d.summary)).toEqual(["one"]), 5000);
    const rendered = requests.filter((r) => r.topic === "one").at(-1)!.request;
    expect(systemOf(rendered)).toContain("Instructions v1");
    expect(systemOf(rendered)).not.toContain("Instructions v2");
    await task("pin-1", "two", "task-p2");
    await eventually(async () => expect((await scribe("pin-1").done()).map((d) => d.summary)).toEqual(["one", "two"]), 5000);
    const fresh = requests.find((r) => r.topic === "two")!.request;
    expect(systemOf(fresh)).toContain("Instructions v2");
    expect(systemOf(fresh)).not.toContain("Instructions v1");
    expect((await scribe("pin-1").sessions()).map((r) => r.instructions)).toEqual(["Instructions v1", "Instructions v2"]);
  } finally {
    delete shared.__scribeInstructions;
  }
}, 20_000);

it("[agent-stop-before-start-returns] a stop that lands before the session's start returns stops it: the actor hears stopped, not the result", async () => {
  const events = captureEvents();
  // Before pi is asked: the first start attempt failed, and the stop lands while it waits to be tried again.
  script("stop-early-1", () => finish({ summary: "should not arrive" }));
  await holdStart("stop-early-1", "fail");
  await task("stop-early-1", "the early stop", "task-se1");
  await eventually(async () => expect(await jobRow("stop-early-1", "fx:agent.session:task-se1")).toMatchObject({ status: "pending", attempts: 1 }));
  expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: "stop-early-1", id: "halt-se1" })).toMatchObject({ status: "handled" });
  expect(notes(events, "Scribe:stop-early-1", "stop recorded; the session stops when its start runs")).toHaveLength(1);
  await settle(env, system); // the retry runs now, finds the stop, and starts nothing
  await eventually(async () => expect(await scribe("stop-early-1").failures()).toEqual([{ type: "agent.failed", payload: { session: "", key: "task-se1", reason: "stopped" } }]));
  expect(await jobRow("stop-early-1", "fx:agent.session:task-se1")).toMatchObject({ status: "failed", lastError: "stopped" });
  expect((await scribe("stop-early-1").piSessions()).map((p) => p.id)).toEqual(["1"]);
  expect(await scribe("stop-early-1").done()).toEqual([]);

  // After pi has the prompt: the start is held inside it, and the stop lands then.
  const held = gate();
  const turn = gate();
  gates.push(held.open, turn.open);
  script("stop-early-2", async () => {
    await turn.wait();
    return finish({ summary: "should not arrive" });
  });
  await holdStart("stop-early-2", "hold", held);
  await task("stop-early-2", "the late stop", "task-se2");
  await reached(held);
  expect(await jobRow("stop-early-2", "fx:agent.session:task-se2")).toMatchObject({ status: "running" });
  expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: "stop-early-2", id: "halt-se2" })).toMatchObject({ status: "handled" });
  held.open();
  const s = scribe("stop-early-2");
  await eventually(async () => expect((await s.failures()).map((f) => f.payload.reason)).toEqual(["stopped"]), 4000);
  const [row] = await s.sessions();
  expect((await s.failures())[0]!.payload).toEqual({ session: row!.session, key: "task-se2", reason: "stopped" });
  expect(await jobRow("stop-early-2", "fx:agent.session:task-se2")).toMatchObject({ status: "failed", lastError: "stopped" });
  expect(await s.wait("task-se2", row!.session as string)).toMatchObject({ status: "unanswered" });
  turn.open();
  await settle(env, system);
  expect(await s.done()).toEqual([]);
  expect(row).toMatchObject({ result: null, stopped_at: expect.any(Number) });
});

it("[agent-stop-mark-aborts] a stop mark the probe finds on a running session stops pi too, not only the job", async () => {
  const turn = gate();
  gates.push(turn.open);
  script("stop-mark-1", async () => {
    await turn.wait();
    return finish({ summary: "should not arrive" });
  });
  const s = scribe("stop-mark-1");
  await task("stop-mark-1", "the gap", "task-sm1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("stop-mark-1", "fx:agent.session:task-sm1")).toMatchObject({ status: "awaiting_job" }));
  const [row] = await s.sessions();
  const session = row!.session as string;
  // A stop handled after the start's last look at its row, before the job was waiting, is kept on the row only.
  await runInDurableObject(s, (_i, state) => state.storage.sql.exec("UPDATE _actors_agent_sessions SET stopped_at = ? WHERE key = ?", Date.now(), "task-sm1"));
  await s.probeNow("task-sm1");
  await eventually(async () => expect(await s.failures()).toEqual([{ type: "agent.failed", payload: { session, key: "task-sm1", reason: "stopped" } }]));
  // pi stopped the session: the held model call is cut off and nothing of the session is left to run.
  await eventually(async () => expect((await s.pending()).filter((p) => p.session === session)).toEqual([]), 4000);
  expect(await s.wait("task-sm1", session)).toMatchObject({ status: "unanswered" });
  turn.open();
  await settle(env, system);
  expect(await s.done()).toEqual([]);
});

it("[agent-steer-after-end] a steer that runs after its session ended is refused with a note, and starts no run", async () => {
  const events = captureEvents();
  const held = gate();
  gates.push(held.open);
  const requests: ScriptedRequest[] = [];
  script("steer-late-1", (r) => (requests.push(r), finish({ summary: "done before the hint" })));
  await holdStart("steer-late-1", "hold", held);
  await task("steer-late-1", "the quick one", "task-sl1");
  await reached(held);
  // Handled while the session is starting, so it is queued; it can't go to pi until the start returns.
  expect(await ingress(env, system, "Scribe", "scribe.hint", { text: "too late" }, { key: "steer-late-1", id: "hint-sl1" })).toMatchObject({ status: "handled" });
  await eventually(async () => expect(await jobRow("steer-late-1", "fx:agent.session.steer:hint-sl1")).toMatchObject({ status: "pending", lastError: "the session's start hasn't returned yet" }));
  held.open();
  const s = scribe("steer-late-1");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["done before the hint"]), 4000);
  await settle(env, system); // the steer's retry runs now, after the session ended
  expect(await jobRow("steer-late-1", "fx:agent.session.steer:hint-sl1")).toMatchObject({ status: "failed", lastError: "the session has ended; not steered" });
  expect(notes(events, "Scribe:steer-late-1", "the session has ended; not steered")).toMatchObject([{ effectKey: "hint-sl1", detail: { key: "task-sl1" } }]);
  const [row] = await s.sessions();
  expect(requests).toHaveLength(1);
  expect((await s.messages(row!.session as string)).filter((e) => e.kind === "pi.user")).toHaveLength(1);
  expect((await s.done()).map((d) => d.summary)).toEqual(["done before the hint"]);
});

it("[agent-returns-second-route] the result goes to the agent itself when its returns message also routes elsewhere", async () => {
  expect(system.routes.filter((r) => r.from === "Scribe" && r.message === "scribe.done").map((r) => r.to)).toEqual(["Scribe", "Probe"]);
  const events = captureEvents();
  script("onward-1", () => finish({ summary: "routed" }));
  await task("onward-1", "the forwarded one", "task-o1");
  await eventually(async () => expect((await scribe("onward-1").done()).map((d) => d.summary)).toEqual(["routed"]), 4000);
  expect(events.filter((e) => e.actor === "Scribe:onward-1" && e.kind === "failed")).toEqual([]);
  expect(events.filter((e) => e.kind === "sent" && e.to?.startsWith("Probe:"))).toEqual([]);
});

it("[agent-exhausted-marker] a session marked exhausted ends: the actor hears agent.exhausted, and pi stops the session", async () => {
  const turn = gate();
  gates.push(turn.open);
  const held = async () => {
    await turn.wait();
    return finish({ summary: "too late" });
  };
  script("exhaust-1", held);
  script("exhaust-2", held);
  for (const [name, budget] of [["exhaust-1", "turns"], ["exhaust-2", "tokens"]] as const) {
    turn.reached = false;
    await task(name, "the costly one", `task-${name}`);
    await reached(turn);
    await eventually(async () => expect(await jobRow(name, `fx:agent.session:task-${name}`)).toMatchObject({ status: "awaiting_job" }));
    await runInDurableObject(scribe(name), (_i, state) => state.storage.sql.exec("UPDATE _actors_agent_sessions SET exhausted = ? WHERE key = ?", budget, `task-${name}`));
    await scribe(name).probeNow(`task-${name}`);
  }
  const [one] = await scribe("exhaust-1").sessions();
  await eventually(async () => expect(await scribe("exhaust-1").failures()).toEqual([{ type: "agent.exhausted", payload: { session: one!.session, key: "task-exhaust-1", budget: "turns" } }]));
  expect(await jobRow("exhaust-1", "fx:agent.session:task-exhaust-1")).toMatchObject({ status: "failed", lastError: "exhausted:turns" });
  expect(await scribe("exhaust-1").wait("task-exhaust-1", one!.session as string)).toMatchObject({ status: "unanswered" });
  // A budget the runtime doesn't know isn't agent.exhausted (its schema would refuse it): it is a failure, said as is.
  const [two] = await scribe("exhaust-2").sessions();
  await eventually(async () => expect(await scribe("exhaust-2").failures()).toEqual([{ type: "agent.failed", payload: { session: two!.session, key: "task-exhaust-2", reason: "exhausted:tokens" } }]));
});

it("[agent-in-doubt] a session job past its deadline is in doubt, and the actor hears agent.failed", async () => {
  const turn = gate();
  gates.push(turn.open);
  script("doubt-1", async () => {
    await turn.wait();
    return finish({ summary: "too late" });
  });
  await task("doubt-1", "the endless one", "task-d1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("doubt-1", "fx:agent.session:task-d1")).toMatchObject({ status: "awaiting_job" }));
  expect(await expireJobs(env, system, "Scribe", "doubt-1")).toBe(1);
  const [row] = await scribe("doubt-1").sessions();
  await eventually(async () => expect(await scribe("doubt-1").failures()).toEqual([{ type: "agent.failed", payload: { session: row!.session, key: "task-d1", reason: "deadline passed" } }]));
  expect(await jobRow("doubt-1", "fx:agent.session:task-d1")).toMatchObject({ status: "in_doubt", lastError: "deadline passed" });
  // A job given up on in doubt stops its session: pi aborts the run, so the held model call is cut off.
  await eventually(async () => expect((await scribe("doubt-1").pending()).filter((p) => p.session === row!.session)).toEqual([]), 4000);
  expect(await jobRow("doubt-1", "fx:agent.session.abort:task-d1")).toMatchObject({ status: "confirmed" });
  expect(await scribe("doubt-1").wait("task-d1", row!.session as string)).toMatchObject({ status: "unanswered" });
  // Nothing the model answers now is delivered.
  turn.open();
  await settle(env, system);
  expect(await scribe("doubt-1").done()).toEqual([]);
});

it("[agent-approval-pending] a session with a tool effect awaiting approval isn't done when its run ends; once none waits, it is", async () => {
  const events = captureEvents();
  const turn = gate();
  gates.push(turn.open);
  script("approve-1", async () => {
    await turn.wait();
    return { text: "Waiting for a person to approve the tool call." };
  });
  const s = scribe("approve-1");
  await task("approve-1", "the approved one", "task-ap1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("approve-1", "fx:agent.session:task-ap1")).toMatchObject({ status: "awaiting_job" }));
  const [row] = await s.sessions();
  // A tool effect of this session, keyed "<session>:<callId>" (Task 6 makes these), parked for a person.
  const effectId = `fx:gateway.tool:${row!.session}:call-1`;
  await runInDurableObject(s, (_i, state) =>
    state.storage.sql.exec(
      "INSERT INTO _actors_outbox (id, kind, target, body, status, attempts, next_at, last_error, created_at, seq) VALUES (?, 'effect', 'gateway.tool', ?, 'awaiting_approval', 0, ?, NULL, ?, 0)",
      effectId,
      JSON.stringify({ name: "gateway.tool", key: `${row!.session}:call-1`, input: {}, causationId: "task-ap1", correlationId: "task-ap1" }),
      Date.now() + 3_600_000,
      Date.now(),
    ),
  );
  turn.open();
  // The run ends (pi has nothing pending for the session), and the look that follows finds the approval waiting.
  const probedNotDone = () => events.filter((e) => e.kind === "job.probed" && e.effectKey === "task-ap1" && (e.detail as { done?: boolean }).done === false);
  await eventually(async () => expect(probedNotDone().length).toBeGreaterThan(0));
  await eventually(async () => expect((await s.pending()).filter((p) => p.session === row!.session)).toEqual([]));
  await s.probeNow("task-ap1");
  await eventually(async () => expect(probedNotDone().length).toBeGreaterThan(1));
  expect(await jobRow("approve-1", "fx:agent.session:task-ap1")).toMatchObject({ status: "awaiting_job" });
  expect(await s.failures()).toEqual([]);
  // Once nothing awaits approval, the same look ends the session.
  await runInDurableObject(s, (_i, state) => state.storage.sql.exec("UPDATE _actors_outbox SET status = 'denied' WHERE id = ?", effectId));
  await s.probeNow("task-ap1");
  await eventually(async () => expect(await s.failures()).toEqual([{ type: "agent.failed", payload: { session: row!.session, key: "task-ap1", reason: "ended without returning a result" } }]));
});

// ---- Declared effects as tools ----

type ToolResult = { toolCallId: string; toolName: string; isError: boolean; content: Array<{ type: string; text?: string }> };
const toolResults = (r: ScriptedRequest) => r.lastToolResults as ToolResult[];
const call = (name: string, args: unknown): ScriptedTurn => ({ calls: [{ name, args }] });
/** Every tool result in a session's transcript, as the model saw it. */
const transcriptResults = async (name: string, session: string) => (await scribe(name).messages(session)).flatMap((e) => e.model ?? []).filter((m) => m.role === "toolResult") as unknown as ToolResult[];
/** The outbox row of a tool effect, by the effect and its "<session>:<callId>" key, with its next_at. */
const effectRow = (name: string, effect: string, key: string) =>
  runInDurableObject(scribe(name), (_i, state) => state.storage.sql.exec<{ status: string; attempts: number; next_at: number; last_error: string | null }>("SELECT status, attempts, next_at, last_error FROM _actors_outbox WHERE id = ?", `fx:${effect}:${key}`).toArray()[0]);
const waitingText = (effect: string, key: string, expiresAt: number) =>
  `Waiting for a person to approve ${effect} (request ${key}, expires ${new Date(expiresAt).toISOString()}). The result will arrive as a message; continue with other work or end your turn.`;
/** Waits until pi has no work left in a session, then asks for a look at its job: the look a finished run gets. */
async function runEnded(name: string, session: string, jobKey: string): Promise<void> {
  await eventually(async () => expect((await scribe(name).pending()).filter((p) => p.session === session)).toEqual([]), 5000);
  await scribe(name).probeNow(jobKey);
}

it("[agent-tool-runs-effect] a declared effect is a tool: the model's call runs it once, keyed by session and call, and the model sees its value", async () => {
  const events = captureEvents();
  const requests: ScriptedRequest[] = [];
  script("tool-1", (r) => (requests.push(r), r.turn === 0 ? call("note_keyed", { text: "a" }) : finish({ summary: "noted" })));
  const s = scribe("tool-1");
  await task("tool-1", "the note", "task-t1");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["noted"]), 4000);
  const [row] = await s.sessions();
  const [result] = toolResults(requests[1]!);
  const key = `${row!.session}:${result!.toolCallId}`;
  expect(result).toMatchObject({ toolName: "note_keyed", isError: false });
  expect(text(result!)).toBe('{"noted":"a"}');
  expect(await s.noted()).toEqual([{ effect: "note.keyed", key, text: "a" }]);
  const fx = events.filter((e) => e.effect === "note.keyed" && e.kind.startsWith("effect."));
  expect(fx.map((e) => [e.kind, e.effectKey])).toEqual([["effect.requested", key], ["effect.confirmed", key]]);
  // Caused by the message that started the session.
  expect(fx[0]).toMatchObject({ causationId: "task-t1", correlationId: "task-t1" });
  // Its result message reached the actor, and isn't steered in: the tool already gave the model its value.
  await settle(env, system);
  expect(events.filter((e) => e.kind === "handled" && e.actor === "Scribe:tool-1" && e.type === "scribe.noted")).toHaveLength(1);
  expect((await s.outbox()).filter((r) => r.id.startsWith("fx:agent.session.steer:"))).toEqual([]);
  // Scribe's own handler for the result message got it.
  expect(await s.results()).toEqual([{ key, status: "confirmed" }]);
});

// see [crash-loop-parked]
it("[agent-restart-mid-tool-keyed] a restart while a keyed tool's effect runs: pi reruns the tool with the same call id, which finds the effect's row", async () => {
  const events = captureEvents();
  const held = gate();
  gates.push(held.open);
  let runs = 0;
  overrideEffect("note.keyed", {
    async run(input) {
      if (++runs === 1) await held.wait(); // cut off by the restart
      return { noted: (input as { text: string }).text };
    },
  });
  const requests: ScriptedRequest[] = [];
  script("tool-keyed-1", (r) => (requests.push(r), r.lastToolResults.length === 0 ? call("note_keyed", { text: "k" }) : finish({ summary: "kept" })));
  await task("tool-keyed-1", "the keyed note", "task-tk1");
  await reached(held);
  await abortAllDurableObjects();
  await settle(env, system);
  await eventually(async () => expect((await scribe("tool-keyed-1").done()).map((d) => d.summary)).toEqual(["kept"]), 5000);
  await settle(env, system);
  // The model was asked once to call the tool; the rerun found the effect's row instead of making a second.
  expect(requests.filter((r) => r.lastToolResults.length === 0)).toHaveLength(1);
  const [row] = await scribe("tool-keyed-1").sessions();
  const results = (await transcriptResults("tool-keyed-1", row!.session as string)).filter((r) => r.toolName !== "finish");
  expect(results).toMatchObject([{ toolName: "note_keyed", isError: false }]);
  expect(text(results[0]!)).toBe('{"noted":"k"}');
  const key = `${row!.session}:${results[0]!.toolCallId}`;
  expect((await scribe("tool-keyed-1").outbox()).filter((r) => r.target === "note.keyed")).toMatchObject([{ id: `fx:note.keyed:${key}`, status: "confirmed", attempts: 2 }]);
  // The rerun asked for the same key, so pi kept the call's id, and found the row actord's recovery had queued again.
  // How far that retry had got by then (queued, running, done) depends on a drive racing pi's rerun; the row check
  // above shows there is no second row either way.
  expect(events.filter((e) => e.kind === "effect.duplicate" && e.effect === "note.keyed")).toMatchObject([{ effectKey: key }]);
  // Twice, the most a keyed effect runs here: the attempt the restart cut off, then its retry.
  expect(runs).toBe(2);
}, 20_000);

// see [crash-loop-parked]
it("[agent-restart-mid-tool-unkeyed] a restart while an unkeyed tool's effect runs: the model hears it was interrupted, and actord records it in doubt and never reruns it", async () => {
  const events = captureEvents();
  const held = gate();
  gates.push(held.open);
  let runs = 0;
  overrideEffect("note.plain", {
    async run(input) {
      if (++runs === 1) await held.wait(); // cut off by the restart
      return { noted: (input as { text: string }).text };
    },
  });
  const requests: ScriptedRequest[] = [];
  script("tool-plain-1", (r) => (requests.push(r), r.lastToolResults.length === 0 ? call("note_plain", { text: "p" }) : finish({ summary: "interrupted" })));
  await task("tool-plain-1", "the plain note", "task-tp1");
  await reached(held);
  await abortAllDurableObjects();
  await settle(env, system);
  await eventually(async () => expect((await scribe("tool-plain-1").done()).map((d) => d.summary)).toEqual(["interrupted"]), 5000);
  await settle(env, system);
  const [result] = toolResults(requests.at(-1)!);
  expect(result).toMatchObject({ toolName: "note_plain", isError: true });
  expect(text(result!)).toContain("Tool note_plain was interrupted");
  const [row] = await scribe("tool-plain-1").sessions();
  const key = `${row!.session}:${result!.toolCallId}`;
  expect((await scribe("tool-plain-1").outbox()).filter((r) => r.target === "note.plain")).toMatchObject([{ id: `fx:note.plain:${key}`, status: "in_doubt" }]);
  expect(events.filter((e) => e.kind === "effect.in_doubt" && e.effect === "note.plain")).toMatchObject([{ effectKey: key }]);
  expect(events.filter((e) => e.kind === "retry.scheduled" && e.effect === "note.plain")).toEqual([]);
  expect(runs).toBe(1);
}, 20_000);

it("[agent-tool-approval] a tool that needs approval answers waiting at once; once approved, its result is steered in and the session finishes", async () => {
  const requests: ScriptedRequest[] = [];
  script("tool-approve-1", (r) => {
    requests.push(r);
    if ((users(r).at(-1) ?? "").startsWith("Result of note.approved")) return finish({ summary: "approved" });
    return r.lastToolResults.length === 0 ? call("note_approved", { text: "b" }) : { text: "Waiting for the approval." };
  });
  const s = scribe("tool-approve-1");
  await task("tool-approve-1", "the approved note", "task-ta1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 4000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  const [result] = toolResults(requests[1]!);
  const key = `${session}:${result!.toolCallId}`;
  const parked = await effectRow("tool-approve-1", "note.approved", key);
  expect(parked).toMatchObject({ status: "awaiting_approval" });
  expect(result).toMatchObject({ toolName: "note_approved", isError: false });
  expect(text(result!)).toBe(waitingText("note.approved", key, parked!.next_at));
  // The run ended its turn, and the job still waits: the result is owed to the session.
  await runEnded("tool-approve-1", session, "task-ta1");
  expect(await jobRow("tool-approve-1", "fx:agent.session:task-ta1")).toMatchObject({ status: "awaiting_job" });
  expect(await s.noted()).toEqual([]);
  expect(await s.decide(key, "approve")).toMatchObject({ status: "confirmed", key, value: { noted: "b" } });
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["approved"]), 4000);
  expect(await s.noted()).toEqual([{ effect: "note.approved", key, text: "b" }]);
  // The result started a new run in the session, as input of its own kind, with the operation id "result:<key>".
  expect(users(requests.at(-1)!).at(-1)).toBe(`Result of note.approved (request ${key}): confirmed {"noted":"b"}`);
  expect((await s.messages(session)).filter((e) => e.kind === "actord.effect_result")).toHaveLength(1);
  expect(await s.wait(`result:${key}`, session)).toMatchObject({ status: "done" });
  expect(await jobRow("tool-approve-1", `fx:agent.session.steer:result:${key}`)).toMatchObject({ status: "confirmed" });
  expect(await jobRow("tool-approve-1", "fx:agent.session:task-ta1")).toMatchObject({ status: "confirmed" });
  expect(await s.failures()).toEqual([]);
  // Steered in, and Scribe's own handler for the result message got it too, once.
  await settle(env, system);
  expect(await s.results()).toEqual([{ key, status: "confirmed" }]);
});

it("[agent-tool-result-stale] an approved effect whose result arrives after its session was replaced is only a note: nothing is submitted to either session", async () => {
  const events = captureEvents();
  const requests: ScriptedRequest[] = [];
  // Approved before the replacement, so the replacement doesn't withdraw it (R19); its run is held until then.
  const running = gate();
  gates.push(running.open);
  overrideEffect("note.approved", { run: async (input) => (await running.wait(), { noted: (input as { text: string }).text }) });
  script("tool-stale-1", (r) => {
    requests.push(r);
    if ((users(r)[0] ?? "").includes('"second"')) return finish({ summary: "second" });
    return r.lastToolResults.length === 0 ? call("note_approved", { text: "c" }) : { text: "Waiting for the approval." };
  });
  const s = scribe("tool-stale-1");
  await task("tool-stale-1", "first", "task-ts1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 4000);
  const [first] = await s.sessions();
  const key = `${first!.session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
  await runEnded("tool-stale-1", first!.session as string, "task-ts1");
  const decided = s.decide(key, "approve");
  await reached(running);
  await task("tool-stale-1", "second", "task-ts2");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["second"]), 4000);
  running.open();
  expect(await decided).toMatchObject({ status: "confirmed", key });
  await settle(env, system);
  expect(notes(events, "Scribe:tool-stale-1", "stale tool result")).toMatchObject([{ detail: { key, session: first!.session, generation: 1 } }]);
  expect((await s.outbox()).filter((r) => r.id.startsWith("fx:agent.session.steer:"))).toEqual([]);
  const [, second] = await s.sessions();
  for (const session of [first!.session, second!.session] as string[]) {
    const entries = await s.messages(session);
    expect(entries.filter((e) => e.kind === "actord.effect_result")).toEqual([]);
    expect(entries.flatMap((e) => e.model ?? []).filter((m) => m.role === "user").map(text).filter((t) => t.startsWith("Result of"))).toEqual([]);
  }
  expect((await s.done()).map((d) => d.summary)).toEqual(["second"]);
  expect(await s.failures()).toEqual([]);
  // Noted as stale, and Scribe's own handler for the result message got it all the same, once.
  expect(await s.results()).toEqual([{ key, status: "confirmed" }]);
});

for (const [how, reason] of [["stopped", "the session was stopped"], ["replaced", "the session was replaced"]] as const) {
  it(`[agent-${how === "stopped" ? "stop" : "replace"}-withdraws-approvals] a session ${how} while a tool waits for a person has that approval denied: a later approve changes nothing, and the effect never runs`, async () => {
    const events = captureEvents();
    const name = `withdraw-${how}`;
    const requests: ScriptedRequest[] = [];
    script(name, (r) => {
      requests.push(r);
      if ((users(r)[0] ?? "").includes('"second"')) return finish({ summary: "second" });
      return r.lastToolResults.length === 0 ? call("note_approved", { text: "w" }) : { text: "Waiting for the approval." };
    });
    const s = scribe(name);
    await task(name, "first", `task-${how}1`);
    await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 4000);
    const [row] = await s.sessions();
    const key = `${row!.session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
    expect(await effectRow(name, "note.approved", key)).toMatchObject({ status: "awaiting_approval" });
    await runEnded(name, row!.session as string, `task-${how}1`);
    if (how === "stopped") expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: name, id: `halt-${how}` })).toMatchObject({ status: "handled" });
    else await task(name, "second", `task-${how}2`);
    expect(await effectRow(name, "note.approved", key)).toMatchObject({ status: "denied", last_error: reason });
    expect(events.filter((e) => e.kind === "effect.denied" && e.actor === `Scribe:${name}`)).toMatchObject([{ effect: "note.approved", effectKey: key, reason }]);
    expect(await s.decide(key, "approve")).toMatchObject({ status: "denied", key });
    await settle(env, system);
    expect(await effectRow(name, "note.approved", key)).toMatchObject({ status: "denied", last_error: reason });
    expect(await s.noted()).toEqual([]);
    expect(await s.results()).toEqual([]);
    expect((await s.done()).map((d) => d.summary)).toEqual(how === "stopped" ? [] : ["second"]);
  });
}

it("[agent-tool-undeclared] only the effects in `tools` are offered, and requestEffect refuses an effect the actor doesn't list", async () => {
  const events = captureEvents();
  const held = gate();
  gates.push(held.open);
  script("tool-undeclared-1", async () => {
    await held.wait();
    return finish({ summary: "listed" });
  });
  const s = scribe("tool-undeclared-1");
  await task("tool-undeclared-1", "the tools", "task-tu1");
  await reached(held);
  const [row] = await s.sessions();
  // note.hidden is in Scribe's effects but not its tools; gateway.keyed is another actor's effect.
  expect((await s.offeredTools(row!.session as string)).sort()).toEqual(["finish", "note_approved", "note_keyed", "note_plain", "note_silent"]);
  const refused = await runInDurableObject(s, (instance: Scribe) =>
    instance.actor.requestEffect("gateway.keyed", { key: "x" }, { key: "x" }).then(
      () => "requested",
      (err: Error) => err.message,
    ),
  );
  expect(refused).toBe("Scribe may not request effect gateway.keyed: it isn't in its declared effects");
  expect(events.filter((e) => e.kind === "effect.denied" && e.actor === "Scribe:tool-undeclared-1")).toMatchObject([{ effect: "gateway.keyed", effectKey: "x", reason: "undeclared capability" }]);
  expect((await s.outbox()).filter((r) => r.kind === "effect" && r.target !== "agent.session")).toEqual([]);
  held.open();
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["listed"]), 4000);
});

it("[agent-tool-denied] a person's denial sends no result message, so the session's probe steers it in, and the model hears it failed", async () => {
  const requests: ScriptedRequest[] = [];
  script("tool-deny-1", (r) => {
    requests.push(r);
    if ((users(r).at(-1) ?? "").startsWith("Result of note.approved")) return finish({ summary: "denied" });
    return r.lastToolResults.length === 0 ? call("note_approved", { text: "d" }) : { text: "Waiting for the approval." };
  });
  const s = scribe("tool-deny-1");
  await task("tool-deny-1", "the denied note", "task-td1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 4000);
  const [row] = await s.sessions();
  const key = `${row!.session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
  await runEnded("tool-deny-1", row!.session as string, "task-td1");
  expect(await s.decide(key, "deny")).toMatchObject({ status: "denied", key });
  await s.probeNow("task-td1");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["denied"]), 4000);
  expect(users(requests.at(-1)!).at(-1)).toBe(`Result of note.approved (request ${key}): failed denied by a person`);
  expect(await s.noted()).toEqual([]);
});

it("[agent-tool-result-reaches-handler] an owed tool result reaches the actor's own handler too; when that throws, the delivery is retried and the result is steered in once", async () => {
  const events = captureEvents();
  const requests: ScriptedRequest[] = [];
  script("tool-handler-1", (r) => {
    requests.push(r);
    if ((users(r).at(-1) ?? "").startsWith("Result of note.approved")) return finish({ summary: "handled" });
    return r.lastToolResults.length === 0 ? call("note_approved", { text: "h" }) : { text: "Waiting for the approval." };
  });
  const s = scribe("tool-handler-1");
  await task("tool-handler-1", "the handled note", "task-th1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 4000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  const key = `${session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
  await runEnded("tool-handler-1", session, "task-th1");
  // Scribe's scribe.noted handler throws at the result's first delivery.
  shared.__scribeNotedThrows = { "tool-handler-1": 1 };
  try {
    expect(await s.decide(key, "approve")).toMatchObject({ status: "confirmed", key });
    const failed = () => events.filter((e) => e.kind === "failed" && e.actor === "Scribe:tool-handler-1" && e.type === "scribe.noted");
    await eventually(async () => expect(failed()).toHaveLength(1));
    // The throw rolled back the whole delivery, the steer it queued included.
    expect(await jobRow("tool-handler-1", `fx:agent.session.steer:result:${key}`)).toBeUndefined();
    expect(await s.results()).toEqual([]);
    await settle(env, system); // the delivery's retry
    await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["handled"]), 4000);
    expect(failed()).toHaveLength(1);
  } finally {
    delete shared.__scribeNotedThrows;
  }
  await settle(env, system);
  expect(await s.results()).toEqual([{ key, status: "confirmed" }]);
  // One steer, requested once; one result in the session, and the model saw it once. (Whether the probe's backstop
  // also asked for that steer, as a duplicate, depends on whether a look fell between the failure and the retry.)
  expect(events.filter((e) => e.kind === "effect.requested" && e.effect === "agent.session.steer").map((e) => e.effectKey)).toEqual([`result:${key}`]);
  expect(await jobRow("tool-handler-1", `fx:agent.session.steer:result:${key}`)).toMatchObject({ status: "confirmed", attempts: 1 });
  expect((await s.messages(session)).filter((e) => e.kind === "actord.effect_result")).toHaveLength(1);
  expect(users(requests.at(-1)!).filter((t) => t.startsWith("Result of"))).toHaveLength(1);
});

it("[agent-tool-approval-no-result] an approved effect with no result message is steered in by the session's probe", async () => {
  const events = captureEvents();
  const requests: ScriptedRequest[] = [];
  script("tool-silent-1", (r) => {
    requests.push(r);
    if ((users(r).at(-1) ?? "").startsWith("Result of note.silent")) return finish({ summary: "silent" });
    return r.lastToolResults.length === 0 ? call("note_silent", { text: "s" }) : { text: "Waiting for the approval." };
  });
  const s = scribe("tool-silent-1");
  await task("tool-silent-1", "the silent note", "task-tq1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 4000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  const key = `${session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
  await runEnded("tool-silent-1", session, "task-tq1");
  expect(await s.decide(key, "approve")).toMatchObject({ status: "confirmed", key, value: { noted: "s" } });
  await settle(env, system);
  // Nothing comes back by message: the job still waits on the result it is owed.
  expect(events.filter((e) => e.kind === "sent" && e.actor === "Scribe:tool-silent-1" && e.effect === "note.silent")).toEqual([]);
  expect(await jobRow("tool-silent-1", "fx:agent.session:task-tq1")).toMatchObject({ status: "awaiting_job" });
  // The next look at the session steers it in from the effect's row.
  await s.probeNow("task-tq1");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["silent"]), 4000);
  expect(users(requests.at(-1)!).at(-1)).toBe(`Result of note.silent (request ${key}): confirmed {"noted":"s"}`);
  expect(await jobRow("tool-silent-1", `fx:agent.session.steer:result:${key}`)).toMatchObject({ status: "confirmed" });
  expect(await s.noted()).toEqual([{ effect: "note.silent", key, text: "s" }]);
});

it("[agent-tool-result-steer-in-doubt] a result steer that ends in doubt gives up its wait, so the session ends instead of waiting out its deadline", async () => {
  const requests: ScriptedRequest[] = [];
  script("tool-steer-doubt-1", (r) => (requests.push(r), r.lastToolResults.length === 0 ? call("note_approved", { text: "q" }) : { text: "Waiting for the approval." }));
  const s = scribe("tool-steer-doubt-1");
  await task("tool-steer-doubt-1", "the lost result", "task-tsd1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 4000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  const key = `${session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
  await runEnded("tool-steer-doubt-1", session, "task-tsd1");
  // pi refuses the result's input, and the steer gets one attempt: it ends in doubt.
  overrideEffectBudget("agent.session.steer", { maxAttempts: 1 });
  await runInDurableObject(s, (instance: Scribe) => {
    const harness = instance.actor.harness;
    const open = harness.session.bind(harness);
    harness.session = ((id: string) =>
      new Proxy(open(id), {
        get: (target, prop) => (prop === "submit" ? async () => Promise.reject(new Error("pi refused the input")) : ((v) => (typeof v === "function" ? v.bind(target) : v))(Reflect.get(target, prop, target))),
      })) as typeof harness.session;
  });
  expect(await s.decide(key, "approve")).toMatchObject({ status: "confirmed", key });
  await eventually(async () => expect(await jobRow("tool-steer-doubt-1", `fx:agent.session.steer:result:${key}`)).toMatchObject({ status: "in_doubt", lastError: "pi refused the input" }));
  expect(await jobRow("tool-steer-doubt-1", "fx:agent.session:task-tsd1")).toMatchObject({ status: "awaiting_job" });
  // The next look gives the wait up; with no work left in pi, the session ends.
  await s.probeNow("task-tsd1");
  await eventually(async () => expect(await s.failures()).toEqual([{ type: "agent.failed", payload: { session, key: "task-tsd1", reason: "ended without returning a result" } }]), 4000);
  expect(await runInDurableObject(s, (_i, state) => state.storage.sql.exec("SELECT done_at FROM _actors_agent_waits WHERE key = ?", key).one().done_at)).toEqual(expect.any(Number));
  expect(await s.done()).toEqual([]);
});

// ---- Budgets ----

/**
 * The tool the budget tests' sessions call every turn: a keyed note, so a turn's tool round always has work. Past 10
 * requests the model gives up, so a budget that doesn't stop the session fails the test instead of running forever.
 */
const noteEvery = (r: ScriptedRequest, usage?: ScriptedTurn["usage"]): ScriptedTurn => (r.turn >= 10 ? { text: "No budget stopped this session." } : { ...call("note_keyed", { text: `turn ${r.turn}` }), ...(usage ? { usage } : {}) });
type Exhausted = { type: string; payload: { session: string; key: string; budget: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } } };

it("[agent-exhausted-turns] a session that calls tools forever is aborted once it has used its turns: at most one request past the limit", async () => {
  overrideBudget("Scribe", { turns: 3 });
  const requests: ScriptedRequest[] = [];
  script("turns-1", (r) => (requests.push(r), noteEvery(r)));
  const s = scribe("turns-1");
  await task("turns-1", "the endless one", "task-tn1");
  await eventually(async () => expect((await s.failures()).map((f) => f.type)).toEqual(["agent.exhausted"]), 4000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  expect((await s.failures())[0]).toMatchObject({ type: "agent.exhausted", payload: { session, key: "task-tn1", budget: "turns" } });
  expect(row).toMatchObject({ exhausted: "turns", result: null });
  expect(await jobRow("turns-1", "fx:agent.session:task-tn1")).toMatchObject({ status: "failed", lastError: "exhausted:turns" });
  // pi stopped the session: nothing of it is left to run, and no more requests follow.
  await eventually(async () => expect((await s.pending()).filter((p) => p.session === session)).toEqual([]), 4000);
  await settle(env, system);
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(requests.length).toBeLessThanOrEqual(4);
  expect((await s.failures()).map((f) => f.type)).toEqual(["agent.exhausted"]);
  expect(await s.done()).toEqual([]);
});

it("[agent-exhausted-usd] a session whose turns cost $0.40 each, with usd: 1, is exhausted after its third request, and its usage says what it spent", async () => {
  const events = captureEvents();
  const requests: ScriptedRequest[] = [];
  script("usd-1", (r) => (requests.push(r), noteEvery(r, { input: 100, output: 10, costUsd: 0.4 })));
  const s = scribe("usd-1");
  await task("usd-1", "the costly one", "task-u1");
  await eventually(async () => expect((await s.failures()).map((f) => f.type)).toEqual(["agent.exhausted"]), 4000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  const [exhausted] = (await s.failures()) as unknown as Exhausted[];
  expect(exhausted).toMatchObject({ type: "agent.exhausted", payload: { session, key: "task-u1", budget: "usd" } });
  await eventually(async () => expect((await s.pending()).filter((p) => p.session === session)).toEqual([]), 4000);
  await settle(env, system);
  // Three requests reach $1.20; a fourth may have been in flight when the abort landed.
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(requests.length).toBeLessThanOrEqual(4);
  const usage = exhausted!.payload.usage!;
  expect(usage.costUsd).toBeGreaterThanOrEqual(1.2 - 1e-9);
  expect(usage.costUsd).toBeLessThanOrEqual(1.6 + 1e-9);
  // Tokens are reported beside the cost, in step with it: 100 in and 10 out per $0.40 turn.
  expect(usage.inputTokens).toBeCloseTo((usage.costUsd! / 0.4) * 100, 6);
  expect(usage.outputTokens).toBeCloseTo((usage.costUsd! / 0.4) * 10, 6);
  // The job's own events carry the same usage.
  expect(events.filter((e) => e.kind === "effect.failed" && e.effect === "agent.session" && e.effectKey === "task-u1")).toMatchObject([{ reason: "exhausted:usd", detail: { usage } }]);
  expect((await s.failures()).map((f) => f.type)).toEqual(["agent.exhausted"]);
});

it("[agent-exhausted-wallclock] a session past its wallClock is exhausted while its model call is held, and pi aborts it", async () => {
  overrideBudget("Scribe", { wallClock: "50ms" });
  const turn = gate();
  gates.push(turn.open);
  script("wall-1", async () => {
    await turn.wait();
    return finish({ summary: "too late" });
  });
  const s = scribe("wall-1");
  const started = Date.now();
  await task("wall-1", "the slow one", "task-w1");
  await eventually(async () => expect((await s.failures()).map((f) => f.type)).toEqual(["agent.exhausted"]), 4000);
  // Its wallClock, not the job's 30s probe period, ended it.
  expect(Date.now() - started).toBeLessThan(30_000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  expect(await s.failures()).toEqual([{ type: "agent.exhausted", payload: { session, key: "task-w1", budget: "wallClock" } }]);
  expect(await jobRow("wall-1", "fx:agent.session:task-w1")).toMatchObject({ status: "failed", lastError: "exhausted:wallClock" });
  await eventually(async () => expect((await s.pending()).filter((p) => p.session === session)).toEqual([]), 4000);
  expect(await s.wait("task-w1", session)).toMatchObject({ status: "unanswered" });
  turn.open();
  await settle(env, system);
  expect(await s.done()).toEqual([]);
});

// see [crash-loop-parked]
it("[agent-exhausted-after-restart] the turns budget reached while the instance restarts is enforced from its start: at most one request past the limit, and agent.exhausted once", async () => {
  overrideBudget("Scribe", { turns: 3 });
  const cut = gate();
  gates.push(cut.open);
  let calls = 0;
  let watchedAtResume: string[] | undefined;
  script("turns-restart-1", async (r) => {
    calls++;
    // The third request is cut off by the restart; pi asks again once it resumes the run, by itself.
    if (calls === 3) await cut.wait();
    // The resumed request: the restarted instance already watches the session, so pi resumed it only after that.
    if (calls === 4) watchedAtResume = shared.__scribes?.["turns-restart-1"]?.watched();
    return noteEvery(r);
  });
  await task("turns-restart-1", "the restarted one", "task-tr1");
  await reached(cut);
  await abortAllDurableObjects();
  await settle(env, system);
  // No look is asked for: the instance's start watches the session again, counting the two turns before the restart.
  const s = scribe("turns-restart-1");
  await eventually(async () => expect((await s.failures()).map((f) => f.type)).toEqual(["agent.exhausted"]), 5000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  expect((await s.failures())[0]).toMatchObject({ payload: { session, key: "task-tr1", budget: "turns" } });
  await eventually(async () => expect((await s.pending()).filter((p) => p.session === session)).toEqual([]), 5000);
  // Another look, and the rest of the system's work, deliver nothing more.
  await s.probeNow("task-tr1");
  await settle(env, system);
  expect((await s.failures()).map((f) => f.type)).toEqual(["agent.exhausted"]);
  // Two turns, the cut-off request and its resumption (the third turn), and at most one request past the limit.
  expect(calls).toBeGreaterThanOrEqual(4);
  expect(calls).toBeLessThanOrEqual(5);
  expect(watchedAtResume).toEqual(["task-tr1"]);
  expect(await jobRow("turns-restart-1", "fx:agent.session:task-tr1")).toMatchObject({ status: "failed", lastError: "exhausted:turns" });
  expect(await s.watched()).toEqual([]);
}, 20_000);

it("[agent-stop-reports-usage] a session stopped mid-run settles with what it spent, though no look had reported it", async () => {
  const turn = gate();
  gates.push(turn.open);
  script("stop-usage-1", async (r) => {
    if (r.turn === 0) return { ...call("note_keyed", { text: "paid" }), usage: { input: 50, output: 5, costUsd: 0.1 } };
    await turn.wait();
    return finish({ summary: "too late" });
  });
  const s = scribe("stop-usage-1");
  await task("stop-usage-1", "the paid one", "task-su1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("stop-usage-1", "fx:agent.session:task-su1")).toMatchObject({ status: "awaiting_job" }));
  expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: "stop-usage-1", id: "halt-su1" })).toMatchObject({ status: "handled" });
  const [row] = await s.sessions();
  await eventually(async () => expect(await s.failures()).toEqual([{ type: "agent.failed", payload: { session: row!.session, key: "task-su1", reason: "stopped", usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.1 } } }]), 4000);
  expect(await s.job("task-su1")).toMatchObject({ settledBy: "cancel", usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.1 } });
});

it("[agent-guard-not-after-settle] a look that ends after its session's job settled doesn't watch the session again", async () => {
  const turn = gate();
  const look = gate();
  gates.push(turn.open, look.open);
  script("guard-late-1", async () => {
    await turn.wait();
    return finish({ summary: "too late" });
  });
  const s = scribe("guard-late-1");
  await task("guard-late-1", "the stale look", "task-gl1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("guard-late-1", "fx:agent.session:task-gl1")).toMatchObject({ status: "awaiting_job" }));
  expect(await s.watched()).toEqual(["task-gl1"]);
  // The next look reads pi's work (the held run), then waits, while a stop settles the job.
  await runInDurableObject(s, (instance: Scribe) => {
    const harness = instance.actor.harness;
    const pending = harness.pending.bind(harness);
    let held = false;
    harness.pending = async (options) => {
      const found = await pending(options);
      if (!held && options?.session) {
        held = true;
        await look.wait();
      }
      return found;
    };
  });
  await s.probeNow("task-gl1");
  await reached(look);
  expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: "guard-late-1", id: "halt-gl1" })).toMatchObject({ status: "handled" });
  await eventually(async () => expect((await s.failures()).map((f) => f.payload.reason)).toEqual(["stopped"]), 4000);
  expect(await s.watched()).toEqual([]);
  // The look goes on with what it read before the stop: the run looked busy. It must not watch a settled session.
  look.open();
  await settle(env, system);
  expect(await s.watched()).toEqual([]);
});

it("[agent-budget-watch-fails] a budget watcher pi refuses is noted and dropped, and the next look watches the session again", async () => {
  const events = captureEvents();
  const turn = gate();
  gates.push(turn.open);
  script("watch-fail-1", async () => {
    await turn.wait();
    return finish({ summary: "watched" });
  });
  const s = scribe("watch-fail-1");
  // pi refuses to watch the session's events until the test lets it through: the harness hands out a stand-in for pi,
  // which reaches the real one for everything except pi's event views, which don't know it.
  const refusing = globalThis as { __refuseEvents?: boolean };
  refusing.__refuseEvents = true;
  try {
    await runInDurableObject(s, (instance: Scribe) => {
      const harness = instance.actor.harness;
      const open = harness.pi.bind(harness);
      harness.pi = async () => {
        const pi = await open();
        return refusing.__refuseEvents ? new Proxy(pi, { get: (target, prop) => ((v) => (typeof v === "function" ? v.bind(target) : v))(Reflect.get(target, prop, target)) }) : pi;
      };
    });
    await task("watch-fail-1", "the unwatched one", "task-wf1");
    await reached(turn);
    const failed = () => events.filter((e) => e.kind === "note" && e.actor === "Scribe:watch-fail-1" && e.reason?.startsWith("budget watcher failed: "));
    await eventually(async () => expect(failed()).toMatchObject([{ effect: "agent.session", effectKey: "task-wf1" }]));
    expect(await s.watched()).toEqual([]);
    refusing.__refuseEvents = false;
    await s.probeNow("task-wf1");
    await eventually(async () => expect(await s.watched()).toEqual(["task-wf1"]));
  } finally {
    delete refusing.__refuseEvents;
  }
  turn.open();
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["watched"]), 4000);
  expect(await s.watched()).toEqual([]);
});

it("[agent-exhausted-awaiting-approval] wallClock runs on while a tool waits for approval: the session is exhausted, the effect stays parked, and its later result is a note", async () => {
  const events = captureEvents();
  const requests: ScriptedRequest[] = [];
  script("wall-approve-1", (r) => (requests.push(r), r.lastToolResults.length === 0 ? call("note_approved", { text: "w" }) : { text: "Waiting for the approval." }));
  const s = scribe("wall-approve-1");
  await task("wall-approve-1", "the parked one", "task-wa1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 4000);
  const [row] = await s.sessions();
  const session = row!.session as string;
  const key = `${session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
  await runEnded("wall-approve-1", session, "task-wa1");
  expect(await effectRow("wall-approve-1", "note.approved", key)).toMatchObject({ status: "awaiting_approval" });
  expect(await jobRow("wall-approve-1", "fx:agent.session:task-wa1")).toMatchObject({ status: "awaiting_job" });
  // The time spent waiting for the person counts: with a wallClock shorter than it, the next look exhausts the session.
  overrideBudget("Scribe", { wallClock: "50ms" });
  await new Promise((r) => setTimeout(r, 60));
  await s.probeNow("task-wa1");
  await eventually(async () => expect(await s.failures()).toEqual([{ type: "agent.exhausted", payload: { session, key: "task-wa1", budget: "wallClock" } }]), 4000);
  expect(await effectRow("wall-approve-1", "note.approved", key)).toMatchObject({ status: "awaiting_approval" });
  // Approved later, its result reaches the actor's own handler, and the ended session only as a note.
  expect(await s.decide(key, "approve")).toMatchObject({ status: "confirmed", key });
  await settle(env, system);
  expect(notes(events, "Scribe:wall-approve-1", "stale tool result")).toMatchObject([{ detail: { key, session } }]);
  expect((await s.outbox()).filter((r) => r.id.startsWith("fx:agent.session.steer:"))).toEqual([]);
  expect((await s.messages(session)).filter((e) => e.kind === "actord.effect_result")).toEqual([]);
  expect(await s.results()).toEqual([{ key, status: "confirmed" }]);
  expect((await s.failures()).map((f) => f.type)).toEqual(["agent.exhausted"]);
  expect(requests).toHaveLength(2);
});

/** The agent.* events of a session's key, from the captured events. */
const agentEvents = (events: ActorEvent[], key: string) => events.filter((e) => e.kind.startsWith("agent.") && e.effectKey === key);

it("[agent-events] a two-turn session with one tool records agent.started, two agent.turn, one agent.tool and agent.ended, in order, each with the session", async () => {
  const events = captureEvents();
  script("events-1", (r) => (r.turn === 0 ? call("note_keyed", { text: "secret text" }) : finish({ summary: "noted" })));
  const s = scribe("events-1");
  await task("events-1", "the note", "task-ev1");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["noted"]), 4000);
  await eventually(async () => expect(agentEvents(events, "task-ev1").map((e) => e.kind)).toContain("agent.ended"));
  const [row] = await s.sessions();
  const session = row!.session as string;
  const mine = agentEvents(events, "task-ev1");
  // finish isn't recorded as a tool call. The second turn's turn_end can reach the watcher after the session settled:
  // then the end records it, as late, so the sequence is the same either way.
  expect(mine.map((e) => e.kind)).toEqual(["agent.started", "agent.tool", "agent.turn", "agent.turn", "agent.ended"]);
  for (const e of mine) expect(e).toMatchObject({ actor: "Scribe:events-1", effect: "agent.session", effectKey: "task-ev1", detail: { session, key: "task-ev1" } });
  expect(mine.filter((e) => e.kind === "agent.turn").map((e) => e.detail?.turn)).toEqual([1, 2]);
  const tool = mine.find((e) => e.kind === "agent.tool" && e.detail?.tool === "note_keyed")!;
  // The effect request's key, so the event leads to the effect; the arguments aren't in the event.
  expect(tool.detail).toEqual({ session, key: "task-ev1", tool: "note_keyed", callId: expect.any(String), effectKey: `${session}:${tool.detail!.callId}` });
  expect(JSON.stringify(mine)).not.toContain("secret text");
  const ended = mine.find((e) => e.kind === "agent.ended")!;
  expect(ended.detail).toMatchObject({ outcome: "confirmed", turns: 2 });
  // The events name the transcript's object and never hold it.
  expect(ended.detail).toMatchObject({ transcript: `transcripts/Scribe/task-ev1/${session}.json` });
  expect(JSON.stringify(mine)).not.toContain("noted\"");
});

it("[agent-transcript-r2] with an R2 binding, agent.ended writes the transcript as JSON to transcripts/<actor>/<key>/<session>.json and names it", async () => {
  const events = captureEvents();
  script("r2-1", (r) => (r.turn === 0 ? call("note_keyed", { text: "a" }) : finish({ summary: "stored" })));
  const s = scribe("r2-1");
  await task("r2-1", "the note", "task-r2");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["stored"]), 4000);
  await eventually(async () => expect(agentEvents(events, "task-r2").map((e) => e.kind)).toContain("agent.ended"));
  const [row] = await s.sessions();
  const name = `transcripts/Scribe/task-r2/${row!.session}.json`;
  expect(agentEvents(events, "task-r2").find((e) => e.kind === "agent.ended")!.detail).toMatchObject({ transcript: name });
  const object = await env.TRANSCRIPTS.get(name);
  expect(object).not.toBeNull();
  const transcript = JSON.parse(await object!.text()) as unknown[];
  expect(Array.isArray(transcript)).toBe(true);
  expect(JSON.stringify(transcript)).toContain("stored");
  // What the harness reports as the session's messages.
  expect(transcript).toEqual(JSON.parse(JSON.stringify(await s.messages(row!.session as string))));
});

it("[agent-events-in-doubt] a session job expired in doubt records one agent.ended, with the in-doubt outcome and its transcript", async () => {
  const events = captureEvents();
  const turn = gate();
  gates.push(turn.open);
  script("endeddoubt-1", async () => {
    await turn.wait();
    return finish({ summary: "too late" });
  });
  await task("endeddoubt-1", "the endless one", "task-ed1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("endeddoubt-1", "fx:agent.session:task-ed1")).toMatchObject({ status: "awaiting_job" }));
  expect(await expireJobs(env, system, "Scribe", "endeddoubt-1")).toBe(1);
  const [row] = await scribe("endeddoubt-1").sessions();
  await eventually(async () => expect(agentEvents(events, "task-ed1").map((e) => e.kind)).toContain("agent.ended"));
  await settle(env, system);
  const ended = agentEvents(events, "task-ed1").filter((e) => e.kind === "agent.ended");
  expect(ended).toHaveLength(1);
  expect(ended[0]).toMatchObject({ reason: "deadline passed", detail: { session: row!.session, outcome: "in_doubt", transcript: `transcripts/Scribe/task-ed1/${row!.session}.json` } });
  expect(await env.TRANSCRIPTS.get(`transcripts/Scribe/task-ed1/${row!.session}.json`)).not.toBeNull();
});

it("[agent-in-doubt-end-after-commit] an in-doubt settlement reads pi and writes the transcript after its handler commits, so a slow read holds up none of the actor's other messages", { timeout: 20_000 }, async () => {
  const events = captureEvents();
  const turn = gate();
  gates.push(turn.open);
  script("wedge-1", async () => {
    await turn.wait();
    return finish({ summary: "too late" });
  });
  await task("wedge-1", "the endless one", "task-w1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("wedge-1", "fx:agent.session:task-w1")).toMatchObject({ status: "awaiting_job" }));
  // Recording the session's end reads its transcript from pi; hold that read.
  const read = gate();
  gates.push(read.open);
  await runInDurableObject(scribe("wedge-1"), (instance: Scribe) => {
    const harness = instance.actor.harness;
    const messages = harness.messages.bind(harness);
    harness.messages = async (...args: Parameters<typeof messages>) => {
      await read.wait();
      return messages(...args);
    };
  });
  const expired = expireJobs(env, system, "Scribe", "wedge-1");
  await reached(read);
  // Inside the handler's transaction, the held read would hold the object's input gate, and this tick with it.
  const tick = ingress(env, system, "Scribe", "scribe.tick", { key: "after-w1" }, { key: "wedge-1" });
  const first = await Promise.race([tick.then(() => "tick handled"), new Promise((r) => setTimeout(() => r("tick held"), 2_000))]);
  read.open();
  expect(first).toBe("tick handled");
  expect(await expired).toBe(1);
  expect(await scribe("wedge-1").fired()).toEqual(["after-w1"]);
  const [row] = await scribe("wedge-1").sessions();
  await eventually(async () => expect(await scribe("wedge-1").failures()).toEqual([{ type: "agent.failed", payload: { session: row!.session, key: "task-w1", reason: "deadline passed" } }]));
  await eventually(async () => expect(agentEvents(events, "task-w1").filter((e) => e.kind === "agent.ended")).toMatchObject([{ reason: "deadline passed", detail: { outcome: "in_doubt" } }]));
});

/** Hold the first call of `method` on instance `name`'s harness until `g` opens; later calls go straight through. */
async function holdHarness(name: string, method: "abort" | "messages", g: ReturnType<typeof gate>): Promise<void> {
  await runInDurableObject(scribe(name), (instance: Scribe) => {
    const harness = instance.actor.harness as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const real = harness[method]!.bind(harness);
    let held = false;
    harness[method] = async (...args: unknown[]) => {
      if (!held) {
        held = true;
        await g.wait();
      }
      return real(...args);
    };
  });
}

it("[agent-ended-cancel-confirmed] a stop whose cancel is confirmed records agent.ended cancelled, however long the transcript takes to write", async () => {
  const events = captureEvents();
  const turn = gate();
  gates.push(turn.open);
  script("cancel-ok-1", async () => (await turn.wait(), finish({ summary: "never" })));
  overrideEffectBudget("agent.session", { timeoutMs: 1_000 });
  await task("cancel-ok-1", "the stop", "task-co1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("cancel-ok-1", "fx:agent.session:task-co1")).toMatchObject({ status: "awaiting_job" }));
  // Recording the end reads the transcript: hold that read past the cancel's timeout.
  const read = gate();
  gates.push(read.open);
  await holdHarness("cancel-ok-1", "messages", read);
  expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: "cancel-ok-1", id: "halt-co1" })).toMatchObject({ status: "handled" });
  await reached(read);
  await new Promise((r) => setTimeout(r, 1_500));
  expect(await jobRow("cancel-ok-1", "fx:agent.session:task-co1")).toMatchObject({ status: "failed", lastError: "cancelled" });
  read.open();
  await eventually(async () => expect(agentEvents(events, "task-co1").filter((e) => e.kind === "agent.ended")).toMatchObject([{ detail: { outcome: "cancelled" } }]));
  await settle(env, system);
  expect(agentEvents(events, "task-co1").filter((e) => e.kind === "agent.ended")).toHaveLength(1);
});

it("[agent-ended-cancel-late] a stop whose cancel answers past its timeout records agent.ended in doubt, as the job settled, never cancelled", async () => {
  const events = captureEvents();
  const turn = gate();
  gates.push(turn.open);
  script("cancel-late-1", async () => (await turn.wait(), finish({ summary: "never" })));
  overrideEffectBudget("agent.session", { timeoutMs: 1_000 });
  await task("cancel-late-1", "the slow stop", "task-cl1");
  await reached(turn);
  await eventually(async () => expect(await jobRow("cancel-late-1", "fx:agent.session:task-cl1")).toMatchObject({ status: "awaiting_job" }));
  // The cancel's abort answers only once the job has settled in doubt; the abort the settlement queues goes through.
  const late = gate();
  gates.push(late.open);
  await holdHarness("cancel-late-1", "abort", late);
  expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: "cancel-late-1", id: "halt-cl1" })).toMatchObject({ status: "handled" });
  await eventually(async () => expect(await jobRow("cancel-late-1", "fx:agent.session:task-cl1")).toMatchObject({ status: "in_doubt", lastError: "cancel not confirmed" }), 4_000);
  await eventually(async () => expect(agentEvents(events, "task-cl1").filter((e) => e.kind === "agent.ended")).toMatchObject([{ reason: "cancel not confirmed", detail: { outcome: "in_doubt" } }]));
  late.open();
  await settle(env, system);
  expect(agentEvents(events, "task-cl1").filter((e) => e.kind === "agent.ended")).toHaveLength(1);
}, 10_000);

it("[agent-ended-start-refused] a start refused after pi opened its session records agent.ended", async () => {
  const events = captureEvents();
  script("start-refused-1", () => finish({ summary: "should not arrive" }));
  // The first try opens the session, then fails at its submit; the stop lands while it waits to be tried again.
  await runInDurableObject(scribe("start-refused-1"), (instance: Scribe) => {
    const harness = instance.actor.harness;
    const session = harness.session.bind(harness);
    let failed = false;
    harness.session = (id: string) => {
      const s = session(id);
      const submit = s.submit.bind(s);
      s.submit = async (...args: Parameters<typeof submit>) => {
        if (failed) return submit(...args);
        failed = true;
        throw new Error("the test failed this submit");
      };
      return s;
    };
  });
  await task("start-refused-1", "the refused one", "task-sr1");
  await eventually(async () => expect(await jobRow("start-refused-1", "fx:agent.session:task-sr1")).toMatchObject({ status: "pending", attempts: 1 }));
  const [row] = await scribe("start-refused-1").sessions();
  expect(row!.session).not.toBeNull();
  expect(await ingress(env, system, "Scribe", "scribe.halt", {}, { key: "start-refused-1", id: "halt-sr1" })).toMatchObject({ status: "handled" });
  await settle(env, system); // the retry runs now, and finds the stop
  expect(await jobRow("start-refused-1", "fx:agent.session:task-sr1")).toMatchObject({ status: "failed", lastError: "stopped" });
  await eventually(async () => expect(agentEvents(events, "task-sr1").filter((e) => e.kind === "agent.ended")).toMatchObject([{ reason: "stopped", detail: { session: row!.session, outcome: "failed" } }]));
  expect(await scribe("start-refused-1").failures()).toEqual([{ type: "agent.failed", payload: { session: row!.session, key: "task-sr1", reason: "stopped" } }]);
});

// ---- Git from the Durable Object (Task 10) ----

const TOKEN = "ghs_sekrit-installation-token-0123456789";
const REPO = "https://github.com/acme/repo.git";
type PushCall = { dir?: string; url?: string; corsProxy?: string; remote?: string; ref?: string; remoteRef?: string; headers?: Record<string, string> };

/** A workspace whose git client is a spy: pushes go to `onPush`, clones are recorded. */
function spyWorkspace(state: DurableObjectState, onPush: (call: PushCall) => { ok: boolean; error: string | null; refs: Record<string, unknown> } = () => ({ ok: true, error: null, refs: {} })) {
  const pushes: PushCall[] = [];
  const clones: Array<Record<string, unknown>> = [];
  const git = {
    async clone(options: Record<string, unknown>) {
      clones.push(options);
    },
    async configGet() {
      return undefined;
    },
    async push(options: PushCall) {
      pushes.push(options);
      return onPush(options);
    },
  } as unknown as GitClient;
  const workspace = new Workspace({ storage: state.storage as unknown as DurableObjectStorageLike, git: () => git });
  return { workspace, pushes, clones };
}

/** Every row of every table in the object's storage, as one string: what could carry a leaked token. */
function everything(state: DurableObjectState): string {
  const sql = state.storage.sql;
  const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").toArray();
  return tables.map((t) => JSON.stringify(sql.exec(`SELECT * FROM "${t.name}"`).toArray())).join("\n");
}

it("[git-push-header-only] the token reaches the git client as a header, and nowhere else", async () => {
  // That no secret reaches the container is [workspace-local-only-passed-to-backend]'s evidence: git runs here, not there.
  await runInDurableObject(scribe("git-header"), async (_i, state) => {
    const { workspace, pushes, clones } = spyWorkspace(state);
    await gitClone(workspace, { url: "https://github.com/acme/repo", dir: "/repo", token: async () => TOKEN });
    const adapter = gitPushEffect({ workspace: () => workspace, dir: "/repo", url: REPO, token: async () => TOKEN });
    const out = await adapter.run({ branch: "factory/one" }, { key: "k1", attempt: 1, signal: new AbortController().signal, reportUsage() {} });
    expect(clones).toHaveLength(1);
    expect(clones[0]).toMatchObject({ url: "https://github.com/acme/repo", dir: "/repo", singleBranch: true, corsProxy: "", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(clones[0]!.depth).toBeUndefined();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ dir: "/repo", url: REPO, corsProxy: "", ref: "factory/one", remoteRef: "refs/heads/factory/one", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(everything(state)).not.toContain(TOKEN);
    expect(everything(state)).not.toContain(btoa(`x-access-token:${TOKEN}`));
  });
});

it("[git-push-header-only] falls back to Basic when Bearer is refused, and scrubs the token from a final error", async () => {
  await runInDurableObject(scribe("git-basic"), async (_i, state) => {
    const basic = `Basic ${btoa(`x-access-token:${TOKEN}`)}`;
    const refused = spyWorkspace(state, (call) => (call.headers?.Authorization?.startsWith("Bearer") ? { ok: false, error: "401 Unauthorized", refs: {} } : { ok: true, error: null, refs: {} }));
    const run = (w: Workspace) => gitPushEffect({ workspace: () => w, dir: "/repo", url: REPO, token: async () => TOKEN }).run({ branch: "factory/x" }, { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage() {} });
    await run(refused.workspace);
    expect(refused.pushes.map((p) => p.headers?.Authorization)).toEqual([`Bearer ${TOKEN}`, basic]);

    const failing = spyWorkspace(state, (call) => {
      throw Object.assign(new Error(`403 denied for ${call.headers?.Authorization} (${TOKEN}, ${btoa(`x-access-token:${TOKEN}`)})`), { status: 403 });
    });
    const err = await run(failing.workspace).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(TOKEN);
    expect(err!.message).not.toContain(btoa(`x-access-token:${TOKEN}`));
  });
});

it("[git-push-only-factory-branches] a branch outside factory/ is rejected before git is called", async () => {
  await runInDurableObject(scribe("git-main"), async (_i, state) => {
    const { workspace, pushes } = spyWorkspace(state);
    const adapter = gitPushEffect({ workspace: () => workspace, dir: "/repo", url: REPO, token: async () => TOKEN });
    const err = await adapter.run({ branch: "main" }, { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage() {} }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EffectRejected);
    expect((err as Error).message).toBe("may push only factory/ branches");
    expect(pushes).toHaveLength(0);
    const open = gitPushEffect({ workspace: () => workspace, dir: "/repo", url: REPO, token: async () => TOKEN, allow: (b) => b === "main" });
    await open.run({ branch: "main" }, { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage() {} });
    expect(pushes).toHaveLength(1);
  });
});

it("[git-push-only-factory-branches] the default guard refuses anything that isn't a valid refname under factory/", async () => {
  await runInDurableObject(scribe("git-refnames"), async (_i, state) => {
    const { workspace, pushes } = spyWorkspace(state);
    const adapter = gitPushEffect({ workspace: () => workspace, dir: "/repo", url: REPO, token: async () => TOKEN });
    const ctx = { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage() {} };
    for (const bad of ["factory/../x", "factory/a..b", "factory/a@{1}", "factory/a/", "factory/a.lock", "factory/a/.hidden", "factory/a b", "factory/a~1", "factory/a^", "factory/a:b", "factory/a?", "factory/a*", "factory/a[", "factory/a\\b", "factory/a\nb", "factory//a", "factory/a.", "factory/", "-factory/x", "refs/heads/factory/x"]) {
      await expect(adapter.run({ branch: bad }, ctx), bad).rejects.toBeInstanceOf(EffectRejected);
    }
    expect(pushes).toHaveLength(0);
    await adapter.run({ branch: "factory/ok-1/part_2.x" }, ctx);
    expect(pushes).toHaveLength(1);
  });
});

it("[git-push-header-only] only an authentication failure falls back to Basic; others surface as themselves", async () => {
  await runInDurableObject(scribe("git-nonauth"), async (_i, state) => {
    const ctx = { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage() {} };
    const nff = spyWorkspace(state, () => ({ ok: false, error: "non-fast-forward", refs: {} }));
    await expect(gitPushEffect({ workspace: () => nff.workspace, dir: "/repo", url: REPO, token: async () => TOKEN }).run({ branch: "factory/x" }, ctx)).rejects.toThrow("git push failed: non-fast-forward");
    expect(nff.pushes).toHaveLength(1);
    const net = spyWorkspace(state, () => {
      throw new Error("network down");
    });
    await expect(gitPushEffect({ workspace: () => net.workspace, dir: "/repo", url: REPO, token: async () => TOKEN }).run({ branch: "factory/x" }, ctx)).rejects.toThrow("network down");
    expect(net.pushes).toHaveLength(1);
    const aborted = new AbortController();
    aborted.abort();
    await expect(gitPushEffect({ workspace: () => nff.workspace, dir: "/repo", url: REPO, token: async () => TOKEN }).run({ branch: "factory/x" }, { ...ctx, signal: aborted.signal })).rejects.toThrow();
    expect(nff.pushes).toHaveLength(1);
  });
});

it("[git-clone-no-token] a failing clone without a token (or with an empty one) keeps its message readable", async () => {
  await runInDurableObject(scribe("git-notoken"), async (_i, state) => {
    const boom = { async clone() { throw new Error("repository not found"); }, async configGet() { return undefined; }, async push() { return { ok: false, error: "non-fast-forward", refs: {} }; } };
    const workspace = new Workspace({ storage: state.storage as unknown as DurableObjectStorageLike, git: () => boom as unknown as GitClient });
    await expect(gitClone(workspace, { url: "https://github.com/acme/public", dir: "/repo" })).rejects.toThrow(/^repository not found$/);
    await expect(gitClone(workspace, { url: "https://github.com/acme/public", dir: "/repo", token: async () => "" })).rejects.toThrow(/^repository not found$/);
    const ctx = { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage() {} };
    await expect(gitPushEffect({ workspace: () => workspace, dir: "/repo", url: REPO, token: async () => "" }).run({ branch: "factory/x" }, ctx)).rejects.toThrow(/^git push failed: non-fast-forward$/);
  });
});

it("[git-push-header-only] run as a registered effect, a client error carrying the token in every form reaches no row, event or outcome", async () => {
  const events = captureEvents();
  const forms = [TOKEN, `Bearer ${TOKEN}`, btoa(`x-access-token:${TOKEN}`), `Basic ${btoa(`x-access-token:${TOKEN}`)}`];
  const leaks = (text: string) => forms.filter((f) => text.includes(f));
  let calls = 0;
  const holder = scribe("git-pipeline-state");
  await runInDurableObject(holder, async (_i, state) => {
    const { workspace } = spyWorkspace(state, (call) => {
      calls++;
      throw new Error(`push failed: ${forms.join(" | ")} | ${call.headers?.Authorization}`);
    });
    // Probe's gateway.keyed stands in for a declared push effect; its key is the branch.
    const push = gitPushEffect({ workspace: () => workspace, dir: "/repo", url: REPO, token: async () => TOKEN });
    overrideEffect("gateway.keyed", { run: (input, ctx) => push.run({ branch: (input as { key: string }).key }, ctx) });
  });
  await ingress(env, system, "Probe", "probe.effect", { effect: "gateway.keyed", key: "factory/leak" }, { key: "git-pipeline" });
  await settle(env, system);
  expect(calls).toBeGreaterThan(0);
  const probeObject = env.PROBE.getByName("git-pipeline");
  const outcomes = await probeObject.outcomes();
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]!.status).not.toBe("confirmed");
  expect(outcomes[0]!.error ?? "").toContain("[token]");
  const dump = await runInDurableObject(probeObject, (_i, state) => {
    const sql = state.storage.sql;
    return sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").toArray().map((t) => JSON.stringify(sql.exec(`SELECT * FROM "${t.name}"`).toArray())).join("\n");
  });
  expect(leaks(dump)).toEqual([]);
  expect(leaks(JSON.stringify(outcomes))).toEqual([]);
  expect(leaks(JSON.stringify(events))).toEqual([]);
});

/**
 * A workspace on Computer's real git client with a repo at /repo whose factory/one branch has one commit, and whose
 * .git/config the agent has written: `origin` is `origin` (another host by default) with a pushurl on another host,
 * and `http.corsProxy` names another host too, if `proxy`.
 */
async function plantedRepo(state: DurableObjectState, proxy: boolean, origin = "https://evil.example/x.git"): Promise<Workspace> {
  const workspace = new Workspace({ storage: state.storage as unknown as DurableObjectStorageLike, git: createGitClient() });
  await workspace.git.init({ dir: "/repo", defaultBranch: "main" });
  await workspace.fs.writeFile("/repo/README.md", "hello\n");
  await workspace.git.add({ dir: "/repo", paths: ["README.md"] });
  await workspace.git.commit({ dir: "/repo", message: "first", author: { name: "agent", email: "agent@example.com" } });
  await workspace.git.branch({ dir: "/repo", name: "factory/one", checkout: true });
  await workspace.git.configSet({ dir: "/repo", path: "remote.origin.url", value: origin });
  await workspace.git.configSet({ dir: "/repo", path: "remote.origin.pushurl", value: "https://evil.example/push.git" });
  if (proxy) await workspace.git.configSet({ dir: "/repo", path: "http.corsProxy", value: "https://evil.example" });
  return workspace;
}

/** Record every outbound fetch in `fn` (answered 401, so a push stops at discovery) and restore fetch after. */
async function outbound<T>(fn: () => Promise<T>): Promise<{ requests: Array<{ url: string; authorization: string | null }>; result: T | Error }> {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, authorization: request.headers.get("Authorization") });
    return new Response("no", { status: 401, statusText: "Unauthorized" });
  }) as typeof fetch;
  try {
    return { requests, result: await fn().catch((e: Error) => e) };
  } finally {
    globalThis.fetch = real;
  }
}

it("[git-push-url-pinned] the real git client pushes to the app's URL, never to a remote the workspace's .git/config names", async () => {
  await runInDurableObject(scribe("git-pinned"), async (_i, state) => {
    const workspace = await plantedRepo(state, false);
    const push = gitPushEffect({ workspace: () => workspace, dir: "/repo", url: "https://github.com/acme/repo.git", token: async () => TOKEN });
    const { requests, result } = await outbound(() => push.run({ branch: "factory/one" }, { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage() {} }));
    expect(result).toBeInstanceOf(Error);
    expect(requests.filter((r) => r.url.includes("evil.example"))).toEqual([]);
    expect(requests.map((r) => r.url)).toEqual(["https://github.com/acme/repo.git/info/refs?service=git-receive-pack", "https://github.com/acme/repo.git/info/refs?service=git-receive-pack"]);
    expect(requests.map((r) => r.authorization)).toEqual([`Bearer ${TOKEN}`, `Basic ${btoa(`x-access-token:${TOKEN}`)}`]);
  });
});

it("[git-push-url-pinned] a corsProxy in the workspace's .git/config refuses the push before any request leaves", async () => {
  await runInDurableObject(scribe("git-proxied"), async (_i, state) => {
    const workspace = await plantedRepo(state, true);
    const push = gitPushEffect({ workspace: () => workspace, dir: "/repo", url: "https://github.com/acme/repo.git", token: async () => TOKEN });
    const { requests, result } = await outbound(() => push.run({ branch: "factory/one" }, { key: "k", attempt: 1, signal: new AbortController().signal, reportUsage() {} }));
    expect(result).toBeInstanceOf(EffectRejected);
    expect((result as Error).message).toMatch(/http\.corsProxy/);
    expect(requests).toEqual([]);
  });
});

it("[git-clone-url-pinned] the real git client clones from the app's URL with no proxy, even into a .git/config that names one", async () => {
  await runInDurableObject(scribe("git-clone-pinned"), async (_i, state) => {
    // A clone into an existing .git keeps its config, and adds `origin` only if it matches; so the agent plants the app's URL.
    const workspace = await plantedRepo(state, true, "https://github.com/acme/repo.git");
    const { requests, result } = await outbound(() => gitClone(workspace, { url: "https://github.com/acme/repo.git", dir: "/repo", token: async () => TOKEN }));
    expect(result).toBeInstanceOf(Error);
    expect(requests.filter((r) => r.url.includes("evil.example"))).toEqual([]);
    expect(requests).toEqual([{ url: "https://github.com/acme/repo.git/info/refs?service=git-upload-pack", authorization: `Bearer ${TOKEN}` }]);
  });
});

it("[git-push-url-pinned] the push and clone URLs must be https, with no credentials in them", async () => {
  await runInDurableObject(scribe("git-url-checked"), async (_i, state) => {
    const { workspace } = spyWorkspace(state);
    for (const url of ["http://github.com/acme/repo.git", "https://x-access-token:t@github.com/acme/repo.git", "ssh://git@github.com/acme/repo.git", "not a url", ""]) {
      expect(() => gitPushEffect({ workspace: () => workspace, dir: "/repo", url, token: async () => TOKEN }), url).toThrow(/https/);
      await expect(gitClone(workspace, { url, dir: "/repo" }), url).rejects.toThrow(/https/);
    }
  });
});

// ---- Workspaces on Computer (Task 9) ----
//
// Builder's workspace is Computer's, in its own SQLite; its commands would run in a container, which the plugin doesn't
// start (spike 3), so a ContainerStub stands in for ctx.container and Computer's own container host drives it. The stub
// has no computerd, so a ContainerBackend over it never connects: a command never reaches it. What a real container
// does with the ignore list and a running command is spike 2's and spike 4's evidence.

const builder = (key: string) => env.BUILDER.getByName(key);
const builders = globalThis as { __builderScripts?: Record<string, Script> };
/** Answer each model request of Builder instance `name` with `fn`. */
function builderScript(name: string, fn: Script): void {
  builders.__builderScripts = { ...builders.__builderScripts, [name]: fn };
}
const build = (key: string, topic: string, id: string) => ingress(env, system, "Builder", "builder.task", { topic }, { key, id });
type WorkspaceResult = { toolName: string; isError: boolean; content: Array<{ type: string; text?: string }> };
/** The last tool result a request ends with: the call the model made last. */
const lastResult = (r: ScriptedRequest) => r.lastToolResults.at(-1) as WorkspaceResult | undefined;
const resultText = (r: WorkspaceResult) => r.content.map((c) => c.text ?? "").join("");
const LOCAL_ONLY = system.actors.Builder.harness.workspace.localOnly;

/**
 * What Computer's ContainerBackend asks computerd before it connects: its health, then /api, which must refuse a
 * request without the client secret. `connect` answers POST /connect, after which computerd would dial back.
 */
function computerd(connect: (request: Request) => Response | Promise<Response>) {
  return (request: Request): Response | Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/api") return new Response("unauthorized", { status: 401 });
    if (pathname === "/connect") return connect(request);
    return new Response("not found", { status: 404 });
  };
}
const noComputerd = () => new Response("the stub has no computerd", { status: 503 });
/** What the container's egress was handed to, once each: Computer connects again once after a failed connect. */
const intercepts = (stub: ContainerStub) => [...new Set(stub.egress.map((e) => `${e.kind} ${e.host ?? ""}`.trim()))];

/**
 * A command backend of the test's own (Computer's public WorkspaceBackend), for what the stub can't show: a command
 * that is running. Each exec starts a run that stays open until the test ends it (`exit`) or loses it (`lose`: its
 * event stream fails, as when the container's connection breaks mid-command). Nothing syncs: the files stay in vfs_*.
 */
class HeldBackend implements WorkspaceBackend {
  readonly id = "container";
  readonly type = "test-held";
  readonly description = "A Linux shell (a stand-in the test drives).";
  readonly runs: Array<{ source: string; exit(code: number, stdout: string): void; lose(error: Error): void }> = [];
  async connect(): Promise<BackendHandle> {
    const shell = {
      exec: async (input: { source: string; id?: string }) => {
        const id = input.id ?? `run-${this.runs.length + 1}`;
        let events!: ReadableStreamDefaultController<unknown>;
        const stream = new ReadableStream({ start: (c) => void (events = c) });
        this.runs.push({
          source: input.source,
          exit(code, stdout) {
            events.enqueue({ id, seq: 0, name: "stdout", value: new TextEncoder().encode(stdout) });
            events.enqueue({ id, seq: 1, name: "exit", code });
            events.close();
          },
          lose: (error) => events.error(error),
        });
        return { id, events: stream };
      },
      getExec: async () => {
        throw new Error("the container was destroyed");
      },
      killExec: async () => {},
      disposeExec: async () => {},
    };
    return { rpc: { shell, sync: {} } as unknown as BackendHandle["rpc"], sync: "none", close: async () => {} };
  }
}
const toolCall = (tools: ToolRegistration[], name: string, args: unknown, callId: string): Promise<ToolExecutionResult> =>
  tools.find((t) => t.name === name)!.execute(args as never, { callId } as never, { abortSignal: new AbortController().signal } as never);
const outputText = (r: ToolExecutionResult) => (r.output ?? []).map((c) => ("text" in c ? c.text : "")).join("");

/** Hold the `nth` write to `path` in the instance's workspace once it has landed, until `g` opens: a tool cut off after its change. */
function holdWrite(instance: Builder, path: string, nth: number, g: ReturnType<typeof gate>): void {
  const workspace = instance.actor.workspace!;
  const fs = workspace.fs;
  let writes = 0;
  const held = new Proxy(fs, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop !== "writeFile") return value.bind(target);
      return async (p: string, ...rest: unknown[]) => {
        await value.call(target, p, ...rest);
        if (p === path && ++writes === nth) await g.wait();
      };
    },
  });
  Object.defineProperty(workspace, "fs", { value: held, configurable: true });
}

it("[container-stub] the stub records starts and intercepts, answers its ports while running, and a destroy fails what is in flight", async () => {
  const stub = new ContainerStub();
  stub.ports.set(8080, () => new Response("ok"));
  await expect(stub.getTcpPort(8080).fetch("http://container/health")).rejects.toThrow("not listening on port 8080");
  stub.start({ env: { A: "1" } });
  expect(stub.running).toBe(true);
  expect(await (await stub.getTcpPort(8080).fetch("http://container/health")).text()).toBe("ok");
  await expect(stub.getTcpPort(9090).fetch("http://container/")).rejects.toThrow("not listening on port 9090");
  const fetcher = { fetch: async () => new Response("proxied") };
  stub.interceptOutboundHttp("computer.internal", fetcher);
  stub.interceptAllOutboundHttp(fetcher);
  stub.interceptOutboundHttps("*", fetcher);
  expect(stub.egress.map((e) => [e.kind, e.host])).toEqual([["http", "computer.internal"], ["all", undefined], ["https", "*"]]);
  stub.ports.set(8081, () => new Promise<Response>(() => {}));
  const hung = stub.getTcpPort(8081).fetch("http://container/connect");
  const exited = stub.monitor();
  await stub.destroy();
  await expect(hung).rejects.toThrow("the container was destroyed");
  await expect(exited).resolves.toBeUndefined();
  expect(stub.running).toBe(false);
  stub.failStart = "no capacity";
  expect(() => stub.start({})).toThrow("no capacity");
  expect(stub.running).toBe(false);
  expect(stub.calls.map((c) => c.op)).toEqual(["start", "intercept", "intercept", "intercept", "destroy", "start"]);
  expect(stub.calls[0]).toEqual({ op: "start", options: { env: { A: "1" } } });
});

it("[workspace-tools-replay] the registry's workspace tools carry this plan's replay classes", async () => {
  await runInDurableObject(builder("replay-1"), async (instance: Builder, state) => {
    const installed = instance.actor.registry.snapshot().tools().filter((t) => t.extension.name === "actord.workspace");
    expect(Object.fromEntries(installed.map(({ tool }) => [tool.name, tool.replay]))).toEqual({ read: "safe", ls: "safe", find: "safe", grep: "safe", write: "safe", delete: "safe", edit: "unsafe", exec: "unsafe" });
    // publish is there only with assets, and can't be repeated safely either.
    const withAssets = new Workspace({ storage: state.storage as unknown as DurableObjectStorageLike, assets: { share: async () => "https://assets.example/x" } });
    expect(workspaceTools(withAssets, ["workspace.*"]).map((t) => [t.name, t.replay])).toContainEqual(["publish", "unsafe"]);
  });
});

it("[workspace-tools-replay] workspace.<name> picks tools by name, and a name Computer has no tool for is refused", async () => {
  await runInDurableObject(builder("replay-2"), async (instance: Builder) => {
    const workspace = instance.actor.workspace!;
    expect(workspaceTools(workspace, ["workspace.read", "workspace.exec"]).map((t) => t.name)).toEqual(["read", "exec"]);
    expect(() => workspaceTools(workspace, ["workspace.reed"])).toThrow(/workspace\.reed/);
  });
});

it("[workspace-no-exec-without-backend] computer() without a backend gives every file tool, and no exec", async () => {
  await runInDurableObject(builder("noexec-1"), async (instance: Builder, state) => {
    const bare = workspaceFor({ lifecycle: instance.lifecycle, ctx: state, env }, computer(), {});
    expect(workspaceTools(bare, ["workspace.*"]).map((t) => t.name)).toEqual(["read", "ls", "find", "grep", "write", "edit", "delete"]);
    expect(workspaceTools(bare, ["workspace.exec"])).toEqual([]);
    expect(workspaceTools(instance.actor.workspace!, ["workspace.*"]).map((t) => t.name)).toContain("exec");
  });
});

it("[workspace-local-only-passed-to-backend] the container starts with MOUNT_IGNORE equal to localOnly and no secret of ours (spike 2's evidence stands in for vfs_nodes)", async () => {
  await runInDurableObject(builder("local-1"), async (instance: Builder) => {
    instance.container.ports.set(8080, computerd(noComputerd));
    await expect(instance.actor.workspace!.runtime.exec("true", { backend: "container" })).rejects.toThrow(/stage=connect/);
    const start = instance.container.calls.find((c) => c.op === "start")!.options as { env: Record<string, string> };
    expect(start.env.MOUNT_IGNORE).toBe(LOCAL_ONLY.join(","));
    // Computer's own: the port, the mount, the ignore list, and computerd's per-container client secret. Nothing from env.
    expect(Object.keys(start.env).sort()).toEqual(["MOUNT_IGNORE", "MOUNT_POINT", "PORT", "RPC_CLIENT_SECRET"]);
    expect(start).toMatchObject({ enableInternet: false, image: "stub-image", instance: "standard-2" });
  });
});

it("[egress-registry-read] the gateway passes GET and HEAD to the npm and yarn registries, and answers 403 to anything else", async () => {
  const seen: Request[] = [];
  const gateway = new RegistryReadGateway({ fetch: async (r) => (seen.push(r), new Response("from the registry")) });
  const get = await gateway.fetch(new Request("https://registry.npmjs.org/zod", { headers: { authorization: "Bearer npm_secret", cookie: "c=1", accept: "application/json" } }));
  expect(get.status).toBe(200);
  expect(await get.text()).toBe("from the registry");
  expect((await gateway.fetch(new Request("https://registry.yarnpkg.com/zod", { method: "HEAD" }))).status).toBe(200);
  const refused = [
    new Request("https://registry.npmjs.org/zod", { method: "PUT", body: "{}" }),
    new Request("https://registry.npmjs.org/-/user/org.couchdb.user:x", { method: "POST", body: "{}" }),
    new Request("https://registry.npmjs.org/zod", { method: "DELETE" }),
    new Request("https://example.com/"),
    new Request("http://registry.npmjs.org/zod"),
    new Request("https://registry.npmjs.org.example.com/zod"),
    new Request("https://registry.npmjs.org:8443/zod"),
    new Request("https://user:pass@registry.npmjs.org/zod"),
  ];
  for (const request of refused) expect((await gateway.fetch(request)).status, `${request.method} ${request.url}`).toBe(403);
  expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["GET https://registry.npmjs.org/zod", "HEAD https://registry.yarnpkg.com/zod"]);
  // Credentials stay behind; the rest of the request goes on.
  expect(seen[0]!.headers.get("authorization")).toBeNull();
  expect(seen[0]!.headers.get("cookie")).toBeNull();
  expect(seen[0]!.headers.get("accept")).toBe("application/json");
});

it("[egress-registry-read] the gateway builds the upstream request from the URL: the container's Host and other headers outside a short list stay behind", async () => {
  const seen: Request[] = [];
  const gateway = new RegistryReadGateway({ fetch: async (r) => (seen.push(r), new Response("from the registry")) });
  const headers = { host: "example.com", "x-forwarded-host": "example.com", forwarded: "host=example.com", "x-custom": "1", accept: "application/vnd.npm.install-v1+json", "accept-encoding": "gzip", "user-agent": "npm/11", "if-none-match": '"etag"', "npm-command": "ci", "npm-otp": "123456" };
  expect((await gateway.fetch(new Request("https://registry.npmjs.org/zod", { headers }))).status).toBe(200);
  expect(seen.map((r) => r.url)).toEqual(["https://registry.npmjs.org/zod"]);
  expect(Object.fromEntries(seen[0]!.headers)).toEqual({ accept: "application/vnd.npm.install-v1+json", "accept-encoding": "gzip", "user-agent": "npm/11", "if-none-match": '"etag"' });
});

it("[egress-registry-read] the gateway doesn't follow a registry's redirect: the 3xx goes back to the container, and its target isn't fetched", async () => {
  const seen: string[] = [];
  // Behaves as fetch does with each redirect mode: "follow" would fetch the Location as well.
  const upstream = async (request: Request): Promise<Response> => {
    seen.push(request.url);
    if (new URL(request.url).host !== "registry.npmjs.org") return new Response("from elsewhere");
    if (request.redirect === "follow") return upstream(new Request("https://elsewhere.example/zod.tgz"));
    return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/zod.tgz" } });
  };
  const response = await new RegistryReadGateway({ fetch: upstream }).fetch(new Request("https://registry.npmjs.org/zod/-/zod-4.0.0.tgz"));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://elsewhere.example/zod.tgz");
  expect(seen).toEqual(["https://registry.npmjs.org/zod/-/zod-4.0.0.tgz"]);
});

it("[egress-registry-read] what the container sends reaches the actor's gateway through WorkspaceProxy: GET to the registry passes, PUT and other hosts get 403", async () => {
  await runInDurableObject(builder("egress-1"), async (instance: Builder) => {
    instance.container.ports.set(8080, computerd(noComputerd));
    await expect(instance.actor.workspace!.runtime.exec("true", { backend: "container" })).rejects.toThrow(/stage=connect/);
    // All of the container's HTTP, and its HTTPS to every host, goes to the gateway; Computer's callback host to itself.
    expect(intercepts(instance.container)).toEqual(["http computer.internal", "all", "https *"]);
    const out = instance.container.egress.find((e) => e.kind === "all")!.fetcher;
    const get = await out.fetch("https://registry.npmjs.org/zod");
    expect([get.status, await get.text()]).toEqual([200, "registry stub: GET /zod"]);
    expect((await out.fetch("https://registry.npmjs.org/zod", { method: "PUT", body: "{}" })).status).toBe(403);
    expect((await out.fetch("https://example.com/")).status).toBe(403);
    expect(instance.upstream.map((r) => `${r.method} ${r.url}`)).toEqual(["GET https://registry.npmjs.org/zod"]);
  });
});

it("[egress-none-by-default] a workspace that declares no egress gets a container without internet, intercepting only Computer's callback host", async () => {
  await runInDurableObject(builder("egress-none"), async (instance: Builder, state) => {
    // A gateway given anyway is not used: egress is what the workspace declares.
    const workspace = workspaceFor({ lifecycle: instance.lifecycle, ctx: state, env }, computer({ backend: containerBackend({ image: "./Dockerfile" }) }), { container: instance, binding: "BUILDER", gateway: new RegistryReadGateway() });
    instance.container.ports.set(8080, computerd(noComputerd));
    await expect(workspace.runtime.exec("true", { backend: "container" })).rejects.toThrow(/stage=connect/);
    expect(intercepts(instance.container)).toEqual(["http computer.internal"]);
    const start = instance.container.calls.find((c) => c.op === "start")!.options as { env: Record<string, string> };
    expect(start).toMatchObject({ enableInternet: false });
    expect(start.env.MOUNT_IGNORE).toBeUndefined();
  });
});

it("[workspace-edit-survives-restart] a write, then an edit cut off by a restart: the file has both changes, and the edit is reported interrupted, not run again", async () => {
  const held = gate();
  gates.push(held.open);
  const path = "/workspace/notes.md";
  const finals: ScriptedRequest[] = [];
  // By the last tool result, not the turn: a restarted object's model counts its turns from 0 again.
  builderScript("edit-1", (r) => {
    const last = lastResult(r);
    if (!last) return { calls: [{ name: "write", args: { path, content: "one\n" } }] };
    if (last.toolName === "write") return { calls: [{ name: "edit", args: { path, edits: [{ oldText: "one\n", newText: "one\ntwo\n" }] } }] };
    finals.push(r);
    return finish({ summary: "edited" });
  });
  await runInDurableObject(builder("edit-1"), (instance: Builder) => holdWrite(instance, path, 2, held));
  await build("edit-1", "notes", "task-w1");
  // The edit's write has landed, and pi hasn't recorded the edit's result.
  await reached(held);
  await abortAllDurableObjects();
  await settle(env, system);
  await eventually(async () => expect(await builder("edit-1").done()).toEqual(["edited"]), 5000);
  // Run again, the edit would have found "one\n" and added a second "two".
  expect(await builder("edit-1").readFile(path)).toBe("one\ntwo\n");
  expect(finals).toHaveLength(1);
  const edit = lastResult(finals[0]!)!;
  expect(edit).toMatchObject({ toolName: "edit", isError: true });
  expect(resultText(edit)).toMatch(/interrupted/);
}, 20_000);

it("[workspace-container-lost-at-connect] the container is destroyed while an exec waits for it to connect: earlier edits stay in vfs_*, and the model sees the command as interrupted", async () => {
  const connecting = gate();
  gates.push(connecting.open);
  const path = "/workspace/app.txt";
  const finals: ScriptedRequest[] = [];
  builderScript("lost-1", (r) => {
    const last = lastResult(r);
    if (!last) return { calls: [{ name: "write", args: { path, content: "v1\n" } }] };
    if (last.toolName === "write") return { calls: [{ name: "edit", args: { path, edits: [{ oldText: "v1", newText: "v2" }] } }] };
    if (last.toolName === "edit") return { calls: [{ name: "exec", args: { command: "npm test", cwd: "/workspace" } }] };
    finals.push(r);
    return finish({ summary: "lost" });
  });
  // computerd would dial back after POST /connect; the stub's never does, so the exec waits on the container until it goes.
  await runInDurableObject(builder("lost-1"), (instance: Builder) => void instance.container.ports.set(8080, computerd(() => connecting.wait().then(() => new Response("late")))));
  await build("lost-1", "the tests", "task-l1");
  await reached(connecting);
  // Gone for good: Computer's one reconnect finds no container either.
  await runInDurableObject(builder("lost-1"), (instance: Builder) => {
    instance.container.failStart = "no container could be started";
    return instance.container.destroy();
  });
  await eventually(async () => expect(await builder("lost-1").done()).toEqual(["lost"]), 4000);
  const exec = lastResult(finals[0]!)!;
  expect(exec).toMatchObject({ toolName: "exec", isError: true });
  expect(resultText(exec)).toMatch(/interrupted/);
  expect(resultText(exec)).toContain("the container was destroyed");
  expect(await builder("lost-1").readFile(path)).toBe("v2\n");
  // The file is in the object's SQLite (Computer's vfs_ tables), not on the container's disk.
  const sizes = await runInDurableObject(builder("lost-1"), (_i, state) => state.storage.sql.exec<{ size: number }>("SELECT n.size FROM vfs_dirents d JOIN vfs_nodes n ON n.inode = d.child_inode WHERE d.name = 'app.txt'").toArray());
  expect(sizes).toEqual([{ size: 3 }]);
});

it("[workspace-container-lost-mid-command] the container is lost while an exec runs: earlier edits stay in vfs_*, and the model sees the command as interrupted", async () => {
  // Scribe's object has no workspace of its own, so this one is the only one on its tables.
  await runInDurableObject(scribe("ws-running-lost"), async (_i, state) => {
    const backend = new HeldBackend();
    const tools = workspaceTools(new Workspace({ storage: state.storage as unknown as DurableObjectStorageLike, backends: [backend] }), ["workspace.*"]);
    const path = "/workspace/app.txt";
    expect((await toolCall(tools, "write", { path, content: "v1\n" }, "c1")).isError).toBeFalsy();
    expect((await toolCall(tools, "edit", { path, edits: [{ oldText: "v1", newText: "v2" }] }, "c2")).isError).toBeFalsy();
    let settled = false;
    const exec = toolCall(tools, "exec", { command: "npm test" }, "c3").finally(() => (settled = true));
    await eventually(async () => expect(backend.runs.map((r) => r.source)).toEqual(["npm test"]));
    // Started, and still running: no result yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    backend.runs[0]!.lose(new Error("RPC session was shut down: the container was destroyed"));
    const result = await exec;
    expect(result.isError).toBe(true);
    expect(outputText(result)).toMatch(/^exec was interrupted: the container was lost before the command finished \(.*the container was destroyed.*\)\. It may have partly run\./);
    // The edits are in the object's SQLite (Computer's vfs_ tables), whatever the container did.
    const sizes = state.storage.sql.exec<{ size: number }>("SELECT n.size FROM vfs_dirents d JOIN vfs_nodes n ON n.inode = d.child_inode WHERE d.name = 'app.txt'").toArray();
    expect(sizes).toEqual([{ size: 3 }]);
    expect(await new Workspace({ storage: state.storage as unknown as DurableObjectStorageLike }).fs.readFile(path, "utf8")).toBe("v2\n");
  });
});

it("[workspace-exec-runs-to-end] an exec that runs to its end gives the model its output, not an interruption", async () => {
  await runInDurableObject(scribe("ws-running-ok"), async (_i, state) => {
    const backend = new HeldBackend();
    const tools = workspaceTools(new Workspace({ storage: state.storage as unknown as DurableObjectStorageLike, backends: [backend] }), ["workspace.exec"]);
    const exec = toolCall(tools, "exec", { command: "npm test" }, "c1");
    await eventually(async () => expect(backend.runs).toHaveLength(1));
    backend.runs[0]!.exit(0, "3 passed\n");
    const result = await exec;
    expect(result.isError).toBeFalsy();
    expect(outputText(result)).toContain("3 passed");
    expect(outputText(result)).not.toMatch(/interrupted/);
  });
});
