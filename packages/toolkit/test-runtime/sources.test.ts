// Declared sources, tested in workerd through the probe Worker's own fetch (SELF), as GitHub would call it.
import { env } from "cloudflare:workers";
import { SELF, abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { type ActorEvent, EffectRejected, deriveId, ingress } from "../src/runtime/index.ts";
import { type ApprovalClaims, approvalEmail, type ForwardableEmailLike, handleEmail, handleWebhook, SUBJECT_TAG, signApprovalToken, verifyApprovalToken } from "../src/sources/index.ts";
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

// ---- Answering by email (plan 2, Task 6) ----

const OWNER = "owner@probe.example";
/** What the trusted receiving server (PROBE_AUTHSERV) writes above a reply it checked. */
const PASS = "mx.probe.example; spf=pass smtp.mailfrom=probe.example; dkim=pass header.d=probe.example; dmarc=pass (p=reject dis=none) header.from=probe.example";
type Answer = { from: unknown; to: unknown; subject: string; text: string; headers?: Record<string, string> };

/** The env the Worker's email handler sees: the probe's, plus a fake send binding that keeps every reply it sends. */
function answering(overrides: Record<string, unknown> = {}): { replies: Answer[]; env: unknown } {
  const replies: Answer[] = [];
  const e = env as unknown as Record<string, unknown>;
  return { replies, env: { PROBE: e.PROBE, PROBE_APPROVAL_SECRET: e.PROBE_APPROVAL_SECRET, PROBE_OWNER: e.PROBE_OWNER, PROBE_FROM: e.PROBE_FROM, PROBE_AUTHSERV: e.PROBE_AUTHSERV, PROBE_SEND: { send: async (m: Answer) => void replies.push(m) }, ...overrides } };
}

let replyCount = 0;
/**
 * A fake ForwardableEmailMessage: the minimal multipart/alternative MIME reply a mail client sends. `headers`
 * come first, as a receiving server prepends Authentication-Results, and one given as an array repeats.
 * The envelope sender is `from`'s unless `envelopeFrom` is given; `messageId: null` leaves the Message-ID out.
 */
function reply({ from, subject, text, headers = {}, envelopeFrom = from, messageId }: { from: string; subject: string; text: string; headers?: Record<string, string | string[]>; envelopeFrom?: string; messageId?: string | null }): ForwardableEmailLike {
  const id = messageId === undefined ? `<reply-${++replyCount}.${crypto.randomUUID()}@mail.probe.example>` : messageId;
  const head: Array<[string, string]> = [
    ...Object.entries(headers).flatMap(([k, v]) => [v].flat().map((one): [string, string] => [k, one])),
    ["From", from],
    ["To", "actord@probe.example"],
    ["Subject", subject],
    ...(id === null ? [] : [["Message-ID", id] as [string, string]]),
    ["Date", "Mon, 26 Oct 2026 09:00:00 +0000"],
    ["MIME-Version", "1.0"],
    ["Content-Type", 'multipart/alternative; boundary="part"'],
  ];
  const html = text.split("\n").map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>");
  const mime = [...head.map(([k, v]) => `${k}: ${v}`), "", "--part", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", text, "--part", "Content-Type: text/html; charset=utf-8", "", `<div>${html}</div>`, "--part--", ""].join("\n");
  const raw = enc.encode(mime.replace(/\r?\n/g, "\r\n"));
  return { from: envelopeFrom, to: "actord@probe.example", headers: new Headers(head), raw: new ReadableStream({ start: (c) => { c.enqueue(raw); c.close(); } }), rawSize: raw.byteLength };
}

/** Park `effect` under `key`, counting its runs, and return the approval request the owner was emailed and its token. */
async function asked(key: string, effect: "gateway.approval" | "gateway.publish" = "gateway.approval") {
  const sent = mailbox();
  const fx = { runs: 0 };
  overrideEffect(effect, { run: async () => ++fx.runs });
  await ingress(env, system, "Probe", "probe.effect", { effect, key }, { key });
  await settle(env, system);
  expect(sent).toHaveLength(1);
  const request = sent[0]!;
  return { request, fx, token: SUBJECT_TAG.exec(request.subject)![1]! };
}
/** A Gmail-style reply body: the owner's lines, then the request quoted below an "On … wrote:" line. */
const below = (request: Sent, ...lines: string[]) => [...lines, "", "On Mon, Oct 26, 2026 at 9:00 AM actord <actord@probe.example> wrote:", ...request.text.trimEnd().split("\n").map((l) => `> ${l}`)].join("\n");
const sourceEvents = (events: ActorEvent[]) => events.filter((e) => e.kind.startsWith("source."));
/** The one reply the owner gets once the actor has their answer, whether or not it changed anything. */
const received = (decision: "approve" | "deny", key: string, effect = "gateway.approval") => `Received: ${decision} for ${effect} (${key}). If it had already been decided or had expired, this changed nothing.`;
const ASK_AGAIN = "reply with approve, or deny followed by a reason, on the first line";
const fxStatus = (key: string, effect = "gateway.approval") => runInDurableObject(probe(key), (_i, s) => s.storage.sql.exec<{ status: string }>("SELECT status FROM _actors_outbox WHERE id = ?", `fx:${effect}:${key}`).one().status);

it("[email-approves] the owner's 'approve' with dmarc=pass approves the parked effect, which runs once, by the owner via @mail", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-ok");
  const { replies, env: e } = answering();
  const answer = reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "approve"), headers: { "Authentication-Results": PASS } });
  await handleEmail(answer, e, system);
  await settle(env, system);
  expect(fx.runs).toBe(1);
  expect(await probe("em-ok").outcomes()).toMatchObject([{ key: "em-ok", status: "confirmed" }]);
  expect(await probe("em-ok").decisions()).toEqual([{ effect: "gateway.approval", effectKey: "em-ok", decision: "approve", reason: null, by: OWNER, authenticated: "pass" }]);
  expect(await probe("em-ok").approvals()).toEqual([{ key: "em-ok", ok: true }]);
  expect(events.find((ev) => ev.kind === "note" && ev.effectKey === "em-ok")).toMatchObject({ reason: "approved by a person", detail: { by: OWNER, via: "@mail" } });
  // The owner hears back once, in the thread, marked as sent automatically.
  expect(replies).toEqual([{ from: "actord@probe.example", to: OWNER, subject: `Re: ${request.subject}`, text: received("approve", "em-ok"), headers: { "Auto-Submitted": "auto-replied", "In-Reply-To": answer.headers.get("message-id") } }]);
  expect(sourceEvents(events)).toEqual([]);
});

