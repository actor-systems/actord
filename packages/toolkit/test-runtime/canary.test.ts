// #82's experiment: can a "canary" transaction tell that a handler yielded to the event loop inside its delivery's
// transaction, including the yields #80's setTimeout(0) sentinel misses? No runtime change: most of these probes run
// deliver's shape directly on the object's storage (deliverLike), and [canary-real-deliver] puts a canary into the real
// deliver from outside it. Measured in local workerd only.
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/chord/sqlite/cloudflare";

const probe = (key: string) => env.PROBE.getByName(key);
type Storage = DurableObjectStorage;
const IO_REFUSED = "Probe.probe.x: handlers may not await I/O; use ctx.effect";
const HANDLER_FAILED = "the handler failed";

type Options = { canary: "outer" | "inner" | "none"; failOn: "sentinel" | "canary" | "nothing" };
type Seen = { canary(): boolean; turn(): boolean };

/**
 * deliver's shape without the runtime: a transaction around a handler; #80's sentinel, a setTimeout(0) queued as the
 * handler starts; and a no-op canary transaction. `canary` says where the canary is requested: "outer" from the code
 * that requested the delivery's transaction, synchronously right after it (the brief's candidate), "inner" inside that
 * transaction just before the handler is called. Both detectors record whether they ran while the handler was
 * pending; the one `failOn` names then fails the delivery from inside its transaction, as deliver's sentinel does.
 */
