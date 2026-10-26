// The charter's skill and agent authoring rules, enforced on the shipped plugins/claude/ directory.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const plugin = new URL("../plugins/claude/", import.meta.url).pathname;
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "missing frontmatter");
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2];
  }
  return { fields, body: text.slice(m[0].length) };
};
// Directories only: Finder drops .DS_Store files here (ignored by git, never shipped).
const skills = readdirSync(join(plugin, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const FORBIDDEN = /deploy|secret|publish|login|\bcurl\b|\bwget\b|npm install|--remote|wrangler/i;

test("the plugin ships the seven skills and two critics the charter names", () => {
  assert.deepEqual(skills.sort(), ["design", "evolve", "implement", "inspect", "reliability", "setup", "start"]);
  assert.deepEqual(readdirSync(join(plugin, "agents")).filter((f) => !f.startsWith(".")).sort(), ["boundary-critic.md", "delivery-auditor.md"]);
});

for (const name of skills) {
  const text = readFileSync(join(plugin, "skills", name, "SKILL.md"), "utf8");
  const { fields, body } = frontmatter(text);
  test(`${name}: narrow description under the listing cap, concise body`, () => {
    assert.equal(fields.name, name);
    assert.ok(fields.description && fields.description.length > 80, "description too short to trigger well");
    assert.ok((fields.description + (fields.when_to_use ?? "")).length <= 1536, "description + when_to_use over 1,536 characters");
    assert.ok(text.split("\n").length < 500, "SKILL.md must stay well under 500 lines");
  });
  test(`${name}: allowed-tools never names deploy, secret, publish, or network commands`, () => {
    assert.doesNotMatch(fields["allowed-tools"] ?? "", FORBIDDEN);
  });
  test(`${name}: every injected command tolerates failure and is pre-approved`, () => {
    const injected = [...body.matchAll(/(?:^|\s)!`([^`]+)`/g)].map((m) => m[1]);
    const allowed = [...(fields["allowed-tools"] ?? "").matchAll(/Bash\(([^)]*)\)/g)].map((m) => m[1]);
    for (const cmd of injected) {
      assert.match(cmd, /\|\| true$/, `injected command must end with "|| true": ${cmd}`);
      const base = cmd.replace(/\s*\|\| true$/, "");
      const toRegex = (rule) => {
        const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        // A trailing " *" also matches the bare command (Claude Code's documented rule semantics).
        return new RegExp(`^${escaped.endsWith(" *") ? `${escaped.slice(0, -2).replace(/\*/g, ".*")}(?: .*)?` : escaped.replace(/\*/g, ".*")}$`);
      };
      // Each command of an `a || b` chain is checked on its own, as Claude Code checks subcommands.
      for (const part of base.split(/\s*\|\|\s*/)) {
        const ok = allowed.some((rule) => toRegex(rule).test(part));
        assert.ok(ok, `injected command "${part}" is not pre-approved by allowed-tools (${allowed.join(", ")})`);
      }
    }
  });
  test(`${name}: states its rules up front, its done condition, and when to stop`, () => {
    const head = body.slice(0, 1500);
    assert.match(head, /Rules that hold for this whole skill/, "compaction-surviving rules must come first");
    assert.match(body, /Done when|Output \(|Report \(|End with exactly one/i, "missing an observable completion condition");
    assert.match(body, /Stop|Never|never|Don't|don't/, "missing stop or failure conditions");
  });
}

for (const file of ["boundary-critic.md", "delivery-auditor.md"]) {
  test(`${file}: read-only tools, so the critic can't edit`, () => {
    const { fields } = frontmatter(readFileSync(join(plugin, "agents", file), "utf8"));
    const tools = fields.tools.split(",").map((t) => t.trim());
    for (const t of tools) assert.ok(["Read", "Grep", "Glob"].includes(t), `${file} grants ${t}`);
  });
}

test("no always-on instructions beyond skill and agent descriptions", () => {
  assert.throws(() => readFileSync(join(plugin, "CLAUDE.md")), "a plugin-root CLAUDE.md isn't loaded and would mislead");
});