it("[email-denies] 'deny not now' denies the parked effect with that reason, and it never runs", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-no");
  const { replies, env: e } = answering();
  await handleEmail(reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "deny not now"), headers: { "Authentication-Results": PASS } }), e, system);
  await settle(env, system);
  expect(fx.runs).toBe(0);
  expect(await probe("em-no").decisions()).toEqual([{ effect: "gateway.approval", effectKey: "em-no", decision: "deny", reason: "not now", by: OWNER, authenticated: "pass" }]);
  expect(events.find((ev) => ev.kind === "effect.denied" && ev.effectKey === "em-no")).toMatchObject({ reason: "not now", detail: { by: OWNER, via: "@mail" } });
  expect(await fxStatus("em-no")).toBe("denied");
  // A bare "Deny" gives no reason.
  const bare = await asked("em-no-bare");
  await handleEmail(reply({ from: OWNER, subject: `Re: ${bare.request.subject}`, text: below(bare.request, "Deny"), headers: { "Authentication-Results": PASS } }), e, system);
  await settle(env, system);
  expect(await probe("em-no-bare").decisions()).toMatchObject([{ decision: "deny", reason: null }]);
  expect(await fxStatus("em-no-bare")).toBe("denied");
  expect(bare.fx.runs).toBe(0);
  expect(replies.map((r) => r.text)).toEqual([received("deny", "em-no"), received("deny", "em-no-bare")]);
});

it("[email-not-owner] a reply that isn't from the owner gets no reply and no delivery, and is recorded", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-who");
  const { replies, env: e } = answering();
  const subject = `Re: ${request.subject}`;
  const text = below(request, "approve");
  const headers = { "Authentication-Results": PASS };
  for (const m of [
    reply({ from: "mallory@evil.example", subject, text, headers }),
    // The owner's From over someone else's envelope, someone else's From over the owner's envelope, and a From naming two people.
    reply({ from: OWNER, envelopeFrom: "mallory@evil.example", subject, text, headers }),
    reply({ from: "Mallory <mallory@evil.example>", envelopeFrom: OWNER, subject, text, headers }),
    reply({ from: `${OWNER}, mallory@evil.example`, envelopeFrom: OWNER, subject, text, headers }),
    // Nobody else hears anything back, not even that a subject has no token.
    reply({ from: "mallory@evil.example", subject: "hello", text: "approve" }),
  ])
    await handleEmail(m, e, system);
  await settle(env, system);
  expect(replies).toEqual([]);
  expect(await probe("em-who").approvals()).toEqual([]);
  expect(fx.runs).toBe(0);
  expect(await fxStatus("em-who")).toBe("awaiting_approval");
  expect(sourceEvents(events).map((ev) => [ev.kind, ev.actor, ev.reason])).toEqual(Array(5).fill(["source.rejected", "@mail", "not_owner"]));
});

