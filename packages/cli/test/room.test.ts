// `actord room`, `actord guard`, and the monitor's lock, through the shipped CLI where it matters. The Room
// mod draws these documents as printed, so their shapes are pinned here and in plugin/tests/fixtures.ts.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../src/cli/commands/events.ts";
import { topologySvg, topologyWithChanges } from "../src/model/svg.ts";

const repo = join(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "plugin/dist/actord.mjs");
const tmp = mkdtempSync(join(tmpdir(), "actord-room-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const app = join(tmp, "evolved");
cpSync(join(repo, "fixtures/valid/evolved"), app, { recursive: true, filter: (src) => !src.includes(".actord") });
symlinkSync(join(repo, "node_modules"), join(app, "node_modules")); // so system.ts loads outside the repo
const base = join(repo, "fixtures/valid/minimal/actord.manifest.json");

function run(cwd: string, args: string[]) {
  const r = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const room = () => {
  const r = run(app, ["room", "--json", "--base-file", base]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
};
// Built at run time so this file's text never reads as a deploy command.
const deploy = ["npx", "wrangler", "deploy"].join(" ");

describe("actord room", () => {
  it("shows the topology with additions against the base, as text and SVG", () => {
    const doc = room();
    expect(doc.schemaVersion).toBe(1);
    expect(doc.system).toBeTruthy();
    expect(doc.topology.base).toBe(`file:${base}`);
    expect(doc.topology.actors.find((a: { name: string }) => a.name === "Auditor").change).toBe("added");
    expect(doc.topology.lines).toContain("+ Auditor (deterministic) · added");
    expect(doc.topology.svg).toMatch(/^<svg [^>]*viewBox/);
    for (const a of ["Auditor", "Pinger", "Ponger"]) expect(doc.topology.svg).toContain(`>${a}</text>`);
    expect(doc.topology.alt).toMatch(/3 actors, \d+ routes, \d+ changes against file:/);
    expect(doc.status).toMatch(/^3 actors · \d+ routes · check – · \d+ changes vs file:/);
    expect(doc.contracts.messages.length).toBeGreaterThan(0);
    expect(doc.contracts.messages[0]).toEqual(expect.objectContaining({ name: expect.any(String), version: expect.any(Number), routes: expect.any(Array) }));
  });

  it("is deterministic apart from its volatile fields", () => {
    expect(run(app, ["room", "--json", "--base-file", base]).out).toBe(run(app, ["room", "--json", "--base-file", base]).out);
  });

  it("reports the last check as passing, then stale after an edit", () => {
    expect(run(app, ["check"]).code).toBe(0);
    expect(room().contracts.check.state).toBe("pass");
    expect(room().status).toContain("check ✓");
    appendFileSync(join(app, "system.ts"), "\n// edited\n");
    expect(room().contracts.check.state).toBe("stale");
    expect(room().status).toContain("check stale");
  });

  it("groups recorded messages into one mailbox per actor, each entry naming its instance and outcome", () => {
    mkdirSync(join(app, ".actord"), { recursive: true });
    copyFileSync(join(repo, "fixtures/events/release-radar-faults.ndjson"), join(app, ".actord/events.ndjson"));
    const doc = room();
    const names = doc.mailboxes.actors.map((a: { name: string }) => a.name);
    expect(names).toEqual([...names].sort());
    expect(names.every((n: string) => !n.includes(":"))).toBe(true);
    const all = doc.mailboxes.actors.flatMap((a: { messages: unknown[] }) => a.messages);
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) expect(m).toEqual(expect.objectContaining({ messageId: expect.any(String), to: expect.stringMatching(/:/), outcome: expect.any(String), mark: expect.any(String) }));
    expect(all.some((m: { outcome: string }) => m.outcome === "retry.exhausted")).toBe(true);
    expect(doc.mailboxes.notable.some((n: string) => n.startsWith("retry.exhausted"))).toBe(true);
  });

  it("splits a verify report into claim groups and marks it stale once actor files change", () => {
    const print = JSON.parse(readFileSync(join(app, ".actord/last-check.json"), "utf8")).fingerprint;
    const claims = [
      { id: "a", statement: "proved", status: "proved-locally" },
      { id: "b", statement: "stub", status: "stub-only" },
      { id: "c", statement: "no", status: "not-guaranteed", why: "platform" },
    ];
    writeFileSync(join(app, ".actord/evidence.json"), JSON.stringify({ verdict: "pass", generatedAt: "2026-01-01T00:00:00Z", profile: "standard", fingerprint: "elsewhere", claims }));
    let ev = room().evidence;
    expect(ev.state).toBe("stale");
    expect(ev.groups.map((g: { label: string }) => g.label)).toEqual(["Proved locally", "Stub only", "Not guaranteed"]);
    expect(ev.groups[2].claims[0].why).toBe("platform");
    expect(print).toBeTruthy();
    run(app, ["check"]);
    const current = JSON.parse(readFileSync(join(app, ".actord/last-check.json"), "utf8")).fingerprint;
    writeFileSync(join(app, ".actord/evidence.json"), JSON.stringify({ verdict: "blocked", fingerprint: current, claims }));
    ev = room().evidence;
    expect(ev.state).toBe("blocked");
  });

  it("prints text without --json and exits 3 outside an actor project", () => {
    const text = run(app, ["room", "--base-file", base]);
    expect(text.out).toMatch(/Topology\n/);
    expect(text.out).toMatch(/Mailboxes\n/);
    const none = run(tmp, ["room", "--json"]);
    expect(none.code).toBe(3);
    expect(JSON.parse(none.out).projectRoot).toBeNull();
  });

  it("--follow --json prints a snapshot now and another when the event log changes", async () => {
    const child = spawn("node", [cli, "room", "--follow", "--json"], { cwd: app });
    const lines: string[] = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
    });
    const waitFor = async (n: number) => {
      for (let i = 0; i < 100 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 100));
    };
    try {
      await waitFor(1);
      expect(JSON.parse(lines[0]!).schemaVersion).toBe(1);
      const before = JSON.parse(lines[0]!).mailboxes.events;
      appendFileSync(join(app, ".actord/events.ndjson"), `${JSON.stringify({ $actord: 1, kind: "received", at: 1, actor: "Pinger:x", messageId: "follow-1", type: "ping", from: "@ingress", to: "Pinger:x" })}\n`);
      await waitFor(2);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(lines[1]!).mailboxes.events).toBe(before + 1);
    } finally {
      child.kill();
    }
  });
});

