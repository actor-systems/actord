// Release documentation and CI: the README covers what a user needs (install, update, uninstall, the Room,
// trust, limitations), the architecture page links every decision, and CI runs the same offline lane as
// local development without credentials or model calls.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(`${root}${p}`, "utf8");
const readme = read("README.md");

test("the README has every section a user needs", () => {
  for (const heading of ["## Install", "## The `actors` CLI", "## The Room", "## Trust and safety", "## Limitations and unverified claims", "## Evaluations", "## Developing this repository"]) {
    assert.ok(readme.includes(`\n${heading}\n`), `README lacks ${heading}`);
  }
  for (const phrase of ["**Update.**", "**Uninstall.**", "claude plugin install actors@actors-toolkit", "claude plugin update actors@actors-toolkit", "/reload-plugins", "docs/architecture.md"]) {
    assert.ok(readme.includes(phrase), `README lacks ${phrase}`);
  }
});

test("every CLI command in the help text has a README row", () => {
  const main = read("packages/cli/src/cli/main.ts");
  const help = main.slice(main.indexOf("Commands:"), main.indexOf("Options:"));
  const commands = [...help.matchAll(/^ {2}([a-z]+)\b/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 10);
  for (const c of commands) assert.ok(readme.includes(`| \`actors ${c}`), `README's CLI table lacks actors ${c}`);
});

test("README tables aren't broken by blank lines", () => {
  const lines = readme.split("\n");
  for (let i = 1; i < lines.length - 1; i++) {
    if (lines[i] === "" && lines[i - 1].startsWith("|") && lines[i + 1].startsWith("|")) assert.fail(`blank line splits a table at README line ${i + 1}`);
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
  for (const step of ["actions/checkout", "npm ci", "npm run verify", "git diff --exit-code -- plugin/dist", "@anthropic-ai/claude-code@"]) {
    assert.ok(ci.includes(step), `CI lacks ${step}`);
  }
  assert.ok(!/secrets\./.test(ci), "CI must not use secrets");
  assert.ok(!/plugin eval/.test(ci), "CI must not run model-backed evals");
  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  assert.ok(existsSync(`${root}scripts/clean-checkout.sh`));
});
