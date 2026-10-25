#!/usr/bin/env node

// src/cli/main.ts
import { parseArgs } from "node:util";

// src/version.ts
var VERSION = true ? "0.1.0" : "0.0.0-dev";
var SCHEMA_VERSION = 1;

// src/cli/commands/doctor.ts
import { spawnSync } from "node:child_process";
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/patterns.ts
var W = String.raw`(?:^|[\s;&|(])(?:\S*/)?wrangler`;
var EFFECT_PATTERNS = [
  {
    id: "wrangler-deploy",
    kind: "deploy",
    description: "Deploy or publish a Worker",
    rules: ["Bash(*wrangler deploy*)", "Bash(*wrangler publish*)"],
    regex: new RegExp(`${W}\\s+(?:.*\\s)?(?:deploy|publish)\\b`),
    examples: ["wrangler deploy", "npx wrangler deploy --env production", "cd app && pnpm exec wrangler publish"]
  },
  {
    id: "wrangler-versions",
    kind: "deploy",
    description: "Upload or deploy a Worker version",
    rules: ["Bash(*wrangler versions upload*)", "Bash(*wrangler versions deploy*)"],
    regex: new RegExp(`${W}\\s+versions\\s+(?:upload|deploy)\\b`),
    examples: ["wrangler versions upload", "npx wrangler versions deploy 1234@100%"]
  },
  {
    id: "wrangler-rollback",
    kind: "deploy",
    description: "Roll back, delete, or change triggers of a deployed Worker",
    rules: ["Bash(*wrangler rollback*)", "Bash(*wrangler delete*)", "Bash(*wrangler triggers deploy*)"],
    regex: new RegExp(`${W}\\s+(?:rollback|delete|triggers\\s+deploy)\\b`),
    examples: ["wrangler rollback", "npx wrangler delete", "wrangler triggers deploy"]
  },
  {
    id: "wrangler-secret",
    kind: "secret",
    description: "Create, change, or delete Worker secrets",
    rules: ["Bash(*wrangler secret*)", "Bash(*wrangler versions secret*)"],
    regex: new RegExp(`${W}\\s+(?:versions\\s+)?secrets?(?:-store)?\\b`),
    examples: ["wrangler secret put API_KEY", "npx wrangler versions secret put X", "wrangler secrets-store secret create"]
  },
  {
    id: "wrangler-remote",
    kind: "remote-write",
    description: "Run a storage or dev command against the remote account",
    rules: ["Bash(*wrangler * --remote*)"],
    regex: new RegExp(`${W}\\s+.*\\s--remote\\b`),
    examples: ["wrangler d1 execute DB --remote --command 'DELETE FROM t'", "npx wrangler kv key put k v --remote"]
  },
  {
    id: "wrangler-resource-write",
    kind: "remote-write",
    description: "Create or delete account resources (KV, R2, D1, Queues, and similar)",
    rules: ["Bash(*wrangler * create*)", "Bash(*wrangler * delete*)"],
    regex: new RegExp(`${W}\\s+\\S+(?:\\s+\\S+)?\\s+(?:create|delete)\\b`),
    examples: ["wrangler kv namespace create CACHE", "npx wrangler r2 bucket delete archive", "wrangler queues create q"]
  },
  {
    id: "wrangler-login",
    kind: "credential",
    description: "Sign in to Cloudflare",
    rules: ["Bash(*wrangler login*)"],
    regex: new RegExp(`${W}\\s+login\\b`),
    examples: ["wrangler login", "npx wrangler login --browser=false"]
  },
  {
    id: "script-deploy",
    kind: "deploy",
    description: "A package script named deploy",
    rules: ["Bash(* run deploy*)", "Bash(yarn deploy*)"],
    regex: /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy\b/,
    examples: ["npm run deploy", "pnpm run deploy -- --env prod", "yarn deploy"]
  },
  {
    id: "cf-deploy",
    kind: "deploy",
    description: "Deploy with Cloudflare's cf CLI or Void",
    rules: ["Bash(cf deploy*)", "Bash(cf * deploy*)", "Bash(*void deploy*)"],
    regex: /(?:^|[\s;&|(])(?:cf(?:\s+\S+)?\s+deploy|(?:\S*\/)?void\s+deploy)\b/,
    examples: ["cf deploy", "cf previews deploy", "npx void deploy"]
  }
];
function askRules() {
  return [...new Set(EFFECT_PATTERNS.flatMap((p) => p.rules))];
}

// src/cli/project.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
var DECLARATION_FILE = "system.ts";
function findProjectRoot(from) {
  let dir = resolve(from);
  for (; ; ) {
    if (existsSync(join(dir, DECLARATION_FILE)) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// src/cli/commands/doctor.ts
var NODE_FLOOR = [22, 18, 0];
var MODS_FLOOR = "2.1.287";
var EVAL_FLOOR = "2.1.269";
function doctor(cwd, env = process.env) {
  const findings = [];
  const add = (f) => findings.push(f);
  const node = process.versions.node.split(".").map(Number);
  add(
    compare(node, NODE_FLOOR) >= 0 ? { id: "node", status: "ok", message: `Node.js ${process.versions.node}` } : {
      id: "node",
      status: "error",
      message: `Node.js ${process.versions.node} is older than 22.18, which loads system.ts natively`,
      fix: "Install Node.js 22.18 or later (24 LTS recommended)."
    }
  );
  const source = env.ACTORS_LAUNCHER === "plugin-bundle" ? "plugin bundle" : env.ACTORS_LAUNCHER === "project-pin" ? "project pin" : "direct";
  add({ id: "cli", status: "ok", message: `actors-toolkit ${VERSION} (${source})` });
  if (env.ACTORS_PLUGIN_VERSION && env.ACTORS_PLUGIN_VERSION !== VERSION) {
    add({
      id: "cli.pin-mismatch",
      status: "warn",
      message: `The plugin bundles actors-toolkit ${env.ACTORS_PLUGIN_VERSION}; this project pins ${VERSION}, which is the one running`,
      fix: `Align them: update the plugin, or run \`npm install -D actors-toolkit@${env.ACTORS_PLUGIN_VERSION}\` in the project.`
    });
  }
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
      fix: "Run `claude update`. Everything else works through CLI text output."
    });
  }
  add({
    id: "credentials",
    status: "info",
    message: "Cloudflare credentials not checked: actors never reads them; wrangler owns authentication and deploys"
  });
  const root = findProjectRoot(cwd);
  if (!root) {
    add({
      id: "project",
      status: "info",
      message: "No actor project here (no system.ts with a package.json in this directory or above)",
      fix: "Create one with `actors init <dir>`, or study examples/release-radar and examples/briefing-desk."
    });
  } else {
    projectFindings(root, add);
  }
  const summary = { ok: 0, warn: 0, error: 0, info: 0 };
  for (const f of findings) summary[f.status]++;
  const text = [
    ...findings.map((f) => `${icon(f.status)} ${f.message}${f.fix ? `
    fix: ${f.fix}` : ""}`),
    "",
    `${summary.ok} ok \xB7 ${summary.warn} warn \xB7 ${summary.error} error`
  ].join("\n");
  return { data: { projectRoot: root, findings, summary }, text, exitCode: summary.error > 0 ? 1 : 0 };
}
function projectFindings(root, add) {
  add({ id: "project", status: "ok", message: `Actor project at ${root}` });
  const pkg = readJson(join2(root, "package.json"));
  const pin = pkg?.devDependencies?.["actors-toolkit"] ?? pkg?.dependencies?.["actors-toolkit"];
  if (!pin) {
    add({
      id: "project.pin",
      status: "warn",
      message: "package.json doesn't pin actors-toolkit, so CI and Claude may run different versions",
      fix: `Run \`npm install -D -E actors-toolkit@${VERSION}\`.`
    });
  } else if (/^[\^~>=<*]|^latest$/.test(pin)) {
    add({ id: "project.pin", status: "warn", message: `actors-toolkit is a range (${pin}), not a pin`, fix: "Use an exact version." });
  } else {
    add({ id: "project.pin", status: "ok", message: `actors-toolkit pinned at ${pin}` });
  }
  const installed = existsSync2(join2(root, "node_modules"));
  add(
    installed ? { id: "project.install", status: "ok", message: "Dependencies installed" } : { id: "project.install", status: "warn", message: "node_modules is missing", fix: "Run `npm install`." }
  );
  const wranglerPkg = readJson(join2(root, "node_modules", "wrangler", "package.json"));
  add(
    wranglerPkg ? { id: "project.wrangler", status: "ok", message: `wrangler ${wranglerPkg.version}` } : { id: "project.wrangler", status: "warn", message: "wrangler is not installed in this project", fix: "Run `npm install -D wrangler`." }
  );
  const config = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find((f) => existsSync2(join2(root, f)));
  add(
    config ? { id: "project.config", status: "ok", message: `Worker config ${config}` } : { id: "project.config", status: "error", message: "No wrangler.jsonc", fix: "Run `actors init --adopt` or add one." }
  );
  add(
    existsSync2(join2(root, ".claude", "skills", "verify", "SKILL.md")) ? { id: "project.verify-skill", status: "ok", message: "Project verify skill present" } : {
      id: "project.verify-skill",
      status: "warn",
      message: "No .claude/skills/verify/SKILL.md, so sessions without the plugin won't run `npm run verify` before commits",
      fix: "Run `actors init --adopt` to add it (existing .claude/ files are never overwritten)."
    }
  );
  const settingsPath = join2(root, ".claude", "settings.json");
  const ask = readJson(settingsPath)?.permissions?.ask ?? [];
  const missing = askRules().filter((r) => !ask.includes(r));
  if (!existsSync2(settingsPath)) {
    add({
      id: "project.permissions",
      status: "warn",
      message: "No .claude/settings.json: deploy and remote-write commands won't prompt",
      fix: "Run `actors init --adopt` to create it."
    });
  } else if (missing.length > 0) {
    add({
      id: "project.permissions",
      status: "warn",
      message: `.claude/settings.json lacks ${missing.length} ask rule(s): ${missing.join(", ")}`,
      fix: "Add them to permissions.ask; `actors init --adopt` prints the full list."
    });
  } else {
    add({ id: "project.permissions", status: "ok", message: "Deploy and remote-write commands require approval" });
  }
  if (existsSync2(join2(root, "system.ts")) && readFileSync2(join2(root, "system.ts"), "utf8").trim() === "") {
    add({ id: "project.declaration", status: "error", message: "system.ts is empty" });
  }
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5e3 });
  return r.status === 0 ? r.stdout : null;
}
function parse(v) {
  return v.split(".").map(Number);
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}
function icon(s) {
  return { ok: "\u2713", warn: "!", error: "\u2717", info: "\xB7" }[s];
}

