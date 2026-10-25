// Every hook command, mod event, mod call, and monitor command shipped in plugin/ must appear in the
// README's "Trust and safety" section. The listing comes from the plugin's own files and from
// `claude plugin validate`, which reads the mod's source the way Claude Code does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const readme = readFileSync(`${root}README.md`, "utf8");
const trust = readme.slice(readme.indexOf("## Trust and safety"), readme.indexOf("\n## ", readme.indexOf("## Trust and safety") + 3));
const json = (p) => (existsSync(`${root}${p}`) ? JSON.parse(readFileSync(`${root}${p}`, "utf8")) : null);

test("README has a trust section", () => assert.ok(trust.length > 200));

test("every settings-style hook command is listed", () => {
  const hooks = json("plugin/hooks/hooks.json")?.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    assert.ok(trust.includes(event), `trust section doesn't name hook event ${event}`);
    for (const g of groups) for (const h of g.hooks) {
      const shown = [h.command, ...(h.args ?? [])].join(" ").replace(/"?\$\{CLAUDE_PLUGIN_ROOT\}"?\//g, "");
      assert.ok(trust.includes(shown), `trust section doesn't show hook command: ${shown}`);
    }
  }
});

test("every monitor command is listed", () => {
  const monitors = json("plugin/monitors/monitors.json") ?? [];
  for (const m of monitors) {
    const shown = m.command.replace(/"?\$\{CLAUDE_PLUGIN_ROOT\}"?\//g, "");
    assert.ok(trust.includes(shown), `trust section doesn't show monitor command: ${shown}`);
  }
});

test("every mod event and mod call is listed", (t) => {
  if (!json("plugin/hooks/hooks.json")?.modules) return t.skip("no mod module yet");
  const r = spawnSync("claude", ["plugin", "validate", `${root}plugin`], { encoding: "utf8" });
  if (r.error) return t.skip("claude not on PATH");
  const out = `${r.stdout}${r.stderr}`;
  const items = (label) =>
    [...out.matchAll(new RegExp(`${label}: (.+)$`, "gm"))].flatMap((m) => m[1].split(/,\s*/)).map((s) => s.replace(/ \(via .*\)$/, "").trim());
  for (const event of items("hooks")) assert.ok(trust.includes(event), `trust section doesn't name mod event ${event}`);
  for (const call of items("calls")) assert.ok(trust.includes(call), `trust section doesn't name mod call ${call}`);
});