it("[email-bad-token] a reply whose subject token was edited, or that has none, gets a reply and no delivery", async () => {
  const events = captureEvents();
  const { request, token, fx } = await asked("em-bad");
  const { replies, env: e } = answering();
  const [payload, signature] = token.split(".") as [string, string];
  const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as ApprovalClaims;
  const edited = [
    `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`, // a changed signature
    `${b64url(JSON.stringify({ ...claims, effectKey: "someone-elses" }))}.${signature}`, // changed claims under the old signature
  ];
  const headers = { "Authentication-Results": PASS };
  const text = below(request, "approve");
  for (const t of edited) await handleEmail(reply({ from: OWNER, subject: `Re: ${request.subject.replace(token, t)}`, text, headers, messageId: `<edited-${t.length}@mail.probe.example>` }), e, system);
  await handleEmail(reply({ from: OWNER, subject: "Re: Approve gateway.approval?", text, headers }), e, system);
  await settle(env, system);
  expect(replies.map((r) => r.text)).toEqual(Array(3).fill("this address only accepts replies to actord approval requests"));
  const first = replies[0]!;
  expect(first).toMatchObject({ from: "actord@probe.example", to: OWNER, subject: `Re: ${request.subject.replace(token, edited[0]!)}`, headers: { "In-Reply-To": `<edited-${edited[0]!.length}@mail.probe.example>` } });
  expect(await probe("em-bad").approvals()).toEqual([]);
  expect(fx.runs).toBe(0);
  expect(await fxStatus("em-bad")).toBe("awaiting_approval");
  expect(sourceEvents(events).map((ev) => [ev.kind, ev.reason])).toEqual([
    ["source.rejected", "bad_signature"],
    ["source.rejected", "bad_signature"],
    ["source.ignored", "no_token"],
  ]);
});

it("[email-expired-token] a reply that arrives after its request expired is told so, and nothing reaches the actor", async () => {
  const events = captureEvents();
  const { request, token, fx } = await asked("em-late");
  const { replies, env: e } = answering();
  await expireApprovals(env, system, "Probe", "em-late");
  await settle(env, system);
  // The request's own claims, signed with the system's secret, with their expiry passed: a reply that comes too late.
  const { claims } = (await verifyApprovalToken("probe-approval-secret", token, Date.now())) as { claims: ApprovalClaims };
  const exp = Date.now() - 60_000;
  const late = await signApprovalToken("probe-approval-secret", { ...claims, exp });
  await handleEmail(reply({ from: OWNER, subject: `Re: ${request.subject.replace(token, late)}`, text: below(request, "approve"), headers: { "Authentication-Results": PASS } }), e, system);
  await settle(env, system);
  expect(replies.map((r) => r.text)).toEqual([`this request expired at ${new Date(exp).toISOString()}; nothing was approved`]);
  expect(await probe("em-late").approvals()).toEqual([]);
  expect(fx.runs).toBe(0);
  expect(await probe("em-late").outcomes()).toMatchObject([{ key: "em-late", status: "failed", error: "approval expired" }]);
  expect(sourceEvents(events)).toMatchObject([{ kind: "source.rejected", actor: "@mail", reason: "expired", effect: "gateway.approval", effectKey: "em-late" }]);
});

it("[email-quoted-approve] an 'approve' only in the quoted text below the owner's first line asks again", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-quote");
  const { replies, env: e } = answering();
  const subject = `Re: ${request.subject}`;
  const headers = { "Authentication-Results": PASS };
  for (const text of [
    below(request, "hmm", "", "> approve"),
    below(request), // nothing written above the quote
    "> approve",
  ])
    await handleEmail(reply({ from: OWNER, subject, text, headers }), e, system);
  await settle(env, system);
  expect(replies.map((r) => r.text)).toEqual(Array(3).fill("reply with approve, or deny followed by a reason, on the first line"));
  expect(await probe("em-quote").approvals()).toEqual([]);
  expect(fx.runs).toBe(0);
  expect(sourceEvents(events).map((ev) => [ev.kind, ev.reason])).toEqual(Array(3).fill(["source.ignored", "unparsed"]));
  // The ask keeps the request's subject, so answering it on the first line counts.
  await handleEmail(reply({ from: OWNER, subject: replies[0]!.subject, text: "approve", headers }), e, system);
  await settle(env, system);
  expect(fx.runs).toBe(1);
});

it("[email-unknown-auth-tool] with no authentication result, 'approve' approves an effect that doesn't publish, marked unknown", async () => {
  const { request, fx } = await asked("em-unk");
  const { replies, env: e } = answering();
  // A display name and another letter case are still the owner's address.
  await handleEmail(reply({ from: "The Owner <Owner@Probe.Example>", envelopeFrom: OWNER, subject: `Re: ${request.subject}`, text: below(request, "  Approve  ") }), e, system);
  await settle(env, system);
  expect(fx.runs).toBe(1);
  expect(await probe("em-unk").decisions()).toEqual([{ effect: "gateway.approval", effectKey: "em-unk", decision: "approve", reason: null, by: OWNER, authenticated: "unknown" }]);
  expect(replies.map((r) => r.text)).toEqual([received("approve", "em-unk")]);
});

