// Bundles the CLI into one dependency-free ESM file for npm (dist/cli.mjs) and for the plugin
// (plugin/dist/actors.mjs). The plugin copy is what ships; tests run against it.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const pluginDist = join(here, "..", "..", "plugin", "dist");

await build({
  entryPoints: [join(here, "src/cli/bin.ts")],
  outfile: join(here, "dist/cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  define: { __ACTORS_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
});
// Library entry points for projects: plain ESM (Node won't strip types under node_modules) plus .d.ts.
const library = { outdir: join(here, "dist"), outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", target: "es2022", legalComments: "none", logLevel: "warning" };
await build({ ...library, entryPoints: { system: join(here, "src/system.ts"), runtime: join(here, "src/runtime/index.ts") }, platform: "neutral" });
await build({ ...library, entryPoints: { testing: join(here, "src/testing.ts") }, platform: "neutral", external: ["cloudflare:test"] });
await build({ ...library, entryPoints: { vitest: join(here, "src/vitest.ts") }, platform: "node" });
execFileSync("npx", ["--no-install", "tsc", "-p", join(here, "tsconfig.build.json")], { cwd: here, stdio: "inherit" });
// Declarations keep the source's relative ".ts" specifiers; projects resolve ".js" to ".d.ts" reliably.
for (const file of readdirSync(join(here, "dist/types"), { recursive: true })) {
  if (!String(file).endsWith(".d.ts")) continue;
  const path = join(here, "dist/types", String(file));
  writeFileSync(path, readFileSync(path, "utf8").replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
}
mkdirSync(pluginDist, { recursive: true });
copyFileSync(join(here, "dist/cli.mjs"), join(pluginDist, "actors.mjs"));
writeFileSync(join(pluginDist, "VERSION"), `${pkg.version}\n`);
console.log(`built actors-toolkit ${pkg.version} → dist/cli.mjs, plugin/dist/actors.mjs`);
