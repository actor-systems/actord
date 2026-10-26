// Declared sources, tested in workerd through the probe Worker's own fetch (SELF), as GitHub would call it.
import { env } from "cloudflare:workers";
import { SELF, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { EffectRejected, ingress } from "../src/runtime/index.ts";
import { approvalEmail, handleWebhook, SUBJECT_TAG, verifyApprovalToken } from "../src/sources/index.ts";
import { captureEvents, expireApprovals, injectFault, overrideEffect, resetSeams, settle } from "../src/testing.ts";
import { system } from "./src/index.ts";

afterEach(() => resetSeams());
const probe = (key: string) => env.PROBE.getByName(key);
const enc = new TextEncoder();

/** The X-Hub-Signature-256 header GitHub would send for this body. */
async function signed(body: string, secret = "test-secret"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
const deliver = async (body: string, headers: Record<string, string>) => SELF.fetch("https://probe/hooks/probe", { method: "POST", body, headers });
const poke = async (key: string, delivery: string) => {
  const body = JSON.stringify({ action: "poke", key });
  return deliver(body, { "x-github-event": "probe", "x-github-delivery": delivery, "x-hub-signature-256": await signed(body) });
};

it("[source-delivers] a signed, mapped GitHub delivery reaches its actor once, under the delivery id", async () => {
  const body = JSON.stringify({ action: "poke", key: "s1" });
  const res = await SELF.fetch("https://probe/hooks/probe", { method: "POST", body, headers: { "x-github-event": "probe", "x-github-delivery": "gh-1", "x-hub-signature-256": await signed(body) } });
  expect(res.status).toBe(202);
  expect(await probe("s1").poked()).toEqual(["gh-1"]);
});

it("[source-bad-signature] a delivery with a wrong signature is refused with 401 and never delivered", async () => {
  const events = captureEvents();
  const body = JSON.stringify({ action: "poke", key: "s-bad" });
  const res = await deliver(body, { "x-github-event": "probe", "x-github-delivery": "gh-bad", "x-hub-signature-256": await signed(body, "not-the-secret") });
  expect(res.status).toBe(401);
  expect(await probe("s-bad").poked()).toEqual([]);
  expect(events.filter((e) => e.kind.startsWith("source."))).toMatchObject([{ kind: "source.rejected", actor: "@hooks", reason: "signature" }]);
  // No signature at all, and one that isn't hex, are refused the same way.
  expect((await deliver(body, { "x-github-event": "probe", "x-github-delivery": "gh-bad" })).status).toBe(401);
  expect((await deliver(body, { "x-github-event": "probe", "x-github-delivery": "gh-bad", "x-hub-signature-256": "sha256=zz" })).status).toBe(401);
  expect(await probe("s-bad").poked()).toEqual([]);
});

it("[source-raw-body] a body re-serialised after signing is refused", async () => {
  const obj = { action: "poke", key: "s-raw" };
  const res = await deliver(JSON.stringify(obj, null, 2), { "x-github-event": "probe", "x-github-delivery": "gh-raw", "x-hub-signature-256": await signed(JSON.stringify(obj)) });
  expect(res.status).toBe(401);
  expect(await probe("s-raw").poked()).toEqual([]);
});

it("[source-redelivery] the same delivery id twice is handled once and answered 202 both times", async () => {
  const statuses = [(await poke("s-re", "gh-re")).status, (await poke("s-re", "gh-re")).status];
  expect(statuses).toEqual([202, 202]);
  expect(await probe("s-re").poked()).toEqual(["gh-re"]);
});

it("[source-unmapped] an event with no mapping is answered 204 and recorded", async () => {
  const events = captureEvents();
  const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const res = await deliver(body, { "x-github-event": "ping", "x-github-delivery": "gh-ping", "x-hub-signature-256": await signed(body) });
  expect(res.status).toBe(204);
  expect(events.filter((e) => e.kind.startsWith("source."))).toMatchObject([{ kind: "source.ignored", actor: "@hooks", detail: { source: "hooks", event: "ping", deliveryId: "gh-ping" } }]);
  // An inherited property name is not a mapping either.
  const res2 = await deliver(body, { "x-github-event": "constructor", "x-github-delivery": "gh-ctor", "x-hub-signature-256": await signed(body) });
  expect(res2.status).toBe(204);
});

it("[source-invalid] a payload the mapping can't turn into a valid message is 400, recorded with its delivery id", async () => {
  const events = captureEvents();
  const body = JSON.stringify({ action: "poke", key: 42 });
  const res = await deliver(body, { "x-github-event": "probe", "x-github-delivery": "gh-invalid", "x-hub-signature-256": await signed(body) });
  expect(res.status).toBe(400);
  expect(events.filter((e) => e.kind.startsWith("source."))).toMatchObject([{ kind: "source.invalid", actor: "@hooks", reason: "invalid_payload", messageId: "gh-invalid", detail: { source: "hooks", event: "probe.poke", deliveryId: "gh-invalid" } }]);
  // Refused at the edge: no actor was asked.
  expect(events.filter((e) => !e.kind.startsWith("source."))).toEqual([]);
});

it("[source-not-mine] a path no source declares falls through to the app", async () => {
  const res = await SELF.fetch("https://probe/other");
  expect(await res.text()).toBe("runtime probe");
});

it("[source-method] a source's path answers only POST", async () => {
  const res = await SELF.fetch("https://probe/hooks/probe");
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
});

it("[source-delivery-id-missing] a signed delivery without X-GitHub-Delivery is 400 and never delivered", async () => {
  const events = captureEvents();
  const body = JSON.stringify({ action: "poke", key: "s-noid" });
  const res = await deliver(body, { "x-github-event": "probe", "x-hub-signature-256": await signed(body) });
  expect(res.status).toBe(400);
  expect(await probe("s-noid").poked()).toEqual([]);
  expect(events.filter((e) => e.kind.startsWith("source."))).toMatchObject([{ kind: "source.invalid", actor: "@hooks", reason: "delivery_id_missing" }]);
});

it("[source-secret-missing] with no secret in env, nothing is accepted: 500, recorded", async () => {
  const events = captureEvents();
  const body = JSON.stringify({ action: "poke", key: "s-nosecret" });
  const req = new Request("https://probe/hooks/probe", { method: "POST", body, headers: { "x-github-event": "probe", "x-github-delivery": "gh-nosecret", "x-hub-signature-256": await signed(body) } });
  const res = await handleWebhook(req, { PROBE: env.PROBE }, system);
  expect(res?.status).toBe(500);
  expect(await probe("s-nosecret").poked()).toEqual([]);
  expect(events.filter((e) => e.kind.startsWith("source."))).toMatchObject([{ kind: "source.rejected", actor: "@hooks", reason: "secret_missing" }]);
});

it("[source-handler-failed] a delivery whose handler fails is 500 and recorded, and its redelivery is handled", async () => {
  const events = captureEvents();
  injectFault({ actor: "Probe", type: "probe.poked", at: "before-handler" });
  expect((await poke("s-fail", "gh-fail")).status).toBe(500);
  expect(await probe("s-fail").poked()).toEqual([]);
  expect(events.filter((e) => e.kind.startsWith("source."))).toMatchObject([{ kind: "source.failed", actor: "@hooks", messageId: "gh-fail", detail: { deliveryId: "gh-fail" } }]);
  expect((await poke("s-fail", "gh-fail")).status).toBe(202);
  expect(await probe("s-fail").poked()).toEqual(["gh-fail"]);
});

/** The probe system with more events on its hooks source (and more routes), as a Worker built from another system.ts would have. */
const variant = (events: Record<string, { message: string; key: (e: never) => string; map: (e: never) => unknown }>, routes: Array<{ from: string; message: string; to: string }> = []) =>
  ({ ...system, sources: { hooks: { ...system.sources.hooks, events: { ...system.sources.hooks.events, ...events } } }, routes: [...system.routes, ...routes] }) as never;
const request = async (body: string, delivery: string) =>
  new Request("https://probe/hooks/probe", { method: "POST", body, headers: { "x-github-event": "probe", "x-github-delivery": delivery, "x-hub-signature-256": await signed(body) } });

it("[source-mapping-throws] a mapping that throws is 400, recorded with its delivery id and the error", async () => {
  const events = captureEvents();
  const sys = variant({ "probe.explode": { message: "probe.poked", key: () => { throw new Error("no key in this payload"); }, map: () => ({ key: "x" }) } });
  const res = await handleWebhook(await request(JSON.stringify({ action: "explode" }), "gh-throw"), env, sys);
  expect(res?.status).toBe(400);
  expect(events.filter((e) => e.kind.startsWith("source."))).toMatchObject([{ kind: "source.invalid", reason: "mapping_failed", messageId: "gh-throw", detail: { event: "probe.explode", deliveryId: "gh-throw", error: "no key in this payload" } }]);
  expect(events.filter((e) => !e.kind.startsWith("source."))).toEqual([]);
});

it("[source-receiver-rejected] a delivery the receiving actor refuses is 400, recorded with its delivery id", async () => {
  const events = captureEvents();
  // This Worker's system routes @hooks → probe.approve, but the deployed actor's doesn't, so the actor refuses it.
  const sys = variant({ "probe.approve": { message: "probe.approve", key: (e: { key: string }) => e.key, map: (e: { key: string }) => ({ key: e.key, by: "someone" }) } }, [{ from: "@hooks", message: "probe.approve", to: "Probe" }]);
  const res = await handleWebhook(await request(JSON.stringify({ action: "approve", key: "s-rej" }), "gh-rej"), env, sys);
  expect(res?.status).toBe(400);
  expect(events.filter((e) => e.kind.startsWith("source."))).toMatchObject([{ kind: "source.invalid", reason: "unauthorized_route", messageId: "gh-rej", detail: { deliveryId: "gh-rej" } }]);
  expect(await probe("s-rej").approvals()).toEqual([]);
});

it("[source-malformed] a signed delivery that isn't JSON, names no event, or maps to no key is 400 and recorded", async () => {
  const events = captureEvents();
  const notJson = "{ not json";
  expect((await deliver(notJson, { "x-github-event": "probe", "x-github-delivery": "gh-nj", "x-hub-signature-256": await signed(notJson) })).status).toBe(400);
  const body = JSON.stringify({ action: "poke", key: "s-mal" });
  expect((await deliver(body, { "x-github-delivery": "gh-noev", "x-hub-signature-256": await signed(body) })).status).toBe(400);
  const sys = variant({ "probe.nokey": { message: "probe.poked", key: () => "", map: () => ({ key: "s-mal" }) } });
  expect((await handleWebhook(await request(JSON.stringify({ action: "nokey" }), "gh-nokey"), env, sys))?.status).toBe(400);
  expect(events.filter((e) => e.kind.startsWith("source.")).map((e) => [e.kind, e.reason, e.messageId])).toEqual([
    ["source.invalid", "invalid_json", "gh-nj"],
    ["source.invalid", "event_missing", "gh-noev"],
    ["source.invalid", "invalid_key", "gh-nokey"],
  ]);
  expect(await probe("s-mal").poked()).toEqual([]);
});

// ---- Asking for approval (plan 2, Task 5) ----

type Sent = { from: unknown; to: unknown; subject: string; text: string; headers?: Record<string, string> };
/** Install the real email adapter for notify.approval, with a fake send binding that keeps every message. */
function mailbox(): Sent[] {
  const sent: Sent[] = [];
  const e = env as unknown as Record<string, string>;
  overrideEffect("notify.approval", approvalEmail({ send: { send: async (m) => void sent.push(m as Sent) }, from: e.PROBE_FROM!, to: e.PROBE_OWNER!, secret: e.PROBE_APPROVAL_SECRET! }));
  return sent;
}
const park = (key: string, instance = key) => ingress(env, system, "Probe", "probe.effect", { effect: "gateway.approval", key }, { key: instance });
const parkedRow = (instance: string, key: string) =>
  runInDurableObject(probe(instance), (_i, s) => s.storage.sql.exec<{ status: string; next_at: number }>("SELECT status, next_at FROM _actors_outbox WHERE id = ?", `fx:gateway.approval:${key}`).one());
const notifyRows = (instance: string) => runInDurableObject(probe(instance), (_i, s) => s.storage.sql.exec<{ id: string; status: string }>("SELECT id, status FROM _actors_outbox WHERE target = 'notify.approval' ORDER BY seq").toArray());

it("[approval-notifies] a parked effect emails the owner once, with a signed token naming it in the subject", async () => {
  const events = captureEvents();
  const sent = mailbox();
  let runs = 0;
  overrideEffect("gateway.approval", { run: async () => ++runs });
  await park("an-1");
  await settle(env, system);
  const row = await parkedRow("an-1", "an-1");
  expect(row.status).toBe("awaiting_approval");
  expect(runs).toBe(0);
  expect(sent).toHaveLength(1);
  const mail = sent[0]!;
  expect(mail).toMatchObject({ from: "actord@probe.example", to: "owner@probe.example" });
  const token = SUBJECT_TAG.exec(mail.subject)?.[1];
  expect(token).toBeDefined();
  expect(mail.subject).toBe(`Approve gateway.approval? [actord:${token}]`);
  expect(mail.headers).toEqual({ "X-Actord-Approval": token });
  expect(await verifyApprovalToken("probe-approval-secret", token!, Date.now())).toEqual({ ok: true, claims: { actor: "Probe", key: "an-1", effect: "gateway.approval", effectKey: "an-1", exp: row.next_at } });
  // The body says what, why, what a denial does, when it expires and how to answer, in that order, with no link to click.
  const lines = [
    "Needs a person", // the effect's description, then its input as indented JSON
    '"key": "an-1"',
    "If you deny it: the actor is told it was denied and the effect never runs.",
    `This request expires at ${new Date(row.next_at).toISOString()}.`,
    "Reply with approve, or deny followed by a reason, on the first line.",
  ];
  const at = lines.map((l) => mail.text.indexOf(l));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(mail.text).not.toMatch(/http/i);
  // The request is an effect of its own, keyed by the effect it asks about, and it settled.
  expect(events.filter((e) => e.kind === "effect.requested" && e.effect === "notify.approval")).toMatchObject([{ effectKey: "approval:gateway.approval:an-1", detail: { approvalFor: "an-1" } }]);
  expect(await notifyRows("an-1")).toEqual([{ id: "fx:notify.approval:approval:gateway.approval:an-1", status: "confirmed" }]);
});

it("[approval-notify-once] parking the same effect again, after a restart's orphan recovery, sends no second email", async () => {
  const events = captureEvents();
  const sent = mailbox();
  overrideEffect("gateway.approval", { run: async () => "ran" });
  await park("an-2");
  await settle(env, system);
  expect(sent).toHaveLength(1);
  // As if the instance died while the attempt was marked running: recovery retries the keyed effect, which parks again.
  await runInDurableObject(probe("an-2"), (_i, s) => void s.storage.sql.exec("UPDATE _actors_outbox SET status = 'running' WHERE id = 'fx:gateway.approval:an-2'"));
  await abortAllDurableObjects();
  await settle(env, system);
  expect(events.filter((e) => e.kind === "effect.awaiting_approval" && e.effectKey === "an-2")).toHaveLength(2);
  expect((await parkedRow("an-2", "an-2")).status).toBe("awaiting_approval");
  expect(sent).toHaveLength(1);
  expect(events.filter((e) => e.kind === "effect.requested" && e.effect === "notify.approval")).toHaveLength(1);
  expect(await notifyRows("an-2")).toHaveLength(1);
});

it("[approval-notify-absent] a system without approvals.notify parks without enqueuing anything", async () => {
  const events = captureEvents();
  const sent = mailbox();
  overrideEffect("gateway.approval", { run: async () => "ran" });
  // A "quiet-" instance runs the probe system without approvals.notify (test-runtime/src/index.ts).
  await park("an-3", "quiet-an-3");
  await settle(env, system);
  expect((await parkedRow("quiet-an-3", "an-3")).status).toBe("awaiting_approval");
  expect(await notifyRows("quiet-an-3")).toEqual([]);
  expect(await runInDurableObject(probe("quiet-an-3"), (_i, s) => s.storage.sql.exec("SELECT COUNT(*) AS n FROM _actors_outbox").one().n)).toBe(1);
  expect(events.filter((e) => e.effect === "notify.approval")).toEqual([]);
  expect(sent).toEqual([]);
});

it("[approval-notify-fails] a notification that fails or ends in doubt leaves the effect parked, and it still expires", async () => {
  overrideEffect("gateway.approval", { run: async () => "ran" });
  for (const [key, run] of [
    ["an-4", async () => { throw new EffectRejected("mailbox full"); }],
    ["an-5", async () => { throw new Error("connection reset after send"); }],
  ] as const) {
    overrideEffect("notify.approval", { run });
    await park(key);
    await settle(env, system);
    expect((await notifyRows(key)).map((r) => r.status)).toEqual([key === "an-4" ? "failed" : "in_doubt"]);
    expect((await parkedRow(key, key)).status).toBe("awaiting_approval");
    await expireApprovals(env, system, "Probe", key);
    await settle(env, system);
    expect(await probe(key).outcomes()).toMatchObject([{ key, status: "failed", error: "approval expired" }]);
  }
});
