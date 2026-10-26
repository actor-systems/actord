import { describe, expect, it } from "vitest";
import { askRules, bashRuleMatches, EFFECT_PATTERNS, matchEffect } from "../src/patterns.ts";

describe("effect pattern table", () => {
  for (const p of EFFECT_PATTERNS) {
    it(`${p.id}: every example matches the regex and at least one generated ask rule`, () => {
      for (const example of p.examples) {
        expect(p.regex.test(example), `${p.id} regex vs "${example}"`).toBe(true);
        const sub = example.split(/\s*(?:&&|\|\||;|\|)\s*/).at(-1)!;
        expect(askRules().some((r) => bashRuleMatches(r, sub)), `no ask rule matches "${sub}"`).toBe(true);
      }
    });
  }

  it.each([
    "wrangler dev",
    "npx wrangler types",
    "wrangler d1 execute DB --local --command 'select 1'",
    "npm test",
    "npm run verify",
    "actord check --json",
    "git commit -m 'describe the deploy plan'",
    "cat docs/deploy-plan.md",
  ])("does not flag local, read-only, or descriptive commands: %s", (cmd) => {
    expect(matchEffect(cmd).map((p) => p.id)).toEqual([]);
  });

  it("ask rules are unique and stable", () => {
    const rules = askRules();
    expect(new Set(rules).size).toBe(rules.length);
    expect(rules).toMatchSnapshot();
  });
});

describe("bashRuleMatches approximates Claude Code's documented semantics", () => {
  it.each([
    ["Bash(ls *)", "ls", true],
    ["Bash(ls *)", "ls -la", true],
    ["Bash(ls *)", "lsof", false],
    ["Bash(*wrangler deploy*)", "npx wrangler deploy --dry-run", true],
    ["Bash(npm run build)", "npm run build --watch", false],
  ])("%s vs %s", (rule, cmd, expected) => {
    expect(bashRuleMatches(rule, cmd)).toBe(expected);
  });
});
