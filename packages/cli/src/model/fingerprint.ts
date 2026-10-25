// A content hash of the files that define an actor system, so hooks and the Room can tell whether
// anything changed since the last passing check.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["system.ts", "wrangler.jsonc", "wrangler.json", "src/index.ts", "src/actors", "src/messages"];

export function actorFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) walk(join(p, e));
    else if (/\.(ts|jsonc?|mts)$/.test(p)) out.push(relative(root, p));
  };
  for (const r of ROOTS) walk(join(root, r));
  return out.sort();
}

export function fingerprint(root: string): string {
  const h = createHash("sha256");
  for (const f of actorFiles(root)) h.update(f).update("\0").update(readFileSync(join(root, f))).update("\0");
  return h.digest("hex").slice(0, 16);
}
