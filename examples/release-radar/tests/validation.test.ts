import { env } from "cloudflare:workers";
import type { Envelope } from "@actord/toolkit/runtime";
import { expect, it } from "vitest";

const base: Envelope = {
  v: 1,
  id: "v-1",
  type: "release.significant",
  version: 1,
  from: "ReleaseLedger:main",
  to: "DigestWriter:main",
  correlationId: "v-1",
  causationId: null,
  attempt: 1,
  sentAt: 0,
  payload: { feedId: "f", itemId: "f-1.0.0", title: "f 1.0.0", version: "1.0.0", severity: "major", reason: "test" },
};
const digest = () => env.DIGEST_WRITER.getByName("main");

it("[malformed] refuses an envelope with missing fields", async () => {
  const r = await digest().receive({ v: 1, id: "m-1" } as unknown as Envelope);
  expect(r).toMatchObject({ status: "rejected", reason: "malformed" });
});

it("[malformed] refuses a payload that fails the message schema", async () => {
  const r = await digest().receive({ ...base, id: "m-2", payload: { ...(base.payload as object), severity: "catastrophic" } });
  expect(r).toMatchObject({ status: "rejected", reason: "invalid_payload" });
});

it("[unauthorized-route] refuses a message on a route the declaration doesn't allow", async () => {
  // Only ReleaseLedger may send release.significant to DigestWriter.
  const r = await digest().receive({ ...base, id: "m-3", from: "FeedPoller:sneaky" });
  expect(r).toMatchObject({ status: "rejected", reason: "unauthorized_route" });
});

it("[malformed] refuses a message version the receiver wasn't built for", async () => {
  const r = await digest().receive({ ...base, id: "m-4", version: 2 });
  expect(r).toMatchObject({ status: "rejected", reason: "version_mismatch" });
});

it("[malformed] refuses a message addressed to another instance", async () => {
  const r = await digest().receive({ ...base, id: "m-5", to: "DigestWriter:other" });
  expect(r).toMatchObject({ status: "rejected", reason: "wrong_recipient" });
});

it("[unknown-message] refuses an undeclared message type", async () => {
  const r = await digest().receive({ ...base, id: "m-6", type: "release.vanished" });
  expect(r).toMatchObject({ status: "rejected", reason: "unknown_message" });
});

it("rejected messages change no state", async () => {
  expect(await digest().findings()).toEqual([]);
});
