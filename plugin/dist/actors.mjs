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
function readJsonc(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
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

// src/cli/commands/model.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { readFileSync as readFileSync4, writeFileSync } from "node:fs";
import { join as join4, relative, resolve as resolve3 } from "node:path";

// src/cli/output.ts
var VOLATILE = {
  doctor: ["projectRoot", "findings[].message"],
  default: ["projectRoot"]
};
function toJson(command, data) {
  const volatile = VOLATILE[command] ?? VOLATILE.default;
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, toolkitVersion: VERSION, volatile, ...data }, null, 2)}
`;
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortKeys(value[k])])
    );
  }
  return value;
}
var UsageError = class extends Error {
};

// src/system.ts
var SYSTEM_BRAND = "actors-toolkit/system@1";
function isSystem(value) {
  return typeof value === "object" && value !== null && value.kind === SYSTEM_BRAND;
}
function durationMs(d) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(d);
  if (!m) return null;
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
  return Math.round(Number(m[1]) * unit);
}

// src/model/manifest.ts
var MANIFEST_FILE = "actors.manifest.json";
var MANIFEST_SCHEMA_VERSION = 1;
var byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
var routeKey = (r) => `${r.from}\0${r.message}\0${r.to}`;
function normalize(system) {
  const routes = (system.routes ?? []).map((r) => ({ from: String(r.from), message: String(r.message), to: String(r.to) })).sort((a, b) => routeKey(a) < routeKey(b) ? -1 : routeKey(a) > routeKey(b) ? 1 : 0);
  const actors = Object.entries(system.actors ?? {}).map(([name, a]) => ({
    name,
    binding: a.binding,
    kind: a.kind,
    purpose: a.purpose ?? "",
    justification: [...a.justification ?? []].sort(),
    schedule: a.schedule ? { every: a.schedule.every, everyMs: durationMs(a.schedule.every), message: a.schedule.message } : null,
    effects: [...a.effects ?? []].sort(),
    budget: a.budget ? { maxAttempts: a.budget.maxAttempts, timeoutMs: a.budget.timeoutMs, maxTokens: a.budget.maxTokens ?? null } : null,
    receives: [...new Set(routes.filter((r) => r.to === name).map((r) => r.message))].sort(),
    sends: [...new Set(routes.filter((r) => r.from === name).map((r) => r.message))].sort()
  })).sort(byName);
  const messages = Object.entries(system.messages ?? {}).map(([name, m]) => ({ name, version: m.version, description: m.description ?? "", payload: jsonSchemaOf(m.payload) })).sort(byName);
  const effects = Object.entries(system.effects ?? {}).map(([name, e]) => ({
    name,
    description: e.description ?? "",
    idempotency: e.idempotency,
    reconcile: e.reconcile ?? false,
    approval: e.approval ?? "none"
  })).sort(byName);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    $comment: "Derived from system.ts by `actors graph --write`. Do not edit; `actors check` fails when it is stale.",
    system: { name: system.name, description: system.description ?? "" },
    actors: sortKeys(actors),
    messages: sortKeys(messages),
    routes,
    effects: sortKeys(effects)
  };
}
function jsonSchemaOf(schema) {
  const std = schema?.["~standard"];
  if (!std?.jsonSchema) return null;
  try {
    return sortKeys(std.jsonSchema.input({ target: "draft-2020-12" }));
  } catch {
    return null;
  }
}
function serializeManifest(m) {
  const { $comment, schemaVersion, system, actors, messages, routes, effects } = m;
  return `${JSON.stringify({ $comment, schemaVersion, system, actors, messages, routes, effects }, null, 2)}
