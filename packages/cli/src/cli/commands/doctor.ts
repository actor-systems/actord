import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { askRules } from "../../patterns.ts";
import { VERSION } from "../../version.ts";
import { projectHost } from "../../templates/host.ts";
import type { CommandResult } from "../output.ts";
import { findProjectRoot, readJson } from "../project.ts";

export type FindingStatus = "ok" | "warn" | "error" | "info";

export interface Finding {
  id: string;
  status: FindingStatus;
  message: string;
  fix?: string;
}

export interface DoctorData {
  projectRoot: string | null;
  findings: Finding[];
  summary: Record<FindingStatus, number>;
}

const NODE_FLOOR = [22, 18, 0];
const MODS_FLOOR = "2.1.287";
const EVAL_FLOOR = "2.1.269";

export function doctor(cwd: string, env: NodeJS.ProcessEnv = process.env): CommandResult<DoctorData> {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  const node = process.versions.node.split(".").map(Number);
  add(
    compare(node, NODE_FLOOR) >= 0
      ? { id: "node", status: "ok", message: `Node.js ${process.versions.node}` }
      : {
          id: "node",
          status: "error",
          message: `Node.js ${process.versions.node} is older than 22.18, which loads system.ts natively`,
          fix: "Install Node.js 22.18 or later (24 LTS recommended).",
        },
  );

  const source = env.ACTORS_LAUNCHER === "plugin-bundle" ? "plugin bundle" : env.ACTORS_LAUNCHER === "project-pin" ? "project pin" : "direct";
  add({ id: "cli", status: "ok", message: `actors-toolkit ${VERSION} (${source})` });
  if (env.ACTORS_PLUGIN_VERSION && env.ACTORS_PLUGIN_VERSION !== VERSION) {
    add({
      id: "cli.pin-mismatch",
      status: "warn",
      message: `The plugin bundles actors-toolkit ${env.ACTORS_PLUGIN_VERSION}; this project pins ${VERSION}, which is the one running`,
      fix: `Align them: update the plugin, or run \`npm install -D actors-toolkit@${env.ACTORS_PLUGIN_VERSION}\` in the project.`,
    });
  }

  const host = env.ACTORS_HOST ?? projectHost(findProjectRoot(cwd) ?? cwd);
  if (host === "codex") {
    const codex = run("codex", ["--version"]);
    add({ id: "codex", status: "info", message: codex?.trim() ?? "Codex not found on PATH; the CLI works without it" });
  }
  if (host === "claude") {
    const claude = run("claude", ["--version"]);
    const claudeVersion = claude?.match(/\d+\.\d+\.\d+/)?.[0];
    if (!claudeVersion) {
      add({ id: "claude", status: "info", message: "Claude Code not found on PATH; the CLI works without it" });
    } else if (compare(parse(claudeVersion), parse(MODS_FLOOR)) >= 0) {
      add({ id: "claude", status: "ok", message: `Claude Code ${claudeVersion} (the Room and plugin evals are available)` });
    } else {
      add({
        id: "claude",
        status: "warn",
        message: `Claude Code ${claudeVersion}: the Room needs ${MODS_FLOOR}+${compare(parse(claudeVersion), parse(EVAL_FLOOR)) < 0 ? `, plugin evals need ${EVAL_FLOOR}+` : ""}`,
        fix: "Run `claude update`. Everything else works through CLI text output.",
      });
    }

  }

  add({
    id: "credentials",
    status: "info",
    message: "Cloudflare credentials not checked: actors never reads them; wrangler owns authentication and deploys",
  });

  const root = findProjectRoot(cwd);
  if (!root) {
    add({
      id: "project",
      status: "info",
      message: "No actor project here (no system.ts with a package.json in this directory or above)",
      fix: "Create one with `actors init <dir>`, or study examples/release-radar and examples/briefing-desk.",
    });
  } else {
    projectFindings(root, add, host);
  }

  const summary = { ok: 0, warn: 0, error: 0, info: 0 };
  for (const f of findings) summary[f.status]++;
  const text = [
    ...findings.map((f) => `${icon(f.status)} ${f.message}${f.fix ? `\n    fix: ${f.fix}` : ""}`),
    "",
    `${summary.ok} ok · ${summary.warn} warn · ${summary.error} error`,
  ].join("\n");
  return { data: { projectRoot: root, findings, summary }, text, exitCode: summary.error > 0 ? 1 : 0 };
}