// src/cli/output.ts
function toJson(command, data) {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, toolkitVersion: VERSION, ...data }, null, 2)}
`;
}
var UsageError = class extends Error {
};

// src/cli/main.ts
var HELP = `actors ${VERSION}: conventions, checks, and inspection for actor systems on Cloudflare

Usage: actors <command> [options]

Commands:
  doctor            Check the environment, project, pins, and Cloudflare tooling

Options:
  --json            Print machine-readable output (with schemaVersion)
  -h, --help        Show help
  -v, --version     Show the toolkit version

Read-only commands never contact Cloudflare. Deploys belong to wrangler, after a person approves.`;
var commands = {
  doctor: ({ cwd }) => doctor(cwd)
};
async function main(argv, io = { out: process.stdout, err: process.stderr, cwd: process.cwd() }) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" }
      }
    });
    const [name, ...rest] = positionals;
    if (values.version) {
      io.out.write(`${VERSION}
`);
      return 0;
    }
    if (!name || values.help) {
      io.out.write(`${HELP}
`);
      return name || values.help ? 0 : 2;
    }
    const handler = commands[name];
    if (!handler) throw new UsageError(`unknown command "${name}"`);
    const json = values.json === true;
    const result = await handler({ positionals: rest, json, cwd: io.cwd });
    io.out.write(json ? toJson(name, result.data) : `${result.text}
`);
    return result.exitCode;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err.write(`actors: ${err.message}
Run \`actors --help\` for usage.
`);
      return 2;
    }
    io.err.write(`actors: internal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}
`);
    return 70;
  }
}

// src/cli/bin.ts
process.exitCode = await main(process.argv.slice(2));
