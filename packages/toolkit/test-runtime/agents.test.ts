// Agents in workerd: a Pi session and actord in one Durable Object, against the Scribe probe (test-runtime/src/agent.ts).
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { ScriptedRequest, ScriptedTurn } from "../src/agents/index.ts";
import { type ActorEvent, ingress } from "../src/runtime/index.ts";
import { captureEvents, eventually, expireJobs, resetSeams, settle } from "../src/testing.ts";
import type { Scribe } from "./src/agent.ts";
import { system } from "./src/index.ts";

const scribe = (key: string) => env.SCRIBE.getByName(key);
type Script = (request: ScriptedRequest) => ScriptedTurn | Promise<ScriptedTurn>;
const shared = globalThis as { __scribeScripts?: Record<string, Script>; __scribeInstructions?: Record<string, string> };

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
