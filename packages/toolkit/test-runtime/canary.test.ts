// #82's experiment, trimmed to the workerd behaviour deliver's canary relies on that no runtime pin shows. These run
// deliver's shape directly on the object's storage (deliverLike). The runtime's own canary is pinned in runtime.test.ts:
// [handler-io-fails-loudly] (every yield fails the delivery), [storage-awaits-allowed] (the allowed awaits don't),
// [beside-transaction-nested] and [canary-ordering] (a writer requested as the handler starts commits after the
// rollback), [canary-every-path] and [canary-quiet]. Measured in local workerd only.
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare";

const probe = (key: string) => env.PROBE.getByName(key);
type Storage = DurableObjectStorage;
const IO_REFUSED = "Probe.probe.x: handlers may not await I/O; use ctx.effect";
const HANDLER_FAILED = "the handler failed";

/**
 * deliver's shape without the runtime: a transaction around a handler, and a no-op canary transaction. `canary` says
 * where it is requested: "outer" from the code that requested the delivery's transaction, synchronously right after it
 * (#82's first candidate), "inner" inside that transaction just before the handler is called (where deliver requests
 * it). It records whether it ran while the handler was pending; with `fail`, it then fails the delivery from inside the
 * transaction, as deliver does.
 */
async function deliverLike(storage: Storage, { canary: placement, fail }: { canary: "outer" | "inner" | "none"; fail: boolean }, log: string[], handler: () => Promise<void>) {
  let open = false;
  let refuse!: (err: Error) => void;
  const refused = new Promise<never>((_r, reject) => (refuse = reject));
  const canaryFn = async () => {
    log.push(open ? "canary (open)" : "canary (closed)");
    if (open && fail) refuse(new Error(IO_REFUSED));
  };
  let canary: Promise<void> | undefined;
  const tx = storage.transaction(async () => {
    if (placement === "inner") canary = storage.transaction(canaryFn);
    open = true;
    log.push("handler starts");
    try {
      await Promise.race([handler(), refused]);
    } finally {
      open = false;
      log.push("handler settled");
    }
  });
  if (placement === "outer") canary = storage.transaction(canaryFn);
  let receipt: { status: string; error?: string };
  try {
    await tx;
    receipt = { status: "handled" };
  } catch (err) {
    receipt = { status: "failed", error: (err as Error).message };
  }
  log.push("transaction ended");
  await canary;
  return receipt;
}

const before = (log: string[], a: string, b: string) => log.indexOf(a) !== -1 && log.indexOf(b) !== -1 && log.indexOf(a) < log.indexOf(b);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Every await that yields to the event loop. #80's timer sentinel caught the last three, and missed the first six.
const yields = (s: Storage): Record<string, () => Promise<unknown>> => ({
  transaction: () => s.transaction(async () => {}),
  getCurrentBookmark: () => s.getCurrentBookmark(),
  sync: () => s.sync(),
  "Response.text": () => new Response("x").text(),
  "Response.json": () => new Response("{}").json(),
  "Request.json": () => new Request("https://probe/", { method: "POST", body: "{}" }).json(),
  "scheduler.wait(1)": () => scheduler.wait(1),
  "setTimeout(0)": () => new Promise((r) => setTimeout(r, 0)),
  fetch: () => SELF.fetch("https://probe/other").then((r) => r.text()),
});

