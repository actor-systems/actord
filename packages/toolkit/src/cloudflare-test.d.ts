// The subset of @cloudflare/vitest-plugin's `cloudflare:test` module that @actord/toolkit/testing uses.
declare module "cloudflare:test" {
  export function listDurableObjectIds(namespace: unknown): Promise<unknown[]>;
  export function runInDurableObject<R>(stub: unknown, callback: (instance: unknown, state: { id: { toString(): string }; storage: { sql: import("./runtime/index.ts").SqlStorageLike } }) => R | Promise<R>): Promise<R>;
}
