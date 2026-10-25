// `actors verify`: a project's full, noninteractive evidence workflow, and `actors test`, its test step.
// Writes machine-readable evidence (default .actors/evidence.json) that people, CI, the Room, and eval
// graders all read. It never deploys and never contacts Cloudflare.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type ClassifiedClaim, classifyClaims, readClaims, type TestResult } from "../../model/claims.ts";
import { SCHEMA_VERSION, VERSION } from "../../version.ts";
import type { CommandResult } from "../output.ts";
import { findProjectRoot, readJson } from "../project.ts";
import { check, EXIT_NO_PROJECT } from "./model.ts";

export type StepStatus = "pass" | "fail" | "blocked" | "skipped";

export interface Step {
  id: "typecheck" | "check" | "tests";
  status: StepStatus;
  command: string;
  durationMs: number;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface Evidence {
  projectRoot: string | null;
  generatedAt: string;
  system: string | null;
  profile: string;
  steps: Step[];
  claims: ClassifiedClaim[];
  summary: { provedLocally: number; stubOnly: number; notGuaranteed: number; blocked: number; failing: number; untested: number };
  verdict: "pass" | "fail" | "blocked";
}

const SANDBOX_BLOCK = /listen EPERM|operation not permitted.*(listen|bind)|EPERM.*127\.0\.0\.1/i;
const TEST_RESULTS = ".actors/vitest-results.json";

function run(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1", ...extraEnv }, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, ms: Date.now() - started };
}

const tail = (s: string, n = 15) => s.trimEnd().split("\n").slice(-n).join("\n");

/** Run the project's workerd tests through Vitest with a JSON report. */
export function runTests(root: string, profile: string): { step: Step; tests: TestResult[] | null; blocked: boolean } {
  const out = join(root, TEST_RESULTS);
  mkdirSync(dirname(out), { recursive: true });
  // The standard profile leaves out tests tagged [extended]; the extended profile runs everything.
  const args = ["--no-install", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${out}`];
  if (profile !== "extended") args.push("--testNamePattern", "^(?!.*\\[extended\\])");
  const r = run("npx", args, root, { ACTORS_FAULT_PROFILE: profile });
  const command = `npx vitest run${profile === "extended" ? "" : " (standard profile: [extended] tests excluded)"}`;
  if (SANDBOX_BLOCK.test(r.output)) {
    return {
      step: { id: "tests", status: "blocked", command, durationMs: r.ms, summary: "blocked: the sandbox denies local port binding, which workerd needs (see docs on network.allowLocalBinding)" },
      tests: null,
      blocked: true,
    };
  }
  let tests: TestResult[] | null = null;
  try {
    const doc = JSON.parse(readFileSync(out, "utf8")) as { testResults: Array<{ assertionResults: Array<{ fullName?: string; title: string; status: string }> }> };
    tests = doc.testResults.flatMap((f) => f.assertionResults.map((a) => ({ name: a.fullName ?? a.title, status: a.status })));
  } catch {
    tests = null;
  }
  if (!tests) return { step: { id: "tests", status: "fail", command, durationMs: r.ms, summary: `no test report (exit ${r.code})`, detail: { output: tail(r.output) } }, tests, blocked: false };
  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  return {
    step: {
      id: "tests",
      status: failed === 0 && r.code === 0 ? "pass" : "fail",
      command,
      durationMs: r.ms,
      summary: `${passed} passed, ${failed} failed, ${tests.length - passed - failed} skipped (workerd)`,
      detail: { passed, failed, total: tests.length, ...(failed ? { failures: tests.filter((t) => t.status === "failed").map((t) => t.name), output: tail(r.output) } : {}) },
    },
    tests,
    blocked: false,
  };
}

export async function verify(cwd: string, opts: { out?: string; profile?: string }): Promise<CommandResult<Evidence>> {
  const root = findProjectRoot(cwd);
  const profile = opts.profile === "extended" ? "extended" : "standard";
  const empty: Evidence = { projectRoot: null, generatedAt: new Date().toISOString(), system: null, profile, steps: [], claims: [], summary: { provedLocally: 0, stubOnly: 0, notGuaranteed: 0, blocked: 0, failing: 0, untested: 0 }, verdict: "fail" };
  if (!root) return { data: empty, text: `No actor project at ${cwd}.`, exitCode: EXIT_NO_PROJECT };
  const steps: Step[] = [];

  const pkg = readJson<{ scripts?: Record<string, string> }>(join(root, "package.json"));
  const tc = pkg?.scripts?.typecheck ? run("npm", ["run", "--silent", "typecheck"], root) : run("npx", ["--no-install", "tsc", "--noEmit"], root);
  steps.push({
    id: "typecheck",
    status: tc.code === 0 ? "pass" : "fail",
    command: pkg?.scripts?.typecheck ? "npm run typecheck" : "npx tsc --noEmit",
    durationMs: tc.ms,
    summary: tc.code === 0 ? "no type errors" : "type errors",
    ...(tc.code === 0 ? {} : { detail: { output: tail(tc.output, 25) } }),
  });

  const started = Date.now();
  const c = await check(root, {});
  steps.push({
    id: "check",
    status: c.data.ok ? "pass" : "fail",
    command: "actors check",
    durationMs: Date.now() - started,
    summary: `${c.data.errors} error(s), ${c.data.warnings} warning(s)`,
    detail: { errors: c.data.errors, warnings: c.data.warnings, codes: c.data.diagnostics.map((d) => `${d.severity}:${d.code}`) },
  });

  const t = runTests(root, profile);
  steps.push(t.step);
  const { claims: raw, error } = readClaims(root);
  const claims = classifyClaims(raw, t.tests, t.blocked);
  const count = (s: string) => claims.filter((x) => x.status === s).length;
  const summary = {
    provedLocally: count("proved-locally"),
    stubOnly: count("stub-only"),
    notGuaranteed: count("not-guaranteed"),
    blocked: count("blocked"),
    failing: count("failing"),
    untested: count("untested"),
  };
  const failed = steps.some((s) => s.status === "fail") || summary.failing > 0 || summary.untested > 0 || error !== null;
  const verdict: Evidence["verdict"] = failed ? "fail" : steps.some((s) => s.status === "blocked") ? "blocked" : "pass";
  const evidence: Evidence = { projectRoot: root, generatedAt: new Date().toISOString(), system: systemName(root), profile, steps, claims, summary, verdict };

  const outPath = resolve(cwd, opts.out ?? join(root, ".actors/evidence.json"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, command: "verify", toolkitVersion: VERSION, volatile: ["projectRoot", "generatedAt", "steps[].durationMs"], ...evidence }, null, 2)}\n`,
  );
  const lines = [
    `actors verify: ${evidence.system ?? "system"} · ${verdict.toUpperCase()} · evidence in ${relative(cwd, outPath) || outPath}`,
    ...steps.map((s) => `  ${s.status === "pass" ? "✓" : s.status === "blocked" ? "⊘" : "✗"} ${s.id.padEnd(9)} ${s.summary}`),
    ...(error ? [`  ✗ claims    ${error}`] : []),
    claims.length ? "" : "  (no actors.claims.json: nothing is claimed about delivery or effects)",
    ...(claims.length
      ? [
          `Claims: ${summary.provedLocally} proved locally · ${summary.stubOnly} stub only · ${summary.notGuaranteed} not guaranteed · ${summary.blocked} blocked · ${summary.failing} failing · ${summary.untested} untested`,
          ...claims.map((cl) => `  ${statusMark(cl.status)} ${cl.status.padEnd(14)} ${cl.id}: ${cl.statement}${cl.why ? ` (${cl.why})` : ""}`),
        ]
      : []),
  ];
  return { data: evidence, text: lines.join("\n"), exitCode: verdict === "fail" ? 1 : 0 };
}

function statusMark(s: string): string {
  return { "proved-locally": "✓", "stub-only": "~", "not-guaranteed": "·", blocked: "⊘", failing: "✗", untested: "?" }[s] ?? "?";
}

function systemName(root: string): string | null {
  const m = readJson<{ system?: { name?: string } }>(join(root, "actors.manifest.json"));
  return m?.system?.name ?? null;
}

export function test(cwd: string, opts: { profile?: string }): CommandResult<{ projectRoot: string | null; step: Step | null }> {
  const root = findProjectRoot(cwd);
  if (!root) return { data: { projectRoot: null, step: null }, text: `No actor project at ${cwd}.`, exitCode: EXIT_NO_PROJECT };
  const t = runTests(root, opts.profile === "extended" ? "extended" : "standard");
  const text = `actors test: ${t.step.status} · ${t.step.summary}${t.step.detail?.output ? `\n${String(t.step.detail.output)}` : ""}`;
  return { data: { projectRoot: root, step: t.step }, text, exitCode: t.step.status === "pass" ? 0 : t.step.status === "blocked" ? 0 : 1 };
}

