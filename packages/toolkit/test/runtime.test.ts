// The runtime's inbox under concurrent delivery, on node:sqlite through the same storage interface the
// runtime uses in workerd. Here a transaction waits a turn before it starts, which lets other copies of a
// message pass the inbox check meanwhile, as workerd occasionally does under load.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { actorRuntime, type DurableObjectStateLike, type Envelope } from "../src/runtime/index.ts";
import { defineSystem, message } from "../src/system.ts";

const system = defineSystem({
  name: "inbox-race",
  description: "One counter, to count how often a message is handled",
  messages: { "count.add": message({ version: 1, description: "Add one", payload: z.object({ n: z.number() }) }) },
  actors: { Counter: { binding: "COUNTER", kind: "deterministic", purpose: "Counts", justification: ["state"] } },
  routes: [{ from: "@ingress", message: "count.add", to: "Counter" }],
});

function slowStartStorage(): DurableObjectStateLike {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    id: { name: "main", toString: () => "main" },
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          const rows = db.prepare(query).all(...(bindings as never[])) as never[];
          return { toArray: () => rows, one: () => rows[0]! };
        },
      },
      // Exclusive, as in workerd, but it only starts after a turn of the event loop.
      transaction<T>(closure: () => Promise<T>): Promise<T> {
        const run = async () => {
          db.exec("BEGIN");
          try {
            const value = await closure();
            db.exec("COMMIT");
            return value;
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
        };
        const prev = tail;
        const result = new Promise((r) => setTimeout(r, 0)).then(() => prev).then(run);
        tail = result.catch(() => {});
        return result;
      },
      setAlarm: (when: number) => void (alarm = when),
      getAlarm: () => alarm,
    },
  };
}

beforeEach(() => void vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

it("[duplicate-delivery] copies that pass the inbox check while the first copy's transaction waits are duplicates, not failures", async () => {
  const ctx = slowStartStorage();
  ctx.storage.sql.exec("CREATE TABLE count (n INTEGER NOT NULL)");
  ctx.storage.sql.exec("INSERT INTO count (n) VALUES (0)");
  const counter = actorRuntime({ ctx, env: {} }, system, "Counter", {
    "count.add": ({ payload }, c) => void c.sql.exec("UPDATE count SET n = n + ?", payload.n),
  });
  const envelope: Envelope = {
    v: 1,
    id: "add-1",
    type: "count.add",
    version: 1,
    from: "@ingress",
    to: "Counter:main",
    correlationId: "add-1",
    causationId: null,
    attempt: 1,
    sentAt: 0,
    payload: { n: 1 },
  };
  const receipts = await Promise.all(Array.from({ length: 10 }, (_, i) => counter.receive({ ...envelope, attempt: i + 1 })));
  expect(receipts.map((r) => r.status).sort()).toEqual(["handled", ...Array(9).fill("duplicate")].sort());
  expect(ctx.storage.sql.exec<{ n: number }>("SELECT n FROM count").one().n).toBe(1);
});
