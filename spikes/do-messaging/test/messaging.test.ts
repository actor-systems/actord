import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("G0 spike: native DO messaging in workerd", () => {
  it("delivers an envelope over RPC and dedupes a duplicate by id", async () => {
    const sender = env.SENDER.getByName("s");
    expect(await sender.send({ n: 1 }, "m-1")).toEqual({ accepted: true });
    expect(await sender.send({ n: 1 }, "m-1")).toEqual({ accepted: false });
    expect(await env.RECEIVER.getByName("only").count()).toBe(1);
  });

  it("keeps SQLite state across eviction", async () => {
    const receiver = env.RECEIVER.getByName("only");
    await env.SENDER.getByName("s").send({ n: 2 }, "m-2");
    await evictDurableObject(receiver);
    expect(await receiver.count()).toBeGreaterThanOrEqual(1);
  });

  it("runs a scheduled alarm that sends a message", async () => {
    const sender = env.SENDER.getByName("alarm");
    await sender.scheduleWake(60_000);
    expect(await runDurableObjectAlarm(sender)).toBe(true);
    expect(await runDurableObjectAlarm(sender)).toBe(false);
  });
});
