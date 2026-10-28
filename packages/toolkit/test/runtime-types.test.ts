// The toolkit's structural binding types must accept the real ones. A project's `env` comes from `wrangler types`
// (workerd's own declarations), so this test generates them offline, as `actord verify` does, in a temp project
// shaped like the starter, and compiles adapters that take a binding straight from `env`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..", "..");
const bin = (name: string) => join(repo, "node_modules", ".bin", name);
const tmp = mkdtempSync(join(tmpdir(), "actord-runtime-types-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
// @actord/toolkit resolves through the repository's workspace link to the built package.
symlinkSync(join(repo, "node_modules"), join(tmp, "node_modules"));
mkdirSync(join(tmp, "src"));
writeFileSync(
  join(tmp, "wrangler.jsonc"),
  `${JSON.stringify({ name: "runtime-types", main: "src/index.ts", compatibility_date: "2026-10-01", send_email: [{ name: "MAIL" }] }, null, 2)}\n`,
);
writeFileSync(
  join(tmp, "tsconfig.json"),
  `${JSON.stringify({
    compilerOptions: {
      target: "es2024",
      module: "es2022",
      moduleResolution: "bundler",
      lib: ["es2024"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
      types: [],
    },
    include: ["src/**/*.ts", "worker-configuration.d.ts"],
  })}\n`,
);
writeFileSync(
  join(tmp, "src", "index.ts"),
  `import { approvalEmail } from "@actord/toolkit/sources";

// env.MAIL is workerd's SendEmail, exactly as \`wrangler types\` declares a send_email binding.
export const notify = (env: Env) => approvalEmail({ send: env.MAIL, from: "actord@example.com", to: "owner@example.com", secret: "s" });

export default {} satisfies ExportedHandler<Env>;
`,
);

// No credentials and an empty HOME: `wrangler types` reads only the config and its bundled workerd.
const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { cwd: tmp, encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmpdir(), WRANGLER_SEND_METRICS: "false" } });

describe("toolkit binding types against wrangler types", () => {
  it("approvalEmail takes env.MAIL, a send_email binding typed as workerd's SendEmail", () => {
    const types = run(bin("wrangler"), ["types"]);
    expect(types.status, types.stdout + types.stderr).toBe(0);
    const tsc = run(bin("tsc"), ["-p", "tsconfig.json", "--pretty", "false"]);
    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);
});
