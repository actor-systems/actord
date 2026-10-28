// Every entry point package.json exports must ship: its types file and its code. A subpath whose declarations the
// build never emits fails every strict TypeScript consumer (TS7016), which nothing else here typechecks. Like
// bundle-isolation, this reads the build: `npm test` builds first (pretest), and a missing file fails, never skips.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, string | Record<string, string>> };

describe("package exports", () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const files = typeof target === "string" ? { default: target } : target;
    it(`${subpath} has a types and a default file, and both exist after the build`, () => {
      if (typeof target !== "string") expect(Object.keys(files).sort(), subpath).toEqual(["default", "types"]);
      for (const [condition, file] of Object.entries(files))
        expect(existsSync(join(root, file)), `${subpath} ${condition}: ${file} is missing; run \`npm run build -w @actord/toolkit\``).toBe(true);
    });
  }
});
