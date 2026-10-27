// The declaration, runtime, sources and testing bundles must stay free of the agent harness libraries:
// only dist/agents.mjs may carry them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dist = join(import.meta.dirname, "..", "dist");
const built = ["runtime", "system", "sources", "testing"].every((n) => existsSync(join(dist, `${n}.mjs`)));
if (!built) console.warn("bundle-isolation: packages/toolkit/dist is missing; run `npm run build -w @actord/toolkit` first. Skipping.");

describe.skipIf(!built)("bundle isolation", () => {
  for (const name of ["runtime", "system", "sources", "testing"])
    it(`dist/${name}.mjs imports neither @earendil-works nor @cloudflare/computer`, () => {
      const text = readFileSync(join(dist, `${name}.mjs`), "utf8");
      expect(text).not.toContain("@earendil-works");
      expect(text).not.toContain("@cloudflare/computer");
    });
});
