import { DurableObject } from "cloudflare:workers";

// Probe: does an in-flight RPC let a second call interleave, and do DO console logs reach vitest?
export class Slow extends DurableObject<Env> {
  async hold(ms: number): Promise<string> {
    await new Promise((r) => setTimeout(r, ms));
    return "held";
  }
}

export class Gate extends DurableObject<Env> {
  log: string[] = [];
  async first(): Promise<string[]> {
    this.log.push("first:start");
    console.log(JSON.stringify({ actorsEvent: 1, kind: "probe", step: "first:start" }));
    await this.env.SLOW.getByName("s").hold(50);
    this.log.push("first:end");
    return this.log;
  }
  async second(): Promise<string[]> {
    this.log.push("second");
    return this.log;
  }
}

export class Tx extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY)");
  }
  idName(): string | undefined {
    return this.ctx.id.name;
  }
  async asyncTxThrows(): Promise<string> {
    try {
      await this.ctx.storage.transaction(async () => {
        this.ctx.storage.sql.exec("INSERT INTO t VALUES ('async')");
        await this.env.SLOW.getByName("s").hold(5);
        throw new Error("boom");
      });
    } catch (e) {
      return `caught ${(e as Error).message}`;
    }
    return "no throw";
  }
  syncTxThrows(): string {
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("INSERT INTO t VALUES ('sync')");
        throw new Error("boom");
      });
    } catch (e) {
      return `caught ${(e as Error).message}`;
    }
    return "no throw";
  }
  async longTxThrows(): Promise<string> {
    try {
      await this.ctx.storage.transaction(async () => {
        this.ctx.storage.sql.exec("INSERT INTO t VALUES ('long')");
        await this.env.SLOW.getByName("s").hold(80);
        throw new Error("boom");
      });
    } catch (e) {
      return `caught ${(e as Error).message}`;
    }
    return "no throw";
  }
  insertOutside(k: string): string {
    this.ctx.storage.sql.exec("INSERT INTO t VALUES (?)", k);
    return `inserted ${k} at ${Date.now()}`;
  }
  rows(): string[] {
    return this.ctx.storage.sql.exec<{ k: string }>("SELECT k FROM t ORDER BY k").toArray().map((r) => r.k);
  }
}
