// bin/actord prefers a project's pinned CLI and otherwise runs the bundled build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const launcher = join(root, "plugin/bin/actord");
const bundled = readFileSync(join(root, "plugin/dist/VERSION"), "utf8").trim();

test("runs the bundled build outside any project", () => {
  const dir = mkdtempSync(join(tmpdir(), "actord-launcher-"));
  try {
    const r = spawnSync(launcher, ["--version"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), bundled);
    const d = spawnSync(launcher, ["doctor"], { cwd: dir, encoding: "utf8" });
    assert.match(d.stdout, /\(plugin bundle\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delegates to a pinned project CLI from a nested directory and passes the bundled version", () => {
  const dir = mkdtempSync(join(tmpdir(), "actord-launcher-"));
  try {
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(dir, "src/actors"), { recursive: true });
    const stub = join(dir, "node_modules/.bin/actord");
    writeFileSync(stub, '#!/bin/sh\necho "pinned $ACTORD_LAUNCHER $ACTORD_PLUGIN_VERSION $*"\n');
    chmodSync(stub, 0o755);
    const r = spawnSync(launcher, ["check", "--json"], { cwd: join(dir, "src/actors"), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `pinned project-pin ${bundled} check --json`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
