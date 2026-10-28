// The model-backed eval lane's housekeeping (scripts/eval-suite.sh): a full run keeps about 80 GB of workspaces,
// so the suite stops before spending anything when /tmp lacks room, and afterwards removes exactly the
// workspaces its run kept. Nothing here calls a model: `claude` on PATH is a stub that records being called.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;

// A kept workspace as the runner leaves it: out/trace.jsonl, a sealed directory, the whole thing read-only.
function keptWorkspace(dir, name, { trace = true } = {}) {
  const kept = join(dir, name);
  mkdirSync(join(kept, "out"), { recursive: true });
  mkdirSync(join(kept, "sealed", "home", "cwd"), { recursive: true });
  if (trace) writeFileSync(join(kept, "out", "trace.jsonl"), "{}\n");
  chmodSync(join(kept, "sealed"), 0o000);
  chmodSync(kept, 0o555);
  return kept;
}

function unseal(dir) {
  spawnSync("chmod", ["-R", "u+rwx", dir]);
  rmSync(dir, { recursive: true, force: true });
}

test("remove-eval-workspaces removes each kept workspace its result names, and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-scripts-"));
  try {
    const a = keptWorkspace(dir, "e-aaa111");
    const b = keptWorkspace(dir, "e-bbb222");
    const elsewhere = keptWorkspace(dir, "not-a-kept-workspace");
    const untraced = keptWorkspace(dir, "e-ccc333", { trace: false });
    const run = (kept) => ({ tracePath: join(kept, "out", "trace.jsonl") });
    const result = join(dir, "result.json");
    writeFileSync(
      result,
      JSON.stringify({
        cases: [
          { name: "one", arms: { with: [run(a), run(a)], without: [run(b)] } },
          { name: "two", arms: { with: [run(elsewhere), run(untraced), {}] } },
          { name: "three" },
        ],
      }),
    );
    const r = spawnSync("bash", [join(root, "scripts/remove-eval-workspaces.sh"), result], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed 2 kept eval workspaces/);
    assert.ok(!existsSync(a) && !existsSync(b), "the kept workspaces remain");
    assert.ok(existsSync(elsewhere), "a directory not named e-* was removed");
    assert.ok(existsSync(untraced), "a directory without out/trace.jsonl was removed");
  } finally {
    unseal(dir);
  }
});

test("eval-suite stops before calling claude when /tmp has less room than a run needs", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-scripts-"));
  const label = `eval-scripts-test-${process.pid}`;
  try {
    const bin = join(dir, "bin");
    const called = join(dir, "claude-was-called");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ntouch '${called}'\nexit 1\n`, { mode: 0o755 });
    const r = spawnSync("bash", [join(root, "scripts/eval-suite.sh"), label, "1"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ACTORD_EVAL_MIN_FREE_GB: "100000000" },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /GB free in \/tmp, 100000000 GB needed/);
    assert.ok(!existsSync(called), "claude was called");
    assert.ok(!existsSync(join(root, "docs/evidence/evals", `${label}.json`)), "a result file was written");
  } finally {
    unseal(dir);
    // Without the check the suite runs on past the stub and writes evidence under this label.
    for (const ext of ["json", "host.json", "log"]) rmSync(join(root, "docs/evidence/evals", `${label}.${ext}`), { force: true });
  }
});
