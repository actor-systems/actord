// Every fenced ts block whose first line is `// actord:check` in the shipped plugin skills is typechecked against
// the built @actord/toolkit types, so a skill cannot teach an API the toolkit no longer has.
// `// actord:check system` names a block `system.ts`, which sibling blocks of the same file may import as "./system".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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

// Types for the Workers runtime are not a dependency of the toolkit, so the snippets get the small slice they use.
// The stub is deliberately CLOSED (no index signatures): a typo like ctx.storge must fail. Extend it explicitly when
// a snippet needs another member.
const workersStub = `declare module "cloudflare:workers" {
  export class DurableObject<E = Env> {
    constructor(ctx: DurableObjectState, env: E);
    ctx: DurableObjectState;
    env: E;
  }
  export const env: Env;
}
interface DurableObjectState {
  id: { name?: string; toString(): string };
  waitUntil(promise: Promise<unknown>): void;
  storage: {
    sql: import("@actord/toolkit/runtime").SqlStorageLike;
    transaction<T>(closure: () => Promise<T>): Promise<T>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
// The bindings and vars the implement references read, each as narrow as the toolkit's own structural type.
interface Env {
  AI: import("@actord/toolkit/decisions").WorkersAI;
  DECISION_INPUTS: import("@actord/toolkit/decisions").DecisionInputs;
  TRANSCRIPTS: import("@actord/toolkit/agents").TranscriptBucket;
  MAIL: import("@actord/toolkit/sources").SendEmailLike;
  OWNER: string;
  APPROVAL_FROM: string;
  APPROVAL_SECRET: string;
}
// What \`wrangler types\` declares for its default Text rule: an agent's instructions file.
declare module "*.txt" {
  const value: string;
  export default value;
}
`;

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
    writeFileSync(join(dir, "workers.d.ts"), workersStub);
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
        include: ["workers.d.ts", "**/*.ts"],
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

test("every // actord:check block typechecks against the built toolkit types", () => {
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
    "a typo'd ctx member compiled: the stub is too loose",
  );
  assert.match(report.join("\n"), /storge/);
});