function projectFindings(root: string, add: (f: Finding) => void, host: string): void {
  add({ id: "project", status: "ok", message: `Actor project at ${root}` });
  const pkg = readJson<{ devDependencies?: Record<string, string>; dependencies?: Record<string, string> }>(join(root, "package.json"));
  const pin = pkg?.devDependencies?.["actors-toolkit"] ?? pkg?.dependencies?.["actors-toolkit"];
  if (!pin) {
    add({
      id: "project.pin",
      status: "warn",
      message: "package.json doesn't pin actors-toolkit, so CI and the coding agent may run different versions",
      fix: `Run \`npm install -D -E actors-toolkit@${VERSION}\`.`,
    });
  } else if (/^[\^~>=<*]|^latest$/.test(pin)) {
    add({ id: "project.pin", status: "warn", message: `actors-toolkit is a range (${pin}), not a pin`, fix: "Use an exact version." });
  } else {
    add({ id: "project.pin", status: "ok", message: `actors-toolkit pinned at ${pin}` });
  }
  const installed = existsSync(join(root, "node_modules"));
  add(
    installed
      ? { id: "project.install", status: "ok", message: "Dependencies installed" }
      : { id: "project.install", status: "warn", message: "node_modules is missing", fix: "Run `npm install`." },
  );
  const wranglerPkg = readJson<{ version: string }>(join(root, "node_modules", "wrangler", "package.json"));
  add(
    wranglerPkg
      ? { id: "project.wrangler", status: "ok", message: `wrangler ${wranglerPkg.version}` }
      : { id: "project.wrangler", status: "warn", message: "wrangler is not installed in this project", fix: "Run `npm install -D wrangler`." },
  );
  const config = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find((f) => existsSync(join(root, f)));
  add(
    config
      ? { id: "project.config", status: "ok", message: `Worker config ${config}` }
      : { id: "project.config", status: "error", message: "No wrangler.jsonc", fix: "Run `actors init --adopt` or add one." },
  );
  if (host === "codex") {
    for (const rel of ["AGENTS.md", ".agents/skills/verify/SKILL.md"]) {
      add(existsSync(join(root, rel))
        ? { id: `project.${rel === "AGENTS.md" ? "guidance" : "verify-skill"}`, status: "ok", message: `${rel} present` }
        : { id: `project.${rel === "AGENTS.md" ? "guidance" : "verify-skill"}`, status: "warn", message: `${rel} missing`, fix: "Run `actors init --adopt --host codex` (existing files are preserved)." });
    }
  }
  if (host === "claude") {
    add(
      existsSync(join(root, ".claude", "skills", "verify", "SKILL.md"))
        ? { id: "project.verify-skill", status: "ok", message: "Project verify skill present" }
        : {
            id: "project.verify-skill",
            status: "warn",
            message: "No .claude/skills/verify/SKILL.md, so sessions without the plugin won't run `npm run verify` before commits",
            fix: "Run `actors init --adopt` to add it (existing .claude/ files are never overwritten).",
          },
    );
    const settingsPath = join(root, ".claude", "settings.json");
    const ask = (readJson<{ permissions?: { ask?: string[] } }>(settingsPath)?.permissions?.ask ?? []) as string[];
    const missing = askRules().filter((r) => !ask.includes(r));
    if (!existsSync(settingsPath)) {
      add({
        id: "project.permissions",
        status: "warn",
        message: "No .claude/settings.json: deploy and remote-write commands won't prompt",
        fix: "Run `actors init --adopt` to create it.",
      });
    } else if (missing.length > 0) {
      add({
        id: "project.permissions",
        status: "warn",
        message: `.claude/settings.json lacks ${missing.length} ask rule(s): ${missing.join(", ")}`,
        fix: "Add them to permissions.ask; `actors init --adopt` prints the full list.",
      });
    } else {
      add({ id: "project.permissions", status: "ok", message: "Deploy and remote-write commands require approval" });
    }

  }
  if (existsSync(join(root, "system.ts")) && readFileSync(join(root, "system.ts"), "utf8").trim() === "") {
    add({ id: "project.declaration", status: "error", message: "system.ts is empty" });
  }
}

function run(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout : null;
}

function parse(v: string): number[] {
  return v.split(".").map(Number);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

function icon(s: FindingStatus): string {
  return { ok: "✓", warn: "!", error: "✗", info: "·" }[s];
}