it("[email-unknown-auth-publishes] with no authentication result, 'approve' can't approve an effect that publishes, though a deny can", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-pub", "gateway.publish");
  const { replies, env: e } = answering();
  const subject = `Re: ${request.subject}`;
  await handleEmail(reply({ from: OWNER, subject, text: below(request, "approve") }), e, system);
  await settle(env, system);
  expect(replies.map((r) => r.text)).toEqual(["this effect publishes; approve it in GitHub"]);
  expect(fx.runs).toBe(0);
  expect(await probe("em-pub").approvals()).toEqual([]);
  expect(await fxStatus("em-pub", "gateway.publish")).toBe("awaiting_approval");
  expect(sourceEvents(events)).toMatchObject([{ kind: "source.rejected", actor: "@mail", reason: "publishes_unauthenticated", effect: "gateway.publish", effectKey: "em-pub" }]);
  // Refusing needs no proof of who sent it, so a deny goes through.
  await handleEmail(reply({ from: OWNER, subject, text: below(request, "deny wrong repo") }), e, system);
  await settle(env, system);
  expect(await probe("em-pub").decisions()).toMatchObject([{ decision: "deny", reason: "wrong repo", authenticated: "unknown" }]);
  expect(await fxStatus("em-pub", "gateway.publish")).toBe("denied");
  // With dmarc=pass, the same approve of an effect that publishes counts.
  const ok = await asked("em-pub-ok", "gateway.publish");
  await handleEmail(reply({ from: OWNER, subject: `Re: ${ok.request.subject}`, text: below(ok.request, "approve"), headers: { "Authentication-Results": PASS } }), e, system);
  await settle(env, system);
  expect(ok.fx.runs).toBe(1);
  expect(fx.runs).toBe(0);
});

it("[email-dmarc-fail] a reply whose Authentication-Results says dmarc=fail is refused, with no reply", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-forged");
  const { replies, env: e } = answering();
  const subject = `Re: ${request.subject}`;
  const text = below(request, "approve");
  await handleEmail(reply({ from: OWNER, subject, text, headers: { "Authentication-Results": "mx.probe.example; spf=fail smtp.mailfrom=probe.example; dkim=none; dmarc=fail (p=reject) header.from=probe.example" } }), e, system);
  // A pass in one header doesn't outweigh a fail in another.
  await handleEmail(reply({ from: OWNER, subject, text, headers: { "Authentication-Results": [PASS, "mx.probe.example; dmarc=FAIL header.from=probe.example"] } }), e, system);
  await settle(env, system);
  expect(replies).toEqual([]);
  expect(fx.runs).toBe(0);
  expect(await probe("em-forged").approvals()).toEqual([]);
  expect(await fxStatus("em-forged")).toBe("awaiting_approval");
  expect(sourceEvents(events).map((ev) => [ev.kind, ev.actor, ev.reason])).toEqual(Array(2).fill(["source.rejected", "@mail", "dmarc_fail"]));
});

it("[email-second-reply] when the owner answers twice, the first answer wins; the second is delivered and finds nothing waiting", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-twice");
  const { replies, env: e } = answering();
  const subject = `Re: ${request.subject}`;
  const headers = { "Authentication-Results": PASS };
  await handleEmail(reply({ from: OWNER, subject, text: below(request, "approve"), headers }), e, system);
  await settle(env, system);
  await handleEmail(reply({ from: OWNER, subject, text: below(request, "deny changed my mind"), headers }), e, system);
  await settle(env, system);
  await handleEmail(reply({ from: OWNER, subject, text: below(request, "approve"), headers }), e, system);
  await settle(env, system);
  expect(fx.runs).toBe(1);
  expect(await probe("em-twice").decisions()).toMatchObject([{ decision: "approve" }, { decision: "deny", reason: "changed my mind" }, { decision: "approve" }]);
  // What applyDecision (ctx.approve or ctx.deny) answered each time.
  expect(await probe("em-twice").approvals()).toEqual([
    { key: "em-twice", ok: true },
    { key: "em-twice", ok: false },
    { key: "em-twice", ok: false },
  ]);
  expect(await probe("em-twice").outcomes()).toMatchObject([{ key: "em-twice", status: "confirmed" }]);
  expect(events.filter((ev) => ev.kind === "effect.denied" || ev.kind === "duplicate")).toEqual([]);
  // Each answer is acknowledged the same way: the reply says what was received, not whether it changed anything.
  expect(replies.map((r) => r.text)).toEqual([received("approve", "em-twice"), received("deny", "em-twice"), received("approve", "em-twice")]);
  expect(sourceEvents(events)).toEqual([]);
});

