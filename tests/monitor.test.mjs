// The plugin's monitor: declared once per skill that starts it, running the CLI's notable-event follower
// with a per-session lock. Runs the monitor command exactly as monitors.json spells it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const monitors = JSON.parse(readFileSync(join(root, "plugin/monitors/monitors.json"), "utf8"));

test("one monitor entry per starting skill, each a strict entry naming an existing skill", () => {
  assert.deepEqual(monitors.map((m) => m.when).sort(), ["on-skill-invoke:inspect", "on-skill-invoke:reliability"]);
  for (const m of monitors) {
    assert.deepEqual(Object.keys(m).sort(), ["command", "description", "name", "when"]);
    assert.ok(existsSync(join(root, "plugin/skills", m.when.split(":")[1], "SKILL.md")));
    assert.ok(!m.command.includes("user_config"), "monitors can't read userConfig");
  }
  assert.equal(new Set(monitors.map((m) => m.command)).size, 1, "both entries run the same follower");
});

test("the monitor prints each notable event once, and a second start in the same session exits quietly", () => {
  const project = mkdtempSync(join(tmpdir(), "actors-monitor-"));
  try {
    writeFileSync(join(project, "system.ts"), "export default {}\n");
    writeFileSync(join(project, "package.json"), "{}\n");
    mkdirSync(join(project, ".actors"));
    const log = join(root, "fixtures/events/release-radar-faults.ndjson");
    copyFileSync(log, join(project, ".actors/events.ndjson"));
    const command = monitors[0].command.replaceAll("${CLAUDE_PLUGIN_ROOT}", join(root, "plugin"));
    // Both starts share a parent, as two monitors of one session do.
    const script = `${command} & first=$!; sleep 1.5; ${command}; echo "second-exit=$?"; sleep 0.5; kill $first`;
    const r = spawnSync("sh", ["-c", script], { cwd: project, encoding: "utf8", timeout: 15000 });
    const lines = r.stdout.trim().split("\n");
    assert.ok(lines.includes("second-exit=0"), r.stdout + r.stderr);
    const notable = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => ["rejected", "failed", "retry.exhausted", "undeliverable", "effect.in_doubt", "effect.denied", "effect.failed"].includes(e.kind));
    const printed = lines.filter((l) => l !== "second-exit=0");
    assert.equal(printed.length, notable.length, `expected one line per notable event:\n${r.stdout}`);
    for (const e of notable) assert.ok(printed.some((l) => l.startsWith(e.kind)), `missing ${e.kind}`);
    assert.ok(!printed.some((l) => /^(received|handled|sent|delivered)\b/.test(l)), "printed a routine event");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
