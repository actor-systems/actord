// Declared sources, tested in workerd through the probe Worker's own fetch (SELF), as GitHub would call it.
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { handleWebhook } from "../src/sources/index.ts";
import { captureEvents, injectFault, resetSeams } from "../src/testing.ts";
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