it("[email-duplicate-delivery] the same email, with the same Message-ID, handled twice is delivered once", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-dup");
  const { replies, env: e } = answering();
  const same = (messageId: string | null) => reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "approve"), headers: { "Authentication-Results": PASS }, messageId });
  await handleEmail(same("<dup-1@mail.probe.example>"), e, system);
  await settle(env, system);
  await handleEmail(same("<dup-1@mail.probe.example>"), e, system);
  await settle(env, system);
  expect(fx.runs).toBe(1);
  expect(await probe("em-dup").approvals()).toEqual([{ key: "em-dup", ok: true }]);
  const id = deriveId("email", "<dup-1@mail.probe.example>");
  expect(events.filter((ev) => ev.kind === "received" && ev.messageId === id)).toHaveLength(1);
  expect(events.filter((ev) => ev.kind === "duplicate")).toMatchObject([{ messageId: id, from: "@mail" }]);
  // The duplicate is acknowledged too: the owner's answer is there either way.
  expect(replies.map((r) => r.text)).toEqual([received("approve", "em-dup"), received("approve", "em-dup")]);
  // With no Message-ID, the same answer to the same request from the same sender is one delivery too.
  const bare = await asked("em-dup-bare");
  const again = () => reply({ from: OWNER, subject: `Re: ${bare.request.subject}`, text: below(bare.request, "approve"), headers: { "Authentication-Results": PASS }, messageId: null });
  await handleEmail(again(), e, system);
  await settle(env, system);
  await handleEmail(again(), e, system);
  await settle(env, system);
  expect(bare.fx.runs).toBe(1);
  expect(await probe("em-dup-bare").approvals()).toEqual([{ key: "em-dup-bare", ok: true }]);
});

it("[email-misconfigured] without a secret or an owner nothing is accepted, and a reply that can't be sent is recorded", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-cfg");
  const e = env as unknown as Record<string, unknown>;
  const answer = (text: string) => reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, text), headers: { "Authentication-Results": PASS } });
  await handleEmail(answer("approve"), { PROBE: e.PROBE, PROBE_OWNER: OWNER, PROBE_FROM: e.PROBE_FROM }, system);
  await handleEmail(answer("approve"), { PROBE: e.PROBE, PROBE_APPROVAL_SECRET: e.PROBE_APPROVAL_SECRET, PROBE_FROM: e.PROBE_FROM }, system);
  // No send binding: the ask can't go out, and that is recorded rather than thrown.
  await handleEmail(answer("hmm"), { PROBE: e.PROBE, PROBE_APPROVAL_SECRET: e.PROBE_APPROVAL_SECRET, PROBE_OWNER: OWNER, PROBE_FROM: e.PROBE_FROM }, system);
  await settle(env, system);
  expect(fx.runs).toBe(0);
  expect(await probe("em-cfg").approvals()).toEqual([]);
  expect(sourceEvents(events).map((ev) => [ev.kind, ev.reason])).toEqual([
    ["source.rejected", "secret_missing"],
    ["source.rejected", "owner_missing"],
    ["source.ignored", "unparsed"],
    ["source.failed", "reply_failed"],
  ]);
});

// One test per case, so each has its own time budget and a failure names its case.
const FORGED: Array<[string, string[], Record<string, unknown>]> = [
  // (a) a pass under an authserv-id nobody trusts, as a sender would write it
  ["em-forged-a", ["mx.forger.example; dmarc=pass header.from=probe.example"], {}],
  // (b) a forged pass below the trusted server's own header, which found no DMARC policy
  ["em-forged-b", ["mx.probe.example; spf=pass smtp.mailfrom=probe.example; dmarc=none header.from=probe.example", "mx.probe.example; dmarc=pass header.from=probe.example"], {}],
  // the trusted header's only "dmarc=pass" is in a comment, or in a quoted value a sender chose
  ["em-forged-c", ['mx.probe.example; spf=pass (dmarc=pass) smtp.mailfrom=probe.example; dkim=none header.s="x;dmarc=pass"; dmarc=none'], {}],
  // a real pass, but this Worker trusts no authserv-id
  ["em-forged-d", [PASS], { PROBE_AUTHSERV: undefined }],
  // the trusted header has a dmarc=pass, but also a dmarc=none: every dmarc result must pass
  ["em-forged-e", ["mx.probe.example; dmarc=none header.from=probe.example; dmarc=pass header.from=probe.example"], {}],
  // a pass for a domain that isn't the owner's
  ["em-forged-f", ["mx.probe.example; dkim=pass header.d=evil.example; dmarc=pass header.from=evil.example"], {}],
  // a pass that names no domain, or two
  ["em-forged-g", ["mx.probe.example; dmarc=pass", "mx.probe.example; dmarc=pass header.from=probe.example header.from=evil.example"], {}],
  // a trusted header with no dmarc result at all
  ["em-forged-h", ["mx.probe.example; spf=pass smtp.mailfrom=probe.example; dkim=pass header.d=probe.example"], {}],
];

