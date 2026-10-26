// Release documentation and CI: the README is a landing page that gets each kind of user installed and points
// into the wiki; the wiki pages (sourced from docs/wiki/) cover install, update, uninstall, the CLI, the Room,
// trust, and limitations; CONTRIBUTING covers working on the repository; the architecture page links every
// decision; and CI runs the same offline lane as local development without credentials or model calls.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(`${root}${p}`, "utf8");
const readme = read("README.md");
const WIKI = "https://github.com/actor-systems/actord/wiki";
const wikiPages = readdirSync(`${root}docs/wiki`).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
const wiki = (page) => read(`docs/wiki/${page}.md`);

test("the README gets every kind of user started and points into the wiki", () => {
  for (const phrase of [
    "## Why actord", "## Get started",
    "claude plugin marketplace add actor-systems/actord", "claude plugin install actord@actord",
    "codex plugin marketplace add actor-systems/actord", "codex plugin add actord@actord",
    "npx @actord/toolkit init", "CONTRIBUTING.md", `${WIKI}/Getting-Started`, `${WIKI}/Trust-and-Safety`,
  ]) {
    assert.ok(readme.includes(phrase), `README lacks ${phrase}`);
  }
  // Every wiki page the README names exists.
  for (const [, page] of readme.matchAll(/github\.com\/actor-systems\/actord\/wiki\/([\w-]+)/g)) {
    assert.ok(wikiPages.includes(page), `README links a wiki page that doesn't exist: ${page}`);
  }
});

test("the wiki covers install, update, uninstall, the Room, trust, limitations, and evaluations", () => {
  for (const page of ["Home", "_Sidebar", "Getting-Started", "CLI", "Runtime", "The-Room", "Trust-and-Safety", "Limitations", "Evaluations"]) {
    assert.ok(wikiPages.includes(page), `docs/wiki lacks ${page}.md`);
  }
  for (const phrase of ["**Update.**", "**Uninstall.**", "claude plugin update actord@actord", "/reload-plugins", "**Update (Codex).**", "**Uninstall (Codex).**"]) {
    assert.ok(wiki("Getting-Started").includes(phrase), `Getting-Started lacks ${phrase}`);
  }
  // Links between pages resolve, and the sidebar reaches every page.
  for (const page of wikiPages) {
    for (const [, target] of wiki(page).matchAll(/\]\(([A-Z][\w-]*)\)/g)) {
      assert.ok(wikiPages.includes(target), `${page} links a page that doesn't exist: ${target}`);
    }
  }
  for (const page of wikiPages.filter((p) => !p.startsWith("_"))) {
    assert.ok(wiki("_Sidebar").includes(`](${page})`), `the sidebar doesn't link ${page}`);
  }
});

test("CONTRIBUTING covers setup, verification, evaluations, and releasing", () => {
  const contributing = read("CONTRIBUTING.md");
  for (const heading of ["## Setting up", "## Verifying a change", "## Making a change", "## Evaluations", "## Releasing"]) {
    assert.ok(contributing.includes(`\n${heading}\n`), `CONTRIBUTING lacks ${heading}`);
  }
  for (const phrase of ["npm run verify", "scripts/eval-suite.sh", "claude plugin tag plugins/claude", "scripts/publish-wiki.sh", "docs/architecture.md"]) {
    assert.ok(contributing.includes(phrase), `CONTRIBUTING lacks ${phrase}`);
  }
});

// One version for the toolkit and both plugins, and so one release tag (decision 0014).
test("the toolkit and every plugin share one version", () => {
  const versions = {
    "packages/toolkit/package.json": JSON.parse(read("packages/toolkit/package.json")).version,
    "plugins/claude/.claude-plugin/plugin.json": JSON.parse(read("plugins/claude/.claude-plugin/plugin.json")).version,
  };
  if (existsSync(`${root}plugins/codex/plugin.json`)) versions["plugins/codex/plugin.json"] = JSON.parse(read("plugins/codex/plugin.json")).version;
  assert.equal(new Set(Object.values(versions)).size, 1, `versions differ: ${JSON.stringify(versions)}`);
});

test("every CLI command in the help text has a row on the CLI wiki page", () => {
  const main = read("packages/toolkit/src/cli/main.ts");
  const help = main.slice(main.indexOf("Commands:"), main.indexOf("Options:"));
  const commands = [...help.matchAll(/^ {2}([a-z]+)\b/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 10);
  for (const c of commands) assert.ok(wiki("CLI").includes(`| \`actord ${c}`), `docs/wiki/CLI.md lacks actord ${c}`);
});

test("tables in the README, CONTRIBUTING, and the wiki aren't broken by blank lines", () => {
  for (const file of ["README.md", "CONTRIBUTING.md", ...wikiPages.map((p) => `docs/wiki/${p}.md`)]) {
    const lines = read(file).split("\n");
    for (let i = 1; i < lines.length - 1; i++) {
      if (lines[i] === "" && lines[i - 1].startsWith("|") && lines[i + 1].startsWith("|")) assert.fail(`blank line splits a table at ${file} line ${i + 1}`);
    }
  }
});

test("the architecture page links every decision", () => {
  const arch = read("docs/architecture.md");
  for (const f of readdirSync(`${root}docs/decisions`).filter((f) => f.endsWith(".md"))) {
    assert.ok(arch.includes(`decisions/${f}`), `docs/architecture.md doesn't link ${f}`);
  }
});

test("CI runs the offline lane from a clean checkout, with no secrets and no model-backed evals", () => {
  const ci = read(".github/workflows/verify.yml");
  for (const step of ["actions/checkout", "npm ci", "npm run verify", "git diff --exit-code -- plugins/claude/dist", "@anthropic-ai/claude-code@"]) {
    assert.ok(ci.includes(step), `CI lacks ${step}`);
  }
  assert.ok(!/secrets\./.test(ci), "CI must not use secrets");
  assert.ok(!/plugin eval/.test(ci), "CI must not run model-backed evals");
  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  assert.ok(existsSync(`${root}scripts/clean-checkout.sh`));
});
