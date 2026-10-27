// Agent actors in the model: declaration helpers, manifest, AGENT_* check rules, diff classes and the graph, on
// in-memory declarations. The negative fixtures cover three codes end to end through the shipped CLI.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkProject } from "../src/model/check.ts";
import { diffManifests } from "../src/model/diff.ts";
import { loadProject, type Project, type WorkerConfig } from "../src/model/load.ts";
import { normalize, serializeManifest } from "../src/model/manifest.ts";
import { renderMermaid } from "../src/model/mermaid.ts";
import { computer, containerBackend, defineSystem, type EffectSpec, message, pi, type RouteSpec } from "../src/system.ts";

const Msg = (description: string) => message({ version: 1, description, payload: z.object({}) });
const messages = {
  "task.requested": Msg("Do a task"),
  "task.steer": Msg("Steer"),
  "task.stop": Msg("Stop"),
  "task.done": Msg("Done"),
  "agent.failed": Msg("Failed"),
  "agent.exhausted": Msg("Exhausted"),
};

const tool: EffectSpec = { description: "Open a PR", idempotency: "key", input: z.object({ title: z.string() }) };
const budget = { usd: 5, turns: 40, wallClock: "30m" } as const;

interface Opts {
  harness?: unknown | null;
  model?: unknown | null;
  returns?: string | null;
  budget?: Record<string, unknown> | null;
  on?: Record<string, string>;
  tools?: string[];
  effects?: Record<string, EffectSpec>;
  actorEffects?: string[];
  instructions?: string;
  routes?: RouteSpec[];
  extraMessages?: Record<string, unknown>;
  extraEffects?: Record<string, EffectSpec>;
}
const selfRoutes: RouteSpec[] = ["task.done", "agent.failed", "agent.exhausted"].map((message) => ({ from: "Coder", message, to: "Coder" }));
const baseRoutes: RouteSpec[] = [{ from: "@ingress", message: "task.requested", to: "Coder" }, ...selfRoutes];

function build(o: Opts = {}) {
  const harness = o.harness === null ? undefined : (o.harness ?? pi({ workspace: computer({ backend: containerBackend({ image: "./Dockerfile" }) }) }));
  return defineSystem({
    name: "agents",
    messages: { ...messages, ...(o.extraMessages ?? {}) },
    actors: {
      Coder: {
        binding: "CODER",
        kind: "agent",
        purpose: "Writes code",
        justification: ["state", "lifecycle"],
        ...(harness ? { harness } : {}),
        ...(o.model === null ? {} : { model: o.model ?? { id: "claude-opus-5-5", reasoning: "high" } }),
        instructions: o.instructions ?? "CODER.md",
        tools: o.tools ?? ["workspace.*", "open-pr"],
        on: o.on ?? { "task.requested": "start" },
        ...(o.returns === null ? {} : { returns: o.returns ?? "task.done" }),
        ...(o.budget === null ? {} : { budget: o.budget ?? budget }),
        effects: o.actorEffects ?? ["open-pr"],
      },
    },
    effects: { "open-pr": tool, ...(o.extraEffects ?? {}), ...(o.effects ?? {}) },
    routes: o.routes ?? baseRoutes,
  } as never);
}

function project(system: ReturnType<typeof build>, extra: Partial<Project> = {}, config: WorkerConfig | null = null): Project {
  const root = mkdtempSync(join(tmpdir(), "agents-model-"));
  writeFileSync(join(root, "CODER.md"), "# Coder\n");
  const cfg: WorkerConfig = config ?? { containers: [{ class_name: "Coder", scheduling_policy: "durable_object", images: { app: { dockerfile: "./Dockerfile" } } }] };
  return { root, system, manifest: normalize(system), loadError: null, config: cfg, configFile: "wrangler.jsonc", entryFile: null, entryExports: null, committedManifest: null, committedManifestRaw: null, ...extra };
}
const codes = (p: Project) =>
  checkProject(p)
    .filter((d) => /^AGENT_|^ACTOR_BUDGET/.test(d.code))
    .map((d) => `${d.severity}:${d.code}`);

