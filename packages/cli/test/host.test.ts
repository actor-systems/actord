import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { init } from "../src/cli/commands/init.ts";
import { doctor } from "../src/cli/commands/doctor.ts";
const dirs: string[] = [];
function temp() {
  const d = mkdtempSync(join(tmpdir(), "actord-host-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("Codex gets a project verify skill and guidance without Claude configuration", () => {
  const d = temp();
  const r = init(d, "app", { host: "codex", toolkit: "0.1.0" });
  const app = join(d, "app");
  expect(r.data.created).toContain("AGENTS.md");
  expect(existsSync(join(app, ".agents/skills/verify/SKILL.md"))).toBe(true);
  expect(existsSync(join(app, ".claude"))).toBe(false);
  const doc = doctor(app, {});
  expect(
    doc.data.findings.find((f) => f.id === "project.verify-skill")?.status,
  ).toBe("ok");
  expect(
    doc.data.findings.some(
      (f) => f.id === "claude" || f.id === "project.permissions",
    ),
  ).toBe(false);
});
it("Codex adoption preserves existing guidance and skills across repeated runs", () => {
  const d = temp();
  mkdirSync(join(d, ".agents/skills/verify"), { recursive: true });
  writeFileSync(join(d, "package.json"), "{}");
  writeFileSync(join(d, "AGENTS.md"), "my guidance");
  writeFileSync(join(d, ".agents/skills/verify/SKILL.md"), "my verify skill");
  for (let n = 0; n < 2; n++)
    expect(
      init(d, undefined, { host: "codex", adopt: true }).data.created,
    ).toEqual([]);
  expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe("my guidance");
  expect(readFileSync(join(d, ".agents/skills/verify/SKILL.md"), "utf8")).toBe(
    "my verify skill",
  );
});
it("a host-neutral project carries only shared runtime and evidence files", () => {
  const d = temp();
  const r = init(d, "plain", { host: "none", toolkit: "0.1.0" });
  expect(
    r.data.created.some(
      (f) =>
        f === "AGENTS.md" ||
        f === "CLAUDE.md" ||
        f.startsWith(".claude") ||
        f.startsWith(".agents"),
    ),
  ).toBe(false);
  expect(r.data.created).toContain("actord.claims.json");
  const doc = doctor(join(d, "plain"), {});
  expect(
    doc.data.findings.some(
      (f) => f.id === "claude" || f.id === "project.permissions",
    ),
  ).toBe(false);
  expect(() => init(d, "bad", { host: "unknown" })).toThrow(
    /Unknown actor host/,
  );
});
