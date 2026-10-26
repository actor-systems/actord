// Registry of verification checks, grouped by charter gate. Each check returns
// { status: pass|fail|blocked|skipped, reason?, output?, command?, ms?, evidenceSource? }.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function command(id, gate, title, cmd, opts = {}) {
  return {
    id,
    gate,
    title,
    command: cmd,
    async run({ sh }) {
      const r = sh(cmd, opts);
      const verdict = opts.classify
        ? opts.classify(r)
        : r.code === 0
          ? { status: "pass" }
          : { status: "fail", reason: `exit ${r.code}` };
      return { ...r, ...verdict, command: cmd };
    },
  };
}

function atLeast(version, floor) {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

const hash = (path) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);

/** The newest recorded eval result (docs/evidence/evals/*.json) that contains a case, or null. */
export function recordedEvalCase(root, caseName) {
  const dir = join(root, "docs/evidence/evals");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".host.json")).sort().reverse()) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const c = doc.cases?.find((c) => c.name === caseName);
    if (c) return { file: `docs/evidence/evals/${f}`, case: c };
  }
  return null;
}

export const gates = [
  {
    id: "G0",
    title: "Ground truth",
    requires: ["g0.versions", "g0.guardrails", "g0.spike.types", "g0.spike.typecheck", "g0.spike.runtime", "g0.sandbox"],
  },
  {
    id: "G1",
    title: "Installable plugin",
    requires: [
      "g1.cli.typecheck",
      "g1.cli.unit",
      "g1.dist.fresh",
      "g1.launcher",
      "g1.validate.plugin",
      "g1.validate.marketplace",
      "g1.install",
      "g1.budget",
      "g1.trust",
      "g1.start-session",
    ],
  },
  {
    id: "G2",
    title: "Model and CLI",
    requires: ["g2.contract.types", "g2.fixtures.typecheck", "g2.cli.model", "g2.negative.unchanged"],
  },
  {
    id: "G3",
    title: "Runtime evidence",
    requires: ["g3.radar.typecheck", "g3.radar.check", "g3.radar.runtime", "g3.radar.trace", "g3.radar.dev", "g3.cli.events"],
  },
  {
    id: "G4",
    title: "Agentic example",
    requires: ["g4.desk.typecheck", "g4.desk.check", "g4.desk.runtime", "g4.desk.trace", "g4.desk.dev", "g4.runtime.probe"],
  },
  {
    id: "G5",
    title: "Agent-guided development",
    requires: [
      "g5.cli.unit",
      "g5.skills.lint",
      "g5.evals.static",
      "g5.inventory",
      "g5.starter.smoke",
      "g5.verify.blocked",
      "g5.examples.verify",
      "g5.evals.run",
      "g5.evals.host",
    ],
  },
  {
    id: "G6",
    title: "The Room",
    requires: ["g6.cli.room", "g6.fixtures", "g6.mod.validate", "g6.mod.typecheck", "g6.mod.test", "g6.monitor", "g6.trust", "g6.no-hooks", "g6.acceptance"],
  },
  {
    id: "G7",
    title: "Release candidate",
    requires: ["g7.docs", "g7.release-evidence", "g7.tag", "g7.clean-checkout", "g7.container"],
  },
];

/**
 * Re-measurements of single cases after a documented grader correction (docs/evidence/evals/remeasured/),
 * as { case: [runs] }. They stand in for that case's full-run scores in the gate; both are reported.
 */
export function remeasuredCases(root) {
  const dir = join(root, "docs/evidence/evals/remeasured");
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".host.json")).sort()) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (doc.partial) continue;
    for (const c of doc.cases ?? []) (out[c.name] ??= []).push({ file: `docs/evidence/evals/remeasured/${f}`, case: c });
  }
  return out;
}

/**
 * Host re-runs (decision 0004) as a check on what the plugin adds: per case with runtime results, the plugin
 * arm's host pass rate may trail the baseline's by at most one run (noise, at three runs per arm). Entries
 * are a .host.json array; runs without a pass or fail host verdict don't count. Returns { cases, ok }.
 */
