#!/usr/bin/env node
// Run an example as a real local Worker (`wrangler dev`), drive it over HTTP, and trace what happened from
// the event lines the running Worker printed. The workerd suites reach actors through test seams; this
// shows the Worker itself boots from its wrangler.jsonc, takes requests at its front door, and leaves a
// causal log that `actord trace` reads.
//   node scripts/dev-smoke.mjs release-radar|briefing-desk
// Local only: throwaway state and HOME, no .dev.vars or .env (no credentials reach the Worker), and no
// outbound requests (Release Radar's first poll is 15 minutes out; the desk's model has no API key, so it
// routes the item to a person). Exit 0 pass, 1 fail, 2 blocked (can't listen here, or credentials present).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const name = process.argv[2];
const scenarios = { "release-radar": releaseRadar, "briefing-desk": briefingDesk };
if (!scenarios[name]) {
  console.error("usage: dev-smoke.mjs release-radar|briefing-desk");
  process.exit(1);
}
const cwd = join(root, "examples", name);
const credentials = readdirSync(cwd).filter((f) => f.startsWith(".dev.vars") || f.startsWith(".env"));
if (credentials.length) {
  console.log(`blocked: ${credentials.join(", ")} in examples/${name}; the smoke never runs a Worker that could hold real credentials`);
  process.exit(2);
}

const temp = mkdtempSync(join(tmpdir(), "actord-dev-smoke-"));
const failures = [];
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  process.execPath,
  [
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--local",
    "--ip", "127.0.0.1",
    "--port", "0",
    "--inspector-port", "0",
    "--persist-to", join(temp, "state"),
    "--env-file", "/dev/null",
    "--show-interactive-dev-session=false",
  ],
  { cwd, detached: true, env: { PATH: process.env.PATH, HOME: join(temp, "home"), WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
const exited = new Promise((r) => child.on("exit", r));

/** The event lines the Worker printed so far, as written to .actord/events.ndjson by test runs. */
const events = () => output.split("\n").filter((l) => l.startsWith('{"$actord":1')).map((l) => JSON.parse(l));
async function until(what, test, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await test()) return true;
  expect(false, `${what} (timed out)`);
  return false;
}
/** `actord trace <id> --json` over the events the Worker printed, through the CLI the plugin ships. */
function trace(id) {
  const file = join(temp, "events.ndjson");
  writeFileSync(file, events().map((e) => JSON.stringify(e)).join("\n") + "\n");
  const text = spawnSync(process.execPath, [join(root, "plugins/claude/dist/actord.mjs"), "trace", id, "--file", file], { cwd, encoding: "utf8" }).stdout;
  console.log(text.trimEnd().replace(/coverage: \S*events\.ndjson/, "coverage: the dev server's events"));
  const r = spawnSync(process.execPath, [join(root, "plugins/claude/dist/actord.mjs"), "trace", id, "--file", file, "--json"], { cwd, encoding: "utf8" });
  return JSON.parse(r.stdout);
}
const walk = (n) => (n ? [n, ...n.children.flatMap(walk), ...n.effects.flatMap((e) => walk(e.result))] : []);

try {
  let base = null;
  for (let i = 0; i < 600 && !base && child.exitCode === null; i++, await sleep(100)) base = /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? null;
  if (!base) {
    console.log(output.trimEnd().split("\n").slice(-30).join("\n"));
    console.log(/EPERM|operation not permitted/.test(output) ? "blocked: wrangler dev can't listen on loopback here (sandbox)" : "FAIL wrangler dev didn't start");
    process.exitCode = /EPERM|operation not permitted/.test(output) ? 2 : 1;
  } else {
    console.log(`wrangler dev: ${base} (local, throwaway state)`);
    await scenarios[name](base);
    console.log(`${events().length} events from the running Worker`);
    process.exitCode = failures.length ? 1 : 0;
  }
} catch (err) {
  console.log(output.trimEnd().split("\n").slice(-30).join("\n"));
  console.log(`FAIL ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([exited, sleep(5_000)]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  rmSync(temp, { recursive: true, force: true });
}

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function releaseRadar(base) {
  const front = await fetch(`${base}/`);
  expect(front.status === 404 && (await front.text()).includes("POST /feeds"), "GET / answers with the Worker's routes");

  const watch = await post(base, "/feeds", { feedId: "smoke", url: "https://feeds.example.test/smoke.json" });
  expect(watch.status === 202 && watch.body.status === "handled", `POST /feeds → 202 handled (${JSON.stringify(watch.body)})`);

  const bad = await post(base, "/feeds", { feedId: "smoke-bad", url: "not a url" });
  expect(bad.status === 400 && bad.body.status === "rejected" && bad.body.reason === "invalid_payload", `POST /feeds with a bad url → 400 rejected (${bad.body.reason})`);

  const findings = await fetch(`${base}/findings`);
  expect(findings.status === 200 && JSON.stringify(await findings.json()) === "[]", "GET /findings → [] before any poll");

  if (!(await until("the watch is handled in the event log", () => events().some((e) => e.kind === "handled" && e.messageId === watch.body.messageId)))) return;
  const t = trace(watch.body.messageId);
  expect(t.found && t.root?.from === "@ingress" && t.root?.to === "FeedPoller:smoke" && t.root?.type === "feed.watch" && t.root?.outcome === "handled", "trace: @ingress → FeedPoller:smoke feed.watch handled");
  expect(events().some((e) => e.kind === "rejected" && e.messageId === bad.body.messageId), "the rejection is in the event log");
}

async function briefingDesk(base) {
  const submit = await post(base, "/items", { itemId: "smoke-1", source: "email", title: "Smoke item", body: "Is the desk running?" });
  expect(submit.status === 202 && submit.body.status === "handled", `POST /items → 202 handled (${JSON.stringify(submit.body)})`);

  const bad = await post(base, "/items", { itemId: "smoke-bad" });
  expect(bad.status === 400 && bad.body.status === "rejected" && bad.body.reason === "invalid_payload", `POST /items without a title → 400 rejected (${bad.body.reason})`);

  let row = null;
  const settled = await until("the item reaches the board as needs_human", async () => {
    row = (await (await fetch(`${base}/briefings`)).json()).find((r) => r.item_id === "smoke-1") ?? null;
    return row?.status === "needs_human";
  });
  if (!settled) return;
  expect(/ANTHROPIC_API_KEY/.test(row.reason ?? ""), `the board says why: ${row.reason}`);

  const t = trace(submit.body.messageId);
  const nodes = walk(t.root);
  const model = nodes.flatMap((n) => n.effects).find((e) => e.effect === "model.analyze");
  expect(t.found && t.root?.to === "Intake:main", "trace: rooted at @ingress → Intake");
  expect(nodes.some((n) => n.type === "item.routed" && n.to === "Analyst:smoke-1" && n.outcome === "handled"), "trace: Intake → Analyst item.routed handled");
  expect(model?.outcome === "failed" && model.attempts === 2, `trace: model.analyze failed after its budget of 2 attempts (${model?.outcome}, ${model?.attempts})`);
  expect(nodes.some((n) => n.type === "briefing.updated" && n.to === "Desk:main" && n.outcome === "handled"), "trace: Analyst → Desk briefing.updated handled");
}
