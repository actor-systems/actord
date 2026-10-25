import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("a second call interleaves while the first awaits an RPC to another DO", async () => {
  const gate = env.GATE.getByName("g");
  const first = gate.first();
  await new Promise((r) => setTimeout(r, 10));
  const second = await gate.second();
  const done = await first;
  console.log("ORDER", JSON.stringify(done));
  expect(second).toContain("second");
  expect(done).toEqual(["first:start", "second", "first:end"]);
});

it("probe: id name, async and sync transaction rollback", async () => {
  const tx = env.TX.getByName("tx-probe");
  console.log("NAME", await tx.idName());
  console.log("ASYNC", await tx.asyncTxThrows(), JSON.stringify(await tx.rows()));
  console.log("SYNC", await tx.syncTxThrows(), JSON.stringify(await tx.rows()));
});

it("probe: does an interleaved write survive another call's transaction rollback?", async () => {
  const tx = env.TX.getByName("tx-interleave");
  const t0 = Date.now();
  const long = tx.longTxThrows();
  await new Promise((r) => setTimeout(r, 20));
  const other = await tx.insertOutside("other");
  console.log("INTERLEAVE", other.replace(/\d{13}/, (m) => `+${Number(m) - t0}ms`), await long, JSON.stringify(await tx.rows()));
});
