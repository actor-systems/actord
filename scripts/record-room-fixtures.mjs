#!/usr/bin/env node
// Records the CLI output the Room's mod tests stub with (plugin/tests/fixtures.ts), from the real CLI run
// on examples/release-radar. Run after `actors verify` there, so events, the check and evidence exist.
// The base manifest drops DigestWriter and adds a retired Notifier, so the topology shows both highlights.
// With --check it records nothing and fails when the CLI's documents no longer have the recorded shapes
// (keys and schemaVersion), which is how a CLI schema change fails the mod's tests.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "examples/release-radar");
const cli = (args, opts = {}) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [join(root, "packages/cli/src/cli/bin.ts"), ...args], { cwd: app, encoding: "utf8", ...opts }));
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout); // trace of an unknown id exits 1 with JSON
    throw err;
  }
};

const head = JSON.parse(readFileSync(join(app, "actors.manifest.json"), "utf8"));
const base = structuredClone(head);
base.actors = base.actors.filter((a) => a.name !== "DigestWriter");
base.routes = base.routes.filter((r) => r.to !== "DigestWriter");
base.actors.push({ ...head.actors[0], name: "Notifier", binding: "NOTIFIER", receives: ["release.significant"], sends: [], effects: [], schedule: null });
base.routes.push({ from: "ReleaseLedger", message: "release.significant", to: "Notifier" });
const dir = mkdtempSync(join(tmpdir(), "room-fixture-"));
const baseFile = join(dir, "base.json");
writeFileSync(baseFile, JSON.stringify(base));

const scrub = (doc) => JSON.parse(JSON.stringify(doc).replaceAll(app, "/work/release-radar").replaceAll(baseFile, "base.json"));
const room = scrub(cli(["room", "--json", "--base-file", baseFile]));
const busiest = room.mailboxes.actors.find((a) => a.name === "ReleaseLedger") ?? room.mailboxes.actors[0];
const target = busiest?.messages.at(-1)?.messageId;
if (!target && !process.argv.includes("--check")) throw new Error("no recorded events in examples/release-radar: run `actors verify` there first");
const trace = target ? scrub(cli(["trace", target, "--json"])) : { found: false };
const unknown = scrub(cli(["trace", "no-such-message", "--json"]));
const deployCommand = ["npx", "wrangler", "deploy"].join(" ");
const hold = scrub(cli(["guard", "--json", "--", deployCommand]));
const outside = scrub(cli(["guard", "--json", "--", deployCommand], { cwd: dir }));
rmSync(dir, { recursive: true, force: true });

if (process.argv.includes("--check")) {
  const recorded = await import(join(root, "plugin/tests/fixtures.ts"));
  const problems = [];
  const compare = (a, b, path) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length && b.length) compare(a[0], b[0], `${path}[]`);
      return;
    }
    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(k in a)) problems.push(`${path}.${k}: printed by the CLI, not in the recording`);
        else if (!(k in b)) problems.push(`${path}.${k}: recorded, no longer printed by the CLI`);
        else compare(a[k], b[k], `${path}.${k}`);
      }
      return;
    }
    if (a !== null && b !== null && typeof a !== typeof b) problems.push(`${path}: recorded ${typeof a}, printed ${typeof b}`);
  };
  compare(recorded.ROOM, room, "room");
  if (trace.found) compare(recorded.TRACE, trace, "trace");
  compare(recorded.TRACE_UNKNOWN, unknown, "traceUnknown");
  compare(recorded.GUARD_HOLD, hold, "guardHold");
  compare(recorded.GUARD_OUTSIDE_PROJECT, outside, "guardOutside");
  for (const doc of [room, unknown, hold, outside, ...(trace.found ? [trace] : [])]) if (doc.schemaVersion !== recorded.ROOM.schemaVersion) problems.push(`schemaVersion ${doc.schemaVersion} != recorded ${recorded.ROOM.schemaVersion}`);
  if (problems.length) {
    console.error(`plugin/tests/fixtures.ts no longer matches the CLI (re-record with node scripts/record-room-fixtures.mjs, then update the Room):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("plugin/tests/fixtures.ts matches the CLI's room, trace, and guard documents");
  process.exit(0);
}

const out = [
  "// Recorded by scripts/record-room-fixtures.mjs from the actors CLI on examples/release-radar. Do not edit;",
  "// re-record instead. `node scripts/record-room-fixtures.mjs --check` fails when the CLI's documents drift.",
  `export const ROOM = ${JSON.stringify(room, null, 2)}`,
  "",
  `export const TRACE = ${JSON.stringify(trace, null, 2)}`,
  "",
  `export const TRACE_UNKNOWN = ${JSON.stringify(unknown, null, 2)}`,
  "",
  `export const GUARD_HOLD = ${JSON.stringify(hold, null, 2)}`,
  "",
  `export const GUARD_OUTSIDE_PROJECT = ${JSON.stringify(outside, null, 2)}`,
  "",
  `export const DEPLOY_COMMAND = ${JSON.stringify(deployCommand)}`,
  "",
].join("\n");
writeFileSync(join(root, "plugin/tests/fixtures.ts"), out);
console.log(`recorded plugin/tests/fixtures.ts: ${room.status}; trace ${target} (${trace.found ? "found" : "unknown"}); guard hold=${hold.hold}`);
