// `actors events` and `actors trace` through the shipped CLI, on event logs recorded from real
// Release Radar test runs in workerd (fixtures/events/).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "plugin/dist/actors.mjs");
const flow = join(repo, "fixtures/events/release-radar-flow.ndjson");
const faults = join(repo, "fixtures/events/release-radar-faults.ndjson");
const tmp = mkdtempSync(join(tmpdir(), "actors-events-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const run = (...args: string[]) => {
  const r = spawnSync("node", [cli, ...args], { cwd: tmp, encoding: "utf8" });
  return { code: r.status, out: r.stdout };
};
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const find = (file: string, pred: (e: Record<string, unknown>) => boolean) => lines(file).find(pred)?.messageId as string;

describe("actors trace", () => {
  const significant = find(flow, (e) => e.type === "release.significant" && e.kind === "handled");

  it("follows a known message from its root cause through effects to its consequences", () => {
    const r = run("trace", significant, "--file", flow, "--json");
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.found).toBe(true);
    expect(doc.rootCauseUnknown).toBe(false);
    expect(doc.root.type).toBe("feed.poll.due");
    expect(doc.root.from).toBe("@clock");
    const fetchEffect = doc.root.effects[0];
    expect(fetchEffect).toMatchObject({ effect: "feed.fetch", outcome: "confirmed" });
    expect(fetchEffect.result.type).toBe("feed.fetched");
    const target = fetchEffect.result.children.flatMap((c: { children: unknown[] }) => c.children).find((n: { messageId: string }) => n.messageId === significant);
    expect(target).toMatchObject({ type: "release.significant", outcome: "handled" });
    expect(target.effects[0]).toMatchObject({ effect: "notify.digest", outcome: "confirmed" });
    // The coverage line names the log by path; normalize the checkout location so the snapshot is portable.
    expect(run("trace", significant, "--file", flow).out.replaceAll(repo, "<repo>")).toMatchSnapshot("trace text");
  });

  it("reports an unknown id as unknown, with its coverage, and exits 1", () => {
    const r = run("trace", "no-such-message", "--file", flow, "--json");
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.out);
    expect(doc.found).toBe(false);
    expect(doc.root).toBeNull();
    expect(doc.coverage.note).toMatch(/Production history isn't available/);
  });

  it("says where coverage ends instead of inventing the missing cause", () => {
    const truncated = join(tmp, "truncated.ndjson");
    const all = readFileSync(flow, "utf8").trim().split("\n");
    const cut = all.findIndex((l) => l.includes('"type":"release.observed"'));
    writeFileSync(truncated, `${all.slice(cut).join("\n")}\n`);
    const r = run("trace", significant, "--file", truncated);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/earlier cause unknown: outside recorded coverage/);
  });

  it("shows retries and the failures that caused them", () => {
    const crashed = find(faults, (e) => e.kind === "failed" && e.reason === "injected fault at after-handler");
    const doc = JSON.parse(run("trace", crashed, "--file", faults, "--json").out);
    const walk = (n: { messageId: string; children: unknown[]; effects: Array<{ result: unknown }> }): unknown[] => [n, ...n.children.flatMap((c) => walk(c as never)), ...n.effects.flatMap((e) => (e.result ? walk(e.result as never) : []))];
    const node = walk(doc.root).find((n) => (n as { messageId: string }).messageId === crashed) as { outcome: string; attempts: number; failures: string[] };
    expect(node).toMatchObject({ outcome: "handled", attempts: 2, failures: ["injected fault at after-handler"] });
  });

  it("marks a dead-lettered message as retry.exhausted", () => {
    const dead = find(faults, (e) => e.kind === "retry.exhausted");
    const out = run("trace", dead, "--file", faults).out;
    expect(out).toMatch(/release\.significant {2}✗ retry\.exhausted after 5 retries/);
  });
});

describe("actors events", () => {
  it("--notable keeps only faults, and --json prints NDJSON", () => {
    const r = run("events", "--notable", "--json", "--file", faults);
    expect(r.code).toBe(0);
    const events = r.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(["failed", "retry.exhausted"]).toContain(e.kind);
    expect(events.every((e) => e.$actors === 1)).toBe(true);
  });

  it("explains that there are no events rather than printing nothing", () => {
    const r = run("events", "--file", join(tmp, "absent.ndjson"));
    expect(r.out).toMatch(/No local events yet/);
  });

  it("--follow streams appended events and survives a new run truncating the log", async () => {
    const file = join(tmp, "live.ndjson");
    writeFileSync(file, "");
    const child = spawn("node", [cli, "events", "--follow", "--json", "--file", file], { cwd: tmp });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 40 && !pred(); i++) await new Promise((r) => setTimeout(r, 100));
    };
    try {
      const [first, second] = readFileSync(flow, "utf8").split("\n");
      appendFileSync(file, `${first}\n`);
      await waitFor(() => out.includes('"seq":1'));
      writeFileSync(file, ""); // a new test run truncates the log
      await new Promise((r) => setTimeout(r, 400));
      appendFileSync(file, `${second}\n`);
      await waitFor(() => out.includes('"seq":2'));
      const kinds = out.trim().split("\n").map((l) => JSON.parse(l).kind);
      expect(kinds[0]).toBe(JSON.parse(first!).kind);
      expect(kinds).toContain("log.reset");
      expect(out).toContain('"seq":2');
    } finally {
      child.kill();
    }
  });
});