describe("actord diff without git", () => {
  it("compares against the manifest on disk and says why", () => {
    // The copy under the OS temp dir is in no repository, as in a sandbox that can't start git.
    const doc = JSON.parse(run(app, ["diff", "--json"]).out);
    expect(doc.base.source).toBe("file:actord.manifest.json");
    expect(doc.notes[0]).toMatch(/^git isn't usable here \(.+\), so this compares against actord\.manifest\.json on disk/);
    expect(doc.changes).toEqual([]);
    const r = JSON.parse(run(app, ["room", "--json"]).out);
    expect(r.topology.base).toBe("file:actord.manifest.json");
    expect(r.topology.changes).toBe(0);
  });
});

describe("--exit-zero", () => {
  it("keeps the output and exits 0, for skill injection where any other exit aborts", () => {
    const plain = run(tmp, ["room", "--json"]);
    expect(plain.code).toBe(3);
    const zero = run(tmp, ["room", "--json", "--exit-zero"]);
    expect(zero.code).toBe(0);
    expect(zero.out).toBe(plain.out);
  });
});

describe("actord guard", () => {
  it("holds a deploy inside an actor project with the diff summary and plan, refusing by default", () => {
    const r = run(app, ["guard", "--json", "--", deploy]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.hold).toBe(true);
    expect(doc.matches.map((m: { id: string }) => m.id)).toEqual(["wrangler-deploy"]);
    expect(doc.question).toContain("Deploy plan:");
    expect(doc.question).toMatch(/permission check still runs/);
    expect(doc.question).toMatch(/\?$/);
    expect(doc.refusal).toMatch(/nobody approved it.*let them run it or approve it themselves/s);
  });

  it("doesn't hold a matching command outside an actor project, nor a command that matches nothing", () => {
    const outside = JSON.parse(run(tmp, ["guard", "--json", "--", deploy]).out);
    expect(outside.hold).toBe(false);
    expect(outside.matches.length).toBe(1);
    const plain = JSON.parse(run(app, ["guard", "--json", "--", "npm test"]).out);
    expect(plain).toEqual(expect.objectContaining({ hold: false, matches: [], question: null }));
  });

  it("is a usage error without a command", () => {
    expect(run(app, ["guard", "--json"]).code).toBe(2);
  });
});

describe("the monitor lock", () => {
  const lock = join(tmp, "locks", "monitor-1.pid");

  it("lets one follower hold it, takes it over from a dead holder, and releases only its own", () => {
    expect(acquireLock(lock, process.pid)).toBe(true);
    expect(acquireLock(lock, 424242)).toBe(false); // this process is alive and holds it
    releaseLock(lock, 424242);
    expect(existsSync(lock)).toBe(true);
    releaseLock(lock, process.pid);
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, "999999"); // a follower that died without releasing
    expect(acquireLock(lock, process.pid)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    releaseLock(lock, process.pid);
  });
});

describe("topology SVG", () => {
  it("escapes names and marks removed routes dashed", () => {
    const head = { schemaVersion: 1, $comment: "", system: { name: "s", description: "" }, actors: [{ name: "A<b>", kind: "deterministic" }], messages: [], routes: [{ from: "@in", message: "m&n", to: "A<b>" }], effects: [] };
    const baseDoc = { ...head, routes: [...head.routes, { from: "@in", message: "gone", to: "A<b>" }] };
    const svg = topologySvg(topologyWithChanges(baseDoc as never, head as never));
    expect(svg).toContain("A&lt;b&gt;");
    expect(svg).toContain("m&amp;n");
    expect(svg).not.toContain("A<b>");
    expect(svg).toMatch(/stroke="#e5534b" stroke-dasharray="5 4" marker-end="url\(#actord-arrow-removed\)"/);
  });
});
