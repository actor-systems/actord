// The implementing agent's guardrails must keep denying each required category.
// This test can't exercise Claude Code's permission engine (decision 0001 records the in-session
// probes); it checks the committed rules still name what they must.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
const deny = settings.permissions.deny;

const required = {
  deployment: ["Bash(*wrangler deploy*)", "Bash(*wrangler versions deploy*)", "Bash(*void deploy*)", "Bash(cf deploy*)"],
  secrets: ["Bash(*wrangler secret*)", "Read(**/.dev.vars)", "Read(**/.env)"],
  "remote writes": ["Bash(*wrangler * --remote*)", "Bash(*wrangler * create*)", "Bash(cf * create*)"],
  publishing: ["Bash(*npm publish*)", "Bash(claude plugin tag*--push*)", "Bash(claude plugin eval*--publish-report*)"],
  "tag pushes": ["Bash(git*push*--tags*)", "Bash(git*push*--v0.*)"],
  "force pushes": ["Bash(git*push*--force*)", "Bash(git*push* -f*)", "Bash(git*push* +*)"],
};

for (const [category, rules] of Object.entries(required)) {
  test(`deny rules cover ${category}`, () => {
    for (const rule of rules) assert.ok(deny.includes(rule), `missing deny rule ${rule}`);
  });
}

test("model-backed evals and plain pushes still ask", () => {
  assert.ok(settings.permissions.ask.includes("Bash(claude plugin eval*)"));
  assert.ok(settings.permissions.ask.includes("Bash(git push*)"));
});

test("no allow rules widen the agent's authority", () => {
  assert.equal(settings.permissions.allow, undefined);
});
