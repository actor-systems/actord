// Every fenced ts block whose first line is `// actord:check` in the shipped plugin skills is typechecked against
// the built @actord/toolkit types and the real Workers runtime types, so a skill cannot teach an API the toolkit no
// longer has, or a call a user's project rejects. `// actord:check system` names a block `system.ts`, which sibling
// blocks of the same file may import as "./system"; the built `actord check` also loads each one under Node.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

const repo = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const toolkit = join(repo, "packages/toolkit");
const claude = join(repo, "plugins/claude");
const codex = join(repo, "plugins/codex");

const markdownIn = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => join(e.parentPath, e.name))
    : [];
const files = [
  ...markdownIn(join(claude, "skills")),
  ...markdownIn(join(claude, "agents")),
  ...markdownIn(join(codex, "skills")),
].sort();

// Fenced ts/typescript blocks whose first line is `// actord:check [name]`. Tolerates indented fences, CRLF and
// info strings (```ts title=x). A marker line outside a matched block, or a repeated sibling name, is an error.
function blocksOf(file) {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const out = [];
  const re =
    /^[ \t]*```(?:ts|typescript)\b[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  for (const m of text.matchAll(re)) {
    const first = /^\s*\/\/ actord:check(?: ([A-Za-z0-9_-]+))?[ \t]*$/.exec(
      m[1].split("\n", 1)[0],
    );
    if (!first) continue;
    // 1-based file line of the block's first code line (the marker).
    const line = text
      .slice(0, m.index + m[0].indexOf("\n") + 1)
      .split("\n").length;
    out.push({ name: first[1], code: m[1], line, n: out.length + 1 });
  }
  const markers = text
    .split("\n")
    .filter((l) => /^\s*\/\/ actord:check\b/.test(l)).length;
  assert.equal(
    markers,
    out.length,
    `${relative(repo, file)}: an // actord:check line is not the first line of a ts/typescript fenced block`,
  );
  const names = out.map((b) => b.name).filter(Boolean);
  assert.equal(
    new Set(names).size,
    names.length,
    `${relative(repo, file)}: duplicate // actord:check sibling name`,
  );
  return out;
}

// The snippets compile against the real Workers runtime types, as a user's project does: `wrangler types` (the
// repository's pinned wrangler and its bundled workerd, offline) generates them from this config, so `env` holds
// workerd's own binding types (Ai, R2Bucket, SendEmail), and "cloudflare:workers", DurableObjectState and the "*.txt"
// Text module are workerd's declarations. They are closed (no index signatures): a typo like ctx.storge fails.
// Add a binding here when a snippet reads another one from `env`.
const wranglerConfig = {
  name: "skill-snippets",
  compatibility_date: "2026-10-01",
  ai: { binding: "AI" },
  r2_buckets: [
    { binding: "DECISION_INPUTS", bucket_name: "decision-inputs" },
    { binding: "TRANSCRIPTS", bucket_name: "transcripts" },
  ],
  send_email: [{ name: "MAIL" }],
  vars: { OWNER: "owner@example.com", APPROVAL_FROM: "actord@example.com" },
  // As sources.md teaches: a clean clone has no .dev.vars, so `wrangler types` learns the secrets from here.
  secrets: { required: ["APPROVAL_SECRET"] },
};

function runtimeTypes(dir) {
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(wranglerConfig));
  // No Cloudflare credentials and an empty HOME: `wrangler types` reads only the config and its bundled workerd.
  const run = spawnSync(
    join(repo, "node_modules/.bin/wrangler"),
    ["types", "--path", join(dir, "worker-configuration.d.ts")],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        TMPDIR: tmpdir(),
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  assert.ifError(run.error);
  assert.equal(
    run.status,
    0,
    `wrangler types failed:\n${run.stdout}${run.stderr}`,
  );
}

const exportsMap = JSON.parse(
  readFileSync(join(toolkit, "package.json"), "utf8"),
).exports;
const paths = {};
for (const [sub, target] of Object.entries(exportsMap))
  if (target.types)
    paths[`@actord/toolkit${sub.slice(1)}`] = [join(toolkit, target.types)];
// The other packages a snippet may import, mapped entry by entry through their own `exports`: `paths` ignore
// `exports`, so a "agents/*" → "node_modules/agents/*" mapping can't find "agents/lifecycle" (dist/lifecycle).
const typesIn = (target) =>
  typeof target === "string"
    ? /\.d\.[cm]?ts$/.test(target)
      ? target
      : null
    : target && typeof target === "object"
      ? (target.types ?? typesIn(target.import) ?? typesIn(target.default))
      : null;
