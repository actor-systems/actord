import { env } from "cloudflare:workers";
import { ingress } from "@actord/toolkit/runtime";
import { resetSeams, settle } from "@actord/toolkit/testing";
import { afterEach, expect, it } from "vitest";
import system from "../system.ts";
import { analysis, deferredModel, gateway, status, submit } from "./helpers.ts";

afterEach(() => resetSeams());

async function until(pred: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

it("[reentrancy] a cancellation handled while the model call is in flight makes the late result stale", async () => {
  const model = deferredModel();
  const sent = gateway("accept");

  const submitting = submit("re-1", "Payment provider latency spike");
  await until(() => model.state.calls === 1, "the model call to start");

  // The analyst is waiting on the model outside any transaction, so the control message gets in.
  const cancel = await ingress(env, system, "Analyst", "item.cancelled", { itemId: "re-1", reason: "resolved upstream" }, { key: "re-1" });
  expect(cancel.status).toBe("handled");
  await until(async () => (await status("re-1")) === "cancelled", "the board to show the cancellation");

  // Now the model answers "urgent" for the old request. It must not produce a briefing.
  model.resolve(analysis("incident", "high"));
  await submitting;
  await settle(env, system);

  expect(await status("re-1")).toBe("cancelled");
  expect(sent).toEqual([]);
  const item = await env.ANALYST.getByName("re-1").item();
  expect(item).toMatchObject({ status: "cancelled", generation: 2 });
});
