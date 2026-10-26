import { describe, expect, it } from "vitest";
import { type Step, verdictReasons } from "../src/cli/commands/verify.ts";
import type { ClassifiedClaim } from "../src/model/claims.ts";

const step = (id: Step["id"], status: Step["status"], summary: string): Step => ({ id, status, command: "", durationMs: 0, summary });
const claim = (id: string, status: string) => ({ id, status }) as unknown as ClassifiedClaim;

describe("verdictReasons: why the verdict isn't pass, readable from the end of the output", () => {
  it("names a failed step even when no claim is failing (run F's misreading)", () => {
    const reasons = verdictReasons(
      [step("typecheck", "fail", "2 type errors"), step("check", "pass", "0 errors"), step("tests", "blocked", "sandbox: local port binding denied")],
      [claim("dedupe", "blocked"), claim("notify-once", "blocked")],
      null,
    );
    expect(reasons).toEqual(["typecheck failed (2 type errors)", "tests blocked (sandbox: local port binding denied)"]);
  });

  it("lists failing and untested claims by id", () => {
    expect(verdictReasons([step("tests", "pass", "11 passed")], [claim("a", "failing"), claim("b", "untested"), claim("c", "proved-locally")], null)).toEqual([
      "1 claim(s) failing: a",
      "1 claim(s) untested: b",
    ]);
  });

  it("is empty on a pass", () => {
    expect(verdictReasons([step("typecheck", "pass", "ok"), step("tests", "pass", "ok")], [claim("a", "proved-locally")], null)).toEqual([]);
  });
});
