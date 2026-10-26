import { defineConfig } from "vitest/config";

// agents/lifecycle, which the runtime builds on, imports cloudflare:workers for its side effects only. Under
// Node, load agents through Vite and give that import an empty module, so runtime tests can use Lifecycle.
const CLOUDFLARE_WORKERS = "\0cloudflare:workers";

export default defineConfig({
  plugins: [
    {
      name: "cloudflare-workers-stub",
      resolveId: (id) => (id === "cloudflare:workers" ? CLOUDFLARE_WORKERS : undefined),
      load: (id) => (id === CLOUDFLARE_WORKERS ? "export {};" : undefined),
    },
  ],
  test: { include: ["test/**/*.test.ts"], environment: "node", server: { deps: { inline: ["agents"] } } },
});
