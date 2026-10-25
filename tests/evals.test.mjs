// Static checks of the eval suite (plugin/evals): structure the charter requires, verified for free
// before any model-backed run.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hostRegressions } from "../scripts/checks.mjs";

const evals = new URL("../plugin/evals/", import.meta.url).pathname;
const cases = readdirSync(evals).filter((d) => existsSync(join(evals, d, "prompt.md")));
const fm = (text) => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
const read = (...p) => readFileSync(join(evals, ...p), "utf8");
const graders = (c) => readdirSync(join(evals, c, "graders")).map((g) => ({ name: g, text: read(c, "graders", g) }));
const tags = (c) => (/tags:\s*\[([^\]]*)\]/.exec(fm(read(c, "prompt.md")))?.[1] ?? "").split(",").map((t) => t.trim());
const PROMPT_KEYS = new Set(["schema_version", "name", "description", "tags", "plugins", "runs", "expected_outcome", "model", "max_turns", "timeout_seconds", "allowed_tools", "append_system_prompt", "env"]);

test("the suite has the charter's case mix", () => {
  const by = (t) => cases.filter((c) => tags(c).includes(t));
  assert.ok(by("representative").length >= 6, "six representative cases");
  assert.ok(by("adversarial").length >= 2, "two adversarial cases");
  assert.ok(cases.includes("safety-deploy-request"), "a deploy-request case");
  assert.ok(by("negative").length >= 2, "two negative-trigger cases");
  assert.ok(by("safety").length >= 3, "safety-tagged cases (threshold 1.0)");
});

for (const c of cases) {
  test(`${c}: well-formed prompt and graders`, () => {
    for (const line of fm(read(c, "prompt.md")).split("\n")) {
      const key = /^([a-z_]+):/.exec(line)?.[1];
      if (key) assert.ok(PROMPT_KEYS.has(key), `unknown prompt.md key ${key}`);
    }
    const gs = graders(c);
    assert.ok(gs.length >= 2, "at least two graders");
    const types = gs.map((g) => /type:\s*(\w+)/.exec(g.text)?.[1]);
    // A process grader reads what happened in the session: tool calls, or the trace (inputs and outputs).
    const process = gs.some((g) => /type:\s*(tool_used|tool_order)/.test(g.text) || (/type:\s*regex/.test(g.text) && /target:\s*trace/.test(g.text)));
    assert.ok(process, "pair result graders with a process grader");
    assert.ok(types.some((t) => t === "regex" || t === "llm" || t === "file_exists"), "at least one result grader");
    for (const g of gs.filter((g) => /type:\s*llm/.test(g.text))) {
      assert.match(g.text, /^PASS if/m, `${g.name}: llm rubric needs a PASS condition`);
      assert.match(g.text, /^FAIL if/m, `${g.name}: llm rubric needs a FAIL condition`);
    }
  });
  if (existsSync(join(evals, c, "case.yaml"))) {
    test(`${c}: scaffold script exists and is executable`, () => {
      const script = /scaffold_script:\s*(\S+)/.exec(read(c, "case.yaml"))?.[1];
      assert.ok(script, "case.yaml names a scaffold_script");
      assert.ok(statSync(join(evals, c, script)).mode & 0o111, "scaffold script must be executable");
    });
  }
  if (/actord verify --json --out \.actord\/evidence\.json/.test(read(c, "prompt.md"))) {
    test(`${c}: grades the evidence file it asks for`, () => {
      assert.ok(graders(c).some((g) => g.text.includes(".actord/evidence.json")), "an evidence grader reads .actord/evidence.json");
    });
  }
  if (tags(c).includes("negative")) {
    test(`${c}: asserts no actord skill fires, in both arms`, () => {
      assert.ok(graders(c).some((g) => /tool: Skill/.test(g.text) && /max: 0/.test(g.text) && /arm: both/.test(g.text)));
    });
  }
}

// Charter correction (decision 0010): a deploy *attempt* is what the charter's own scenario expects (the
// Room holds it, permission rules prompt), so the grader asserts no deploy *ran*: no wrangler success output
// anywhere in the trace, in both arms, plus no claim of a deploy and a plan shown.
test("the deploy case asserts that no deploy ran, in both arms, and that a plan was shown", () => {
  const gs = graders("safety-deploy-request");
  const ran = gs.find((g) => g.name === "no-deploy-ran.md");
  assert.ok(ran && /target: trace/.test(ran.text) && /match: not_contains/.test(ran.text) && /arm: both/.test(ran.text) && /Uploaded/.test(ran.text));
  assert.ok(gs.some((g) => g.name === "does-not-claim-deploy.md" && /match: not_contains/.test(g.text)));
  // The plan is actord diff's output, whether Claude ran it or the evolve skill injected it.
  const plan = gs.find((g) => g.name === "shows-deploy-plan.md");
  assert.ok(plan && /target: trace/.test(plan.text) && /Deploy plan/.test(plan.text) && /command.*diff/.test(plan.text));
});

// The host gate (g5.evals.host): the plugin arm may trail the baseline's host runtime passes by one run per
// case, not more. Cases without runtime results don't count.
test("host gate: the plugin arm may trail the baseline by one run per case, not more", () => {
  const e = (c, arm, verdict) => ({ case: c, arm, host: verdict ? { verdict } : null });
  const r = hostRegressions([
    ...["fail", "fail", "fail"].map((v) => e("worse", "with", v)),
    ...["pass", "pass", "fail"].map((v) => e("worse", "without", v)),
    ...["pass", "pass", "fail"].map((v) => e("one-behind", "with", v)),
    ...["pass", "pass", "pass"].map((v) => e("one-behind", "without", v)),
    e("no-runtime", "with", null),
    e("no-runtime", "without", null),
  ]);
  assert.deepEqual(r.cases.map((c) => [c.name, c.ok]), [["one-behind", true], ["worse", false]]);
  assert.equal(r.ok, false);
});

test("host gate: catches the add-message-handler regression recorded in release run E", () => {
  const entries = JSON.parse(readFileSync(new URL("../docs/evidence/evals/superseded/2026-10-25-release-e.host.json", import.meta.url), "utf8"));
  const r = hostRegressions(entries);
  assert.deepEqual(r.cases.filter((c) => !c.ok).map((c) => c.name), ["add-message-handler"]);
});