`;
}

// src/model/check.ts
var ACTOR_NAME = /^[A-Z][A-Za-z0-9]*$/;
var MESSAGE_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
var EXTERNAL = /* @__PURE__ */ new Set(["@clock", "@ingress"]);
function checkProject(project) {
  const out = [];
  const add = (severity, code, subject, message, fix = null) => out.push({ code, severity, subject, message, fix });
  if (project.loadError || !project.system || !project.manifest) {
    add("error", "DECLARATION_LOAD_FAILED", "system.ts", project.loadError ?? "system.ts did not load");
    return sortDiagnostics(out);
  }
  const m = project.manifest;
  const system = project.system;
  const actors = new Map(m.actors.map((a) => [a.name, a]));
  const messages = new Map(m.messages.map((x) => [x.name, x]));
  const effects = new Map(m.effects.map((e) => [e.name, e]));
  for (const a of m.actors) {
    if (!ACTOR_NAME.test(a.name)) add("error", "NAME_INVALID", a.name, `Actor name "${a.name}" must be a PascalCase class name`);
    if (a.justification.length === 0)
      add("error", "ACTOR_UNJUSTIFIED", a.name, `${a.name} lists no justification for being an actor`, "Name which of identity, state, lifecycle, isolation, scheduling, or permissions applies, or make it a function.");
    if ((a.kind === "agent" || a.kind === "model-assisted") && !a.budget)
      add("error", "ACTOR_BUDGET_MISSING", a.name, `${a.name} is ${a.kind} but declares no budget`, "Add budget: { maxAttempts, timeoutMs } so model work is bounded.");
    if (a.schedule) {
      if (a.schedule.everyMs === null) add("error", "SCHEDULE_INVALID", a.name, `schedule.every "${a.schedule.every}" isn't a duration like 15m`);
      if (!m.routes.some((r) => r.from === "@clock" && r.to === a.name && r.message === a.schedule.message))
        add("error", "SCHEDULE_ROUTE_MISSING", a.name, `${a.name} schedules ${a.schedule.message} but no route delivers it from @clock`, `Add { from: "@clock", message: "${a.schedule.message}", to: "${a.name}" }.`);
    }
    for (const e of a.effects)
      if (!effects.has(e)) add("error", "EFFECT_UNDECLARED", a.name, `${a.name} requests effect "${e}", which the system doesn't declare`, "Declare it under effects, with its idempotency, or remove it.");
    if (a.receives.length === 0)
      add("warning", "ACTOR_UNREACHABLE", a.name, `No route delivers anything to ${a.name}, so nothing can ever activate it`);
  }
  const bindings = /* @__PURE__ */ new Map();
  for (const a of m.actors) bindings.set(a.binding, [...bindings.get(a.binding) ?? [], a.name]);
  for (const [b, names] of bindings) if (names.length > 1) add("error", "BINDING_DUPLICATE", b, `Binding ${b} is used by ${names.join(" and ")}`);
  for (const msg of m.messages) {
    if (!MESSAGE_NAME.test(msg.name)) add("error", "NAME_INVALID", msg.name, `Message name "${msg.name}" must be lowercase and dotted, like release.observed`);
    if (!Number.isInteger(msg.version) || msg.version < 1) add("error", "MESSAGE_VERSION_INVALID", msg.name, `${msg.name} version must be a positive integer`);
    const schema = system.messages[msg.name]?.payload;
    if (!schema?.["~standard"]) add("error", "MESSAGE_SCHEMA_INVALID", msg.name, `${msg.name} payload isn't a Standard Schema (zod 4, valibot, arktype, ...)`);
    else if (!msg.payload) add("warning", "PAYLOAD_SCHEMA_OPAQUE", msg.name, `${msg.name} payload can't be exported as JSON Schema, so diffs can't classify its changes`);
    if (!m.routes.some((r) => r.message === msg.name)) add("warning", "MESSAGE_UNUSED", msg.name, `${msg.name} is declared but no route carries it`);
  }
  const seen = /* @__PURE__ */ new Set();
  for (const r of m.routes) {
    const label = `${r.from} \u2192 ${r.message} \u2192 ${r.to}`;
    if (seen.has(label)) add("error", "ROUTE_DUPLICATE", label, `Route ${label} is declared twice`);
    seen.add(label);
    if (r.from.startsWith("@") && !EXTERNAL.has(r.from)) add("error", "ROUTE_INVALID_SENDER", label, `${r.from} isn't a sender; use @clock, @ingress, or an actor`);
    else if (!r.from.startsWith("@") && !actors.has(r.from)) add("error", "ROUTE_UNKNOWN_ACTOR", label, `Route sender ${r.from} isn't a declared actor`);
    if (!actors.has(r.to)) add("error", "ROUTE_UNKNOWN_ACTOR", label, `Route receiver ${r.to} isn't a declared actor`);
    if (!messages.has(r.message)) add("error", "ROUTE_UNKNOWN_MESSAGE", label, `Route message ${r.message} isn't declared`);
    if (r.from === "@clock" && actors.get(r.to)?.schedule?.message !== r.message)
      add("error", "CLOCK_ROUTE_WITHOUT_SCHEDULE", label, `@clock delivers ${r.message} to ${r.to}, but ${r.to} has no schedule for it`);
  }
  for (const e of m.effects) {
    if (!m.actors.some((a) => a.effects.includes(e.name))) add("warning", "EFFECT_UNUSED", e.name, `Effect ${e.name} is declared but no actor may request it`);
    if (e.idempotency === "none" && !e.reconcile)
      add("warning", "EFFECT_IN_DOUBT", e.name, `${e.name} has no idempotency key and no reconciliation: an attempt whose acknowledgment is lost is in doubt and must be reported as in_doubt, never retried blindly or reported as delivered`);
  }
  for (const cycle of findCycles(m)) add("warning", "ROUTE_CYCLE", cycle.join(" \u2192 "), `Messages can loop: ${cycle.join(" \u2192 ")}. Make sure handlers terminate and dedupe redeliveries.`);
  checkConfig(project, m, add);
  checkManifest(project, m, add);
  return sortDiagnostics(out);
}
function checkConfig(project, m, add) {
  if (!project.config) {
    add("error", "CONFIG_MISSING", "wrangler.jsonc", project.configFile ? `${project.configFile} doesn't parse` : "No wrangler.jsonc next to system.ts", "Add one; `actors init --adopt` writes the Durable Object bindings and exports the declaration needs.");
    return;
  }
  const cfg = project.config;
  const bindings = cfg.durable_objects?.bindings ?? [];
  const legacy = Array.isArray(cfg.migrations) && cfg.migrations.length > 0;
  if (legacy) add("warning", "CONFIG_LEGACY_MIGRATIONS", project.configFile, "wrangler config uses the legacy migrations array; Cloudflare's declarative exports map is the current flow", "Move Durable Object classes to exports (see docs/decisions/0006).");
  const legacyClasses = new Set(
    (cfg.migrations ?? []).flatMap((x) => [...x.new_sqlite_classes ?? [], ...x.new_classes ?? []])
  );
  for (const a of m.actors) {
    const b = bindings.find((x) => x.name === a.binding);
    if (!b) add("error", "CONFIG_BINDING_MISSING", a.name, `wrangler config has no Durable Object binding ${a.binding} for ${a.name}`, `Add { "name": "${a.binding}", "class_name": "${a.name}" } to durable_objects.bindings.`);
    else if (b.class_name !== a.name) add("error", "CONFIG_BINDING_CLASS_MISMATCH", a.name, `Binding ${a.binding} points at class ${b.class_name}, not ${a.name}`);
    const exp = cfg.exports?.[a.name];
    const live = exp && exp.type === "durable-object" && (exp.state ?? "created") === "created";
    if (!live && !legacyClasses.has(a.name))
      add("error", "CONFIG_EXPORT_MISSING", a.name, `wrangler config doesn't declare ${a.name} as a live Durable Object export`, `Add "exports": { "${a.name}": { "type": "durable-object", "storage": "sqlite" } }.`);
    if (project.entryExports && !project.entryExports.has(a.name))
      add("error", "ENTRY_EXPORT_MISSING", a.name, `The Worker entry (${project.entryFile}) doesn't export class ${a.name}`, `Export it, for example: export { ${a.name} } from "./actors/...";`);
  }
  if (!project.entryExports) add("error", "ENTRY_MISSING", project.configFile, "wrangler config has no main entry file, or it doesn't exist");
  const declared = new Set(m.actors.map((a) => a.binding));
  for (const b of bindings)
    if (!declared.has(b.name)) add("warning", "CONFIG_UNDECLARED_DO", b.name, `Durable Object binding ${b.name} (${b.class_name}) isn't in system.ts; it's an escape hatch the checks can't see`);
}
function checkManifest(project, m, add) {
  if (project.committedManifestRaw === null) {
    add("warning", "MANIFEST_MISSING", MANIFEST_FILE, `No ${MANIFEST_FILE}; \`actors diff\` uses the committed copy as its base`, "Run `actors graph --write` and commit it.");
  } else if (project.committedManifestRaw !== serializeManifest(m)) {
    add("error", "MANIFEST_STALE", MANIFEST_FILE, `${MANIFEST_FILE} doesn't match system.ts`, "Run `actors graph --write` and commit the result.");
  }
}
function findCycles(m) {
  const edges = /* @__PURE__ */ new Map();
  for (const r of m.routes) if (!r.from.startsWith("@")) edges.set(r.from, (edges.get(r.from) ?? /* @__PURE__ */ new Set()).add(r.to));
  const cycles = [];
  const names = [...edges.keys()].sort();
  for (const start of names) {
    const stack = [start];
    const walk = (node) => {
      for (const next of [...edges.get(node) ?? []].sort()) {
        if (next === start) cycles.push([...stack, start]);
        else if (next > start && !stack.includes(next)) {
          stack.push(next);
          walk(next);
          stack.pop();
        }
      }
    };
    walk(start);
  }
  return cycles;
}
function sortDiagnostics(d) {
  const rank = (x) => x.severity === "error" ? 0 : 1;
  const cmp = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  return d.sort((a, b) => rank(a) - rank(b) || cmp(a.code, b.code) || cmp(a.subject ?? "", b.subject ?? "") || cmp(a.message, b.message));
}

