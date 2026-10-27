// Agents in workerd: a Pi session and actord in one Durable Object, against the Scribe probe (test-runtime/src/agent.ts).
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { ScriptedRequest, ScriptedTurn } from "../src/agents/index.ts";
import { type ActorEvent, ingress } from "../src/runtime/index.ts";
import { captureEvents, eventually, expireJobs, overrideEffect, overrideEffectBudget, resetSeams, settle } from "../src/testing.ts";
import type { Scribe } from "./src/agent.ts";
import { system } from "./src/index.ts";

const scribe = (key: string) => env.SCRIBE.getByName(key);
type Script = (request: ScriptedRequest) => ScriptedTurn | Promise<ScriptedTurn>;
const shared = globalThis as { __scribeScripts?: Record<string, Script>; __scribeInstructions?: Record<string, string>; __scribeNotedThrows?: Record<string, number> };

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
  await eventually(async () => expect(await s.done()).toEqual([{ id: expect.any(String), sender: "Scribe:returns-1", summary: "ok" }]), 5000);
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["fixed"]), 5000);
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["once"]), 5000);
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["with bullets"]), 5000);
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
  await eventually(async () => expect(await s.failures()).toEqual([{ type: "agent.failed", payload: { session: row!.session, key: "task-x1", reason: "stopped" } }]), 5000);
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["second"]), 5000);
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["second"]), 5000);
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
  await eventually(async () => expect(await s.failures()).toMatchObject([{ type: "agent.failed", payload: { key: "task-e1", reason: "ended without returning a result" } }]), 5000);
  expect((await s.failures())[0]!.payload.session).toBe((await s.sessions())[0]!.session);
  expect((await s.outbox()).find((r) => r.id === "fx:agent.session:task-e1")).toMatchObject({ status: "failed", lastError: "ended without returning a result" });
  expect(await s.done()).toEqual([]);
});

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
});

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
});

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
  await eventually(async () => expect((await s.failures()).map((f) => f.payload.reason)).toEqual(["stopped"]), 5000);
  const [row] = await s.sessions();
  expect((await s.failures())[0]!.payload).toEqual({ session: row!.session, key: "task-se2", reason: "stopped" });
  expect(await jobRow("stop-early-2", "fx:agent.session:task-se2")).toMatchObject({ status: "failed", lastError: "stopped" });
  expect(await s.wait("task-se2", row!.session as string)).toMatchObject({ status: "unanswered" });
  turn.open();
  await settle(env, system);
  expect(await s.done()).toEqual([]);
  expect(row).toMatchObject({ result: null, stopped_at: expect.any(Number) });
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["done before the hint"]), 5000);
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
  await eventually(async () => expect((await scribe("onward-1").done()).map((d) => d.summary)).toEqual(["routed"]), 5000);
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
  // The model answers after the job settled: its result is a note, not a delivery.
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["noted"]), 5000);
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
  // The rerun asked for the same key: actord's recovery had queued the cut-off attempt again, and the rerun waited for it.
  // Whether that retry had started by then depends on a drive racing pi's rerun: queued or running, never a second row.
  expect(events.filter((e) => e.kind === "effect.duplicate" && e.effect === "note.keyed")).toMatchObject([{ effectKey: key, detail: { existingStatus: expect.stringMatching(/^(pending|running)$/) } }]);
  // Twice, the most a keyed effect runs here: the attempt the restart cut off, then its retry.
  expect(runs).toBe(2);
});

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
});

it("[agent-tool-approval] a tool that needs approval answers waiting at once; once approved, its result is steered in and the session finishes", async () => {
  const requests: ScriptedRequest[] = [];
  script("tool-approve-1", (r) => {
    requests.push(r);
    if ((users(r).at(-1) ?? "").startsWith("Result of note.approved")) return finish({ summary: "approved" });
    return r.lastToolResults.length === 0 ? call("note_approved", { text: "b" }) : { text: "Waiting for the approval." };
  });
  const s = scribe("tool-approve-1");
  await task("tool-approve-1", "the approved note", "task-ta1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 5000);
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["approved"]), 5000);
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

it("[agent-tool-result-stale] an approval that resolves after its session was replaced is only a note: nothing is submitted to either session", async () => {
  const events = captureEvents();
  const requests: ScriptedRequest[] = [];
  script("tool-stale-1", (r) => {
    requests.push(r);
    if ((users(r)[0] ?? "").includes('"second"')) return finish({ summary: "second" });
    return r.lastToolResults.length === 0 ? call("note_approved", { text: "c" }) : { text: "Waiting for the approval." };
  });
  const s = scribe("tool-stale-1");
  await task("tool-stale-1", "first", "task-ts1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 5000);
  const [first] = await s.sessions();
  const key = `${first!.session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
  await runEnded("tool-stale-1", first!.session as string, "task-ts1");
  await task("tool-stale-1", "second", "task-ts2");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["second"]), 5000);
  expect(await s.decide(key, "approve")).toMatchObject({ status: "confirmed", key });
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["listed"]), 5000);
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
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 5000);
  const [row] = await s.sessions();
  const key = `${row!.session}:${toolResults(requests[1]!)[0]!.toolCallId}`;
  await runEnded("tool-deny-1", row!.session as string, "task-td1");
  expect(await s.decide(key, "deny")).toMatchObject({ status: "denied", key });
  await s.probeNow("task-td1");
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["denied"]), 5000);
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
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 5000);
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
    await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["handled"]), 5000);
    expect(failed()).toHaveLength(1);
  } finally {
    delete shared.__scribeNotedThrows;
  }
  await settle(env, system);
  expect(await s.results()).toEqual([{ key, status: "confirmed" }]);
  // One steer, requested once, never asked for again; one result in the session, and the model saw it once.
  expect(events.filter((e) => e.kind === "effect.requested" && e.effect === "agent.session.steer").map((e) => e.effectKey)).toEqual([`result:${key}`]);
  expect(events.filter((e) => e.kind === "effect.duplicate" && e.effect === "agent.session.steer")).toEqual([]);
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
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 5000);
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
  await eventually(async () => expect((await s.done()).map((d) => d.summary)).toEqual(["silent"]), 5000);
  expect(users(requests.at(-1)!).at(-1)).toBe(`Result of note.silent (request ${key}): confirmed {"noted":"s"}`);
  expect(await jobRow("tool-silent-1", `fx:agent.session.steer:result:${key}`)).toMatchObject({ status: "confirmed" });
  expect(await s.noted()).toEqual([{ effect: "note.silent", key, text: "s" }]);
});

it("[agent-tool-result-steer-in-doubt] a result steer that ends in doubt gives up its wait, so the session ends instead of waiting out its deadline", async () => {
  const requests: ScriptedRequest[] = [];
  script("tool-steer-doubt-1", (r) => (requests.push(r), r.lastToolResults.length === 0 ? call("note_approved", { text: "q" }) : { text: "Waiting for the approval." }));
  const s = scribe("tool-steer-doubt-1");
  await task("tool-steer-doubt-1", "the lost result", "task-tsd1");
  await eventually(async () => expect(requests.length).toBeGreaterThanOrEqual(2), 5000);
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
  await eventually(async () => expect(await s.failures()).toEqual([{ type: "agent.failed", payload: { session, key: "task-tsd1", reason: "ended without returning a result" } }]), 5000);
  expect(await runInDurableObject(s, (_i, state) => state.storage.sql.exec("SELECT done_at FROM _actors_agent_waits WHERE key = ?", key).one().done_at)).toEqual(expect.any(Number));
  expect(await s.done()).toEqual([]);
});
