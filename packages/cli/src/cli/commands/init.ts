// `actors init`: create a starter project in an empty directory, or `--adopt` an existing one by adding
// only what's missing. Never overwrites a file, and never touches existing `.claude/` files.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { askRules } from "../../patterns.ts";
import { claudeMd, settingsJson, starterFiles, verifySkill } from "../../templates/project.ts";
import { VERSION } from "../../version.ts";
import { type CommandResult, UsageError } from "../output.ts";
import { readJson } from "../project.ts";

export interface InitData {
  projectRoot: string;
  mode: "create" | "adopt";
  created: string[];
  skipped: string[];
  suggestions: string[];
  toolkit: string;
}

/** The tarball the plugin bundles next to dist/actors.mjs, until actors-toolkit is on npm. */
function bundledTarball(): string | null {
  const dirs = [process.env.ACTORS_PLUGIN_DIST];
  try {
    dirs.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // not running from a file
  }
  for (const dir of dirs) {
    const tgz = dir ? join(dir, `actors-toolkit-${VERSION}.tgz`) : null;
    if (tgz && existsSync(tgz)) return tgz;
  }
  return null;
}

export function init(cwd: string, target: string | undefined, opts: { adopt?: boolean; name?: string; toolkit?: string }): CommandResult<InitData> {
  const root = resolve(cwd, target ?? ".");
  const created: string[] = [];
  const skipped: string[] = [];
  const suggestions: string[] = [];
  const write = (rel: string, content: string) => {
    const path = join(root, rel);
    if (existsSync(path)) {
      skipped.push(rel);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    created.push(rel);
  };

  if (opts.adopt) {
    if (!existsSync(join(root, "package.json"))) throw new UsageError(`--adopt needs an existing project with a package.json at ${root}`);
    const name = opts.name ?? readJson<{ name?: string }>(join(root, "package.json"))?.name ?? basename(root);
    write(".claude/skills/verify/SKILL.md", verifySkill());
    write(".claude/settings.json", settingsJson());
    write("CLAUDE.md", claudeMd(name));
    if (skipped.includes(".claude/settings.json")) {
      const ask = readJson<{ permissions?: { ask?: string[] } }>(join(root, ".claude/settings.json"))?.permissions?.ask ?? [];
      const missing = askRules().filter((r) => !ask.includes(r));
      if (missing.length) suggestions.push(`.claude/settings.json exists, so it wasn't changed. Add these to permissions.ask:\n${missing.map((r) => `    "${r}"`).join(",\n")}`);
    }
    const pkg = readJson<{ scripts?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, "package.json"));
    if (!pkg?.scripts?.verify) suggestions.push(`Add a script to package.json: "verify": "actors verify"`);
    if (!pkg?.devDependencies?.["actors-toolkit"]) suggestions.push(`Pin the CLI so CI and Claude run the same version: npm install -D -E actors-toolkit@${VERSION}`);
    if (!existsSync(join(root, "actors.manifest.json"))) suggestions.push("Run `npx actors graph --write` and commit actors.manifest.json.");
    return result(root, "adopt", created, skipped, suggestions, "unchanged");
  }

  // A git repository and installed dependencies don't make a directory "taken".
  if (existsSync(root) && readdirSync(root).filter((e) => e !== ".git" && e !== "node_modules").length > 0) {
    throw new UsageError(`${root} isn't empty; init only creates projects in empty directories. To add the toolkit's files to an existing project, run \`actors init --adopt\`.`);
  }
  const name = (opts.name ?? basename(root)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "actor-system";
  let toolkit = opts.toolkit ?? VERSION;
  const tgz = opts.toolkit ? null : bundledTarball();
  if (tgz) {
    mkdirSync(join(root, "vendor"), { recursive: true });
    copyFileSync(tgz, join(root, "vendor", basename(tgz)));
    created.push(`vendor/${basename(tgz)}`);
    toolkit = `file:vendor/${basename(tgz)}`;
  }
  for (const [rel, content] of Object.entries(starterFiles(name, toolkit))) write(rel, content);
  suggestions.push("cd into the project, then: npm install && npx actors graph --write && npm run verify");
  return result(root, "create", created, skipped, suggestions, toolkit);
}

function result(root: string, mode: "create" | "adopt", created: string[], skipped: string[], suggestions: string[], toolkit: string): CommandResult<InitData> {
  const text = [
    `actors init (${mode}) at ${root}`,
    ...created.map((f) => `  + ${f}`),
    ...skipped.map((f) => `  = ${f} (exists; left unchanged)`),
    ...(suggestions.length ? ["", "Next:", ...suggestions.map((s) => `  ${s}`)] : []),
  ].join("\n");
  return { data: { projectRoot: root, mode, created, skipped, suggestions, toolkit }, text, exitCode: 0 };
}
