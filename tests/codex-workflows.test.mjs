// The Codex skills each carry a hand-copied references/workflow.md. Nothing regenerates them, so this pins the copies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const skills = new URL("../plugins/codex/skills/", import.meta.url).pathname;
const workflow = (skill) =>
  readFileSync(`${skills}${skill}/references/workflow.md`, "utf8");
const identical = (names) => {
  const [first, ...rest] = names;
  for (const name of rest)
    assert.equal(
      workflow(name),
      workflow(first),
      `${name} drifted from ${first}`,
    );
};

test("the evolve, inspect and setup workflow.md copies are byte-identical", () => {
  identical([
    "evolve-actor-system",
    "inspect-actor-system",
    "setup-actor-project",
  ]);
});

test("the implement and verify workflow.md copies are byte-identical", () => {
  identical(["implement-actor-behavior", "verify-actor-reliability"]);
});

test("the design workflow.md stands alone", () => {
  const design = workflow("design-actor-system");
  for (const other of ["evolve-actor-system", "implement-actor-behavior"])
    assert.notEqual(design, workflow(other));
});
