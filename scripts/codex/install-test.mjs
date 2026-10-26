// Installs the real root marketplace into disposable Codex configuration; never invokes a model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validatePlugin } from "./validate-plugin.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "actord-codex-install-"));
const home = path.join(temp, "codex");
fs.mkdirSync(home);
const env = { PATH: process.env.PATH, HOME: temp, CODEX_HOME: home };
const steps = [];
function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: temp,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  steps.push({
    command: [command, ...args]
      .join(" ")
      .replaceAll(root, "<repo>")
      .replaceAll(temp, "<temp>"),
    status: r.status === 0 ? "passed" : "failed",
    output: ((r.stdout ?? "") + (r.stderr ?? ""))
      .replaceAll(temp, "<temp>")
      .replaceAll(root, "<repo>"),
  });
  if (r.status !== 0)
    throw Error(
      `Install check failed: ${command} ${args.join(" ")}\n${r.stderr}`,
    );
  return r.stdout;
}
try {
  run("codex", ["plugin", "marketplace", "add", root, "--json"]);
  const installed = JSON.parse(
    run("codex", ["plugin", "add", "actord@actord", "--json"]),
  ).installedPath;
  if (validatePlugin(installed).skills.length !== 6)
    throw Error("Missing installed skills");
  const version = JSON.parse(
    fs.readFileSync(path.join(installed, "plugin.json")),
  ).version;
  if (
    run(process.execPath, [
      path.join(installed, "bin/actord.js"),
      "--version",
    ]).trim() !== version
  )
    throw Error("Installed launcher version differs");
  run("codex", ["plugin", "list", "--json"]);
  run("codex", ["plugin", "remove", "actord@actord", "--json"]);
  run("codex", ["plugin", "marketplace", "remove", "actord", "--json"]);
} catch (error) {
  steps.push({ status: "failed", reason: error.message });
  process.exitCode = 1;
} finally {
  const report = {
    schemaVersion: 1,
    status: steps.every((s) => s.status === "passed") ? "passed" : "failed",
    steps,
    unverified: [
      "Model-backed skill invocation and desktop onboarding; not run by this credential-free lane",
    ],
  };
  fs.mkdirSync(path.join(root, "docs/evidence"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs/evidence/codex-install.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(temp, { recursive: true, force: true });
}
