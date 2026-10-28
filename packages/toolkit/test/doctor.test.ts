import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctor } from "../src/cli/commands/doctor.ts";
import { askRules } from "../src/patterns.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "actord-doctor-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const byId = (r: ReturnType<typeof doctor>, id: string) => r.data.findings.find((f) => f.id === id);

describe("actord doctor", () => {
  it("outside a project reports info, not errors, and exits 0", () => {
    const r = doctor(tmp(), {});
    expect(r.exitCode).toBe(0);
    expect(byId(r, "project")?.status).toBe("info");
    expect(byId(r, "credentials")?.message).toMatch(/never reads them/);
  });

  it("in a bare project names each missing piece with a fix", () => {
    const d = tmp();
    writeFileSync(join(d, "system.ts"), "export default {}\n");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x" }));
    const r = doctor(join(d), {});
    expect(byId(r, "project.pin")?.status).toBe("warn");
    expect(byId(r, "project.config")?.status).toBe("error");
    expect(byId(r, "project.permissions")?.status).toBe("warn");
    expect(r.exitCode).toBe(1);
    for (const f of r.data.findings.filter((f) => f.status === "warn" || f.status === "error")) expect(f.fix).toBeTruthy();
  });

  it("in a complete project finds the pin, config, verify skill, and every ask rule", () => {
    const d = tmp();
    writeFileSync(join(d, "system.ts"), "export default {}\n");
    writeFileSync(join(d, "package.json"), JSON.stringify({ devDependencies: { "@actord/toolkit": "0.2.0" } }));
    writeFileSync(join(d, "wrangler.jsonc"), "{}");
    mkdirSync(join(d, ".claude/skills/verify"), { recursive: true });
    writeFileSync(join(d, ".claude/skills/verify/SKILL.md"), "---\nname: verify\n---\n");
    writeFileSync(join(d, ".claude/settings.json"), JSON.stringify({ permissions: { ask: askRules() } }));
    mkdirSync(join(d, "src"));
    const r = doctor(join(d, "src"), {});
    expect(r.data.projectRoot).toBe(d);
    for (const id of ["project.pin", "project.config", "project.verify-skill", "project.permissions"]) {
      expect(byId(r, id)?.status, id).toBe("ok");
    }
  });

  it("requires Node 22.19: 22.18 is an error with the 22.19 fix, 22.19.0 passes", () => {
    const old = doctor(tmp(), {}, "22.18.9");
    expect(byId(old, "node")?.status).toBe("error");
    expect(byId(old, "node")?.message).toMatch(/older than 22\.19/);
    expect(byId(old, "node")?.fix).toMatch(/22\.19/);
    expect(byId(doctor(tmp(), {}, "22.19.0"), "node")?.status).toBe("ok");
    expect(byId(doctor(tmp(), {}, "24.1.0"), "node")?.status).toBe("ok");
  });

  it("warns when the plugin bundles a different version than the project pins", () => {
    const r = doctor(tmp(), { ACTORD_PLUGIN_VERSION: "9.9.9", ACTORD_LAUNCHER: "project-pin" });
    expect(byId(r, "cli.pin-mismatch")?.status).toBe("warn");
    expect(byId(r, "cli")?.message).toMatch(/project pin/);
  });
});
