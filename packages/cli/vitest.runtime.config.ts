// Runtime guarantees, tested in workerd against a tiny probe system (test-runtime/).
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test-runtime/wrangler.jsonc" } })],
  test: { include: ["test-runtime/**/*.test.ts"] },
});
