// The declaration, runtime, sources and testing bundles must stay free of the agent harness libraries:
// only dist/agents.mjs may carry them. Verify's g2.cli.model builds first; a missing bundle fails, never skips.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dist = join(import.meta.dirname, "..", "dist");

describe("bundle isolation", () => {
  for (const name of ["runtime", "system", "sources", "testing"])
    it(`dist/${name}.mjs imports neither @earendil-works nor @cloudflare/computer`, () => {
      const file = join(dist, `${name}.mjs`);
      expect(existsSync(file), `${file} is missing: run \`npm run build -w @actord/toolkit\` first`).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("@earendil-works");
      expect(text).not.toContain("@cloudflare/computer");
    });
});