it("[canary-placement] a canary requested beside the delivery's transaction runs only after it ends, even when the handler awaits I/O or sync(); one requested inside it, just before the handler, runs while it is open, at the handler's yield; both hold inside blockConcurrencyWhile, and a leftover canary doesn't run inside the next delivery", async () => {
  const out = await runInDurableObject(probe("canary-place"), async (_i, state) => {
    const s = state.storage;
    const results: Record<string, string[]> = {};
    const awaits = { "scheduler.wait(1)": () => scheduler.wait(1), "sync()": () => s.sync() };
    for (const [name, wait] of Object.entries(awaits)) {
      for (const placement of ["outer", "inner"] as const) {
        for (const context of ["plain", "in blockConcurrencyWhile"] as const) {
          const log: string[] = [];
          const deliver = () =>
            deliverLike(s, { canary: placement, fail: false }, log, async () => {
              await wait();
              log.push("await returned");
            });
          if (context === "plain") await deliver();
          else await state.blockConcurrencyWhile(deliver);
          results[`${name}/${placement}/${context}`] = log;
        }
      }
    }
    // A canary left by a delivery that didn't yield runs after its transaction. It doesn't run inside the next one, which
    // is requested as soon as the first ends and yields for 5 ms.
    const log: string[] = [];
    let nextOpen = false;
    await s.transaction(async () => {
      void s.transaction(async () => void log.push(nextOpen ? "first's canary (next open)" : "first's canary (next closed)"));
      log.push("first's handler");
    });
    await s.transaction(async () => {
      nextOpen = true;
      log.push("next handler starts");
      await scheduler.wait(5);
      log.push("next handler settles");
      nextOpen = false;
    });
    await scheduler.wait(1);
    results.stale = log;
    return results;
  });
  for (const name of ["scheduler.wait(1)", "sync()"]) {
    for (const context of ["plain", "in blockConcurrencyWhile"]) {
      // Requested beside: never while the handler is open. It runs once the transaction ends.
      const outer = out[`${name}/outer/${context}`]!;
      expect(outer, name).not.toContain("canary (open)");
      expect(before(outer, "transaction ended", "canary (closed)"), name).toBe(true);
      // Requested inside: after the handler starts, and before its await returns.
      const inner = out[`${name}/inner/${context}`]!;
      expect(before(inner, "handler starts", "canary (open)"), name).toBe(true);
      expect(before(inner, "canary (open)", "await returned"), name).toBe(true);
    }
  }
  expect(out.stale).toContain("first's canary (next closed)");
});