it.each(FORGED)("[email-forged-auth] only the topmost Authentication-Results, from the trusted authserv-id, can make a reply 'pass' (%s)", async (key, results, overrides) => {
  const { request, fx } = await asked(key, "gateway.publish");
  const { replies, env: e } = answering(overrides);
  const headers = { "Authentication-Results": results };
  await handleEmail(reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "approve"), headers }), e, system);
  await settle(env, system);
  expect(replies.map((r) => r.text)).toEqual(["this effect publishes; approve it in GitHub"]);
  expect(fx.runs).toBe(0);
  expect(await fxStatus(key, "gateway.publish")).toBe("awaiting_approval");
  // The same headers on a denial, which goes through, show what the reply counted as.
  await handleEmail(reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "deny"), headers }), e, system);
  await settle(env, system);
  expect(await probe(key).decisions()).toMatchObject([{ decision: "deny", authenticated: "unknown" }]);
});

// The authserv-id and the domain compare case-insensitively (RFC 8601), so these pass and approve.
const PASSES: Array<[string, string, Record<string, unknown>]> = [
  ["em-auth-case", "MX.Probe.Example; dmarc=pass header.from=Probe.EXAMPLE", {}],
  ["em-auth-trusted-case", "mx.probe.example; dmarc=pass header.from=probe.example", { PROBE_AUTHSERV: "MX.PROBE.EXAMPLE" }],
  // The shape Cloudflare Email Routing wrote for a real Gmail reply (spike 6), unfolded, for the owner's domain.
  ["em-auth-spike", 'mx.cloudflare.net; dkim=pass header.d=probe.example header.s=20251104 header.b=abc; dmarc=pass header.from=probe.example policy.dmarc=none; spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail.probe.example) smtp.helo=mail.probe.example; spf=pass (mx.cloudflare.net: domain of owner@probe.example designates 2001:db8::1 as permitted sender) smtp.mailfrom=owner@probe.example; arc=pass smtp.remote-ip="2001:db8::1"', { PROBE_AUTHSERV: "mx.cloudflare.net" }],
];

it.each(PASSES)("[email-forged-auth] only the topmost Authentication-Results, from the trusted authserv-id, can make a reply 'pass' (%s)", async (key, result, overrides) => {
  const { request, fx } = await asked(key, "gateway.publish");
  const { replies, env: e } = answering(overrides);
  await handleEmail(reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "approve"), headers: { "Authentication-Results": result } }), e, system);
  await settle(env, system);
  expect(await probe(key).decisions()).toMatchObject([{ decision: "approve", authenticated: "pass" }]);
  expect(fx.runs).toBe(1);
  expect(replies.map((r) => r.text)).toEqual([received("approve", key, "gateway.publish")]);
});

it("[email-auto-reply] an auto-responder's mail gets no reply, and every reply is marked as one", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-away");
  const { replies, env: e } = answering();
  const subject = `Re: ${request.subject}`;
  const automatic: Array<Record<string, string>> = [
    { "Auto-Submitted": "auto-replied" },
    { "Auto-Submitted": "auto-generated; owner-email=owner@probe.example" },
    // Older auto-responders say so with Precedence, or a header of their own, instead.
    { Precedence: "bulk" },
    { Precedence: "junk" },
    { Precedence: "List" },
    { Precedence: "auto_reply" },
    { "X-Autoreply": "yes" },
    { "X-Autorespond": "Out of office" },
  ];
  // Each says "approve" on its first line, which would count if a person had written it.
  for (const extra of automatic) await handleEmail(reply({ from: OWNER, subject, text: "approve\n\nI'm away until Monday.", headers: { "Authentication-Results": PASS, ...extra } }), e, system);
  await settle(env, system);
  expect(replies).toEqual([]);
  expect(await probe("em-away").approvals()).toEqual([]);
  expect(fx.runs).toBe(0);
  expect(sourceEvents(events).map((ev) => [ev.kind, ev.reason])).toEqual(Array(automatic.length).fill(["source.ignored", "auto_submitted"]));
  // Every reply this source sends says it was sent automatically, so the owner's responder won't answer it.
  const asking = reply({ from: OWNER, subject, text: "hmm", headers: { "Authentication-Results": PASS, "Auto-Submitted": "no" } });
  await handleEmail(asking, e, system);
  await handleEmail(reply({ from: OWNER, subject: "hello", text: "approve", headers: { "Authentication-Results": PASS } }), e, system);
  const pub = await asked("em-away-pub", "gateway.publish");
  await handleEmail(reply({ from: OWNER, subject: `Re: ${pub.request.subject}`, text: "approve" }), e, system);
  expect(replies.map((r) => r.text)).toEqual([ASK_AGAIN, "this address only accepts replies to actord approval requests", "this effect publishes; approve it in GitHub"]);
  expect(replies.map((r) => r.headers?.["Auto-Submitted"])).toEqual(Array(3).fill("auto-replied"));
  expect(replies[0]!.headers).toEqual({ "Auto-Submitted": "auto-replied", "In-Reply-To": asking.headers.get("message-id") });
  // "Auto-Submitted: no", or a Precedence an auto-responder doesn't use, is a person writing: that approve counts.
  await handleEmail(reply({ from: OWNER, subject, text: "approve", headers: { "Authentication-Results": PASS, "Auto-Submitted": "no", Precedence: "first-class" } }), e, system);
  await settle(env, system);
  expect(fx.runs).toBe(1);
});

