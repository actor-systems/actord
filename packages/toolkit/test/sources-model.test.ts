// Sources (@github, @email) and approvals in the model: check rules, manifest, diff and graph, on in-memory
// declarations. The negative fixtures cover the main error codes end to end through the shipped CLI.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkProject } from "../src/model/check.ts";
import { diffManifests } from "../src/model/diff.ts";
import type { Project, WorkerConfig } from "../src/model/load.ts";
import { normalize, serializeManifest } from "../src/model/manifest.ts";
import { renderMermaid } from "../src/model/mermaid.ts";
import { defineSystem, type EffectSpec, inboundEmail, message, type RouteSpec, webhook } from "../src/system.ts";

const Issue = message({ version: 1, description: "An issue was opened", payload: z.object({ number: z.number() }) });
const Decision = message({ version: 1, description: "A person decided", payload: z.object({ answer: z.string() }) });
const Publish = message({ version: 1, description: "Publish", payload: z.object({}) });

const github = () =>
  webhook({
    path: "/hooks/github",
    verify: "github",
    secret: "GITHUB_WEBHOOK_SECRET",
    events: { "issues.opened": { message: "issue.opened", key: (e: { number: number }) => String(e.number), map: (e: { number: number }) => ({ number: e.number }) } },
  });
const email = () => inboundEmail({ secret: "APPROVAL_SECRET", owner: "OWNER_ADDRESS", from: "FROM_ADDRESS", send: "SEND_EMAIL", message: "approval.decided" });

interface Opts {
  sources?: Record<string, ReturnType<typeof github> | ReturnType<typeof email>>;
  routes?: RouteSpec[];
  effects?: Record<string, EffectSpec>;
  actorEffects?: string[];
  approvals?: { notify: string };
}
const baseRoutes: RouteSpec[] = [
  { from: "@github", message: "issue.opened", to: "Triage" },
  { from: "@email", message: "approval.decided", to: "Triage" },
  { from: "@ingress", message: "publish.requested", to: "Triage" },
];

function build(o: Opts = {}) {
  return defineSystem({
    name: "sources",
    messages: { "issue.opened": Issue, "approval.decided": Decision, "publish.requested": Publish },
    actors: { Triage: { binding: "TRIAGE", kind: "deterministic", purpose: "Triages", justification: ["state"], effects: o.actorEffects ?? [] } },
    sources: o.sources ?? { github: github(), email: email() },
    ...(o.effects ? { effects: o.effects } : {}),
    ...(o.approvals ? { approvals: o.approvals } : {}),
    routes: o.routes ?? baseRoutes,
  } as never);
}

function project(system: ReturnType<typeof build>, extra: Partial<Project> = {}): Project {
  const config: WorkerConfig = { vars: { GITHUB_WEBHOOK_SECRET: "x", APPROVAL_SECRET: "x", OWNER_ADDRESS: "x", FROM_ADDRESS: "x" }, send_email: [{ name: "SEND_EMAIL" }] };
  return { root: "/nowhere", system, manifest: normalize(system), loadError: null, config, configFile: "wrangler.jsonc", entryFile: null, entryExports: null, committedManifest: null, committedManifestRaw: null, ...extra };
}
const NEW = /^(SOURCE_|APPROVAL_NOTIFY|APPROVAL_ROUTE|PUBLISHES|ROUTE_INVALID_SENDER)/;
const codes = (p: Project) =>
  checkProject(p)
    .filter((d) => NEW.test(d.code))
    .map((d) => `${d.severity}:${d.code}`);

const notify: EffectSpec = { description: "Notify", idempotency: "key" };
const gated: EffectSpec = { description: "Publish", idempotency: "key", approval: "human" };

