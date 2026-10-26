// End-to-end consumer test from the shipping plugin directory, without checkout or provider credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../..");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "plugins/codex/plugin.json")),
).version;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "actord-consumer-"));
const cache = spawnSync("npm", ["config", "get", "cache"], {
  encoding: "utf8",
}).stdout.trim();
const env = {
  PATH: process.env.PATH,
  HOME: path.join(temp, "home"),
  npm_config_cache: cache,
  npm_config_registry: "https://registry.npmjs.org/",
  WRANGLER_SEND_METRICS: "false",
};
fs.mkdirSync(env.HOME);
const installMode = process.argv.includes("--online")
  ? "--prefer-offline"
  : "--offline";
const steps = [];
// Recorded evidence is published: name the node binary and the home folder portably.
const portable = (text) =>
  text.replaceAll(process.execPath, "node").replaceAll(os.homedir(), "~");
function run(cmd, args, cwd = temp, expect = 0) {
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 6 * 1024 * 1024,
  });
  const output = portable(
    ((r.stdout ?? "") + (r.stderr ?? "")).replaceAll(temp, "<temp>"),
  );
  const passed =
    expect === "nonzero"
      ? r.status !== null && r.status !== 0
      : r.status === expect;
  steps.push({
    command: portable([cmd, ...args].join(" ").replaceAll(temp, "<temp>")),
    status: passed ? "passed" : "failed",
    exitCode: r.status,
    expected: expect,
    output,
  });
  if (!passed)
    throw Error(
      `Consumer command failed: ${cmd} ${args.join(" ")}\n${output.slice(-5000)}`,
    );
  return r;
}
function verifyGraph(cli, project) {
  const plain = JSON.parse(
    run(process.execPath, [cli, "graph", "--json"], project).stdout,
  );
  if (Object.hasOwn(plain, "mermaid"))
    throw Error("Default graph JSON unexpectedly includes Mermaid");
  const text = run(
    process.execPath,
    [cli, "graph", "--format", "mermaid"],
    project,
  ).stdout;
  const doc = JSON.parse(
    run(
      process.execPath,
      [cli, "graph", "--format", "mermaid", "--json"],
      project,
    ).stdout,
  );
  if (!text.startsWith("flowchart LR\n") || doc.mermaid !== text.trimEnd())
    throw Error("Mermaid text and JSON outputs do not agree");
  for (const actor of doc.manifest.actors)
    if (!text.includes(`${actor.name}<br/>`))
      throw Error(`Mermaid graph is missing actor ${actor.name}`);
  const bad = run(
    process.execPath,
    [cli, "graph", "--format", "dot"],
    project,
    2,
  );
  if (!bad.stdout.includes("unknown --format"))
    throw Error("Unknown graph format has no useful diagnostic");
}
try {
  // A standalone copy exercises the exact marketplace directory without access to root examples.
  fs.cpSync(path.join(root, "plugins/codex"), path.join(temp, "plugin"), {
    recursive: true,
  });
  const cli = path.join(temp, "plugin/bin/actord.js");
  run(process.execPath, [cli, "--version"]);
  const app = path.join(temp, "app");
  run(process.execPath, [cli, "init", app, "--json"]);
  run(process.execPath, [cli, "init", app], temp, 2);
  run("npm", ["install", installMode], app);
  run("npm", ["exec", "--offline", "--", "actord", "--version"], app);
  run(process.execPath, [cli, "graph", "--write", "--json"], app);
  verifyGraph(cli, app);
  run(process.execPath, [cli, "verify", "--json"], app);
  const evidence = JSON.parse(
    fs.readFileSync(path.join(app, ".actord/evidence.json")),
  );
  if (evidence.verdict !== "pass" || evidence.summary.provedLocally < 3)
    throw Error("Expected passing native workerd claims");
  const pinnedDoctor = JSON.parse(
    run(
      process.execPath,
      [
        path.join(app, "node_modules/@actord/toolkit/dist/cli.mjs"),
        "doctor",
        "--json",
      ],
      app,
    ).stdout,
  );
  if (
    pinnedDoctor.findings.some(
      (f) => f.id === "claude" || f.id === "project.permissions",
    )
  )
    throw Error("Project CLI lost the Codex host profile");
  // Establish that the installed declarations reject an undeclared send.
  const actor = path.join(app, "src/actors/greeter.ts");
  const original = fs.readFileSync(actor, "utf8");
  fs.writeFileSync(
    actor,
    original.replace(
      'ctx.send("greeting.recorded",',
      'ctx.send("undeclared.message",',
    ),
  );
  const bad = run("npm", ["run", "typecheck"], app, "nonzero");
  if (!bad.stdout.includes("undeclared.message"))
    throw Error("Compiler rejection did not identify the undeclared message");
  fs.writeFileSync(actor, original);
  run("npm", ["run", "typecheck"], app);
  const events = fs
    .readFileSync(path.join(app, ".actord/events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const id = events.find((e) => e.messageId)?.messageId;
  if (!id) throw Error("No runtime message evidence");
  run(process.execPath, [cli, "trace", id, "--json"], app);
  run(process.execPath, [cli, "diff", "--json"], app);
  for (const template of ["release-radar", "briefing-desk"]) {
    const sample = path.join(temp, template);
    run(process.execPath, [
      cli,
      "init",
      sample,
      "--template",
      template,
      "--json",
    ]);
    run("npm", ["install", installMode], sample);
    run(process.execPath, [cli, "graph", "--write"], sample);
    verifyGraph(cli, sample);
    run(process.execPath, [cli, "verify", "--json"], sample);
    const claims = JSON.parse(
      fs.readFileSync(path.join(sample, ".actord/evidence.json")),
    );
    if (claims.verdict !== "pass")
      throw Error(`${template}: expected passing workerd claims`);
  }
  // Generated guidance works with the project's pinned CLI as well as the plugin bundle.
  if (
    !fs.existsSync(path.join(app, ".agents/skills/verify/SKILL.md")) ||
    fs.existsSync(path.join(app, ".claude"))
  )
    throw Error("Host template mismatch");
} catch (error) {
  steps.push({ status: "failed", reason: error.message });
  process.exitCode = 1;
  console.error(error.message);
} finally {
  const report = {
    schemaVersion: 1,
    version,
    scope:
      "shipping Codex directory and installed toolkit; starter and root reference templates; no checkout required",
    status: steps.every((s) => s.status === "passed") ? "passed" : "failed",
    steps,
  };
  fs.mkdirSync(path.join(root, "docs/evidence"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs/evidence/codex-clean-install.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify({ status: report.status, steps: steps.length }));
  fs.rmSync(temp, { recursive: true, force: true });
}
