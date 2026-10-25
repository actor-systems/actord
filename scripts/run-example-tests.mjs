#!/usr/bin/env node
// Run an example's workerd test suite and confirm every required fault-matrix tag has a passing test.
//   node scripts/run-example-tests.mjs <example-dir> <tag> [<tag> ...]
// Tags appear in test names as [tag]. Prints one line per tag; exits 1 on any failure or missing tag.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, ...required] = process.argv.slice(2);
const root = join(import.meta.dirname, "..");
const cwd = join(root, dir);
const out = join(cwd, ".actors", "vitest-results.json");
const r = spawnSync("npx", ["--no-install", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${out}`], { cwd, encoding: "utf8" });
let results;
try {
  results = JSON.parse(readFileSync(out, "utf8"));
} catch {
  console.log(r.stdout.slice(-3000), r.stderr.slice(-2000));
  console.log("FAIL: no JSON results");
  process.exit(1);
}
const tests = results.testResults.flatMap((f) => f.assertionResults.map((a) => ({ name: a.fullName ?? a.title, status: a.status })));
const failed = tests.filter((t) => t.status !== "passed");
let bad = failed.length;
for (const t of failed) console.log(`FAIL test: ${t.name}`);
for (const tag of required) {
  const tagged = tests.filter((t) => t.name.includes(`[${tag}]`));
  const ok = tagged.length > 0 && tagged.every((t) => t.status === "passed");
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} [${tag}] ${tagged.length} test(s)`);
}
console.log(`${tests.length - failed.length}/${tests.length} tests passed in workerd`);
process.exit(bad ? 1 : 0);