describe("source checks", () => {
  it("a source's sender may appear in routes, and check passes", () => {
    expect(codes(project(build()))).toEqual([]);
  });

  it("an undeclared source's sender is still an invalid sender", () => {
    const sys = build({ sources: {}, routes: baseRoutes.slice(2).concat([{ from: "@github", message: "issue.opened", to: "Triage" }]) });
    expect(codes(project(sys))).toEqual(["error:ROUTE_INVALID_SENDER"]);
  });

  it("SOURCE_ROUTE_MISSING: a mapped event's message has no route from the source", () => {
    expect(codes(project(build({ routes: baseRoutes.slice(1) })))).toEqual(["error:SOURCE_ROUTE_MISSING"]);
  });

  it("SOURCE_ROUTE_AMBIGUOUS: more than one route from the source carries the message", () => {
    const two = defineSystem({
      name: "two",
      messages: { "issue.opened": Issue, "approval.decided": Decision },
      actors: { A: { binding: "A", kind: "deterministic", purpose: "a", justification: ["state"] }, B: { binding: "B", kind: "deterministic", purpose: "b", justification: ["state"] } },
      sources: { github: github() },
      routes: [{ from: "@github", message: "issue.opened", to: "A" }, { from: "@github", message: "issue.opened", to: "B" }],
    } as never);
    expect(codes(project(two as never))).toEqual(["error:SOURCE_ROUTE_AMBIGUOUS"]);
  });

  it("SOURCE_PATH_DUPLICATE: two webhook sources on one path", () => {
    const other = webhook({ path: "/hooks/github", verify: "github", secret: "GITHUB_WEBHOOK_SECRET", events: {} }) as unknown as ReturnType<typeof github>;
    const sys = build({ sources: { github: github(), other, email: email() } });
    expect(codes(project(sys))).toEqual(["error:SOURCE_PATH_DUPLICATE"]);
  });

  it("SOURCE_NAME_RESERVED: a source named after a sender the runtime uses itself", () => {
    for (const name of ["clock", "ingress", "timer", "rpc"]) {
      const sys = build({ sources: { github: github(), [name]: email() }, routes: [baseRoutes[0]!, { from: `@${name}`, message: "approval.decided", to: "Triage" }, baseRoutes[2]!] });
      expect(codes(project(sys)), name).toEqual(["error:SOURCE_NAME_RESERVED"]);
    }
    // A name that only starts like one is fine.
    const sys = build({ sources: { github: github(), timers: email() }, routes: [baseRoutes[0]!, { from: "@timers", message: "approval.decided", to: "Triage" }, baseRoutes[2]!] });
    expect(codes(project(sys))).toEqual([]);
  });

  it("SOURCE_SECRET_UNDECLARED: a warning unless wrangler vars or .dev.vars.example names the secret", () => {
    const others = { OWNER_ADDRESS: "x", FROM_ADDRESS: "x" };
    const send_email = [{ name: "SEND_EMAIL" }];
    const bare = project(build(), { config: { vars: others, send_email } });
    expect(codes(bare)).toEqual(["warning:SOURCE_SECRET_UNDECLARED", "warning:SOURCE_SECRET_UNDECLARED"]);
    const dir = mkdtempSync(join(tmpdir(), "actord-src-"));
    writeFileSync(join(dir, ".dev.vars.example"), "# secrets\nGITHUB_WEBHOOK_SECRET=\nAPPROVAL_SECRET=changeme\n");
    expect(codes(project(build(), { config: { vars: others, send_email }, root: dir }))).toEqual([]);
    expect(codes(project(build(), { config: { vars: { ...others, GITHUB_WEBHOOK_SECRET: "x" }, send_email } }))).toEqual(["warning:SOURCE_SECRET_UNDECLARED"]);
  });

  const emailWithAuthserv = () => inboundEmail({ secret: "APPROVAL_SECRET", owner: "OWNER_ADDRESS", from: "FROM_ADDRESS", send: "SEND_EMAIL", authserv: "MAIL_AUTHSERV", message: "approval.decided" });
  const secrets = { GITHUB_WEBHOOK_SECRET: "x", APPROVAL_SECRET: "x" };
  const found = (p: Project, code: string) => checkProject(p).filter((d) => d.code === code).map((d) => [d.severity, d.subject, d.message, d.fix]);

  it("SOURCE_ENV_UNDECLARED: a warning for an email source's owner, from or authserv that neither wrangler vars nor .dev.vars.example names", () => {
    const sys = build({ sources: { github: github(), email: emailWithAuthserv() } });
    const send_email = [{ name: "SEND_EMAIL" }];
    // The scenario in #49: the source names MAIL_AUTHSERV, but wrangler calls the variable AUTHSERV.
    const misnamed = project(sys, { config: { vars: { ...secrets, OWNER_ADDRESS: "x", FROM_ADDRESS: "x", AUTHSERV: "mx.cloudflare.net" }, send_email } });
    expect(codes(misnamed)).toEqual(["warning:SOURCE_ENV_UNDECLARED"]);
    expect(found(misnamed, "SOURCE_ENV_UNDECLARED")).toEqual([
      ["warning", "@email", "@email trusts the authserv-id in MAIL_AUTHSERV, which is in neither wrangler vars nor .dev.vars.example, so every reply would be refused (authserv_missing)", "Add MAIL_AUTHSERV to wrangler vars, or list it in .dev.vars.example."],
    ]);
    // With none of them declared, each is named, with what the runtime would then do.
    expect(found(project(sys, { config: { vars: secrets, send_email } }), "SOURCE_ENV_UNDECLARED").map(([, subject, message]) => [subject, message])).toEqual([
      ["@email", "@email reads the owner's address from OWNER_ADDRESS, which is in neither wrangler vars nor .dev.vars.example, so every reply would be refused (owner_missing)"],
      ["@email", "@email sends its replies from the address in FROM_ADDRESS, which is in neither wrangler vars nor .dev.vars.example, so no reply could be sent"],
      ["@email", "@email trusts the authserv-id in MAIL_AUTHSERV, which is in neither wrangler vars nor .dev.vars.example, so every reply would be refused (authserv_missing)"],
    ]);
    // .dev.vars.example counts, as it does for the secret.
    const dir = mkdtempSync(join(tmpdir(), "actord-src-"));
    writeFileSync(join(dir, ".dev.vars.example"), "OWNER_ADDRESS=\nFROM_ADDRESS=\nMAIL_AUTHSERV=mx.cloudflare.net\n");
    expect(codes(project(sys, { config: { vars: secrets, send_email }, root: dir }))).toEqual([]);
    // A source without authserv isn't asked for one, and a webhook source uses only its secret.
    expect(codes(project(build(), { config: { vars: { ...secrets, OWNER_ADDRESS: "x", FROM_ADDRESS: "x" }, send_email } }))).toEqual([]);
    expect(codes(project(build({ sources: { github: github() }, routes: [baseRoutes[0]!, baseRoutes[2]!] }), { config: { vars: { GITHUB_WEBHOOK_SECRET: "x" } } }))).toEqual([]);
  });

  it("SOURCE_SEND_UNDECLARED: a warning unless wrangler's send_email bindings declare the email source's send binding", () => {
    const vars = { ...secrets, OWNER_ADDRESS: "x", FROM_ADDRESS: "x" };
    const missing = project(build(), { config: { vars } });
    expect(codes(missing)).toEqual(["warning:SOURCE_SEND_UNDECLARED"]);
    expect(found(missing, "SOURCE_SEND_UNDECLARED")).toEqual([
      ["warning", "@email", "@email replies through the send_email binding SEND_EMAIL, which wrangler's send_email bindings don't declare, so the owner would never hear back", 'Add { "name": "SEND_EMAIL" } to send_email in the wrangler config.'],
    ]);
    // Another binding's name, or a variable of the same name, isn't the binding.
    expect(codes(project(build(), { config: { vars, send_email: [{ name: "EMAIL" }] } }))).toEqual(["warning:SOURCE_SEND_UNDECLARED"]);
    expect(codes(project(build(), { config: { vars: { ...vars, SEND_EMAIL: "x" } } }))).toEqual(["warning:SOURCE_SEND_UNDECLARED"]);
    expect(codes(project(build(), { config: { vars, send_email: [{ name: "EMAIL" }, { name: "SEND_EMAIL", allowed_destination_addresses: ["owner@example.com"] }] } }))).toEqual([]);
  });
});

