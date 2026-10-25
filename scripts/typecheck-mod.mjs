#!/usr/bin/env node
// Type-checks the Room (plugin/hooks, plugin/types, plugin/tests) against the declarations Claude Code
// writes for the installed build. Those are generated per build, so they aren't committed: this finds
// them (ACTORD_CLAUDE_TYPES, the folder the engine lays beside a hot-reloaded mod, or the plugin-authoring
// skill's copy) and exits 4, "blocked", when none exists for the running `claude --version`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim().split(/\s/)[0];
const candidates = [
  process.env.ACTORD_CLAUDE_TYPES,
  join(root, "plugin/.claude-plugin/types/claude-code/index.d.ts"),
  ...globSync(`/private/tmp/claude-*/bundled-skills/${version}/*/plugin-authoring/types/claude-code.d.ts`),
  ...globSync(`/tmp/claude-*/bundled-skills/${version}/*/plugin-authoring/types/claude-code.d.ts`),
].filter((p) => p && existsSync(p));
const types = candidates.find((p) => readFileSync(p, "utf8").startsWith(`// Written by Claude Code ${version}.`));
if (!types) {
  console.error(`blocked: no Claude Code ${version} mod declarations found (set ACTORD_CLAUDE_TYPES, or load the plugin-authoring skill once)`);
  process.exit(4);
}

const dir = mkdtempSync(join(tmpdir(), "room-tsc-"));
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2023",
      lib: ["es2023"],
      types: [],
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      jsx: "react",
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment",
    },
    include: [types, join(root, "plugin/hooks"), join(root, "plugin/types"), join(root, "plugin/tests")],
  }),
);
const r = spawnSync("npx", ["--no-install", "tsc", "-p", join(dir, "tsconfig.json")], { cwd: root, encoding: "utf8" });
rmSync(dir, { recursive: true, force: true });
process.stdout.write(r.stdout + r.stderr);
console.log(r.status === 0 ? `the Room type-checks against Claude Code ${version} (${types})` : "type errors in the Room");
process.exit(r.status ?? 1);