describe("a valid agent", () => {
  it("passes every AGENT_* rule", () => {
    expect(codes(project(build()))).toEqual([]);
  });
});

describe("agent check rules", () => {
  it("AGENT_HARNESS_MISSING", () => {
    expect(codes(project(build({ harness: null, tools: ["open-pr"] })))).toEqual(["error:AGENT_HARNESS_MISSING"]);
  });
  it("AGENT_MODEL_MISSING", () => {
    expect(codes(project(build({ model: null })))).toEqual(["error:AGENT_MODEL_MISSING"]);
  });
  it("AGENT_RETURNS_MISSING", () => {
    expect(codes(project(build({ returns: null })))).toEqual(["error:AGENT_RETURNS_MISSING"]);
  });
  it("ACTOR_BUDGET_MISSING: an agent with no budget is told to declare usd, turns and wallClock", () => {
    const missing = checkProject(project(build({ budget: null }))).filter((d) => d.code === "ACTOR_BUDGET_MISSING");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.fix).toMatch(/usd/);
    expect(missing[0]!.fix).toMatch(/turns/);
    expect(missing[0]!.fix).toMatch(/wallClock/);
    expect(missing[0]!.fix).not.toMatch(/maxAttempts|timeoutMs/);
  });
  it("AGENT_BUDGET_INCOMPLETE: usd, turns and wallClock are all needed", () => {
    expect(codes(project(build({ budget: { usd: 5, turns: 40 } })))).toEqual(["error:AGENT_BUDGET_INCOMPLETE"]);
  });
  it("ACTOR_BUDGET_INVALID: usd positive and finite, turns whole, wallClock a duration", () => {
    for (const bad of [{ usd: 0 }, { usd: Infinity }, { usd: -1 }, { turns: 1.5 }, { turns: 0 }, { wallClock: "soon" }])
      expect(codes(project(build({ budget: { ...budget, ...bad } }))), JSON.stringify(bad)).toEqual(["error:ACTOR_BUDGET_INVALID"]);
    expect(codes(project(build({ budget: { ...budget, usd: 0.25 } })))).toEqual([]);
  });
  it("AGENT_ON_UNROUTED: an on message nothing delivers to the agent", () => {
    expect(codes(project(build({ on: { "task.requested": "start", "task.steer": "steer" } })))).toEqual(["error:AGENT_ON_UNROUTED"]);
  });
  it("AGENT_SELF_ROUTE_MISSING: returns, agent.failed and agent.exhausted need a route to itself", () => {
    expect(codes(project(build({ routes: baseRoutes.filter((r) => r.message !== "agent.failed") })))).toEqual(["error:AGENT_SELF_ROUTE_MISSING"]);
    expect(codes(project(build({ routes: baseRoutes.filter((r) => r.message !== "task.done") })))).toEqual(["error:AGENT_SELF_ROUTE_MISSING"]);
  });
  it("AGENT_TOOL_UNDECLARED: a tool that is neither workspace.* nor one of the actor's effects", () => {
    expect(codes(project(build({ tools: ["workspace.*", "open-pr", "ghost"] })))).toEqual(["error:AGENT_TOOL_UNDECLARED"]);
    expect(codes(project(build({ tools: ["workspace.*", "open-pr", "other"], extraEffects: { other: tool } })))).toEqual(["error:AGENT_TOOL_UNDECLARED"]);
    expect(codes(project(build({ tools: ["workspace.read", "workspace.edit", "open-pr"] })))).toEqual([]);
  });
  it("AGENT_TOOL_INPUT_MISSING: a tool effect needs input", () => {
    const noInput = { description: "Open a PR", idempotency: "key" } as EffectSpec;
    expect(codes(project(build({ effects: { "open-pr": noInput } })))).toEqual(["error:AGENT_TOOL_INPUT_MISSING"]);
  });
  it("AGENT_TOOL_APPROVAL_RESULT_MISSING warns: a tool that needs a person's approval has its result steered in by the probe without a result message (R20)", () => {
    const approved = { ...tool, approval: "human" } as EffectSpec;
    expect(codes(project(build({ effects: { "open-pr": approved } })))).toEqual(["warning:AGENT_TOOL_APPROVAL_RESULT_MISSING"]);
    expect(codes(project(build({ effects: { "open-pr": { ...approved, result: "task.done" } as EffectSpec } })))).toEqual([]);
    // Only the actor's tools count: an effect it requests itself may go without.
    expect(codes(project(build({ tools: ["workspace.*"], effects: { "open-pr": approved } })))).toEqual([]);
  });
  it("AGENT_WORKSPACE_TOOLS_WITHOUT_WORKSPACE", () => {
    expect(codes(project(build({ harness: pi() })))).toEqual(["error:AGENT_WORKSPACE_TOOLS_WITHOUT_WORKSPACE"]);
  });
  it("AGENT_EXEC_WITHOUT_BACKEND warns when workspace.* or workspace.exec has nowhere to run", () => {
    const noBackend = pi({ workspace: computer() });
    expect(codes(project(build({ harness: noBackend })))).toEqual(["warning:AGENT_EXEC_WITHOUT_BACKEND"]);
    expect(codes(project(build({ harness: noBackend, tools: ["workspace.exec", "open-pr"] })))).toEqual(["warning:AGENT_EXEC_WITHOUT_BACKEND"]);
    expect(codes(project(build({ harness: noBackend, tools: ["workspace.read", "open-pr"] })))).toEqual([]);
  });
  it("AGENT_LOCAL_ONLY_INVALID: a pattern Computer would reject", () => {
    const withLocal = (localOnly: string[]) => build({ harness: pi({ workspace: computer({ backend: containerBackend({ image: "./Dockerfile" }), localOnly }) }) });
    for (const bad of ["node_modules", "{a,b}", "/a[0-9]", "/a?", "/a\\b", "/a,b", "/a/***"])
      expect(codes(project(withLocal([bad]))), bad).toEqual(["error:AGENT_LOCAL_ONLY_INVALID"]);
    expect(codes(project(withLocal(["/node_modules", "**/*.log", "/build/**"])))).toEqual([]);
  });
  it("AGENT_CONTAINER_CONFIG_MISSING: needs a containers entry for the class with scheduling_policy durable_object and images, not image (R17)", () => {
    const sys = build();
    const images = { app: { dockerfile: "./Dockerfile" } };
    expect(codes(project(sys, {}, {}))).toEqual(["error:AGENT_CONTAINER_CONFIG_MISSING"]);
    expect(codes(project(sys, {}, { containers: [{ class_name: "Other", scheduling_policy: "durable_object", images }] }))).toEqual(["error:AGENT_CONTAINER_CONFIG_MISSING"]);
    expect(codes(project(sys, {}, { containers: [{ class_name: "Coder", images }] }))).toEqual(["error:AGENT_CONTAINER_CONFIG_MISSING"]);
    // wrangler rejects image for a container the Durable Object schedules, and needs images.
    expect(codes(project(sys, {}, { containers: [{ class_name: "Coder", scheduling_policy: "durable_object" }] }))).toEqual(["error:AGENT_CONTAINER_CONFIG_MISSING"]);
    expect(codes(project(sys, {}, { containers: [{ class_name: "Coder", scheduling_policy: "durable_object", image: "./Dockerfile" }] }))).toEqual(["error:AGENT_CONTAINER_CONFIG_MISSING"]);
    expect(codes(project(sys, {}, { containers: [{ class_name: "Coder", scheduling_policy: "durable_object", image: "./Dockerfile", images }] }))).toEqual(["error:AGENT_CONTAINER_CONFIG_MISSING"]);
    expect(codes(project(sys, {}, { containers: [{ class_name: "Coder", scheduling_policy: "durable_object", images }] }))).toEqual([]);
  });
  it("AGENT_NAME_RESERVED: agent.session and every agent.session.* name", () => {
    expect(codes(project(build({ extraEffects: { "agent.session": tool } })))).toEqual(["error:AGENT_NAME_RESERVED"]);
    expect(codes(project(build({ extraMessages: { "agent.session.settled": Msg("x") } })))).toEqual(["error:AGENT_NAME_RESERVED"]);
    expect(codes(project(build({ extraEffects: { "agent.session.steer": tool } })))).toEqual(["error:AGENT_NAME_RESERVED"]);
    expect(codes(project(build({ extraEffects: { "agent.sessions": tool } })))).toEqual([]);
  });
  it("AGENT_INSTRUCTIONS_MISSING: the file must exist next to system.ts", () => {
    expect(codes(project(build({ instructions: "missing.md" })))).toEqual(["error:AGENT_INSTRUCTIONS_MISSING"]);
  });
});

