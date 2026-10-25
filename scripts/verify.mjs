#!/usr/bin/env node
// Offline verification for the toolkit repository. Runs every registered check, then writes
// verify-report.json (machine) and docs/verification-report.md (human). A gate passes only when
// every check it requires ran and passed in this invocation; blocked checks keep a gate "blocked".
//
//   node scripts/verify.mjs                 run everything
//   node scripts/verify.mjs --only g2.      run checks whose id starts with a prefix (report not written)
//   node scripts/verify.mjs --versions      print tool versions as JSON
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checks, gates } from "./checks.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

export function sh(cmd, opts = {}) {
  const started = Date.now();
  const r = spawnSync("bash", ["-c", cmd], {
    cwd: opts.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
    timeout: opts.timeoutMs ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = clean(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  return { code: r.status ?? (r.signal ? 128 : 1), output, ms: Date.now() - started };
}

function clean(text) {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/((?:TOKEN|SECRET|API_KEY|PASSWORD)[A-Z_]*\s*[=:]\s*)\S+/gi, "$1[redacted]");
}

function tail(text, lines = 40) {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function pkg(name) {
  try {
    return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

export function versions() {
  const v = (cmd) => {
    const r = sh(cmd);
    return r.code === 0 ? r.output.trim().split("\n")[0] : null;
  };
  return {
    claude: v("claude --version")?.replace(/\s*\(Claude Code\)/, "") ?? null,
    node: process.version,
    npm: v("npm --version"),
    wrangler: v("npx --no-install wrangler --version")?.replace(/^.*?(\d+\.\d+\.\d+).*$/, "$1") ?? null,
    workerd: pkg("workerd"),
    vitest: pkg("vitest"),
    vitestPlugin: pkg("@cloudflare/vitest-plugin"),
    typescript: pkg("typescript"),
    platform: `${process.platform}-${process.arch}`,
  };
}

if (args.includes("--versions")) {
  console.log(JSON.stringify(versions(), null, 2));
  process.exit(0);
}

const selected = checks.filter((c) => !only || c.id.startsWith(only));
const results = [];
const env = { root, sh, versions: versions() };
for (const check of selected) {
  process.stdout.write(`• ${check.id} … `);
  let result;
  try {
    result = await check.run(env);
  } catch (err) {
    result = { status: "fail", reason: `check threw: ${err?.message ?? err}` };
  }
  const entry = {
    id: check.id,
    gate: check.gate,
    title: check.title,
    command: result.command ?? check.command ?? null,
    status: result.status,
    reason: result.reason ?? null,
    evidenceSource: result.evidenceSource ?? "host",
    durationMs: result.ms ?? null,
    outputTail: result.output ? tail(result.output) : null,
  };
  results.push(entry);
  console.log(`${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`);
}

const gateStatus = {};
for (const gate of gates) {
  const own = results.filter((r) => r.gate === gate.id);
  const missing = gate.requires.filter((id) => !results.some((r) => r.id === id));
  let status;
  if (own.some((r) => r.status === "fail")) status = "failed";
  else if (missing.length > 0) status = only ? "not-run" : "incomplete";
  else if (own.some((r) => r.status === "blocked")) status = "blocked";
  else if (own.length === 0) status = "not-started";
  else status = "passed";
  gateStatus[gate.id] = { title: gate.title, status, missing };
}

const failed = results.filter((r) => r.status === "fail");
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  versions: env.versions,
  summary: {
    pass: results.filter((r) => r.status === "pass").length,
    fail: failed.length,
    blocked: results.filter((r) => r.status === "blocked").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  },
  gates: gateStatus,
  checks: results,
};

if (!only) {
  writeFileSync(join(root, "verify-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/verification-report.md"), renderMarkdown(report));
  console.log("\nwrote verify-report.json and docs/verification-report.md");
}
console.log(
  `\n${report.summary.pass} pass · ${report.summary.fail} fail · ${report.summary.blocked} blocked · ${report.summary.skipped} skipped`,
);
for (const [id, g] of Object.entries(gateStatus)) console.log(`  ${id} ${g.status}`);
process.exit(failed.length > 0 ? 1 : 0);

function renderMarkdown(r) {
  const lines = [
    "# Verification report",
    "",
    `Generated ${r.generatedAt} by \`npm run verify\` (\`scripts/verify.mjs\`). Machine-readable copy: \`verify-report.json\`.`,
    "",
    "## Versions",
    "",
    "| Tool | Version |",
    "| --- | --- |",
    ...Object.entries(r.versions).map(([k, v]) => `| ${k} | ${v ?? "not found"} |`),
    "",
    "## Gates",
    "",
    "| Gate | Status | Missing checks |",
    "| --- | --- | --- |",
    ...Object.entries(r.gates).map(
      ([id, g]) => `| ${id} — ${g.title} | **${g.status}** | ${g.missing.join(", ") || "—"} |`,
    ),
    "",
    `## Checks (${r.summary.pass} pass · ${r.summary.fail} fail · ${r.summary.blocked} blocked · ${r.summary.skipped} skipped)`,
    "",
    "| Check | Gate | Status | Evidence from | Command | Reason |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.checks.map(
      (c) =>
        `| \`${c.id}\` ${c.title} | ${c.gate} | ${c.status} | ${c.evidenceSource} | ${c.command ? `\`${c.command.replace(/\|/g, "\\|")}\`` : "—"} | ${(c.reason ?? "").replace(/\|/g, "\\|")} |`,
    ),
    "",
  ];
  const failures = r.checks.filter((c) => c.status !== "pass" && c.outputTail);
  if (failures.length) {
    lines.push("## Output of non-passing checks", "");
    for (const c of failures) lines.push(`### ${c.id} (${c.status})`, "", "```text", c.outputTail, "```", "");
  }
  return `${lines.join("\n")}\n`;
}