async function deliverLike(storage: Storage, { canary: placement, failOn }: Options, log: string[], handler: (seen: Seen) => Promise<void>) {
  let open = false;
  let canaryRan = false;
  let turned = false;
  let refuse!: (err: Error) => void;
  const refused = new Promise<never>((_r, reject) => (refuse = reject));
  const canaryFn = async () => {
    log.push(open ? "canary (open)" : "canary (closed)");
    if (!open) return;
    canaryRan = true;
    if (failOn === "canary") refuse(new Error(IO_REFUSED));
  };
  let canary: Promise<void> | undefined;
  const tx = storage.transaction(async () => {
    if (placement === "inner") canary = storage.transaction(canaryFn);
    const sentinel = setTimeout(() => {
      turned = true;
      log.push("sentinel");
      if (failOn === "sentinel") refuse(new Error(IO_REFUSED));
    }, 0);
    open = true;
    log.push("handler starts");
    try {
      await Promise.race([handler({ canary: () => canaryRan, turn: () => turned }), refused]);
    } finally {
      open = false;
      clearTimeout(sentinel);
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

// The awaits that yield: the six #80's sentinel misses ([storage-await-no-macrotask]), and three it catches.
const MISSES = ["transaction", "getCurrentBookmark", "sync", "Response.text", "Response.json", "Request.json"];
const CAUGHT = ["scheduler.wait(1)", "setTimeout(0)", "fetch"];
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

it("[canary-placement] a canary requested beside the delivery's transaction runs only after it ends, whatever the handler awaits; one requested inside it, before the handler, runs while it is open, at the handler's yield", async () => {
  const out = await runInDurableObject(probe("canary-place"), async (_i, state) => {
    const s = state.storage;
    const results: Record<string, string[]> = {};
    for (const [name, wait] of Object.entries(yields(s))) {
      for (const placement of ["outer", "inner"] as const) {
        for (const context of ["plain", "in blockConcurrencyWhile"] as const) {
          const log: string[] = [];
          const deliver = () =>
            deliverLike(s, { canary: placement, failOn: "nothing" }, log, async () => {
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
  for (const name of [...MISSES, ...CAUGHT]) {
    for (const context of ["plain", "in blockConcurrencyWhile"]) {
      // Requested beside: never while the handler is open, even across 1 ms of I/O. It runs once the transaction ends.
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

// The awaits a handler may make (Runtime.md), as [storage-await-no-macrotask] lists them, and microtasks.
const ALLOWED = ["microtasks", "put", "put-many", "get", "get-many", "list", "delete", "delete-many", "getAlarm", "setAlarm", "deleteAlarm", "sql", "kv.get", "kv.put", "kv.delete", "transactionSync", "lifecycle.jobs.push", "Blob.text", "crypto.subtle.digest"];

it("[canary-catalogue] the inner canary runs exactly when a writer waiting beside the handler gets into its transaction, and ahead of it: during every await #80's sentinel catches and every one it misses, and never during microtasks or the storage awaits handlers may make", async () => {
  const out = await runInDurableObject(probe("canary-cat"), async (instance: { pingAt(t: number): Promise<void> }, state) => {
    const s = state.storage;
    s.sql.exec("CREATE TABLE IF NOT EXISTS beside (v TEXT)");
    const awaits: Record<string, () => unknown> = {
      microtasks: async () => {
        for (let i = 0; i < 500; i++) await Promise.resolve();
      },
      put: () => s.put("canary-probe", 1),
      "put-many": () => s.put({ a: 1, b: 2 }),
      get: () => s.get("canary-probe"),
      "get-many": () => s.get(["a", "b"]),
      list: () => s.list(),
      delete: () => s.delete("a"),
      "delete-many": () => s.delete(["b", "absent"]),
      getAlarm: () => s.getAlarm(),
      setAlarm: () => s.setAlarm(Date.now() + 86_400_000),
      deleteAlarm: () => s.deleteAlarm(),
      sql: () => s.sql.exec("SELECT 1").toArray(),
      "kv.get": () => s.kv.get("canary-probe"),
      "kv.put": () => s.kv.put("canary-probe-kv", 1),
      "kv.delete": () => s.kv.delete("canary-probe-kv"),
      transactionSync: () => s.transactionSync(() => s.sql.exec("SELECT 1").toArray()),
      "lifecycle.jobs.push": () => instance.pingAt(Date.now() + 86_400_000),
      "Blob.text": () => new Blob(["x"]).text(),
      "crypto.subtle.digest": () => crypto.subtle.digest("SHA-256", new TextEncoder().encode("x")),
      ...yields(s),
    };
    const results: Record<string, { seen: unknown; log: string[] }> = {};
    for (const [api, call] of Object.entries(awaits)) {
      const log: string[] = [];
      const ran = { waiting: false, during: false };
      const request: Record<string, () => void> = {};
      // Registered here, outside any transaction, as in [storage-await-no-macrotask]. The handler requests `waiting`
      // before the await (a microtask then lets it ask for its transaction), and `during` from a microtask that runs
      // once the await's call has been made.
      const written = (["waiting", "during"] as const).map((w) =>
        new Promise<void>((r) => (request[w] = r)).then(() =>
          s.transaction(async () => {
            ran[w] = true;
            log.push(`${w} writer runs`);
            s.sql.exec("INSERT INTO beside (v) VALUES (?)", `${api}/${w}`);
          }),
        ),
      );
      let seen: unknown;
      await deliverLike(s, { canary: "inner", failOn: "nothing" }, log, async (probe) => {
        request.waiting!();
        await Promise.resolve();
        const pending = call();
        queueMicrotask(request.during!);
        await pending;
        seen = { turn: probe.turn(), canary: probe.canary(), ...ran };
      });
      await Promise.all(written);
      results[api] = { seen, log };
    }
    return results;
  });
  // After each await: had the sentinel run (turn), the canary, the writer requested before the await, the one requested
  // during it? A nested transaction() lets the earlier writer in, but not one requested after the handler asked for it.
  expect(Object.fromEntries(Object.entries(out).map(([api, r]) => [api, r.seen]))).toEqual({
    ...Object.fromEntries(ALLOWED.map((api) => [api, { turn: false, canary: false, waiting: false, during: false }])),
    ...Object.fromEntries(MISSES.map((api) => [api, { turn: false, canary: true, waiting: true, during: api !== "transaction" }])),
    ...Object.fromEntries(CAUGHT.map((api) => [api, { turn: true, canary: true, waiting: true, during: true }])),
  });
  for (const [api, { log }] of Object.entries(out)) {
    if (ALLOWED.includes(api)) {
      // Unrun until the transaction has ended; then it goes first, still ahead of the writers.
      expect(before(log, "transaction ended", "canary (closed)") && before(log, "canary (closed)", "waiting writer runs"), api).toBe(true);
    } else {
      expect(before(log, "canary (open)", "waiting writer runs"), api).toBe(true);
      if (CAUGHT.includes(api)) expect(before(log, "canary (open)", "sentinel"), api).toBe(true);
    }
  }
});

it("[canary-writer-fate] when the inner canary fails the delivery, every writer that gets into a handler's transaction runs after its rollback and commits: today's sentinel lets those writers in first, and its rollback takes their rows", async () => {
  const out = await runInDurableObject(probe("canary-fate"), async (_i, state) => {
    const s = state.storage;
    s.sql.exec("CREATE TABLE IF NOT EXISTS beside (v TEXT)");
    s.sql.exec("CREATE TABLE IF NOT EXISTS mine (v TEXT)");
    const db = new DurableObjectSqliteDatabase(s);
    const results: Record<string, { receipt?: string; kept: boolean; mine: number; log: string[] }> = {};
    for (const regime of ["sentinel", "canary"] as const) {
      for (const [y, call] of Object.entries(yields(s))) {
        for (const when of ["outside-before", "outside-after", "starting", "during"] as const) {
          const tag = `${regime}/${y}/${when}`;
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
          const options: Options = regime === "canary" ? { canary: "inner", failOn: "canary" } : { canary: "none", failOn: "sentinel" };
          const receipt = deliverLike(s, options, log, async () => {
            s.sql.exec("INSERT INTO mine (v) VALUES (?)", tag);
            // As the handler starts, then 10 microtasks, as in [beside-transaction-nested]; or once the await's call is made.
            if (when === "starting") request();
            for (let i = 0; i < 10; i++) await Promise.resolve();
            const pending = call();
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
      }
    }
    return results;
  });
  for (const [tag, r] of Object.entries(out)) {
    const [regime, y, when] = tag.split("/") as ["sentinel" | "canary", string, string];
    // The handler's own write always rolls back.
    expect(r.mine, tag).toBe(0);
    if (when === "outside-before") {
      // Requested before the delivery's transaction: it runs first, whole, in both regimes.
      expect(before(r.log, "writer committed", "handler starts"), tag).toBe(true);
    }
    if (regime === "canary") {
      // Failed by the canary with #80's message, and every writer, whenever it asked, runs after the rollback.
      expect({ receipt: r.receipt, kept: r.kept }, tag).toEqual({ receipt: IO_REFUSED, kept: true });
      if (when !== "outside-before") expect(before(r.log, "canary (open)", "transaction ended") && before(r.log, "transaction ended", "writer runs"), tag).toBe(true);
    } else {
      // Today: the sentinel fails only the awaits it catches; a miss fails with the handler's own error. A writer
      // requested inside the handler's turns gets in and loses its row, unless it asked after a nested transaction().
      const lost = (when === "starting" || when === "during") && !(y === "transaction" && when === "during");
      expect({ receipt: r.receipt, kept: r.kept }, tag).toEqual({ receipt: CAUGHT.includes(y) ? IO_REFUSED : HANDLER_FAILED, kept: !lost });
      if (lost) expect(before(r.log, "writer committed", "transaction ended"), tag).toBe(true);
      if (when === "outside-after") expect(before(r.log, "transaction ended", "writer runs"), tag).toBe(true);
    }
  }
});

it("[canary-io-writer] a writer requested by an I/O callback: I/O started outside the transaction can't call back until the transaction ends, even across 30 ms; I/O the handler started calls back during its await and the writer gets in, unless the canary has failed the delivery first", async () => {
  const out = await runInDurableObject(probe("canary-io"), async (_i, state) => {
    const s = state.storage;
    s.sql.exec("CREATE TABLE IF NOT EXISTS beside (v TEXT)");
    const results: Record<string, { receipt?: string; kept: boolean; log: string[] }> = {};
    for (const io of ["wait", "fetch"] as const) {
      for (const where of ["outside", "inside"] as const) {
        for (const failOn of ["nothing", "canary"] as const) {
          const tag = `${io}/${where}/${failOn}`;
          const log: string[] = [];
          let start!: () => void;
          const started = new Promise<void>((r) => (start = r));
          const written = started
            .then(() => (io === "wait" ? scheduler.wait(1) : SELF.fetch("https://probe/other").then((r) => r.text())))
            .then(() => {
              log.push("I/O callback");
              return s.transaction(async () => {
                log.push("writer runs");
                s.sql.exec("INSERT INTO beside (v) VALUES (?)", tag);
              });
            });
          // Started here, outside any transaction, just before the delivery; or by the handler, inside it.
          if (where === "outside") start();
          const r = await deliverLike(s, { canary: failOn === "canary" ? "inner" : "none", failOn }, log, async () => {
            if (where === "inside") start();
            await scheduler.wait(30);
            log.push("handler awaited 30 ms");
            throw new Error(HANDLER_FAILED);
          });
          await written;
          results[tag] = { receipt: r.error, kept: s.sql.exec("SELECT 1 FROM beside WHERE v = ?", tag).toArray().length === 1, log };
        }
      }
    }
    return results;
  });
  for (const io of ["wait", "fetch"]) {
    const outside = out[`${io}/outside/nothing`]!;
    expect({ receipt: outside.receipt, kept: outside.kept }, io).toEqual({ receipt: HANDLER_FAILED, kept: true });
    expect(before(outside.log, "transaction ended", "I/O callback"), io).toBe(true);
    const inside = out[`${io}/inside/nothing`]!;
    expect({ receipt: inside.receipt, kept: inside.kept }, io).toEqual({ receipt: HANDLER_FAILED, kept: false });
    expect(before(inside.log, "writer runs", "handler awaited 30 ms"), io).toBe(true);
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
 * Puts a canary into the real deliver without changing the runtime: deliver's transaction (the one whose closure checks
 * _actors_inbox) gets a no-op transaction requested first thing inside it, and is raced against it. If the canary runs
 * while deliver's closure is still running, the closure fails with INJECTED, so the delivery rolls back. Every other
 * transaction passes through. With `canary` false, only the wrapper is added (a baseline for [canary-overhead]).
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

it("[canary-real-deliver] with a canary put into the real deliver, [beside-transaction-nested]'s known misses and [sentinel-ordering]'s already-waiting writer fail the delivery from the canary, and the waiting writer commits after the rollback", async () => {
  const gate = globalThis as { __probeGate?: unknown };
  const microtasks = async (n: number) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  // What the slow probe.outcome handler awaits after it starts the writer, before it throws ([beside-transaction-nested]).
  const cases: Record<string, (s: Storage) => Promise<unknown>> = {
    microtasks: () => microtasks(500),
    io: () => scheduler.wait(1),
    sync: (s) => microtasks(10).then(() => s.sync()),
    body: () => microtasks(10).then(() => new Response("x").text()),
    transaction: (s) => microtasks(10).then(() => s.transaction(async () => {})),
    bookmark: (s) => microtasks(10).then(() => s.getCurrentBookmark()),
    // [sentinel-ordering]'s "pending" writer, with the handler awaiting a fetch.
    fetch: () => SELF.fetch("https://probe/other").then((r) => r.text()),
  };
  const results: Record<string, { receipt: { status: string; error?: string }; kept: boolean; handlerRow: number; log: string[] }> = {};
  try {
    for (const [what, wait] of Object.entries(cases)) {
      const name = `canary-real-${what}`;
      results[what] = await runInDurableObject(probe(name), async (instance: Receiver, state) => {
        state.storage.sql.exec("CREATE TABLE IF NOT EXISTS beside (v TEXT)");
        const db = new DurableObjectSqliteDatabase(state.storage);
        const log: string[] = [];
        let start!: () => void;
        const written = new Promise<void>((r) => (start = r)).then(() =>
          db
            .transaction(async (t) => {
              log.push("writer runs");
              await t.run("INSERT INTO beside (v) VALUES ('pi')");
            })
            .then(() => log.push("writer committed")),
        );
        let thrown!: () => void;
        const handlerDone = new Promise<void>((r) => (thrown = r));
        gate.__probeGate = {
          then: (_resolve: () => void, reject: (err: Error) => void) => {
            start();
            void wait(state.storage).then(() => {
              log.push("handler throws");
              reject(new Error(HANDLER_FAILED));
              thrown();
            });
          },
        };
        const restore = injectCanary(state.storage, true, log);
        let receipt: { status: string; error?: string };
        try {
          receipt = await instance.actor.receive(envelopeFor(name, `${name}-1`, "slow-canary"));
        } finally {
          restore();
        }
        await written;
        await handlerDone;
        return { receipt, kept: state.storage.sql.exec("SELECT v FROM beside").toArray().length === 1, handlerRow: state.storage.sql.exec("SELECT key FROM outcomes").toArray().length, log };
      });
    }
  } finally {
    delete gate.__probeGate;
  }
  // Microtasks only: unchanged from [beside-transaction-nested]. The canary runs after the rollback, then the writer.
  expect(results.microtasks).toMatchObject({ receipt: { status: "failed", error: HANDLER_FAILED }, kept: true, handlerRow: 0, log: ["handler throws", "canary (closed)", "writer runs", "writer committed"] });
  for (const what of ["io", "sync", "body", "transaction", "bookmark", "fetch"]) {
    // Today the writer runs nested and its row is lost ([beside-transaction-nested], [sentinel-ordering]). With the canary,
    // the canary runs first and fails the delivery (ahead of the sentinel where it would catch it), and the writer commits.
    expect(results[what], what).toMatchObject({ receipt: { status: "failed", error: INJECTED }, kept: true, handlerRow: 0, log: ["canary (open)", "writer runs", "writer committed", "handler throws"] });
  }
});

// Run by hand (remove .skip; pass --silent=false to see what it logs): its medians are in #82. Local workerd's clock moves only at I/O, so it times
// batches of 100 deliveries, over 20 rounds after 2 of warm-up, alternating which variant goes first.
it.skip("[canary-overhead] one no-op canary transaction per delivery: a bare transaction, and the real deliver", async () => {
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
