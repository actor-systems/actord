// The subset of @cloudflare/vitest-plugin's `cloudflare:test` module that @actord/toolkit/testing uses.
declare module "cloudflare:test" {
  export function runDurableObjectAlarm(stub: unknown): Promise<boolean>;
  export function listDurableObjectIds(namespace: unknown): Promise<unknown[]>;
  export function runInDurableObject<R>(stub: unknown, callback: (instance: unknown, state: { storage: { sql: { exec(q: string, ...b: unknown[]): { toArray(): Array<Record<string, unknown>> } }; setAlarm(t: number): Promise<void>; getAlarm(): Promise<number | null> } }) => R | Promise<R>): Promise<R>;
}
