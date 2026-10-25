#!/usr/bin/env node
// Typecheck every fixture with TypeScript 7. Valid fixtures must pass; a negative fixture must fail
// exactly when its expected.json says "typecheck": "fail" (the compiler is the first critic).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
let failures = 0;
for (const kind of ["valid", "negative"]) {
  for (const name of readdirSync(join(root, "fixtures", kind))) {
    const dir = join(root, "fixtures", kind, name);
    if (!existsSync(join(dir, "tsconfig.json"))) continue;
    const expected = kind === "valid" ? "pass" : JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")).typecheck;
    const r = spawnSync("npx", ["--no-install", "tsc", "-p", join(dir, "tsconfig.json")], { cwd: root, encoding: "utf8" });
    const got = r.status === 0 ? "pass" : "fail";
    const ok = got === expected;
    if (!ok) failures++;
    const firstError = (r.stdout.split("\n").find((l) => l.includes("error TS")) ?? "").replace(root + "/", "");
    console.log(`${ok ? "ok  " : "FAIL"} ${kind}/${name}: tsc ${got} (expected ${expected})${got === "fail" ? `  ${firstError}` : ""}`);
  }
}
process.exit(failures ? 1 : 0);
