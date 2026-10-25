// Registry of verification checks, grouped by charter gate. Each check returns
// { status: pass|fail|blocked|skipped, reason?, output?, command?, ms?, evidenceSource? }.

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

export const gates = [
  {
    id: "G0",
    title: "Ground truth",
    requires: ["g0.versions", "g0.guardrails", "g0.spike.types", "g0.spike.typecheck", "g0.spike.runtime", "g0.sandbox"],
  },
];

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
];
