import { appendFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    silent: false,
    include: ["test/probe.test.ts"],
    onConsoleLog(log) {
      if (log.includes('"actorsEvent"')) appendFileSync(process.env.PROBE_OUT ?? "/dev/null", log);
    },
  },
});