describe("agent manifest", () => {
  it("carries harness, model, instructions, tools, on, returns, the new budget fields and the effect input", () => {
    const m = normalize(build());
    const coder = m.actors[0]!;
    expect(coder).toMatchObject({
      harness: { kind: "pi", workspace: { kind: "computer", backend: { kind: "container", image: "./Dockerfile" } } },
      model: { id: "claude-opus-5-5", reasoning: "high" },
      instructions: "CODER.md",
      tools: ["open-pr", "workspace.*"],
      on: { "task.requested": "start" },
      returns: "task.done",
      budget: { usd: 5, turns: 40, wallClock: "30m", maxAttempts: null, timeoutMs: null },
    });
    expect(m.effects[0]!.input).toMatchObject({ type: "object", properties: { title: { type: "string" } } });
  });
  it("[agent-manifest-unchanged-without-agents] every committed example and valid fixture manifest is byte-identical", async () => {
    const repo = join(import.meta.dirname, "..", "..", "..");
    const dirs = ["examples", "fixtures/valid"].flatMap((d) => readdirSync(join(repo, d)).map((n) => join(repo, d, n)));
    let checked = 0;
    for (const dir of dirs) {
      const p = await loadProject(dir);
      if (!p.committedManifestRaw) continue;
      expect(p.loadError, dir).toBeNull();
      expect(serializeManifest(p.manifest!), dir).toBe(p.committedManifestRaw);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("agent diff", () => {
  const manifestOf = (o: Opts) => normalize(build(o));
  const kinds = (b: Opts, h: Opts) => diffManifests(manifestOf(b), manifestOf(h)).changes.map((c) => `${c.kind}:${c.compatibility}${c.requiresApproval ? ":approval" : ""}`);

  it("a model id change is risky and needs approval", () => {
    expect(kinds({}, { model: { id: "claude-sonnet-5-5", reasoning: "high" } })).toEqual(["agent.model:risky:approval"]);
  });
  it("a budget increase is risky; a decrease is compatible", () => {
    expect(kinds({}, { budget: { ...budget, usd: 10 } })).toEqual(["actor.budget:risky"]);
    expect(kinds({}, { budget: { ...budget, turns: 80 } })).toEqual(["actor.budget:risky"]);
    expect(kinds({}, { budget: { ...budget, wallClock: "1h" } })).toEqual(["actor.budget:risky"]);
    expect(kinds({}, { budget: { ...budget, usd: 1 } })).toEqual(["actor.budget:compatible"]);
    expect(kinds({}, { budget: { ...budget, wallClock: "10m" } })).toEqual(["actor.budget:compatible"]);
  });
  it("adding a tool is risky and needs approval; removing one is compatible", () => {
    const extra: Opts = { tools: ["workspace.*", "open-pr", "other"], extraEffects: { other: tool }, actorEffects: ["open-pr", "other"] };
    expect(kinds({}, extra)).toContain("agent.tool.added:risky:approval");
    expect(kinds(extra, {})).toContain("agent.tool.removed:compatible");
  });
  it("instructions changes are compatible", () => {
    expect(kinds({}, { instructions: "OTHER.md" })).toEqual(["agent.instructions:compatible"]);
  });
  it("an on verb change is breaking", () => {
    expect(kinds({}, { on: { "task.requested": "steer" } })).toEqual(["agent.on:breaking"]);
  });
});

describe("agent graph", () => {
  it("draws an agent as a hexagon with its tools as dotted edges to effects", () => {
    const text = renderMermaid(normalize(build()));
    expect(text).toContain('a_Coder{{"Coder<br/>agent"}}');
    expect(text).toContain("a_Coder -.-> e_open_pr");
    expect(text).toContain('e_open_pr(["open-pr"])');
  });
});