it("[canary-writer-fate] when the inner canary fails the delivery, a writer requested during the handler's await, for every await that yields, runs after the rollback and commits; one requested from outside before or after the delivery's transaction runs whole before or after it", async () => {
  const out = await runInDurableObject(probe("canary-fate"), async (_i, state) => {
    const s = state.storage;
    s.sql.exec("CREATE TABLE IF NOT EXISTS beside (v TEXT)");
    s.sql.exec("CREATE TABLE IF NOT EXISTS mine (v TEXT)");
    const db = new DurableObjectSqliteDatabase(s);
    const all = yields(s);
    const cases = [...Object.keys(all).map((y) => [y, "during"] as const), ...["sync", "scheduler.wait(1)"].flatMap((y) => [[y, "outside-before"] as const, [y, "outside-after"] as const])];
    const results: Record<string, { receipt?: string; kept: boolean; mine: number; log: string[] }> = {};
    for (const [y, when] of cases) {
      const tag = `${y}/${when}`;
      const log: string[] = [];
      let request!: () => void;
      // Registered outside any transaction; the write goes through chord's store, as pi's does.
      const written = new Promise<void>((r) => (request = r)).then(() =>
        db
          .transaction(async (t) => {
            log.push("writer runs");
            await t.run(`INSERT INTO beside (v) VALUES ('${tag}')`);
          })
          .then(() => log.push("writer committed")),
      );
      let thrown!: () => void;
      const handlerDone = new Promise<void>((r) => (thrown = r));
      if (when === "outside-before") {
        // Requested before the delivery's transaction, and given the microtasks chord takes to ask for its own.
        request();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      const receipt = deliverLike(s, { canary: "inner", fail: true }, log, async () => {
        s.sql.exec("INSERT INTO mine (v) VALUES (?)", tag);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        const pending = all[y]!();
        // Requested once the await's call has been made.
        if (when === "during") queueMicrotask(request);
        await pending;
        log.push("handler throws");
        thrown();
        throw new Error(HANDLER_FAILED);
      });
      if (when === "outside-after") request();
      const r = await receipt;
      await written;
      await handlerDone;
      results[tag] = { receipt: r.error, kept: s.sql.exec("SELECT 1 FROM beside WHERE v = ?", tag).toArray().length === 1, mine: s.sql.exec("SELECT 1 FROM mine WHERE v = ?", tag).toArray().length, log };
    }
    return results;
  });
  expect(Object.keys(out)).toHaveLength(13);
  for (const [tag, r] of Object.entries(out)) {
    // Failed by the canary with #80's message; the handler's own write rolled back, and the writer's committed.
    expect({ receipt: r.receipt, mine: r.mine, kept: r.kept }, tag).toEqual({ receipt: IO_REFUSED, mine: 0, kept: true });
    if (tag.endsWith("/outside-before")) expect(before(r.log, "writer committed", "handler starts"), tag).toBe(true);
    else expect(before(r.log, "canary (open)", "transaction ended") && before(r.log, "transaction ended", "writer runs"), tag).toBe(true);
  }
});

it("[canary-io-writer] a writer requested by an I/O callback: I/O started outside the transaction can't call back until the transaction ends, even while the handler waits 2 s for its writer; I/O the handler started calls back during its await and the writer gets in, unless the canary has failed the delivery first", async () => {
  const out = await runInDurableObject(probe("canary-io"), async (_i, state) => {
    const s = state.storage;
    s.sql.exec("CREATE TABLE IF NOT EXISTS beside (v TEXT)");
    const results: Record<string, { receipt?: string; kept: boolean; log: string[] }> = {};
    for (const io of ["wait", "fetch"] as const) {
      for (const where of ["outside", "inside"] as const) {
        for (const fail of [false, true]) {
          const tag = `${io}/${where}/${fail ? "canary" : "nothing"}`;
          const log: string[] = [];
          let start!: () => void;
          let ran!: () => void;
          const running = new Promise<void>((r) => (ran = r));
          const written = new Promise<void>((r) => (start = r))
            .then(() => (io === "wait" ? scheduler.wait(1) : SELF.fetch("https://probe/other").then((r) => r.text())))
            .then(() => {
              log.push("I/O callback");
              return s.transaction(async () => {
                log.push("writer runs");
                s.sql.exec("INSERT INTO beside (v) VALUES (?)", tag);
                ran();
              });
            });
          let thrown!: () => void;
          const handlerDone = new Promise<void>((r) => (thrown = r));
          // Started here, outside any transaction, just before the delivery; or by the handler, inside it.
          if (where === "outside") start();
          // The handler waits for the writer to run (or 2 s), then fails, as in [beside-transaction-nested].
          const r = await deliverLike(s, { canary: fail ? "inner" : "none", fail }, log, async () => {
            if (where === "inside") start();
            await Promise.race([running, sleep(2_000)]);
            log.push("handler waited");
            thrown();
            throw new Error(HANDLER_FAILED);
          });
          await written;
          await handlerDone;
          results[tag] = { receipt: r.error, kept: s.sql.exec("SELECT 1 FROM beside WHERE v = ?", tag).toArray().length === 1, log };
        }
      }
    }
    return results;
  });
  for (const io of ["wait", "fetch"]) {
    // Outside: held for the whole transaction, so the handler waits out its 2 s, fails, and the writer commits after.
    const outside = out[`${io}/outside/nothing`]!;
    expect({ receipt: outside.receipt, kept: outside.kept }, io).toEqual({ receipt: HANDLER_FAILED, kept: true });
    expect(before(outside.log, "transaction ended", "I/O callback"), io).toBe(true);
    // Inside: the writer runs nested during the handler's await, and the handler's failure takes its row.
    const inside = out[`${io}/inside/nothing`]!;
    expect({ receipt: inside.receipt, kept: inside.kept }, io).toEqual({ receipt: HANDLER_FAILED, kept: false });
    expect(before(inside.log, "writer runs", "handler waited"), io).toBe(true);
    for (const where of ["outside", "inside"]) {
      const canary = out[`${io}/${where}/canary`]!;
      expect({ receipt: canary.receipt, kept: canary.kept }, `${io}/${where}`).toEqual({ receipt: IO_REFUSED, kept: true });
      expect(before(canary.log, "transaction ended", "I/O callback"), `${io}/${where}`).toBe(true);
    }
  }
});

type Receiver = { actor: { receive(e: unknown): Promise<{ status: string; error?: string }> } };
const envelopeFor = (name: string, id: string, key: string) => ({ v: 1, id, type: "probe.outcome", version: 1, from: `Probe:${name}`, to: `Probe:${name}`, correlationId: id, causationId: null, attempt: 1, sentAt: Date.now(), payload: { key, status: "confirmed" } });
const INJECTED = "the injected canary ran while the delivery was open";

/**
 * Puts one more canary into the real deliver, which has its own since #82: deliver's transaction (the one whose closure
 * checks _actors_inbox) gets a no-op transaction requested first thing inside it, and is raced against it. Every other
 * transaction passes through. With `canary` false, only the wrapper is added: [canary-overhead]'s baseline. (#82's
 * Phase 1, before the runtime had a canary, used this to show a canary in the real deliver: 27c3f4e.)
 */
function injectCanary(s: Storage, canary: boolean, log?: string[]): () => void {
  const orig = s.transaction;
  (s as unknown as { transaction: unknown }).transaction = function (this: Storage, fn: () => Promise<unknown>) {
    if (!String(fn).includes("_actors_inbox")) return orig.call(this, fn);
    return orig.call(this, async () => {
      let done = false;
      let refuse!: (err: Error) => void;
      const refused = new Promise<never>((_r, reject) => (refuse = reject));
      if (canary)
        void orig.call(this, async () => {
          log?.push(done ? "canary (closed)" : "canary (open)");
          if (!done) refuse(new Error(INJECTED));
        });
      try {
        return await Promise.race([fn(), refused]);
      } finally {
        done = true;
      }
    });
  };
  return () => void delete (s as unknown as { transaction?: unknown }).transaction;
}

// Run by hand (remove .skip; pass --silent=false to see what it logs): #82 has the medians it gave before the runtime
// had a canary. Local workerd's clock moves only at I/O, so it times batches of 100 deliveries, over 20 rounds after 2
// of warm-up, alternating which variant goes first.
it.skip("[canary-overhead] one no-op canary transaction per delivery: on a bare transaction, and on top of the real deliver's own", async () => {
  const stats = (a: number[]) => {
    const sorted = [...a].sort((x, y) => x - y);
    return { median: (sorted[9]! + sorted[10]!) / 2, mean: a.reduce((x, y) => x + y, 0) / a.length, min: sorted[0], max: sorted.at(-1) };
  };
  const time = async (batch: (variant: "with" | "without") => Promise<void>) => {
    const ms: Record<"with" | "without", number[]> = { with: [], without: [] };
    for (let round = 0; round < 22; round++) {
      for (const v of round % 2 ? (["with", "without"] as const) : (["without", "with"] as const)) {
        const t0 = Date.now();
        await batch(v);
        if (round >= 2) ms[v].push(Date.now() - t0);
      }
    }
    return { with: stats(ms.with), without: stats(ms.without) };
  };
  const bare = await runInDurableObject(probe("canary-bench-bare"), async (_i, state) => {
    const s = state.storage;
    s.sql.exec("CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY)");
    s.sql.exec("CREATE TABLE IF NOT EXISTS rows (v TEXT)");
    let n = 0;
    return time(async (v) => {
      const canaries: Array<Promise<void> | undefined> = [];
      for (let i = 0; i < 100; i++) {
        const id = `m${n++}`;
        let c: Promise<void> | undefined;
        await s.transaction(async () => {
          if (s.sql.exec("SELECT 1 FROM inbox WHERE id = ?", id).toArray().length) return;
          if (v === "with") c = s.transaction(async () => {});
          await (async () => void s.sql.exec("INSERT INTO rows (v) VALUES (?)", id))();
          s.sql.exec("INSERT INTO inbox (id) VALUES (?)", id);
        });
        canaries.push(c);
      }
      await Promise.all(canaries);
    });
  });
  const real = await runInDurableObject(probe("canary-bench-real"), async (instance: Receiver, state) => {
    let n = 0;
    return time(async (v) => {
      const restore = injectCanary(state.storage, v === "with");
      try {
        for (let i = 0; i < 100; i++) {
          const r = await instance.actor.receive(envelopeFor("canary-bench-real", `b${n}`, `b${n++}`));
          if (r.status !== "handled") throw new Error(JSON.stringify(r));
        }
      } finally {
        restore();
      }
    });
  });
  console.log(JSON.stringify({ "ms per 100 deliveries": { bare, real } }));
});