describe("approval checks", () => {
  const withApproval = (o: Opts) => build({ actorEffects: ["notify", "publish"], effects: { notify, publish: gated }, approvals: { notify: "notify" }, ...o });

  it("a gated effect with its notify effect listed and an email route passes", () => {
    expect(codes(project(withApproval({})))).toEqual([]);
  });

  it("APPROVAL_NOTIFY_UNDECLARED: a gated actor doesn't list the notify effect", () => {
    expect(codes(project(withApproval({ actorEffects: ["publish"] })))).toEqual(["error:APPROVAL_NOTIFY_UNDECLARED"]);
  });

  it("APPROVAL_NOTIFY_NEEDS_APPROVAL: the notify effect is itself gated", () => {
    expect(codes(project(withApproval({ effects: { notify: gated, publish: gated } })))).toEqual(["error:APPROVAL_NOTIFY_NEEDS_APPROVAL"]);
  });

  it("APPROVAL_ROUTE_MISSING: no route from the email source carries the decision message to the actor", () => {
    expect(codes(project(withApproval({ routes: [baseRoutes[0]!, baseRoutes[2]!] })))).toContain("error:APPROVAL_ROUTE_MISSING");
  });

  it("APPROVAL_NOTIFY_UNKNOWN: notify names an undeclared effect, and nothing else is reported for it", () => {
    expect(codes(project(withApproval({ approvals: { notify: "ghost" } })))).toEqual(["error:APPROVAL_NOTIFY_UNKNOWN"]);
  });

  it("two gated actors and one email source pass check: the email source may route to each", () => {
    const sys = defineSystem({
      name: "two-gated",
      messages: { "approval.decided": Decision, "publish.requested": Publish },
      actors: {
        A: { binding: "A", kind: "deterministic", purpose: "a", justification: ["state"], effects: ["notify", "publish"] },
        B: { binding: "B", kind: "deterministic", purpose: "b", justification: ["state"], effects: ["notify", "publish"] },
      },
      effects: { notify, publish: gated },
      approvals: { notify: "notify" },
      sources: { email: email() },
      routes: [
        { from: "@email", message: "approval.decided", to: "A" },
        { from: "@email", message: "approval.decided", to: "B" },
        { from: "@ingress", message: "publish.requested", to: "A" },
        { from: "@ingress", message: "publish.requested", to: "B" },
      ],
    } as never);
    expect(codes(project(sys as never))).toEqual([]);
  });

  it("PUBLISHES_WITHOUT_APPROVAL: publishes needs approval: human", () => {
    const sys = build({ actorEffects: ["publish"], effects: { publish: { description: "Publish", idempotency: "key", publishes: true } } });
    expect(codes(project(sys))).toEqual(["error:PUBLISHES_WITHOUT_APPROVAL"]);
    const ok = build({ actorEffects: ["publish"], effects: { publish: { ...gated, publishes: true } } });
    expect(codes(project(ok))).toEqual([]);
  });
});

