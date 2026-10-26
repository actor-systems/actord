// Runs the shipped CLI (plugins/claude/dist/actord.mjs, rebuilt by `npm run build`) against every fixture.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "plugins/claude/dist/actord.mjs");
const fixtures = join(repo, "fixtures");
const list = (kind: string) => readdirSync(join(fixtures, kind)).filter((d) => existsSync(join(fixtures, kind, d, "system.ts")));

function run(cwd: string, ...args: string[]) {
  const r = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
/** Drop the explicitly volatile fields so the rest can be compared byte for byte across machines. */
function stable(out: string) {
  const doc = JSON.parse(out);
  for (const field of doc.volatile ?? []) if (!field.includes("[]")) delete doc[field];
  return doc;
}

describe("valid fixtures", () => {
  for (const name of list("valid")) {
    const dir = join(fixtures, "valid", name);
    it(`${name}: check passes with no diagnostics`, () => {
      const r = run(dir, "check", "--json");
      expect(r.code, r.out + r.err).toBe(0);
      expect(JSON.parse(r.out).diagnostics).toEqual([]);
    });
    it(`${name}: check, graph, and diff are deterministic and snapshot-stable`, () => {
      for (const args of [["check", "--json"], ["graph", "--json"], ["graph"]]) {
        const a = run(dir, ...args);
        const b = run(dir, ...args);
        expect(a.out).toBe(b.out);
        expect(args.includes("--json") ? stable(a.out) : a.out).toMatchSnapshot(args.join(" "));
      }
    });
    it(`${name}: the committed manifest is what graph --json derives`, () => {
      const graph = JSON.parse(run(dir, "graph", "--json").out);
      expect(JSON.parse(readFileSync(join(dir, "actord.manifest.json"), "utf8"))).toEqual(graph.manifest);
    });
  }

  it("diff classifies evolved against minimal, with a plan and no deploy", () => {
    const r = run(join(fixtures, "valid/evolved"), "diff", "--json", "--base-file", "../minimal/actord.manifest.json");
    expect(r.code).toBe(0);
    const doc = stable(r.out);
    expect(doc.changes.map((c: { kind: string; compatibility: string }) => `${c.kind}:${c.compatibility}`)).toEqual([
      "actor.added:compatible",
      "effect.added:risky",
      "message.payload:breaking",
      "route.added:compatible",
    ]);
    expect(doc.summary.requiresApproval).toBe(true);
    expect(doc.plan.at(-1).kind).toBe("deploy");
    expect(doc.plan.at(-1).text).toMatch(/never deploys/);
    expect(doc).toMatchSnapshot("diff evolved vs minimal");
  });
});

describe("negative fixtures fail for the reason they exist", () => {
  for (const name of list("negative")) {
    const dir = join(fixtures, "negative", name);
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
    it(`${name}: exits ${expected.check.exitCode} with ${expected.check.codes.join(", ")}`, () => {
      const r = run(dir, "check", "--json");
      expect(r.code, r.out + r.err).toBe(expected.check.exitCode);
      const codes = JSON.parse(r.out).diagnostics.filter((d: { severity: string }) => d.severity === "error").map((d: { code: string }) => d.code);
      expect(codes).toEqual(expected.check.codes);
    });
  }
});

describe("exit statuses", () => {
  it("3 outside a project, and brief output is silent when nothing relevant changed", () => {
    expect(run(repo, "check").code).toBe(3);
    const r = run(join(fixtures, "negative/route-unknown-actor"), "check", "--format", "brief", "--changed", "README.md");
    expect([r.code, r.out]).toEqual([0, ""]);
  });
  it("2 for an unknown command", () => {
    expect(run(repo, "frobnicate").code).toBe(2);
  });
});
