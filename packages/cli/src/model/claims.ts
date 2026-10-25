// Reliability claims (actors.claims.json) classified against a test run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CLAIMS_FILE = "actors.claims.json";

export type Basis = "workerd" | "stub" | "not-guaranteed";
export type ClaimStatus = "proved-locally" | "stub-only" | "not-guaranteed" | "failing" | "untested" | "blocked";

export interface Claim {
  id: string;
  basis: Basis;
  statement: string;
  tests?: string[];
  why?: string;
}

export interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped" | string;
}

export interface ClassifiedClaim extends Claim {
  status: ClaimStatus;
  evidence: string[];
}

export function readClaims(root: string): { claims: Claim[]; error: string | null } {
  const path = join(root, CLAIMS_FILE);
  if (!existsSync(path)) return { claims: [], error: null };
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { claims?: Claim[] };
    return { claims: doc.claims ?? [], error: null };
  } catch (e) {
    return { claims: [], error: `${CLAIMS_FILE} doesn't parse: ${(e as Error).message}` };
  }
}

/**
 * A workerd or stub claim is established only when every tag it names has at least one passing test and
 * no failing test in this run. If the runtime suite couldn't run (blocked), nothing is
 * established; not-guaranteed claims are reported as such regardless.
 */
export function classifyClaims(claims: Claim[], tests: TestResult[] | null, blocked: boolean): ClassifiedClaim[] {
  return claims.map((c) => {
    if (c.basis === "not-guaranteed") return { ...c, status: "not-guaranteed", evidence: [] };
    if (blocked || !tests) return { ...c, status: "blocked", evidence: [] };
    const evidence: string[] = [];
    let status: ClaimStatus = c.basis === "workerd" ? "proved-locally" : "stub-only";
    for (const tag of c.tests ?? []) {
      // Tests skipped by the profile (for example [extended]) neither establish nor refute a claim.
      const tagged = tests.filter((t) => t.name.includes(`[${tag}]`));
      const failed = tagged.filter((t) => t.status === "failed");
      const passed = tagged.filter((t) => t.status === "passed");
      if (failed.length > 0) {
        status = "failing";
        evidence.push(...failed.map((t) => `failed: ${t.name}`));
      } else if (passed.length === 0) {
        if (status !== "failing") status = "untested";
        evidence.push(tagged.length ? `[${tag}] has only skipped tests` : `[${tag}] has no test`);
      } else evidence.push(...passed.map((t) => `passed: ${t.name}`));
    }
    if ((c.tests ?? []).length === 0) {
      status = "untested";
      evidence.push("names no tests");
    }
    return { ...c, status, evidence };
  });
}