// src/model/diff.ts
var EMPTY_MANIFEST = {
  schemaVersion: 1,
  $comment: "",
  system: { name: "", description: "" },
  actors: [],
  messages: [],
  routes: [],
  effects: []
};
function diffManifests(base, head) {
  const changes = [];
  const add = (kind, subject, compatibility, detail, opts = {}) => changes.push({ kind, subject, compatibility, requiresApproval: opts.approval ?? false, irreversible: opts.irreversible ?? false, detail });
  diffKeyed(base.actors, head.actors, {
    added: (a) => add("actor.added", a.name, "compatible", `New actor ${a.name} (${a.kind}); its namespace is provisioned on the next deploy`),
    removed: (a) => add("actor.removed", a.name, "breaking", `Removing ${a.name} retires its Durable Object class: a deleted export destroys all its stored data permanently`, {
      approval: true,
      irreversible: true
    }),
    changed: (b, h) => diffActor(b, h, add)
  });
  diffKeyed(base.messages, head.messages, {
    added: (m) => add("message.added", m.name, "compatible", `New message ${m.name}@${m.version}`),
    removed: (m) => add("message.removed", m.name, "breaking", `${m.name} is gone; copies already in flight will be rejected after the deploy`),
    changed: (b, h) => diffMessage(b, h, add)
  });
  const key = (r) => `${r.from} \u2192 ${r.message} \u2192 ${r.to}`;
  const baseRoutes = new Set(base.routes.map(key));
  const headRoutes = new Set(head.routes.map(key));
  for (const r of head.routes) if (!baseRoutes.has(key(r))) add("route.added", key(r), "compatible", `New route ${key(r)}`);
  for (const r of base.routes)
    if (!headRoutes.has(key(r))) add("route.removed", key(r), "breaking", `Route removed; in-flight ${r.message} from ${r.from} to ${r.to} will be refused as unauthorized after the deploy`);
  diffKeyed(base.effects, head.effects, {
    added: (e) => add("effect.added", e.name, "risky", `New external effect ${e.name} (idempotency: ${e.idempotency}); a person must approve the new capability`, { approval: true }),
    removed: (e) => add("effect.removed", e.name, "compatible", `Effect ${e.name} removed`),
    changed: (b, h) => diffEffect(b, h, add)
  });
  if (base.system.name && base.system.name !== head.system.name) add("system.renamed", head.system.name, "risky", `System renamed from ${base.system.name}`);
  const order = (c) => `${c.kind}\0${c.subject}\0${c.detail}`;
  changes.sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0);
  return {
    changes,
    summary: {
      total: changes.length,
      breaking: changes.filter((c) => c.compatibility === "breaking").length,
      risky: changes.filter((c) => c.compatibility === "risky").length,
      requiresApproval: changes.some((c) => c.requiresApproval || c.irreversible),
      irreversible: changes.some((c) => c.irreversible)
    },
    plan: plan(changes, head)
  };
}
function diffKeyed(base, head, on) {
  const b = new Map(base.map((x) => [x.name, x]));
  const h = new Map(head.map((x) => [x.name, x]));
  for (const [name, x] of h) {
    const old = b.get(name);
    if (!old) on.added(x);
    else if (JSON.stringify(old) !== JSON.stringify(x)) on.changed(old, x);
  }
  for (const [name, x] of b) if (!h.has(name)) on.removed(x);
}
function diffActor(b, h, add) {
  const s = h.name;
  if (b.binding !== h.binding) add("actor.binding", s, "breaking", `Binding renamed ${b.binding} \u2192 ${h.binding}; wrangler.jsonc and every env reference must change together`);
  if (b.kind !== h.kind) add("actor.kind", s, "risky", `Kind ${b.kind} \u2192 ${h.kind}${h.kind !== "deterministic" ? ": its output is no longer deterministic" : ""}`);
  if (JSON.stringify(b.schedule) !== JSON.stringify(h.schedule))
    add("actor.schedule", s, "risky", `Schedule ${b.schedule ? `${b.schedule.message} every ${b.schedule.every}` : "none"} \u2192 ${h.schedule ? `${h.schedule.message} every ${h.schedule.every}` : "none"}`);
  for (const e of h.effects.filter((e2) => !b.effects.includes(e2))) add("actor.effect.added", `${s} \u2192 ${e}`, "risky", `${s} may now request external effect ${e}`, { approval: true });
  for (const e of b.effects.filter((e2) => !h.effects.includes(e2))) add("actor.effect.removed", `${s} \u2192 ${e}`, "compatible", `${s} no longer requests ${e}`);
  if (JSON.stringify(b.budget) !== JSON.stringify(h.budget)) add("actor.budget", s, "risky", `Model budget ${JSON.stringify(b.budget)} \u2192 ${JSON.stringify(h.budget)}`);
  if (b.purpose !== h.purpose || JSON.stringify(b.justification) !== JSON.stringify(h.justification))
    add("actor.described", s, "compatible", "Purpose or justification changed");
}
function diffMessage(b, h, add) {
  const s = h.name;
  if (b.version !== h.version) {
    add("message.version", s, "risky", `${s} version ${b.version} \u2192 ${h.version}: copies of v${b.version} in flight will be refused unless outboxes drain before the deploy`);
    return;
  }
  if (b.description !== h.description && JSON.stringify(b.payload) === JSON.stringify(h.payload)) {
    add("message.described", s, "compatible", "Description changed");
    return;
  }
  for (const finding of comparePayload(b.payload, h.payload)) {
    add("message.payload", s, finding.compatibility, finding.compatibility === "breaking" ? `${finding.detail}; bump the version or keep accepting the old shape` : finding.detail);
  }
}
function diffEffect(b, h, add) {
  const s = h.name;
  if (b.idempotency !== h.idempotency)
    add("effect.idempotency", s, "risky", `Idempotency ${b.idempotency} \u2192 ${h.idempotency}${h.idempotency === "none" ? ": unacknowledged attempts become in doubt" : ""}`);
  if (b.approval !== h.approval) add("effect.approval", s, "risky", `Approval ${b.approval} \u2192 ${h.approval}`, { approval: h.approval === "none" });
  if (b.reconcile !== h.reconcile) add("effect.reconcile", s, "risky", `Reconciliation ${b.reconcile} \u2192 ${h.reconcile}`);
}
function comparePayload(oldS, newS, path = "payload") {
  if (JSON.stringify(oldS) === JSON.stringify(newS)) return [];
  if (!oldS || !newS) return [{ compatibility: "risky", detail: `${path} schema changed, and one side can't be exported as JSON Schema` }];
  const out = [];
  const ot = oldS.type;
  const nt = newS.type;
  if (JSON.stringify(ot) !== JSON.stringify(nt)) return [{ compatibility: "breaking", detail: `${path} type ${JSON.stringify(ot)} \u2192 ${JSON.stringify(nt)}` }];
  if (Array.isArray(oldS.enum) || Array.isArray(newS.enum)) {
    const before = oldS.enum ?? [];
    const after = new Set((newS.enum ?? []).map((v) => JSON.stringify(v)));
    const lost = before.filter((v) => !after.has(JSON.stringify(v)));
    if (lost.length) out.push({ compatibility: "breaking", detail: `${path} no longer accepts ${lost.map((v) => JSON.stringify(v)).join(", ")}` });
    else out.push({ compatibility: "compatible", detail: `${path} accepts additional values` });
    return out;
  }
  if (ot === "object") {
    const op = oldS.properties ?? {};
    const np = newS.properties ?? {};
    const oreq = new Set(oldS.required ?? []);
    const nreq = new Set(newS.required ?? []);
    for (const k of Object.keys(np).sort()) {
      if (!(k in op)) {
        out.push(nreq.has(k) ? { compatibility: "breaking", detail: `${path}.${k} is a new required property` } : { compatibility: "compatible", detail: `${path}.${k} is a new optional property` });
      } else {
        if (!oreq.has(k) && nreq.has(k)) out.push({ compatibility: "breaking", detail: `${path}.${k} became required` });
        if (oreq.has(k) && !nreq.has(k)) out.push({ compatibility: "compatible", detail: `${path}.${k} became optional` });
        out.push(...comparePayload(op[k] ?? null, np[k] ?? null, `${path}.${k}`));
      }
    }
    for (const k of Object.keys(op).sort()) if (!(k in np)) out.push({ compatibility: "compatible", detail: `${path}.${k} was removed (old copies still pass; the field is ignored)` });
    const rest = (s) => JSON.stringify({ ...s, properties: void 0, required: void 0 });
    if (rest(oldS) !== rest(newS)) out.push({ compatibility: "risky", detail: `${path} object constraints changed (for example additionalProperties)` });
    return out;
  }
  return [{ compatibility: "risky", detail: `${path} constraints changed (${JSON.stringify(oldS)} \u2192 ${JSON.stringify(newS)})` }];
}
function plan(changes, head) {
  const steps = [{ kind: "verify", text: "Run `actors check` and `npm run verify`; deploy nothing unless both pass." }];
  for (const c of changes.filter((c2) => c2.kind === "actor.added")) {
    const a = head.actors.find((x) => x.name === c.subject);
    steps.push({
      kind: "config",
      text: `Declare ${c.subject} in wrangler.jsonc: binding { "name": "${a?.binding}", "class_name": "${c.subject}" } and exports.${c.subject} = { "type": "durable-object", "storage": "sqlite" } (\`actors check\` confirms both).`
    });
  }
  for (const c of changes.filter((c2) => c2.kind === "actor.removed")) {
    steps.push({
      kind: "irreversible",
      text: `IRREVERSIBLE: retiring ${c.subject} means exports.${c.subject}.state = "deleted", which destroys all its stored data with no trash. Export anything worth keeping first. If this is a rename, use state "renamed" with renamed_to instead, which keeps the data. Needs explicit approval.`
    });
  }
  const drains = changes.filter((c) => c.compatibility === "breaking" && (c.kind.startsWith("message") || c.kind === "route.removed"));
  if (drains.length)
    steps.push({
      kind: "drain",
      text: `Drain first: changes to ${drains.map((c) => c.subject).join(", ")} affect what in-flight messages may look like or where they may go. Deploy when outboxes are empty, or version the message and accept both shapes.`
    });
  const approvals = changes.filter((c) => c.requiresApproval && !c.irreversible);
  if (approvals.length) steps.push({ kind: "approval", text: `A person must approve: ${approvals.map((c) => c.detail).join("; ")}.` });
  if (changes.some((c) => c.kind === "actor.schedule")) steps.push({ kind: "schedule", text: "An alarm that is already set keeps its old time until it fires once under the new code." });
  if (changes.some((c) => c.kind === "actor.added" || c.kind === "actor.removed"))
    steps.push({
      kind: "lifecycle",
      text: "Durable Object lifecycle changes apply only through `wrangler deploy` (not `wrangler versions upload`); a later rollback can't cross them, and gradual deployment isn't available for them."
    });
  steps.push({ kind: "deploy", text: "Deploying is a person's decision. After approval, they run `npx wrangler deploy`; the toolkit never deploys." });
  return steps;
}

