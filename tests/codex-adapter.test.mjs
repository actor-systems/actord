import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fixture,
  run,
  root,
  coreVersion,
  coreArchive,
  adapterRoot,
} from "./codex-helpers.mjs";
import { entrypoint } from "../plugins/codex/src/launcher.mjs";

test("adapter uses the in-repository build and no vendored runtime", () => {
  assert(!fs.existsSync(path.join(adapterRoot, "vendor")));
  assert(!fs.existsSync(path.join(adapterRoot, "examples")));
  assert(!fs.existsSync(path.join(adapterRoot, "src/runtime.ts")));
  assert(fs.existsSync(path.join(adapterRoot, "dist", coreArchive)));
});
test("launcher honors the project pin from nested directories and avoids itself", (t) => {
  const dir = fixture(t);
  const nested = path.join(dir, "src");
  assert.equal(entrypoint(nested).source, "project-pin");
  const actual = run(nested, ["--version"]);
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.trim(), coreVersion);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "actord-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.equal(entrypoint(outside).source, "plugin-bundle");
});
test("launcher skips a core alias pointing back to the Codex adapter", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actord-self-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adapter = path.join(dir, "node_modules/@actord/toolkit");
  fs.mkdirSync(path.join(adapter, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(adapter, "bin/actord.js"),
    "throw Error('adapter recursion');",
  );
  fs.writeFileSync(
    path.join(adapter, "package.json"),
    JSON.stringify({
      name: "@actord/toolkit",
      bin: { actord: "bin/actord.js" },
    }),
  );
  const selected = entrypoint(path.join(dir, "src"), adapter);
  assert.equal(selected.source, "plugin-bundle");
  assert.equal(selected.entry, path.join(adapter, "dist/actord.mjs"));
  const link = path.join(dir, "linked-adapter");
  fs.symlinkSync(adapter, link, "dir");
  assert.equal(entrypoint(dir, link).source, "plugin-bundle");
});
test("graph exposes Mermaid only when requested and rejects unknown formats", (t) => {
  const dir = fixture(t);
  const manifestFile = path.join(dir, "actord.manifest.json");
  const before = fs.readFileSync(manifestFile, "utf8");
  const plain = run(dir, ["graph", "--json"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(Object.hasOwn(JSON.parse(plain.stdout), "mermaid"), false);
  const text = run(dir, ["graph", "--format", "mermaid"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^flowchart LR\n/);
  assert.match(text.stdout, /a_First -->\|"thing\.created@1"\| a_Second/);
  const json = run(dir, ["graph", "--format", "mermaid", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.equal(data.mermaid, text.stdout.trimEnd());
  assert.deepEqual(data.manifest, JSON.parse(plain.stdout).manifest);
  assert.equal(run(dir, ["graph", "--format", "mermaid"]).stdout, text.stdout);
  const bad = run(dir, ["graph", "--format", "dot"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /unknown --format/);
  assert.equal(run(dir, ["graph", "--format", "dot", "--json"]).status, 2);
  assert.equal(fs.readFileSync(manifestFile, "utf8"), before);
});
test("missing Wrangler config or Worker entry cannot pass project checks", (t) => {
  const dir = fixture(t);
  assert.equal(run(dir, ["check", "--json"]).status, 0);
  fs.renameSync(path.join(dir, "wrangler.jsonc"), path.join(dir, "saved.json"));
  const missing = run(dir, ["check", "--json"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /CONFIG_MISSING/);
  fs.renameSync(path.join(dir, "saved.json"), path.join(dir, "wrangler.jsonc"));
  fs.rmSync(path.join(dir, "src/index.ts"));
  const entry = run(dir, ["check", "--json"]);
  assert.equal(entry.status, 1);
  assert.match(entry.stdout, /ENTRY_(EXPORT_)?MISSING/);
});
test("actor class rename produces a breaking, irreversible lifecycle plan", (t) => {
  const dir = fixture(t);
  const base = path.join(dir, "before.json");
  fs.copyFileSync(path.join(dir, "actord.manifest.json"), base);
  const declaration = path.join(dir, "system.ts");
  fs.writeFileSync(
    declaration,
    fs.readFileSync(declaration, "utf8").replaceAll("Second", "Replacement"),
  );
  const result = run(dir, ["diff", "--base-file", base, "--json"]);
  assert.equal(result.status, 0);
  const d = JSON.parse(result.stdout);
  assert(d.summary.breaking > 0);
  assert.equal(d.summary.irreversible, true);
  assert(d.plan.some((s) => s.kind === "irreversible"));
  assert(d.plan.some((s) => s.kind === "lifecycle"));
});
test("trace orders parent before children and includes branches from the common cause", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "events.ndjson");
  const event = (id, cause, from, to) => ({
    $actord: 1,
    kind: "handled",
    at: 0,
    actor: to,
    messageId: id,
    type: "thing.created",
    version: 1,
    from,
    to,
    causationId: cause,
    correlationId: "root",
  });
  fs.writeFileSync(
    file,
    [
      event("a-child", "z-root", "First:main", "Second:main"),
      event("b-sibling", "z-root", "First:main", "Second:other"),
      event("z-root", null, "@ingress", "First:main"),
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  const result = run(dir, ["trace", "a-child", "--file", file, "--json"]);
  assert.equal(result.status, 0);
  const trace = JSON.parse(result.stdout);
  assert.equal(trace.root.messageId, "z-root");
  assert.deepEqual(
    trace.root.children.map((c) => c.messageId),
    ["a-child", "b-sibling"],
  );
  const text = run(dir, ["trace", "a-child", "--file", file]);
  assert(text.stdout.indexOf("(z-root)") < text.stdout.indexOf("(a-child)"));
});
test("Codex scaffold and adopt preserve host boundaries", (t) => {
  const parent = fixture(t);
  const app = path.join(parent, "new");
  let result = run(parent, ["init", app, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert(fs.existsSync(path.join(app, "AGENTS.md")));
  assert(fs.existsSync(path.join(app, ".agents/skills/verify/SKILL.md")));
  assert(!fs.existsSync(path.join(app, ".claude")));
  assert(fs.existsSync(path.join(app, "vendor", coreArchive)));
  const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json")));
  assert.equal(pkg.actord.host, "codex");
  assert.equal(pkg.actors, undefined);
  assert(fs.existsSync(path.join(app, "actord.claims.json")));
  const guidance = fs.readFileSync(path.join(app, "AGENTS.md"), "utf8");
  assert.match(guidance, /@actord\/toolkit/);
  assert.match(guidance, /npx actord check/);
  assert.match(
    fs.readFileSync(path.join(app, ".agents/skills/verify/SKILL.md"), "utf8"),
    /\.actord\/evidence\.json/,
  );
  fs.writeFileSync(path.join(app, "AGENTS.md"), "owner guidance");
  result = run(app, ["init", "--adopt", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(app, "AGENTS.md"), "utf8"),
    "owner guidance",
  );
  assert.equal(run(app, ["init", app]).status, 2);
  const doctor = JSON.parse(run(app, ["doctor", "--json"]).stdout);
  assert(
    !doctor.findings.some(
      (f) => f.id === "claude" || f.id === "project.permissions",
    ),
  );
});

for (const template of ["release-radar", "briefing-desk"])
  test(`${template} scaffolds an independent Codex reference app`, (t) => {
    const parent = fixture(t);
    const app = path.join(parent, template);
    const result = run(parent, ["init", app, "--template", template, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert(fs.existsSync(path.join(app, "AGENTS.md")));
    assert(!fs.existsSync(path.join(app, ".claude")));
    assert(fs.existsSync(path.join(app, "actord.manifest.json")));
    assert(fs.existsSync(path.join(app, "actord.claims.json")));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(app, "package.json"))).actord.host,
      "codex",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(app, "package.json")))
        .devDependencies["@actord/toolkit"],
      `file:vendor/${coreArchive}`,
    );
    fs.writeFileSync(path.join(app, "keep"), "sentinel");
    assert.equal(run(parent, ["init", app, "--template", template]).status, 2);
    assert.equal(fs.readFileSync(path.join(app, "keep"), "utf8"), "sentinel");
  });