for (const pkg of ["agents", "zod", "vitest"]) {
  const root = join(repo, "node_modules", pkg);
  const entries = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).exports;
  for (const [sub, target] of Object.entries(entries)) {
    const types = !sub.includes("*") && typesIn(target);
    if (types) paths[`${pkg}${sub.slice(1)}`] = [join(root, types)];
  }
}
for (const scope of ["@earendil-works", "@cloudflare"])
  paths[`${scope}/*`] = [join(repo, "node_modules", scope, "*")];

const REQUIRED = [
  ...["runtime", "timers-and-jobs", "sources", "agents", "decisions"].map((n) =>
    join(claude, `skills/implement/references/${n}.md`),
  ),
  join(claude, "skills/design/references/declaration.md"),
  ...[
    "design-actor-system",
    "evolve-actor-system",
    "implement-actor-behavior",
    "inspect-actor-system",
    "setup-actor-project",
    "verify-actor-reliability",
  ].map((s) => join(codex, `skills/${s}/references/workflow.md`)),
];

test("the reference files that show runtime API each carry a checked block", () => {
  const problems = REQUIRED.flatMap((f) =>
    !existsSync(f)
      ? [`missing: ${relative(repo, f)}`]
      : blocksOf(f).length
        ? []
        : [`no // actord:check block: ${relative(repo, f)}`],
  );
  assert.deepEqual(problems, []);
});

test("the no-await rule is stated where handlers are written", () => {
  const holders = [
    join(claude, "skills/implement/SKILL.md"),
    join(claude, "skills/implement/references/runtime.md"),
    join(codex, "skills/implement-actor-behavior/SKILL.md"),
    join(claude, "agents/delivery-auditor.md"),
  ];
  const missing = holders
    .filter((f) => !/handlers may not await/i.test(readFileSync(f, "utf8")))
    .map((f) => relative(repo, f));
  assert.deepEqual(
    missing,
    [],
    "these files must say 'handlers may not await'",
  );
});

// Compiles blocks (as returned by blocksOf, tagged with file) in one temp project; returns tsc's status and report.
function compileSnippets(units) {
  const missing = Object.values(paths)
    .flat()
    .filter((t) => t.includes("/dist/types/") && !existsSync(t));
  assert.deepEqual(
    missing,
    [],
    "build first: npm run build -w @actord/toolkit",
  );
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "actord-snippets-")));
  try {
    const origin = new Map();
    runtimeTypes(dir);
    const dirs = new Map();
    for (const u of units) {
      if (!dirs.has(u.file)) dirs.set(u.file, join(dir, String(dirs.size)));
      const sub = dirs.get(u.file);
      mkdirSync(sub, { recursive: true });
      const slug = u.file.replace(/[^A-Za-z0-9]+/g, "-");
      const target = join(
        sub,
        u.name ? `${u.name}.ts` : `snippet-${slug}-${u.n}.ts`,
      );
      writeFileSync(target, u.code);
      origin.set(target, u);
    }
    assert.ok(origin.size > 0, "no // actord:check blocks found to compile");
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2024",
          lib: ["es2024"],
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
          noUncheckedIndexedAccess: true,
          allowImportingTsExtensions: true,
          types: ["node"],
          typeRoots: [join(repo, "node_modules/@types")],
          paths,
        },
        include: ["worker-configuration.d.ts", "**/*.ts"],
      }),
    );
    const tsc = spawnSync(
      join(repo, "node_modules/.bin/tsc"),
      ["-p", join(dir, "tsconfig.json"), "--pretty", "false"],
      { encoding: "utf8" },
    );
    assert.ifError(tsc.error);
    const report = (tsc.stdout + tsc.stderr)
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = /^(.+?\.ts)\((\d+),\d+\): (.*)$/.exec(l);
        // tsc prints paths relative to its own cwd, so match on the tail.
        const at =
          m &&
          [...origin].find(([target]) =>
            target.endsWith(m[1].replace(/^(\.\.\/)+/, "")),
          )?.[1];
        return at
          ? `${at.file} block #${at.n} (line ${at.line + Number(m[2]) - 1}): ${m[3]}`
          : l;
      });
    return { status: tsc.status, report };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every // actord:check block typechecks against the built toolkit and the real runtime types", () => {
  const units = files.flatMap((f) =>
    blocksOf(f).map((b) => ({ ...b, file: relative(repo, f) })),
  );
  const { status, report } = compileSnippets(units);
  assert.equal(status, 0, `snippets do not compile:\n${report.join("\n")}`);
});