describe("manifest", () => {
  it("the manifest lists sources without their functions", () => {
    const m = normalize(build({ actorEffects: ["publish"], effects: { publish: { ...gated, publishes: true } }, approvals: { notify: "notify" } }));
    expect(m.sources).toEqual([
      { name: "email", kind: "email", path: null, verify: null, events: [], message: "approval.decided" },
      { name: "github", kind: "webhook", path: "/hooks/github", verify: "github", events: [{ event: "issues.opened", message: "issue.opened" }], message: null },
    ]);
    expect(m.approvals).toEqual({ notify: "notify" });
    expect(m.effects[0]).toMatchObject({ publishes: true });
    const text = serializeManifest(m);
    expect(text).not.toMatch(/=>|function|"map":|"key":/);
    expect(JSON.parse(text).sources).toHaveLength(2);
  });

  it("a system with no sources has sources: [] and approvals: null, and publishes only when true", () => {
    const m = normalize(build({ sources: {}, routes: baseRoutes.slice(2), actorEffects: ["notify"], effects: { notify } }));
    expect(m.sources).toEqual([]);
    expect(m.approvals).toBeNull();
    expect("publishes" in m.effects[0]!).toBe(false);
  });
});

describe("diff", () => {
  const manifestOf = (o: Opts) => normalize(build(o));
  const kinds = (b: Opts, h: Opts) => diffManifests(manifestOf(b), manifestOf(h)).changes.map((c) => `${c.kind}:${c.compatibility}`);

  it("diff classifies source changes", () => {
    const only = { sources: { github: github() }, routes: [baseRoutes[0]!, baseRoutes[2]!] };
    const both = {};
    expect(kinds(only, both).filter((k) => k.startsWith("source."))).toEqual(["source.added:compatible"]);
    expect(kinds(both, only).filter((k) => k.startsWith("source."))).toEqual(["source.removed:breaking"]);

    const gh = (over: object, events?: object) => ({ sources: { github: { ...github(), ...over, ...(events ? { events } : {}) }, email: email() } }) as Opts;
    const ev = { "issues.opened": github().events["issues.opened"]!, "issues.closed": { ...github().events["issues.opened"]!, message: "issue.opened" } };
    expect(kinds(gh({}), gh({}, ev)).filter((k) => k.startsWith("source."))).toEqual(["source.event.added:compatible"]);
    expect(kinds(gh({}, ev), gh({})).filter((k) => k.startsWith("source."))).toEqual(["source.event.removed:risky"]);
    expect(kinds(gh({}), gh({ path: "/hooks/gh2" })).filter((k) => k.startsWith("source."))).toEqual(["source.path:risky"]);
    expect(kinds(gh({}), gh({ secret: "OTHER" }))).toEqual([]);
  });

  it("publishes and approvals.notify changes are risky, and nothing is unclassified", () => {
    const eff = (publishes: boolean): Opts => ({ actorEffects: ["publish"], effects: { publish: { ...gated, ...(publishes ? { publishes } : {}) } } });
    expect(kinds(eff(false), eff(true))).toEqual(["effect.publishes:risky"]);
    const ap = (n: string): Opts => ({ actorEffects: ["a", "b"], effects: { a: notify, b: notify }, approvals: { notify: n } });
    expect(kinds(ap("a"), ap("b"))).toEqual(["approvals.notify:risky"]);
    const all = [...kinds(eff(false), eff(true)), ...kinds(ap("a"), ap("b"))];
    expect(all.some((k) => k.includes("changed"))).toBe(false);
  });

  it("source verify, message, kind and event remaps are risky, and a field with no rule is unclassified", () => {
    const gh = (over: object): Opts => ({ sources: { github: { ...github(), ...over }, email: email() } }) as Opts;
    expect(kinds(gh({}), gh({ verify: "gitlab" })).filter((k) => k.startsWith("source."))).toEqual(["source.verify:risky"]);
    const em = (over: object): Opts => ({ sources: { github: github(), email: { ...email(), ...over } } }) as Opts;
    expect(kinds(em({}), em({ message: "other.decided" })).filter((k) => k.startsWith("source."))).toEqual(["source.message:risky"]);
    const remap = { "issues.opened": { ...github().events["issues.opened"]!, message: "publish.requested" } };
    expect(kinds(gh({}), gh({ events: remap })).filter((k) => k.startsWith("source."))).toEqual(["source.event.message:risky"]);
    const asEmail = { sources: { github: { ...email() }, email: email() } } as Opts;
    expect(kinds({}, asEmail).filter((k) => k.startsWith("source."))).toContain("source.kind:risky");
    const base = manifestOf({});
    const head = JSON.parse(JSON.stringify(base)) as typeof base;
    (head.sources[1] as unknown as Record<string, unknown>).newField = "x";
    const d = diffManifests(base, head).changes.filter((c) => c.kind === "source.changed");
    expect(d.map((c) => c.compatibility)).toEqual(["risky"]);
  });

  it("approvals added and removed are risky, and publishes on needs a person's approval", () => {
    const ap = (a?: string): Opts => ({ actorEffects: ["a"], effects: { a: notify }, ...(a ? { approvals: { notify: a } } : {}) });
    expect(kinds(ap(), ap("a"))).toEqual(["approvals.notify:risky"]);
    expect(kinds(ap("a"), ap())).toEqual(["approvals.notify:risky"]);
    const eff = (publishes: boolean): Opts => ({ actorEffects: ["publish"], effects: { publish: { ...gated, ...(publishes ? { publishes } : {}) } } });
    const c = diffManifests(manifestOf(eff(false)), manifestOf(eff(true))).changes.find((x) => x.kind === "effect.publishes");
    expect(c?.requiresApproval).toBe(true);
    const off = diffManifests(manifestOf(eff(true)), manifestOf(eff(false))).changes.find((x) => x.kind === "effect.publishes");
    expect(off?.requiresApproval).toBe(false);
  });

  it("a baseline manifest written before sources reads as none", () => {
    const old = JSON.parse(JSON.stringify(manifestOf({ sources: {}, routes: baseRoutes.slice(2) }))) as Record<string, unknown>;
    delete old.sources;
    delete old.approvals;
    const d = diffManifests(old as never, manifestOf({ sources: {}, routes: baseRoutes.slice(2) }));
    expect(d.changes).toEqual([]);
  });
});

describe("graph", () => {
  it("the graph draws a source as an outside node", () => {
    expect(renderMermaid(normalize(build()))).toContain('x_github(["@github"])');
  });
});
