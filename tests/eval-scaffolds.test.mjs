// Static checks of the eval scaffolds (plugins/claude/evals/*/scaffold.sh), free and offline. Running every scaffold
// takes about a minute even in parallel (each clones node_modules), so this resolves what they reference instead:
// - every path a scaffold builds from its own directory, or from a variable derived from it, exists;
// - a `repo` or `root` variable is the repository root;
// - every project a scaffold names is one scripts/scaffold-project.sh builds;
// - every source patch applies to the example it patches.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, test } from "node:test";

const repo = resolve(import.meta.dirname, "..");
const evals = join(repo, "plugins/claude/evals");
const SELF = /\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)/g;
const tmp = mkdtempSync(join(tmpdir(), "actord-scaffolds-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** The projects scripts/scaffold-project.sh builds, from its usage line. */
function projects(root) {
  const usage = /scaffold-project\.sh <dest-dir> ([\w|-]+)/.exec(readFileSync(join(root, "scripts/scaffold-project.sh"), "utf8"));
  return new Set(usage?.[1].split("|") ?? []);
}

/**
 * What one script references: each `name="$(cd "<path>" && pwd)"` assignment, and each quoted absolute path once the
 * script's directory and those variables are substituted, with the bare word after it (a scaffold's project).
 */
export function references(file) {
  const vars = {};
  const sub = (s) => s.replace(SELF, dirname(file)).replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, v) => vars[v] ?? m);
  const assigned = [];
  const paths = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const line = sub(raw.trim());
    const assign = /^([A-Za-z_]\w*)="\$\(cd "([^"]+)" && pwd\)"$/.exec(line);
    if (assign) {
      vars[assign[1]] = resolve(assign[2]);
      assigned.push({ name: assign[1], path: vars[assign[1]] });
      continue;
    }
    for (const m of line.matchAll(/"(\/[^"]*)"(?:\s+([\w.-]+))?/g)) paths.push({ path: resolve(m[1]), arg: m[2] });
  }
  return { assigned, paths };
}

/** Everything wrong with a scaffold's references, following any script under the eval directory that it calls. */
export function problems(file, root, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const rel = (p) => relative(root, p) || ".";
  const out = [];
  const { assigned, paths } = references(file);
  for (const a of assigned)
    if (/^(repo|root)$/.test(a.name) && a.path !== root) out.push(`${rel(file)}: ${a.name} resolves to ${rel(a.path)}, not the repository root`);
  for (const p of paths) {
    if (!existsSync(p.path)) {
      out.push(`${rel(file)}: ${rel(p.path)} doesn't exist`);
      continue;
    }
    if (p.path.endsWith("/_scaffold/project.sh") && !projects(root).has(p.arg ?? ""))
      out.push(`${rel(file)}: scaffold-project.sh builds no project "${p.arg}"`);
    if (p.path.endsWith(".sh") && p.path.startsWith(join(root, "plugins/claude/evals"))) out.push(...problems(p.path, root, seen));
  }
  return out;
}

const cases = readdirSync(evals).filter((c) => existsSync(join(evals, c, "case.yaml")));
const scaffold = (c) => join(evals, c, /scaffold_script:\s*(\S+)/.exec(readFileSync(join(evals, c, "case.yaml"), "utf8"))[1]);

for (const c of cases) {
  test(`${c}: every path its scaffold references resolves`, () => {
    assert.deepEqual(problems(scaffold(c), repo), []);
  });

  // A patch runs against a fresh copy of the example it patches, exactly as the scaffold runs it after project.sh.
  const text = readFileSync(scaffold(c), "utf8");
  const patch = /python3 - <<'PY'\n([\s\S]*?)\nPY\n/.exec(text)?.[1];
  if (patch) {
    test(`${c}: its source patch applies to the example`, () => {
      const project = references(scaffold(c)).paths.find((p) => p.path.endsWith("/_scaffold/project.sh"))?.arg;
      assert.ok(project && existsSync(join(repo, "examples", project)), "a patching scaffold patches an example");
      const dir = join(tmp, c);
      const skip = /(^|\/)(node_modules|\.wrangler|\.actord)(\/|$)/;
      cpSync(join(repo, "examples", project), dir, { recursive: true, filter: (src) => !skip.test(relative(join(repo, "examples", project), src)) });
      const r = spawnSync("python3", ["-"], { cwd: dir, input: patch, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  }
}

// The bug this file exists for: after the move to plugins/claude/ (d4103b5), _scaffold/project.sh still climbed
// three levels, to plugins/, and every scaffold that builds a project failed.
test("catches a shared scaffold that resolves the repository one level short", () => {
  const root = join(tmp, "fake-repo");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/scaffold-project.sh"), "#   scaffold-project.sh <dest-dir> starter|deps\n");
  const shared = join(root, "plugins/claude/evals/_scaffold/project.sh");
  mkdirSync(dirname(shared), { recursive: true });
  const body = (up) =>
    `#!/usr/bin/env bash\nset -euo pipefail\nhere="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\nrepo="$(cd "$here/${up}" && pwd)"\n"$repo/scripts/scaffold-project.sh" "$PWD" "$@" >/dev/null\n`;
  writeFileSync(shared, body("../../.."));
  assert.deepEqual(problems(shared, root), [
    "plugins/claude/evals/_scaffold/project.sh: repo resolves to plugins, not the repository root",
    "plugins/claude/evals/_scaffold/project.sh: plugins/scripts/scaffold-project.sh doesn't exist",
  ]);
  writeFileSync(shared, body("../../../.."));
  assert.deepEqual(problems(shared, root), []);
});
