// Validate the direct marketplace source. There is no filtered adapter build or adapter npm package.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validatePlugin } from "./validate-plugin.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const plugin = path.join(root, "plugins/codex");
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, "plugin.json")));
const allowed = new Set([
  "README.md",
  "plugin.json",
  "skills",
  "bin",
  "src",
  "dist",
  ".DS_Store",
]);
for (const entry of fs.readdirSync(plugin))
  if (!allowed.has(entry)) throw Error(`Non-shipping plugin entry: ${entry}`);
const files = fs
  .readdirSync(plugin, { recursive: true })
  .map(String)
  .filter((f) => !f.endsWith(".DS_Store"));
for (const file of files) {
  if (
    /(^|\/)(node_modules|vendor|examples|auth\.json|\.env[^/]*|\.dev.vars[^/]*|\.wrangler|\.actord)(\/|$)/.test(
      file,
    ) ||
    fs.lstatSync(path.join(plugin, file)).isSymbolicLink()
  )
    throw Error(`Unsafe plugin path: ${file}`);
}
const toolkit = JSON.parse(
  fs.readFileSync(path.join(root, "packages/toolkit/package.json")),
);
if (manifest.version !== toolkit.version || manifest.license !== "Apache-2.0")
  throw Error("Plugin version/license mismatch");
const archive = path.join(
  plugin,
  "dist",
  `actord-toolkit-${toolkit.version}.tgz`,
);
const inventory = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .trim()
  .split("\n");
if (inventory.includes("package/dist/reference-templates.json"))
  throw Error(
    "Codex-only reference templates must not ship in the toolkit archive",
  );
const templates = JSON.parse(
  fs.readFileSync(path.join(plugin, "dist/reference-templates.json"), "utf8"),
);
for (const [name, template] of Object.entries(templates))
  for (const [file, content] of Object.entries(template)) {
    if (
      file.split(/[\\/]/).includes("..") ||
      path.isAbsolute(file) ||
      /(^|\/)(node_modules|\.claude|CLAUDE\.md|\.DS_Store|\.actord|\.wrangler|\.env[^/]*|\.dev.vars[^/]*)(\/|$)/.test(
        file,
      )
    )
      throw Error(`Unsafe template path: ${file}`);
    if (
      fs.readFileSync(path.join(root, "examples", name, file), "utf8") !==
      content
    )
      throw Error(`Stale template: ${name}/${file}`);
  }
const marketplace = JSON.parse(
  fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json")),
);
if (
  marketplace.plugins.find((p) => p.name === "actord")?.source.path !==
  "./plugins/codex"
)
  throw Error("Marketplace must use direct source");
console.log(
  JSON.stringify(
    { status: "passed", validation: validatePlugin(plugin), files, inventory },
    null,
    2,
  ),
);