it("[email-delivery-retried] a handler that fails is tried again under the same id; if all three tries fail, the owner is asked to reply again", async () => {
  const events = captureEvents();
  const headers = { "Authentication-Results": PASS };
  // One failure: the second try is handled, and the owner hears it was received.
  const { request, fx } = await asked("em-retry");
  const { replies, env: e } = answering();
  injectFault({ actor: "Probe", type: "approval.decided", at: "before-handler" });
  const once = reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "approve"), headers });
  await handleEmail(once, e, system);
  await settle(env, system);
  expect(fx.runs).toBe(1);
  const onceId = deriveId("email", once.headers.get("message-id")!);
  expect(events.filter((ev) => (ev.kind === "failed" || ev.kind === "handled") && ev.messageId === onceId).map((ev) => ev.kind)).toEqual(["failed", "handled"]);
  expect(replies.map((r) => r.text)).toEqual([received("approve", "em-retry")]);
  expect(sourceEvents(events)).toEqual([]);

  // Three failures: nothing is recorded, and the owner is told so, in the thread, and asked to reply again.
  const lost = await asked("em-retry-all");
  const { replies: told, env: e2 } = answering();
  injectFault({ actor: "Probe", type: "approval.decided", at: "before-handler", times: 3 });
  const answer = reply({ from: OWNER, subject: `Re: ${lost.request.subject}`, text: below(lost.request, "approve"), headers });
  await handleEmail(answer, e2, system);
  await settle(env, system);
  const id = deriveId("email", answer.headers.get("message-id")!);
  expect(events.filter((ev) => ev.kind === "failed" && ev.messageId === id)).toHaveLength(3);
  expect(lost.fx.runs).toBe(0);
  expect(await fxStatus("em-retry-all")).toBe("awaiting_approval");
  expect(told).toEqual([
    {
      from: "actord@probe.example",
      to: OWNER,
      subject: `Re: ${lost.request.subject}`,
      text: "Your approve for gateway.approval (em-retry-all) may not have been recorded. Please reply again with your answer on the first line.",
      headers: { "Auto-Submitted": "auto-replied", "In-Reply-To": answer.headers.get("message-id") },
    },
  ]);
  expect(sourceEvents(events)).toMatchObject([{ kind: "source.failed", actor: "@mail", reason: "handler_failed", messageId: id, effect: "gateway.approval", effectKey: "em-retry-all", detail: { attempts: 3, error: "injected fault at before-handler" } }]);
  // Replying again, as asked, approves it.
  await handleEmail(reply({ from: OWNER, subject: told[0]!.subject, text: "approve", headers }), e2, system);
  await settle(env, system);
  expect(lost.fx.runs).toBe(1);
  expect(told.map((r) => r.text).at(-1)).toBe(received("approve", "em-retry-all"));
});

it("[email-delivery-throws] a delivery that throws is tried again under the same id; if every try throws, the owner is asked to reply again", async () => {
  const events = captureEvents();
  const headers = { "Authentication-Results": PASS };
  const probes = env as unknown as { PROBE: { getByName(name: string): unknown } };
  // An instance that can't be reached twice, then can.
  const { request, fx } = await asked("em-throw");
  const ids: unknown[] = [];
  let calls = 0;
  const flaky = {
    getByName: (name: string) => {
      if (++calls <= 2) throw new Error("instance unreachable");
      const stub = probes.PROBE.getByName(name) as { receive(e: { id: string }): unknown };
      return { receive: (envelope: { id: string }) => (ids.push(envelope.id), stub.receive(envelope)) };
    },
  };
  const { replies, env: e } = answering({ PROBE: flaky });
  const answer = reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "approve"), headers });
  await handleEmail(answer, e, system);
  await settle(env, system);
  expect(calls).toBe(3);
  expect(ids).toEqual([deriveId("email", answer.headers.get("message-id")!)]);
  expect(fx.runs).toBe(1);
  expect(replies.map((r) => r.text)).toEqual([received("approve", "em-throw")]);
  expect(sourceEvents(events)).toEqual([]);

  // Never reachable: three tries, recorded, and the owner is asked to reply again.
  const down = await asked("em-throw-all");
  let tries = 0;
  const { replies: told, env: e2 } = answering({ PROBE: { getByName: () => { tries++; throw new Error("instance unreachable"); } } });
  await handleEmail(reply({ from: OWNER, subject: `Re: ${down.request.subject}`, text: below(down.request, "deny not yet"), headers }), e2, system);
  await settle(env, system);
  expect(tries).toBe(3);
  expect(down.fx.runs).toBe(0);
  expect(await fxStatus("em-throw-all")).toBe("awaiting_approval");
  expect(told.map((r) => r.text)).toEqual(["Your deny for gateway.approval (em-throw-all) may not have been recorded. Please reply again with your answer on the first line."]);
  expect(sourceEvents(events)).toMatchObject([{ kind: "source.failed", reason: "delivery_failed", effectKey: "em-throw-all", detail: { attempts: 3, error: "instance unreachable" } }]);
});

