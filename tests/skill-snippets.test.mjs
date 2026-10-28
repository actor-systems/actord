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

// Fenced ts/typescript blocks whose first line is `// actord:check [name]`.
function blocksOf(file) {
  const out = [];
  const re = /^```(?:ts|typescript)\n([\s\S]*?)^```$/gm;
  for (const m of readFileSync(file, "utf8").matchAll(re)) {
    const first = /^\/\/ actord:check(?: ([A-Za-z0-9_-]+))?[ \t]*$/.exec(
      m[1].split("\n", 1)[0],
    );
    if (first)
      out.push({
        name: first[1],
        code: m[1],
        line:
          readFileSync(file, "utf8").slice(0, m.index).split("\n").length + 1,
      });
  }
  return out;
}

// Types for the Workers runtime are not a dependency of the toolkit, so the snippets get the small slice they use.
const workersStub = `declare module "cloudflare:workers" {
  export class DurableObject<E = unknown> {
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
    [k: string]: any;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  [k: string]: any;
}
interface Env { [k: string]: any }
`;

const exportsMap = JSON.parse(
  readFileSync(join(toolkit, "package.json"), "utf8"),
).exports;
const paths = {};
for (const [sub, target] of Object.entries(exportsMap))
  if (target.types)
    paths[`@actord/toolkit${sub.slice(1)}`] = [join(toolkit, target.types)];
paths["agents"] = [join(repo, "node_modules/agents")];
paths["agents/*"] = [join(repo, "node_modules/agents/*")];
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

test("every // actord:check block typechecks against the built toolkit types", () => {
  assert.ok(
    existsSync(join(toolkit, "dist/types/runtime/index.d.ts")),
    "build first: npm run build -w @actord/toolkit",
  );
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "actord-snippets-")));
  try {
    const origin = new Map();
    writeFileSync(join(dir, "workers.d.ts"), workersStub);
    files.forEach((file, fi) => {
      const slug = relative(repo, file).replace(/[^A-Za-z0-9]+/g, "-");
      const sub = join(dir, String(fi));
      let n = 0;
      for (const b of blocksOf(file)) {
        mkdirSync(sub, { recursive: true });
        const name = b.name ? `${b.name}.ts` : `snippet-${slug}-${++n}.ts`;
        const target = join(sub, name);
        writeFileSync(target, b.code);
        origin.set(target, `${relative(repo, file)}:${b.line}`);
      }
    });
    if (origin.size === 0) return;
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
          );
        return at ? `${at[1]} (+${m[2]}): ${m[3]}` : l;
      });
    assert.equal(
      tsc.status,
      0,
      `snippets do not compile:\n${report.join("\n")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
