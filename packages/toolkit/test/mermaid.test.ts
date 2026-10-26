// `actord graph --format mermaid`: the topology as a Mermaid flowchart, through the shipped CLI where it matters.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMermaid } from "../src/model/mermaid.ts";

const repo = join(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "plugins/claude/dist/actord.mjs");
const radar = join(repo, "examples/release-radar");

function run(cwd: string, args: string[]) {
  const r = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("actord graph --format mermaid", () => {
  it("prints a flowchart with every external sender, actor, and route of the committed manifest", () => {
    const r = run(radar, ["graph", "--format", "mermaid"]);
    expect(r.code).toBe(0);
    expect(r.out.startsWith("flowchart LR\n")).toBe(true);
    const manifest = JSON.parse(readFileSync(join(radar, "actord.manifest.json"), "utf8"));
    for (const a of manifest.actors) expect(r.out).toContain(`a_${a.name}["${a.name}<br/>`);
    for (const route of manifest.routes) expect(r.out).toContain(`${route.message}@1`);
    expect(r.out).toContain('x_clock(["@clock"])');
    expect(r.out).toContain("deterministic · every 15m");
    expect(run(radar, ["graph", "--format", "mermaid"]).out).toBe(r.out);
  });

  it("adds the flowchart to --json, and refuses a format it doesn't know", () => {
    const doc = JSON.parse(run(radar, ["graph", "--format", "mermaid", "--json"]).out);
    expect(doc.mermaid.startsWith("flowchart LR")).toBe(true);
    expect(JSON.parse(run(radar, ["graph", "--json"]).out).mermaid).toBeUndefined();
    const bad = run(radar, ["graph", "--format", "dot"]);
    expect(bad.code).toBe(2);
    expect(bad.out).toMatch(/unknown --format "dot" \(text or mermaid\)/);
  });
});

describe("renderMermaid", () => {
  const manifest = (routes: Array<{ from: string; message: string; to: string }>, actors = ["end", "Desk"]) =>
    ({
      system: { name: "s", description: "" },
      actors: actors.map((name) => ({ name, kind: "deterministic", schedules: [] })),
      messages: routes.map((r) => ({ name: r.message, version: 2 })),
      routes,
      effects: [],
    }) as never;

  it("gives every node a prefixed id, so an actor named after a Mermaid keyword can't break the chart", () => {
    const out = renderMermaid(manifest([{ from: "@in", message: "go", to: "end" }]));
    expect(out).toContain('a_end["end<br/>deterministic"]');
    expect(out).toContain('x_in -->|"go@2"| a_end');
    expect(out).not.toMatch(/^\s+end\b/m);
  });

  it("escapes what would end a quoted label", () => {
    const out = renderMermaid(manifest([{ from: "@in", message: 'say "hi" <now> & go', to: "Desk" }]));
    expect(out).toContain('"say #quot;hi#quot; #lt;now#gt; #amp; go@2"');
  });

  it("stacks routes between the same two nodes on one arrow, self-loops included", () => {
    const out = renderMermaid(
      manifest([
        { from: "Desk", message: "a.done", to: "Desk" },
        { from: "Desk", message: "b.done", to: "Desk" },
        { from: "@in", message: "c", to: "Desk" },
      ]),
    );
    expect(out).toContain('a_Desk -->|"a.done@2<br/>b.done@2"| a_Desk');
    expect(out.match(/-->/g)).toHaveLength(2);
  });
});