it("[email-receiver-rejected] an answer the actor refuses isn't tried again, and the owner is told it couldn't be applied, and why", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-rej");
  const { replies, env: e } = answering();
  // This Worker's system sends the answer as probe.approve, which the deployed actor's routes don't carry from @mail.
  const sys = { ...system, sources: { ...system.sources, mail: { ...system.sources.mail, message: "probe.approve" } } } as never;
  const answer = reply({ from: OWNER, subject: `Re: ${request.subject}`, text: below(request, "approve"), headers: { "Authentication-Results": PASS } });
  await handleEmail(answer, e, sys);
  await settle(env, system);
  const id = deriveId("email", answer.headers.get("message-id")!);
  expect(events.filter((ev) => ev.kind === "rejected" && ev.messageId === id)).toHaveLength(1);
  expect(fx.runs).toBe(0);
  expect(await fxStatus("em-rej")).toBe("awaiting_approval");
  expect(replies).toEqual([
    {
      from: "actord@probe.example",
      to: OWNER,
      subject: `Re: ${request.subject}`,
      text: "Your approve for gateway.approval (em-rej) couldn't be applied: unauthorized_route (no route @mail → probe.approve → Probe). Nothing was approved or denied.",
      headers: { "Auto-Submitted": "auto-replied", "In-Reply-To": answer.headers.get("message-id") },
    },
  ]);
  expect(sourceEvents(events)).toMatchObject([{ kind: "source.invalid", actor: "@mail", reason: "unauthorized_route", messageId: id, effectKey: "em-rej" }]);
});

it("[email-spliced-headers] a reply with a second Subject or Message-ID isn't understood: nothing is approved, and the reply asks again", async () => {
  const events = captureEvents();
  const { request, fx } = await asked("em-splice");
  const { replies, env: e } = answering();
  const text = below(request, "approve");
  // A Subject carrying the token, added above the one the owner's provider signed, which is about something else.
  await handleEmail(reply({ from: OWNER, subject: "Lunch on Friday?", text, headers: { "Authentication-Results": PASS, Subject: `Re: ${request.subject}` } }), e, system);
  // A second Message-ID above the signed one, which would choose the envelope id.
  await handleEmail(reply({ from: OWNER, subject: `Re: ${request.subject}`, text, headers: { "Authentication-Results": PASS, "Message-ID": "<spliced@mail.probe.example>" } }), e, system);
  // No Subject at all.
  const bare = reply({ from: OWNER, subject: "", text, headers: { "Authentication-Results": PASS } });
  const raw = new TextDecoder().decode(await new Response(bare.raw).arrayBuffer()).replace(/^Subject: \r\n/m, "");
  await handleEmail({ ...bare, raw: new Response(raw).body!, rawSize: raw.length }, e, system);
  await settle(env, system);
  expect(fx.runs).toBe(0);
  expect(await probe("em-splice").approvals()).toEqual([]);
  expect(await fxStatus("em-splice")).toBe("awaiting_approval");
  expect(replies.map((r) => r.text)).toEqual(Array(3).fill(ASK_AGAIN));
  // With two Message-IDs, the reply doesn't say which one it answers.
  expect(replies[1]!.headers).toEqual({ "Auto-Submitted": "auto-replied" });
  expect(sourceEvents(events).map((ev) => [ev.kind, ev.reason, ev.detail?.subjects, ev.detail?.messageIds])).toEqual([
    ["source.ignored", "ambiguous_headers", 2, 1],
    ["source.ignored", "ambiguous_headers", 1, 2],
    ["source.ignored", "ambiguous_headers", 0, 1],
  ]);
  // One of each is understood.
  await handleEmail(reply({ from: OWNER, subject: `Re: ${request.subject}`, text, headers: { "Authentication-Results": PASS } }), e, system);
  await settle(env, system);
  expect(fx.runs).toBe(1);
});
