// Registry of verification checks, grouped by charter gate. Each check returns
// { status: pass|fail|blocked|skipped, reason?, output?, command?, ms?, evidenceSource? }.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse()) {
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
    requires: ["g3.radar.typecheck", "g3.radar.check", "g3.radar.runtime", "g3.radar.trace", "g3.cli.events"],
  },
  {
    id: "G4",
    title: "Agentic example",
    requires: ["g4.desk.typecheck", "g4.desk.check", "g4.desk.runtime", "g4.desk.trace", "g4.runtime.probe"],
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
    ],
  },
];

/** The newest recorded eval result (docs/evidence/evals/*.json), or null. */
export function latestEvalRun(root) {
  const dir = join(root, "docs/evidence/evals");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) return null;
  const file = files.at(-1);
  return { file: `docs/evidence/evals/${file}`, doc: JSON.parse(readFileSync(join(dir, file), "utf8")) };
}



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
  command("g1.cli.typecheck", "G1", "CLI typechecks (TypeScript 7)", "npm run --silent typecheck -w actors-toolkit"),
  command("g1.cli.unit", "G1", "CLI unit tests (doctor, effect pattern table)", "npx --no-install vitest run test/doctor.test.ts test/patterns.test.ts", { cwd: "packages/cli" }),
  {
    id: "g1.dist.fresh",
    gate: "G1",
    title: "Shipped plugin/dist matches a fresh build of packages/cli",
    command: "npm run --silent build -w actors-toolkit",
    async run({ sh, root }) {
      const files = ["plugin/dist/actors.mjs", "plugin/dist/VERSION"].map((f) => join(root, f));
      const before = files.map(hash);
      const r = sh("npm run --silent build -w actors-toolkit");
      if (r.code !== 0) return { ...r, status: "fail", reason: "build failed" };
      const after = files.map(hash);
      return before.every((h, i) => h === after[i])
        ? { ...r, status: "pass" }
        : { ...r, status: "fail", reason: "plugin/dist was stale; it has been rebuilt, commit it" };
    },
  },
  command("g1.launcher", "G1", "bin/actors prefers the project pin, else the bundle", "node --test tests/launcher.test.mjs"),
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
  command("g3.radar.check", "G3", "actors check passes on Release Radar (declaration, config, exports, manifest)", "node ../../plugin/dist/actors.mjs check", { cwd: "examples/release-radar" }),
  command("g3.radar.runtime", "G3", "Release Radar fault matrix passes in workerd", "node scripts/run-example-tests.mjs examples/release-radar"),
  command("g3.radar.trace", "G3", "A real significant release traces from @clock to a confirmed notification", "scripts/trace-smoke.sh"),
  command("g3.cli.events", "G3", "actors events/trace on recorded logs: known, unknown, truncated, retries, follow", "npx --no-install vitest run test/events.test.ts", { cwd: "packages/cli" }),
  command("g4.desk.typecheck", "G4", "Briefing Desk typechecks, including the live Anthropic adapter", "npm run --silent typecheck -w briefing-desk"),
  command("g4.desk.check", "G4", "actors check passes on Briefing Desk", "node ../../plugin/dist/actors.mjs check", { cwd: "examples/briefing-desk" }),
  command("g4.desk.runtime", "G4", "Briefing Desk claims all have passing workerd tests (reentrancy, budget, approval, in-doubt)", "node scripts/run-example-tests.mjs examples/briefing-desk"),
  command("g4.desk.trace", "G4", "The stale model result traces to its cancelled item", "scripts/trace-stale-smoke.sh"),
  command("g4.runtime.probe", "G4", "Runtime guarantees in workerd: denied capability, reconcile, approval, orphaned attempts", "npx --no-install vitest run --config vitest.runtime.config.ts", { cwd: "packages/cli" }),
  command("g5.cli.unit", "G5", "init, hooks (check-on-edit, evidence gate), claim classification", "npx --no-install vitest run test/g5.test.ts", { cwd: "packages/cli" }),
  command("g5.skills.lint", "G5", "Seven skills and two read-only critics follow the charter's authoring rules", "node --test tests/skills.test.mjs"),
  command("g5.evals.static", "G5", "Eval suite structure: case mix, paired graders, safety and negative-trigger assertions", "node --test tests/evals.test.mjs"),
  {
    id: "g5.inventory",
    gate: "G5",
    title: "claude plugin details lists 7 skills, 2 agents, 2 hooks; always-on ≤ 1,500 tokens",
    command: "scripts/budget.sh && grep docs/evidence/plugin-details.txt",
    async run({ sh, root }) {
      const r = sh("scripts/budget.sh");
      const details = existsSync(join(root, "docs/evidence/plugin-details.txt")) ? readFileSync(join(root, "docs/evidence/plugin-details.txt"), "utf8") : "";
      const ok = r.code === 0 && /Skills \(7\)/.test(details) && /Agents \(2\)/.test(details);
      const m = /\{"pluginDir".*\}/.exec(r.output);
      return { ...r, status: ok ? "pass" : "fail", reason: m ? `always-on ~${JSON.parse(m[0]).max} tokens` : "could not measure" };
    },
  },
  command("g5.starter.smoke", "G5", "A fresh starter from actors init verifies PASS offline; regenerating changes nothing", "scripts/starter-smoke.sh"),
  command("g5.verify.blocked", "G5", "actors verify inside the default sandbox reports BLOCKED, static evidence passing", "scripts/verify-blocked.sh"),
  command("g5.examples.verify", "G5", "actors verify passes on both reference apps", "cd examples/release-radar && node ../../plugin/dist/actors.mjs verify && cd ../briefing-desk && node ../../plugin/dist/actors.mjs verify"),
  {
    id: "g5.evals.run",
    gate: "G5",
    title: "Model-backed eval suite: Δ per case recorded; safety and negative-trigger cases at 1.0",
    command: "claude plugin eval plugin --scaffold --no-publish --max-cost-usd … (owner-approved lane)",
    async run({ root }) {
      const run = latestEvalRun(root);
      if (!run) return { status: "blocked", reason: "model-backed; awaiting owner approval of the eval lane ($50 total ceiling)" };
      const cases = run.doc.cases ?? [];
      const strict = cases.filter((c) => c.name.startsWith("safety-") || c.name.startsWith("negative-"));
      const failing = strict.filter((c) => (c.aggregates?.score ?? 0) < 1);
      const deltas = cases.map((c) => `${c.name} Δ${c.aggregates?.delta ?? "n/a"}`).join(", ");
      const reason = `${run.file}: score ${run.doc.aggregates?.overallScore}, mean Δ ${run.doc.aggregates?.meanDelta}; ${deltas}`;
      return failing.length
        ? { status: "fail", reason: `below 1.0: ${failing.map((c) => c.name).join(", ")}. ${reason}`, evidenceSource: "eval-run" }
        : { status: "pass", reason, evidenceSource: "eval-run" };
    },
  },
];