test("the harness is strict: a misspelled Workers member fails to compile", () => {
  const code = [
    "// actord:check",
    'import { DurableObject } from "cloudflare:workers";',
    "export class A extends DurableObject {",
    "  f() { return this.ctx.storge; }",
    "}",
    "",
  ].join("\n");
  const { status, report } = compileSnippets([
    { file: "self-test.md", n: 1, line: 1, code },
  ]);
  assert.notEqual(
    status,
    0,
    "a typo'd ctx member compiled: the runtime types are too loose",
  );
  assert.match(report.join("\n"), /storge/);
});

test("the harness's env holds workerd's own binding types, not the toolkit's structural ones", () => {
  const code = [
    "// actord:check",
    'import { env } from "cloudflare:workers";',
    "export const bindings: [Ai, R2Bucket, R2Bucket, SendEmail, string] = [env.AI, env.DECISION_INPUTS, env.TRANSCRIPTS, env.MAIL, env.APPROVAL_SECRET];",
    "",
  ].join("\n");
  const { status, report } = compileSnippets([
    { file: "self-test.md", n: 1, line: 1, code },
  ]);
  assert.equal(status, 0, report.join("\n"));
});

// `actord check` imports system.ts under Node, so a declaration that compiles can still fail to load (an entry point
// that reaches cloudflare:workers). Each `// actord:check system` block runs through the built CLI, alone in a temp
// project. A lone block is only system.ts, so these errors, about files that sit next to it in a project, are expected;
// any other error fails the gate, as does a declaration that doesn't load.
const NOT_IN_A_BLOCK = new Map([
  ["CONFIG_MISSING", "no wrangler.jsonc: the block is the project's only file"],
  [
    "AGENT_CONTAINER_CONFIG_MISSING",
    "a Computer container is declared in wrangler.jsonc's containers, which a lone block has none of",
  ],
  [
    "AGENT_INSTRUCTIONS_MISSING",
    "an agent's instructions file sits next to system.ts, and the block doesn't carry it",
  ],
]);
const cli = join(claude, "dist/actord.mjs");

function checkSystem(code) {
  assert.ok(existsSync(cli), "build first: npm run build -w @actord/toolkit");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "actord-check-")));
  try {
    // @actord/toolkit (a workspace link to packages/toolkit) and zod resolve from the repository.
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
    writeFileSync(join(dir, "system.ts"), code);
    const run = spawnSync("node", [cli, "check", "--json"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.ifError(run.error);
    let result;
    try {
      result = JSON.parse(run.stdout);
    } catch {
      return [`no JSON from actord check: ${run.stdout}${run.stderr}`];
    }
    return [
      ...(result.skipped ? ["the check was skipped"] : []),
      ...result.diagnostics
        .filter((d) => d.severity === "error" && !NOT_IN_A_BLOCK.has(d.code))
        .map((d) => `${d.code}: ${d.message}`),
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("actord check loads every // actord:check system block, with no error a valid declaration shouldn't produce", () => {
  const systems = files.flatMap((f) =>
    blocksOf(f)
      .filter((b) => b.name === "system")
      .map((b) => ({ ...b, file: relative(repo, f) })),
  );
  assert.ok(systems.length > 0, "no // actord:check system blocks found");
  const problems = systems.flatMap((b) =>
    checkSystem(b.code).map((p) => `${b.file} (line ${b.line}): ${p}`),
  );
  assert.deepEqual(problems, []);
});

test("the check pass is strict: a system.ts importing a schema from an entry point Node can't load fails", () => {
  const code = [
    "// actord:check system",
    'import { defineSystem, message } from "@actord/toolkit/system";',
    'import { approvalDecided } from "@actord/toolkit/sources";',
    "",
    "export default defineSystem({",
    '  name: "self-test",',
    '  messages: { "approval.decided": message({ version: 1, description: "The owner answered", payload: approvalDecided }) },',
    '  actors: { Desk: { binding: "DESK", kind: "deterministic", purpose: "Applies decisions", justification: ["state"] } },',
    '  routes: [{ from: "@ingress", message: "approval.decided", to: "Desk" }],',
    "});",
    "",
  ].join("\n");
  assert.match(checkSystem(code).join("\n"), /DECLARATION_LOAD_FAILED/);
});
