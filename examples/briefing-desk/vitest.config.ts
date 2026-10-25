import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { actorEvents } from "@actord/toolkit/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }), actorEvents()],
});
