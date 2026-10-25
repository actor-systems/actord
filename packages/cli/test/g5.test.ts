// actors init, the plugin hooks, and claim classification, through the shipped CLI where it matters.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classifyClaims } from "../src/model/claims.ts";
import { askRules } from "../src/patterns.ts";

const repo = join(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "plugin/dist/actors.mjs");
const tmp = mkdtempSync(join(tmpdir(), "actors-g5-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(cwd: string, args: string[], input?: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [cli, ...args], { cwd, input, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("actors init", () => {
  it("creates a complete starter with the verify skill, ask rules, and a short CLAUDE.md", () => {
    const r = run(tmp, ["init", "fresh", "--name", "Fresh App", "--json", "--toolkit", "0.1.0"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.mode).toBe("create");
    for (const f of ["system.ts", "wrangler.jsonc", "tests/greeting.test.ts", "actors.claims.json", ".claude/skills/verify/SKILL.md", ".claude/settings.json", "CLAUDE.md"]) {
      expect(doc.created).toContain(f);
    }
    const dir = join(tmp, "fresh");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("fresh-app");
    expect(JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")).permissions.ask).toEqual(askRules());
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8").trim().split("\n").length).toBeLessThanOrEqual(10);
  });

  it("creates in a directory holding only .git, node_modules, and Claude Code's own .claude state", () => {
    const dir = join(tmp, "with-state");
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    mkdirSync(join(dir, ".claude/.cc-writes"), { recursive: true });
    const r = run(tmp, ["init", "with-state", "--json", "--toolkit", "0.1.0"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).created).toContain(".claude/settings.json");
    // A .claude directory with real configuration still counts.
    const taken = join(tmp, "taken");
    mkdirSync(join(taken, ".claude"), { recursive: true });
    writeFileSync(join(taken, ".claude/settings.json"), "{}");
    expect(run(tmp, ["init", "taken"]).code).toBe(2);
  });

  it("refuses a non-empty directory instead of overwriting it", () => {
    const r = run(tmp, ["init", "fresh"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/isn't empty.*--adopt/s);
  });

  it("--adopt adds only missing files, never changes existing .claude files, and is idempotent", () => {
    const dir = join(tmp, "existing");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "existing" }));
    const mine = JSON.stringify({ permissions: { ask: ["Bash(*wrangler deploy*)"] } });
    writeFileSync(join(dir, ".claude/settings.json"), mine);
    const first = JSON.parse(run(dir, ["init", "--adopt", "--json"]).out);
    expect(first.created.sort()).toEqual([".claude/skills/verify/SKILL.md", "CLAUDE.md"]);
    expect(first.skipped).toEqual([".claude/settings.json"]);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(mine);
    expect(first.suggestions.join("\n")).toMatch(/Add these to permissions\.ask/);
    const second = JSON.parse(run(dir, ["init", "--adopt", "--json"]).out);
    expect(second.created).toEqual([]);
  });
});

describe("hooks", () => {
  const broken = join(repo, "fixtures/negative/route-unknown-actor");
  const valid = join(repo, "fixtures/valid/minimal");
  const edit = (file: string) => JSON.stringify({ hook_event_name: "PostToolUse", cwd: repo, tool_name: "Edit", tool_input: { file_path: file } });

  it("check-on-edit returns hard errors to Claude as additional context", () => {
    const r = run(repo, ["hook", "check-on-edit"], edit(join(broken, "system.ts")));
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(doc.hookSpecificOutput.additionalContext).toMatch(/ROUTE_UNKNOWN_ACTOR/);
  });

  it("check-on-edit says nothing when clean, for unrelated files, outside projects, or when turned off", () => {
    expect(run(repo, ["hook", "check-on-edit"], edit(join(valid, "system.ts"))).out).toBe("");
    expect(run(repo, ["hook", "check-on-edit"], edit(join(broken, "README.md"))).out).toBe("");
    expect(run(repo, ["hook", "check-on-edit"], edit(join(repo, "README.md"))).out).toBe("");
    expect(run(repo, ["hook", "check-on-edit"], edit(join(broken, "system.ts")), { CLAUDE_PLUGIN_OPTION_CHECK_ON_EDIT: "false" }).out).toBe("");
    expect(run(repo, ["hook", "check-on-edit"], "not json").code).toBe(0);
  });

  it("evidence-gate is opt-in, blocks once when actor files changed since the last passing check, and never twice", () => {
    const dir = join(tmp, "gate");
    cpSync(valid, dir, { recursive: true });
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules")); // so system.ts can load outside the repo
    const stop = (active: boolean) => JSON.stringify({ hook_event_name: "Stop", cwd: dir, stop_hook_active: active });
    const on = { CLAUDE_PLUGIN_OPTION_STRICT_EVIDENCE: "true" };
    spawnSync("git", ["init", "-q"], { cwd: dir });
    expect(run(dir, ["hook", "evidence-gate"], stop(false)).out).toBe(""); // off by default
    writeFileSync(join(dir, "system.ts"), `${readFileSync(join(dir, "system.ts"), "utf8")}\n// edited\n`);
    const blocked = JSON.parse(run(dir, ["hook", "evidence-gate"], stop(false), on).out);
    expect(blocked).toMatchObject({ decision: "block" });
    expect(blocked.reason).toMatch(/run `actors check`/);
    expect(run(dir, ["hook", "evidence-gate"], stop(true), on).out).toBe(""); // already continuing: never twice
    run(dir, ["check"]); // records a passing check for the current files
    expect(existsSync(join(dir, ".actors/last-check.json"))).toBe(true);
    expect(run(dir, ["hook", "evidence-gate"], stop(false), on).out).toBe("");
  });
});

describe("claim classification", () => {
  const claims = [
    { id: "a", basis: "workerd" as const, statement: "a", tests: ["x"] },
    { id: "b", basis: "stub" as const, statement: "b", tests: ["y"] },
    { id: "c", basis: "not-guaranteed" as const, statement: "c" },
    { id: "d", basis: "workerd" as const, statement: "d", tests: ["missing"] },
  ];
  const tests = [
    { name: "suite > [x] works", status: "passed" },
    { name: "suite > [extended][x] stress", status: "skipped" },
    { name: "suite > [y] stubbed", status: "failed" },
  ];
  it("needs a passing test for every tag, and reports blocked runs as blocked", () => {
    expect(classifyClaims(claims, tests, false).map((c) => `${c.id}:${c.status}`)).toEqual(["a:proved-locally", "b:failing", "c:not-guaranteed", "d:untested"]);
    expect(classifyClaims(claims, null, true).map((c) => c.status)).toEqual(["blocked", "blocked", "not-guaranteed", "blocked"]);
  });
});
