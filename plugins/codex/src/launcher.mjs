import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scaffoldTemplate } from "./templates.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Select only the actual shared package, never this adapter's own `actord` bin.
export function entrypoint(cwd, adapterRoot = root) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const pkg = join(dir, "node_modules/@actord/toolkit/package.json");
    if (existsSync(pkg)) {
      const data = JSON.parse(readFileSync(pkg, "utf8"));
      const bin = typeof data.bin === "string" ? data.bin : data.bin?.actord;
      if (data.name === "@actord/toolkit" && bin) {
        const entry = resolve(dirname(pkg), bin);
        if (
          existsSync(entry) &&
          !realpathSync(entry).startsWith(realpathSync(adapterRoot) + "/")
        )
          return { entry, source: "project-pin" };
      }
    }
    if (dirname(dir) === dir) break;
  }
  return {
    entry: join(adapterRoot, "dist/actord.mjs"),
    source: "plugin-bundle",
  };
}

export function launch(args, cwd = process.cwd()) {
  const selected = entrypoint(cwd);
  const core = join(root, "dist");
  const env = {
    ...process.env,
    ACTORD_HOST: "codex",
    ACTORD_PLUGIN_VERSION: readFileSync(join(core, "VERSION"), "utf8").trim(),
    ACTORD_PLUGIN_DIST: core,
    ACTORD_LAUNCHER: selected.source,
  };
  if (args[0] === "init" && args.includes("--template"))
    return scaffoldTemplate(args, root, env);
  const result = spawnSync(process.execPath, [selected.entry, ...args], {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`actord: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