// src/model/load.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, statSync } from "node:fs";
import { dirname as dirname2, join as join3, resolve as resolve2 } from "node:path";
import { pathToFileURL } from "node:url";
async function loadProject(root) {
  const project = {
    root,
    system: null,
    manifest: null,
    loadError: null,
    config: null,
    configFile: null,
    entryFile: null,
    entryExports: null,
    committedManifest: null,
    committedManifestRaw: null
  };
  try {
    const mod = await import(pathToFileURL(join3(root, DECLARATION_FILE)).href);
    const candidate = mod.default ?? mod.system;
    if (!isSystem(candidate)) {
      project.loadError = "system.ts must `export default defineSystem({...})` from actors-toolkit/system";
    } else {
      project.system = candidate;
      project.manifest = normalize(candidate);
    }
  } catch (err) {
    project.loadError = explainLoadError(err);
  }
  for (const file of ["wrangler.jsonc", "wrangler.json"]) {
    if (existsSync3(join3(root, file))) {
      project.configFile = file;
      project.config = readJsonc(join3(root, file));
      break;
    }
  }
  if (project.config?.main) {
    project.entryFile = project.config.main;
    project.entryExports = collectExports(resolve2(root, project.config.main), /* @__PURE__ */ new Set());
  }
  const manifestPath = join3(root, MANIFEST_FILE);
  if (existsSync3(manifestPath)) {
    project.committedManifestRaw = readFileSync3(manifestPath, "utf8");
    project.committedManifest = readJson(manifestPath);
  }
  return project;
}
function explainLoadError(err) {
  const e = err;
  const msg = (e.message ?? String(err)).split("\n")[0] ?? "";
  if (e.code === "ERR_MODULE_NOT_FOUND") return `system.ts imports a module that isn't installed or doesn't exist: ${msg}. Run \`npm install\`, and use explicit .ts extensions for relative imports.`;
  if (e.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") return `system.ts uses TypeScript syntax Node can't strip (enums, namespaces, parameter properties): ${msg}`;
  if (/Cannot use import statement outside a module/.test(msg)) return `${msg}. Set "type": "module" in package.json.`;
  return `system.ts failed to load: ${msg}`;
}
var EXPORT_RE = /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|export\s*\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?|export\s*\*\s*from\s*["']([^"']+)["']/g;
function collectExports(file, seen) {
  const names = /* @__PURE__ */ new Set();
  if (seen.has(file) || !existsSync3(file) || !statSync(file).isFile()) return names;
  seen.add(file);
  const source = readFileSync3(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  for (const m of source.matchAll(EXPORT_RE)) {
    if (m[1]) names.add(m[1]);
    if (m[2] !== void 0) {
      for (const part of m[2].split(",")) {
        const spec = part.trim().replace(/^type\s+/, "");
        if (!spec || part.trim().startsWith("type ")) continue;
        const alias = spec.split(/\s+as\s+/).at(-1).trim();
        if (alias) names.add(alias);
      }
    }
    if (m[4]) {
      const target = resolveRelative(dirname2(file), m[4]);
      if (target) for (const n of collectExports(target, seen)) names.add(n);
    }
  }
  return names;
}
function resolveRelative(dir, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve2(dir, spec);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join3(base, "index.ts")]) {
    if (existsSync3(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// src/cli/commands/model.ts
var EXIT_NO_PROJECT = 3;
function noProject(cwd, data) {
  return {
    data: { ...data, projectRoot: null },
    text: `No actor project at ${cwd} (no system.ts with a package.json here or above).`,
    exitCode: EXIT_NO_PROJECT
  };
}
var RELEVANT = [/(^|\/)system\.ts$/, /(^|\/)src\/actors\//, /(^|\/)src\/messages\//, /(^|\/)wrangler\.jsonc?$/, /(^|\/)src\/index\.ts$/, new RegExp(`(^|/)${MANIFEST_FILE.replace(".", "\\.")}$`)];
async function check(cwd, opts) {
  const root = findProjectRoot(cwd);
  if (!root) return noProject(cwd, { skipped: true, ok: true, errors: 0, warnings: 0, diagnostics: [] });
  if (opts.changed && opts.changed.length > 0) {
    const touched = opts.changed.map((f) => relative(root, resolve3(cwd, f))).filter((f) => !f.startsWith(".."));
    if (!touched.some((f) => RELEVANT.some((re) => re.test(f)))) {
      return { data: { projectRoot: root, skipped: true, ok: true, errors: 0, warnings: 0, diagnostics: [] }, text: opts.format === "brief" ? "" : "No actor files changed; nothing to check.", exitCode: 0 };
    }
  }
  const project = await loadProject(root);
  const diagnostics = checkProject(project);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const data = { projectRoot: root, skipped: false, ok: errors === 0, errors, warnings, diagnostics };
  let text;
  if (opts.format === "brief") {
    text = diagnostics.filter((d) => d.severity === "error").map((d) => `actors check: ${d.code} ${d.subject ?? ""}: ${d.message}${d.fix ? ` (fix: ${d.fix})` : ""}`).join("\n");
  } else {
    const lines = diagnostics.map((d) => `${d.severity === "error" ? "\u2717" : "!"} ${d.code}${d.subject ? ` ${d.subject}` : ""}: ${d.message}${d.fix ? `
    fix: ${d.fix}` : ""}`);
    lines.push(`${errors === 0 ? "\u2713" : "\u2717"} ${project.manifest?.system.name ?? "system"}: ${errors} error(s), ${warnings} warning(s)`);
    text = lines.join("\n");
  }
  return { data, text, exitCode: errors === 0 ? 0 : 1 };
}
async function graph(cwd, opts) {
  const root = findProjectRoot(cwd);
  if (!root) return noProject(cwd, { manifest: null, written: null });
  const project = await loadProject(root);
  if (!project.manifest) return { data: { projectRoot: root, manifest: null, written: null }, text: `\u2717 ${project.loadError}`, exitCode: 1 };
  let written = null;
  if (opts.write) {
    writeFileSync(join4(root, MANIFEST_FILE), serializeManifest(project.manifest));
    written = MANIFEST_FILE;
  }
  const text = renderGraph(project.manifest) + (written ? `

wrote ${written}` : "");
  return { data: { projectRoot: root, manifest: project.manifest, written }, text, exitCode: 0 };
}
var count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
function renderGraph(m) {
  const ver = new Map(m.messages.map((x) => [x.name, x.version]));
  const width = Math.max(0, ...m.routes.map((r) => r.from.length));
  const lines = [
    `${m.system.name} \xB7 ${count(m.actors.length, "actor")} \xB7 ${count(m.routes.length, "route")} \xB7 ${count(m.messages.length, "message")} \xB7 ${count(m.effects.length, "effect")}`,
    "",
    "Routes",
    ...m.routes.map((r) => `  ${r.from.padEnd(width)}  \u2500\u2500${r.message}@${ver.get(r.message) ?? "?"}\u2500\u2500\u25B6  ${r.to}`),
    "",
    "Actors"
  ];
  for (const a of m.actors) {
    const facts = [a.kind, a.schedule ? `every ${a.schedule.every}` : null, a.effects.length ? `effects ${a.effects.join(", ")}` : null, `justified by ${a.justification.join(", ") || "nothing"}`].filter(Boolean);
    lines.push(`  ${a.name} (${a.binding}): ${facts.join(" \xB7 ")}`, `    ${a.purpose}`);
  }
  if (m.effects.length) {
    lines.push("", "Effects");
    for (const e of m.effects) lines.push(`  ${e.name}: idempotency ${e.idempotency}${e.reconcile ? ", reconcilable" : ""}, approval ${e.approval}. ${e.description}`);
  }
  return lines.join("\n");
}
async function diff(cwd, opts) {
  const root = findProjectRoot(cwd);
  if (!root) return noProject(cwd, { ...diffManifests(EMPTY_MANIFEST, EMPTY_MANIFEST), base: { source: "none", system: "" }, head: { system: "" }, notes: [] });
  const project = await loadProject(root);
  if (!project.manifest) return { data: { projectRoot: root, ...diffManifests(EMPTY_MANIFEST, EMPTY_MANIFEST), base: { source: "none", system: "" }, head: { system: "" }, notes: [project.loadError ?? ""] }, text: `\u2717 ${project.loadError}`, exitCode: 1 };
  const notes = [];
  let base = EMPTY_MANIFEST;
  let source = "none";
  if (opts.baseFile) {
    base = JSON.parse(readFileSync4(resolve3(cwd, opts.baseFile), "utf8"));
    source = `file:${opts.baseFile}`;
  } else {
    const ref = opts.base ?? "HEAD";
    const fromGit = gitShow(root, ref, MANIFEST_FILE);
    if (fromGit) {
      base = JSON.parse(fromGit);
      source = `git:${ref}`;
    } else {
      notes.push(`No ${MANIFEST_FILE} at ${ref}; the whole system is shown as added. Commit the manifest (\`actors graph --write\`) to diff against it.`);
    }
  }
  const result = diffManifests(base, project.manifest);
  const data = { projectRoot: root, base: { source, system: base.system.name }, head: { system: project.manifest.system.name }, notes, ...result };
  return { data, text: renderDiff(data), exitCode: 0 };
}
function gitShow(root, ref, file) {
  const top = spawnSync2("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return null;
  const rel = relative(top.stdout.trim(), join4(root, file));
  const r = spawnSync2("git", ["-C", root, "show", `${ref}:${rel}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
function renderDiff(d) {
  const sign = (k) => k.endsWith(".added") ? "+" : k.endsWith(".removed") ? "-" : "~";
  const lines = [`actors diff: ${d.head.system} against ${d.base.source}`, ...d.notes.map((n) => `  note: ${n}`), ""];
  if (d.changes.length === 0) lines.push("  No architectural changes.");
  for (const c of d.changes) {
    const flags = [c.compatibility, c.requiresApproval ? "needs approval" : null, c.irreversible ? "IRREVERSIBLE" : null].filter(Boolean).join(", ");
    lines.push(`  ${sign(c.kind)} ${c.kind.padEnd(20)} ${c.subject}  [${flags}]`, `      ${c.detail}`);
  }
  lines.push("", "Deploy plan (a plan, not a deploy):", ...d.plan.map((s, i) => `  ${i + 1}. ${s.text}`));
  return lines.join("\n");
}

// src/cli/main.ts
var HELP = `actors ${VERSION}: conventions, checks, and inspection for actor systems on Cloudflare

Usage: actors <command> [options]

Commands:
  doctor                       Check the environment, project, pins, and Cloudflare tooling
  check [--changed <file>...]  Validate the declaration, routes, schemas, config, and manifest
        [--format brief]       (brief: hard errors only, silent when clean; for hooks)
  graph [--write]              Print the topology; --write updates actors.manifest.json
  diff [--base <ref>]          Classify architectural changes against the committed manifest
       [--base-file <path>]    (default base: HEAD) and print a deploy plan, never a deploy

Options:
  --json            Print machine-readable output (with schemaVersion)
  -h, --help        Show help
  -v, --version     Show the toolkit version

Exit status: 0 ok \xB7 1 hard errors \xB7 2 usage \xB7 3 not in an actor project.
Read-only commands never contact Cloudflare. Deploys belong to wrangler, after a person approves.`;
var str = (v) => typeof v === "string" ? v : void 0;
var commands = {
  doctor: ({ cwd }) => doctor(cwd),
  check: ({ cwd, values, positionals }) => check(cwd, { changed: [...values.changed ?? [], ...values.changed !== void 0 ? positionals : []], format: str(values.format) }),
  graph: ({ cwd, values }) => graph(cwd, { write: values.write === true }),
  diff: ({ cwd, values }) => diff(cwd, { base: str(values.base), baseFile: str(values["base-file"]) })
};
async function main(argv, io = { out: process.stdout, err: process.stderr, cwd: process.cwd() }) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: "boolean" },
        changed: { type: "string", multiple: true },
        format: { type: "string" },
        write: { type: "boolean" },
        base: { type: "string" },
        "base-file": { type: "string" },
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
    const result = await handler({ positionals: rest, json, cwd: io.cwd, values });
    io.out.write(json ? toJson(name, result.data) : result.text ? `${result.text}
` : "");
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