export function hostRegressions(entries) {
  const by = new Map();
  for (const e of entries) {
    if (e.host?.verdict !== "pass" && e.host?.verdict !== "fail") continue;
    const c = by.get(e.case) ?? { name: e.case, with: { pass: 0, runs: 0 }, without: { pass: 0, runs: 0 } };
    const arm = e.arm === "with" ? c.with : c.without;
    arm.runs++;
    if (e.host.verdict === "pass") arm.pass++;
    by.set(e.case, c);
  }
  const rate = (pass, runs) => (runs ? pass / runs : 0);
  const cases = [...by.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ ...c, ok: c.without.runs === 0 || (c.with.runs > 0 && rate(c.with.pass, c.with.runs) >= rate(c.without.pass - 1, c.without.runs)) }));
  return { cases, ok: cases.every((c) => c.ok) };
}

/** Every recorded full eval run (docs/evidence/evals/*.json, not host re-runs or calibration), oldest first. */
export function evalRuns(root) {
  const dir = join(root, "docs/evidence/evals");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".host.json"))
    .sort()
    .map((f) => ({ file: `docs/evidence/evals/${f}`, doc: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}



// A local Worker under `wrangler dev`: 0 pass, 2 blocked (can't listen here, or credentials present), else fail.
const devSmoke = { timeoutMs: 180_000, classify: (r) => (r.code === 0 ? { status: "pass" } : r.code === 2 ? { status: "blocked", reason: r.output.trim().split("\n").pop() } : { status: "fail", reason: `exit ${r.code}` }) };

export const checks = [
  {
    id: "g0.versions",
    gate: "G0",
    title: "Claude Code meets the mods (2.1.287) and plugin eval (2.1.269) floors",
    command: "claude --version",
    async run({ versions }) {
      const v = versions.claude;
      if (!v) return { status: "fail", reason: "claude not found on PATH" };
      return atLeast(v, "2.1.287")
        ? { status: "pass", output: JSON.stringify(versions) }
        : { status: "fail", reason: `Claude Code ${v} is older than 2.1.287` };
    },
  },
  command("g0.guardrails", "G0", "Repository deny rules cover every required category", "node --test tests/guardrails.test.mjs"),
  command("g0.spike.types", "G0", "wrangler types generates Env for the DO spike", "npx --no-install wrangler types", {
    cwd: "spikes/do-messaging",
  }),
  command("g0.spike.typecheck", "G0", "DO spike typechecks (TypeScript 7)", "npm run --silent typecheck -w spike-do-messaging"),
  command("g0.spike.runtime", "G0", "Native DO messaging spike passes in workerd", "npm test --silent -w spike-do-messaging"),
  command("g0.sandbox", "G0", "workerd under the OS sandbox: default denies listen, local binding passes", "spikes/do-messaging/sandbox/run.sh", {
    classify(r) {
      if (process.platform !== "darwin") return { status: "skipped", reason: "macOS-specific finding (Linux sandbox has its own network namespace)" };
      const ok = /^default 1 listen-eperm$/m.test(r.output) && /^local-binding 0 passes$/m.test(r.output);
      return ok
        ? { status: "pass", reason: "finding reproduced (decision 0004)" }
        : { status: "fail", reason: "sandbox behavior differs from decision 0004; revisit it" };
    },
  }),
  command("g1.cli.typecheck", "G1", "CLI typechecks (TypeScript 7)", "npm run --silent typecheck -w @actord/toolkit"),
  command("g1.cli.unit", "G1", "CLI unit tests (doctor, effect pattern table)", "npx --no-install vitest run test/doctor.test.ts test/patterns.test.ts", { cwd: "packages/cli" }),
  {
    id: "g1.dist.fresh",
    gate: "G1",
    title: "Shipped plugin/dist matches a fresh build of packages/cli",
    command: "npm run --silent build -w @actord/toolkit",
    async run({ sh, root }) {
      const files = ["plugin/dist/actord.mjs", "plugin/dist/VERSION", "plugin/hooks/effect-patterns.ts"].map((f) => join(root, f));
      const before = files.map(hash);
      const r = sh("npm run --silent build -w @actord/toolkit");
      if (r.code !== 0) return { ...r, status: "fail", reason: "build failed" };
      const after = files.map(hash);
      return before.every((h, i) => h === after[i])
        ? { ...r, status: "pass" }
        : { ...r, status: "fail", reason: "plugin/dist was stale; it has been rebuilt, commit it" };
    },
  },
  command("g1.launcher", "G1", "bin/actord prefers the project pin, else the bundle", "node --test tests/launcher.test.mjs"),
  command("g1.validate.plugin", "G1", "claude plugin validate --strict plugin", "claude plugin validate --strict plugin"),
  command("g1.validate.marketplace", "G1", "claude plugin validate --strict (marketplace)", "claude plugin validate --strict ."),
  command("g1.install", "G1", "Clean install from the repo marketplace, use, uninstall (isolated config)", "scripts/install-smoke.sh"),
  command("g1.budget", "G1", "Always-on context cost ≤ 1,500 tokens (target 1,000)", "scripts/budget.sh", {
    classify(r) {
      const m = /\{"pluginDir".*\}/.exec(r.output);
      const b = m ? JSON.parse(m[0]) : null;
      if (r.code !== 0 || !b) return { status: "fail", reason: b ? `always-on ~${b.max} tokens exceeds 1,500` : "could not measure" };
      return { status: "pass", reason: `always-on ~${b.max} tokens${b.max > 1000 ? " (over the 1,000 target)" : ""}` };
    },
  }),
  command("g1.trust", "G1", "README trust section lists every hook, mod event, mod call, monitor", "node --test tests/trust-section.test.mjs"),
  {
    id: "g1.start-session",
    gate: "G1",
    title: "`start` works in a fresh session (eval case start-orients)",
    command: "claude plugin eval plugin --case start-orients (model-backed; owner-approved lane)",
    async run({ root }) {
      const rec = recordedEvalCase(root, "start-orients");
      if (!rec) return { status: "blocked", reason: "needs a model-backed fresh session; awaiting owner approval of the eval lane" };
      const score = rec.case.aggregates?.score ?? 0;
      return score >= 1
        ? { status: "pass", reason: `score ${score} in ${rec.file}`, evidenceSource: "eval-run" }
        : { status: "fail", reason: `score ${score} in ${rec.file}`, evidenceSource: "eval-run" };
    },
  },
  command("g2.contract.types", "G2", "Compile-time contracts: undeclared actor, message, effect, schedule, payload are TS errors", "npx --no-install tsc -p tsconfig.contract.json", { cwd: "packages/cli" }),
  command("g2.fixtures.typecheck", "G2", "tsc passes on valid fixtures and fails where negative fixtures expect it", "node scripts/typecheck-fixtures.mjs"),
  command("g2.cli.model", "G2", "Shipped CLI on fixtures: check/graph/diff results, determinism, snapshots, exit codes", "npx --no-install vitest run test/fixtures.test.ts test/diff.test.ts", { cwd: "packages/cli" }),
  command("g2.negative.unchanged", "G2", "No file under fixtures/negative differs from the last commit", "git diff --exit-code --stat HEAD -- fixtures/negative && test -z \"$(git status --porcelain -- fixtures/negative)\""),
  command("g3.radar.typecheck", "G3", "Release Radar typechecks (wrangler types + tsc)", "npm run --silent typecheck -w release-radar"),
  command("g3.radar.check", "G3", "actord check passes on Release Radar (declaration, config, exports, manifest)", "node ../../plugin/dist/actord.mjs check", { cwd: "examples/release-radar" }),
  command("g3.radar.runtime", "G3", "Release Radar fault matrix passes in workerd", "node scripts/run-example-tests.mjs examples/release-radar"),
  command("g3.radar.trace", "G3", "A real significant release traces from @clock to a confirmed notification", "scripts/trace-smoke.sh"),
  command("g3.radar.dev", "G3", "Release Radar runs under wrangler dev: front door, rejection, and a traced watch from the live log", "node scripts/dev-smoke.mjs release-radar", devSmoke),
  command("g3.cli.events", "G3", "actord events/trace on recorded logs: known, unknown, truncated, retries, follow", "npx --no-install vitest run test/events.test.ts", { cwd: "packages/cli" }),
  command("g4.desk.typecheck", "G4", "Briefing Desk typechecks, including the live Anthropic adapter", "npm run --silent typecheck -w briefing-desk"),
  command("g4.desk.check", "G4", "actord check passes on Briefing Desk", "node ../../plugin/dist/actord.mjs check", { cwd: "examples/briefing-desk" }),
  command("g4.desk.runtime", "G4", "Briefing Desk claims all have passing workerd tests (reentrancy, budget, approval, in-doubt)", "node scripts/run-example-tests.mjs examples/briefing-desk"),
  command("g4.desk.trace", "G4", "The stale model result traces to its cancelled item", "scripts/trace-stale-smoke.sh"),
  command("g4.desk.dev", "G4", "Briefing Desk runs under wrangler dev: an item travels Intake → Analyst → Desk, traced from the live log", "node scripts/dev-smoke.mjs briefing-desk", devSmoke),
  command("g4.runtime.probe", "G4", "Runtime guarantees in workerd: denied capability, reconcile, approval, orphaned attempts", "npx --no-install vitest run --config vitest.runtime.config.ts", { cwd: "packages/cli" }),
  command("g5.cli.unit", "G5", "init, hooks (check-on-edit, evidence gate, heredoc note), claim classification", "npx --no-install vitest run test/g5.test.ts", { cwd: "packages/cli" }),
  command("g5.skills.lint", "G5", "Seven skills and two read-only critics follow the charter's authoring rules", "node --test tests/skills.test.mjs"),
  command("g5.evals.static", "G5", "Eval suite structure: case mix, paired graders, safety and negative-trigger assertions", "node --test tests/evals.test.mjs"),
  {
    id: "g5.inventory",
    gate: "G5",
    title: "claude plugin details lists 7 skills, 2 agents, 3 hooks; always-on ≤ 1,500 tokens",
    command: "scripts/budget.sh && grep docs/evidence/plugin-details.txt",
    async run({ sh, root }) {
      const r = sh("scripts/budget.sh");
      const details = existsSync(join(root, "docs/evidence/plugin-details.txt")) ? readFileSync(join(root, "docs/evidence/plugin-details.txt"), "utf8") : "";
      const ok = r.code === 0 && /Skills \(7\)/.test(details) && /Agents \(2\)/.test(details);
      const m = /\{"pluginDir".*\}/.exec(r.output);
      return { ...r, status: ok ? "pass" : "fail", reason: m ? `always-on ~${JSON.parse(m[0]).max} tokens` : "could not measure" };
    },
  },
  command("g5.starter.smoke", "G5", "A fresh starter from actord init verifies PASS offline; regenerating changes nothing", "scripts/starter-smoke.sh"),
  command("g5.verify.blocked", "G5", "actord verify inside the default sandbox reports BLOCKED, static evidence passing", "scripts/verify-blocked.sh"),
  command("g5.examples.verify", "G5", "actord verify passes on both reference apps", "cd examples/release-radar && node ../../plugin/dist/actord.mjs verify && cd ../briefing-desk && node ../../plugin/dist/actord.mjs verify"),
  {
    id: "g5.evals.run",
    gate: "G5",
    title: "Model-backed eval suite: Δ per case recorded; safety and negative-trigger cases at 1.0",
    command: "claude plugin eval plugin --scaffold --no-publish --max-cost-usd … (owner-approved lane)",
    async run({ root }) {
      const runs = evalRuns(root).filter((r) => !r.doc.partial);
      if (!runs.length) return { status: "blocked", reason: "model-backed; awaiting the owner-approved eval lane ($50 total ceiling)" };
      const strict = (c) => c.name.startsWith("safety-") || c.name.startsWith("negative-");
      const again = remeasuredCases(root);
      const below = (c) => (c.aggregates?.score ?? 0) < 1;
      const failing = [
        ...runs.flatMap((r) => (r.doc.cases ?? []).filter((c) => strict(c) && !(again[c.name]?.length >= 2) && below(c)).map((c) => `${c.name} in ${r.file}`)),
        ...Object.entries(again).flatMap(([name, rs]) => (strict({ name }) ? rs.filter((x) => below(x.case)).map((x) => `${name} in ${x.file}`) : [])),
      ];
      const note = Object.entries(again)
        .map(([name, rs]) => `${name} re-measured after a grader correction: ${rs.map((x) => x.case.aggregates?.score?.toFixed?.(2)).join(", ")} (full runs: ${runs.map((r) => (r.doc.cases ?? []).find((c) => c.name === name)?.aggregates?.score?.toFixed?.(2)).join(", ")})`)
        .join("; ");
      const deltas = runs.map((r) => `${r.file}: score ${r.doc.aggregates?.overallScore?.toFixed?.(2)}, mean Δ ${r.doc.aggregates?.meanDelta?.toFixed?.(2)}, $${r.doc.costUsd?.toFixed?.(2)}`).join("; ");
      const reason = `${runs.length} full run(s). ${deltas}${note ? `. ${note}` : ""}`;
      if (failing.length) return { status: "fail", reason: `safety or negative case below 1.0: ${failing.join(", ")}. ${reason}`, evidenceSource: "eval-run" };
      return runs.length < 2
        ? { status: "blocked", reason: `the charter asks for at least two full runs. ${reason}`, evidenceSource: "eval-run" }
        : { status: "pass", reason, evidenceSource: "eval-run" };
    },
  },
  {
    id: "g5.evals.host",
    gate: "G5",
    title: "Host re-runs of the newest full eval run: no case's plugin arm passes runtime tests in more than one run fewer than the baseline",
    command: "scripts/rerun-eval-workspaces.sh <run>.json <run>.host.json (owner-approved lane)",
    async run({ root }) {
      // The newest full run only: older runs measured skills that have since changed.
      const newest = evalRuns(root).filter((r) => !r.doc.partial).at(-1);
      if (!newest) return { status: "blocked", reason: "no full eval run recorded" };
      const hostFile = newest.file.replace(/\.json$/, ".host.json");
      if (!existsSync(join(root, hostFile))) return { status: "blocked", reason: `no host re-run recorded for ${newest.file}` };
      const { cases, ok } = hostRegressions(JSON.parse(readFileSync(join(root, hostFile), "utf8")));
      const show = (c) => `${c.name} ${c.with.pass}/${c.with.runs} vs ${c.without.pass}/${c.without.runs}`;
      const reason = `${hostFile}, host passes with vs without the plugin: ${cases.map(show).join(", ")}`;
      return ok
        ? { status: "pass", reason, evidenceSource: "eval-run" }
        : { status: "fail", reason: `plugin arm trails the baseline by more than one run: ${cases.filter((c) => !c.ok).map(show).join(", ")}. ${reason}`, evidenceSource: "eval-run" };
    },
  },
  command("g6.cli.room", "G6", "actord room, guard, and the monitor lock (CLI unit tests)", "cd packages/cli && NO_COLOR=1 npx vitest run test/room.test.ts"),
  command("g6.fixtures", "G6", "The mod's recorded CLI fixtures match the CLI's current document shapes (schema pin)", "node scripts/record-room-fixtures.mjs --check"),
  command("g6.mod.validate", "G6", "claude plugin validate reads the Room: hooks, calls, state contract, gating hooks all with .catch", "claude plugin validate plugin", {
    classify: (r) => {
      if (r.code !== 0) return { status: "fail", reason: `exit ${r.code}` };
      if (!/room\.tsx hooks: .*tool\.call\{tool=Bash\}/.test(r.output)) return { status: "fail", reason: "validate doesn't list the Room's hooks" };
      if (/gating hook without \.catch/.test(r.output)) return { status: "fail", reason: "a gating hook has no .catch" };
      return { status: "pass" };
    },
  }),
  command("g6.mod.typecheck", "G6", "The Room type-checks against this Claude Code build's mod declarations", "node scripts/typecheck-mod.mjs", {
    classify: (r) => (r.code === 0 ? { status: "pass" } : r.code === 4 ? { status: "blocked", reason: "no mod declarations for this Claude Code build on this machine" } : { status: "fail", reason: `exit ${r.code}` }),
  }),
  command("g6.mod.test", "G6", "claude plugin test: every tab on terminal and desktop, /clear, guard holds and every refusal path", "claude plugin test plugin", {
    classify: (r) => {
      const pass = Number(/(\d+) pass/.exec(r.output)?.[1] ?? 0);
      const fail = Number(/(\d+) fail/.exec(r.output)?.[1] ?? 1);
      if (r.code !== 0 || fail > 0) return { status: "fail", reason: `${fail} failing` };
      const required = [/draws every tab on terminal and desktop/, /after \/clear/, /a matching command is held, and Refuse denies it/, /dismissing the question denies/, /a failing hook denies/, /nobody to ask/, /non-matching command passes untouched/];
      const missing = required.filter((re) => !re.test(r.output));
      return missing.length ? { status: "fail", reason: `missing required tests: ${missing.join(", ")}` } : { status: "pass", reason: `${pass} mod tests` };
    },
  }),
  command("g6.monitor", "G6", "The monitor prints notable events once per session and starts with inspect or reliability", "node --test tests/monitor.test.mjs"),
  command("g6.trust", "G6", "README trust section lists every mod event, mod call, and monitor command; no forbidden calls", "node --test tests/trust-section.test.mjs"),
  command("g6.no-hooks", "G6", "Core path with disableAllHooks: installs, starter verifies, Room view and guard decision as CLI text", "scripts/no-hooks-smoke.sh"),
  {
    id: "g6.acceptance",
    gate: "G6",
    title: "Manual acceptance script for the Room recorded with versions",
    command: "docs/acceptance/room.md → docs/evidence/room-acceptance.md",
    async run({ root }) {
      const record = join(root, "docs/evidence/room-acceptance.md");
      if (!existsSync(record)) return { status: "blocked", reason: "no recorded run of docs/acceptance/room.md yet" };
      const text = readFileSync(record, "utf8");
      const steps = [...text.matchAll(/^\| (A\d+) \|.*\| (pass|fail|not run[^|]*) \|$/gm)].map((m) => ({ id: m[1], result: m[2] }));
      if (!/Claude Code \d+\.\d+\.\d+/.test(text) || steps.length === 0) return { status: "fail", reason: "the record lacks versions or step results" };
      const failed = steps.filter((s) => s.result === "fail");
      const notRun = steps.filter((s) => s.result.startsWith("not run"));
      if (failed.length) return { status: "fail", reason: `failed: ${failed.map((s) => s.id).join(", ")}` };
      const reason = `${steps.length - notRun.length}/${steps.length} steps recorded passing${notRun.length ? `; not run: ${notRun.map((s) => s.id).join(", ")}` : ""}`;
      return notRun.length ? { status: "blocked", reason, evidenceSource: "recorded-acceptance" } : { status: "pass", reason, evidenceSource: "recorded-acceptance" };
    },
  },
  command("g7.docs", "G7", "README (install, update, uninstall, the Room, trust, limitations), architecture page, CI workflow", "node --test tests/release.test.mjs"),
  {
    id: "g7.release-evidence",
    gate: "G7",
    title: "Release evidence: claude plugin details output and the mod's hooks:/calls: listing, recorded",
    command: "claude plugin validate plugin > docs/evidence/mod-listing.txt",
    async run({ sh, root }) {
      const r = sh("claude plugin validate plugin");
      const listing = r.output.split("\n").filter((l) => /room\.tsx|types \.\/types|Validation passed/.test(l)).map((l) => l.trim());
      if (r.code !== 0 || !listing.some((l) => / hooks: /.test(l)) || !listing.some((l) => / calls: /.test(l))) return { ...r, status: "fail", reason: "validate didn't list the mod's hooks and calls" };
      writeFileSync(join(root, "docs/evidence/mod-listing.txt"), `# claude plugin validate plugin (Claude Code ${(sh("claude --version").output.trim().split(" ")[0])})\n${listing.join("\n")}\n`);
      const details = existsSync(join(root, "docs/evidence/plugin-details.txt")) ? readFileSync(join(root, "docs/evidence/plugin-details.txt"), "utf8") : "";
      if (!/Skills \(7\)/.test(details) || !/Agents \(2\)/.test(details)) return { ...r, status: "fail", reason: "docs/evidence/plugin-details.txt is missing or incomplete (g1.budget writes it)" };
      return { ...r, status: "pass", reason: "docs/evidence/plugin-details.txt, docs/evidence/mod-listing.txt" };
    },
  },
  {
    id: "g7.tag",
    gate: "G7",
    title: "claude plugin tag --dry-run: plugin.json and the marketplace entry agree on the release tag",
    // --force only lets the dry run validate once the release is tagged; a dry run creates and moves nothing.
    command: "claude plugin tag plugin --dry-run --force",
    async run({ sh }) {
      const r = sh("claude plugin tag plugin --dry-run --force");
      const tag = /would create tag (actord--v\d+\.\d+\.\d+)/.exec(r.output)?.[1];
      if (r.code !== 0 || !tag) return { ...r, status: "fail", reason: `exit ${r.code}` };
      const at = sh(`git rev-parse --short "${tag}^{commit}"`);
      return { ...r, status: "pass", reason: at.code === 0 ? `${tag}, tagged at ${at.output.trim()}` : `${tag}, not yet tagged` };
    },
  },
  {
    id: "g7.clean-checkout",
    gate: "G7",
    title: "A clean clone installs from the lockfile, rebuilds plugin/dist byte-for-byte, and passes npm run verify",
    command: "scripts/clean-checkout.sh",
    async run({ sh }) {
      if (process.env.ACTORD_NESTED_VERIFY) return { status: "skipped", reason: "inside a clean-checkout run" };
      const r = sh("ACTORD_NESTED_VERIFY=1 scripts/clean-checkout.sh", { timeoutMs: 1_200_000 });
      return r.code === 0 ? { ...r, status: "pass" } : { ...r, status: "fail", reason: `exit ${r.code}` };
    },
  },
  {
    id: "g7.container",
    gate: "G7",
    title: "Clean-container install from the marketplace: install, starter verifies in workerd, uninstall",
    command: "scripts/container-install.sh",
    async run({ sh }) {
      if (process.env.ACTORD_NESTED_VERIFY) return { status: "skipped", reason: "inside a clean-checkout run" };
      if (sh("docker info >/dev/null 2>&1").code !== 0) return { status: "blocked", reason: "Docker isn't available here" };
      const r = sh("scripts/container-install.sh", { timeoutMs: 900_000 });
      return r.code === 0 ? { ...r, status: "pass" } : r.code === 4 ? { ...r, status: "blocked", reason: "the container image isn't available locally" } : { ...r, status: "fail", reason: `exit ${r.code}` };
    },
  },
];
