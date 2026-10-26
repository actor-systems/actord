// The job-effect check rules, on in-memory declarations. fixtures/negative/job-deadline-missing covers
// JOB_DEADLINE_MISSING end to end through the shipped CLI; these pin the cases a fixture can't (warnings).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkProject } from "../src/model/check.ts";
import type { Project } from "../src/model/load.ts";
import { normalize } from "../src/model/manifest.ts";
import { defineSystem, type EffectSpec, type MessageSpec, message } from "../src/system.ts";

const Done = message({ version: 1, description: "CI finished", payload: z.object({ runId: z.string() }) });
const Start = message({ version: 1, description: "Start CI", payload: z.object({}) });

function jobCodes(job: EffectSpec, opts: { declareDone?: boolean; routeDone?: boolean } = {}) {
  const { declareDone = true, routeDone = true } = opts;
  const system = defineSystem({
    name: "jobs",
    messages: { "ci.start": Start, ...(declareDone ? { "ci.finished": Done } : {}) } as Record<string, MessageSpec>,
    actors: { Runner: { binding: "RUNNER", kind: "deterministic", purpose: "Runs CI", justification: ["state"], effects: ["ci.run"] } },
    effects: { "ci.run": job },
    routes: [{ from: "@ingress", message: "ci.start", to: "Runner" }, ...(routeDone ? [{ from: "@ingress" as const, message: "ci.finished", to: "Runner" as const }] : [])],
  });
  const project: Project = { root: "/nowhere", system, manifest: normalize(system), loadError: null, config: null, configFile: null, entryFile: null, entryExports: null, committedManifest: null, committedManifestRaw: null };
  return checkProject(project)
    .filter((d) => d.code.startsWith("JOB_"))
    .map((d) => `${d.severity}:${d.code}`);
}

const job = { description: "Run CI", kind: "job", idempotency: "key" } as const;

describe("job effect checks", () => {
  it("a job with a deadline that its completion message can reach passes", () => {
    expect(jobCodes({ ...job, deadline: "2h", completes: { message: "ci.finished" } })).toEqual([]);
    expect(jobCodes({ ...job, deadline: "2h", probe: { every: "1m" } }, { declareDone: false, routeDone: false })).toEqual([]);
  });

  it("JOB_DEADLINE_MISSING: no deadline, or one that isn't a duration", () => {
    expect(jobCodes({ ...job, completes: { message: "ci.finished" } })).toEqual(["error:JOB_DEADLINE_MISSING"]);
    expect(jobCodes({ ...job, deadline: "2x" as never, completes: { message: "ci.finished" } })).toEqual(["error:JOB_DEADLINE_MISSING"]);
  });

  it("JOB_UNOBSERVABLE: neither probe nor completes is a warning", () => {
    expect(jobCodes({ ...job, deadline: "2h" })).toEqual(["warning:JOB_UNOBSERVABLE"]);
  });

  it("JOB_COMPLETES_ROUTE_MISSING: the completion message must be declared and routed to the requester", () => {
    expect(jobCodes({ ...job, deadline: "2h", completes: { message: "ci.finished" } }, { routeDone: false })).toEqual(["error:JOB_COMPLETES_ROUTE_MISSING"]);
    expect(jobCodes({ ...job, deadline: "2h", completes: { message: "ci.finished" } }, { declareDone: false, routeDone: false })).toEqual(["error:JOB_COMPLETES_ROUTE_MISSING"]);
  });

  it("a call effect is never checked as a job", () => {
    expect(jobCodes({ description: "Notify", idempotency: "key" })).toEqual([]);
  });
});

describe("approval expiry checks", () => {
  const codes = (fx: EffectSpec) => {
    const system = defineSystem({
      name: "approvals",
      messages: { "ci.start": Start, "ci.finished": Done } as Record<string, MessageSpec>,
      actors: { Runner: { binding: "RUNNER", kind: "deterministic", purpose: "Runs CI", justification: ["state"], effects: ["ci.run"] } },
      effects: { "ci.run": fx },
      routes: [{ from: "@ingress", message: "ci.start", to: "Runner" }],
    });
    const project: Project = { root: "/nowhere", system, manifest: normalize(system), loadError: null, config: null, configFile: null, entryFile: null, entryExports: null, committedManifest: null, committedManifestRaw: null };
    return checkProject(project).filter((d) => d.code.startsWith("APPROVAL_")).map((d) => `${d.severity}:${d.code}`);
  };
  it("APPROVAL_EXPIRES_IGNORED: expires without approval: human", () => {
    expect(codes({ description: "x", idempotency: "key", expires: "1d" })).toEqual(["warning:APPROVAL_EXPIRES_IGNORED"]);
    expect(codes({ description: "x", idempotency: "key", approval: "none", expires: "1d" })).toEqual(["warning:APPROVAL_EXPIRES_IGNORED"]);
    expect(codes({ description: "x", idempotency: "key", approval: "human", expires: "1d" })).toEqual([]);
    expect(codes({ description: "x", idempotency: "key" })).toEqual([]);
  });
});
