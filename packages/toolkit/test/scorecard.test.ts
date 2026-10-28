// `actord scorecard`: calibration of decision effects from the event log. The fixture
// (fixtures/events/decisions.ndjson) holds events shaped field for field like the runtime's: full model ids, Clairic's
// own field types, 64-hex input digests, a score's probabilities, and two instances of each actor whose decision keys
// collide, as per-repo or per-tenant instances' keys do. A decision id ("<effect>:<key>") is unique only within its
// instance, so the scorecard keys a record and its labels by the event's actor and the id. The hand-worked numbers:
//
// decide.triage (Clef-flash): four labelled decisions + one shadow decision (a79, unlabelled). a77 and b77 share the
// id decide.triage:77, a78 and b78 decide.triage:78; a77 is labelled twice (the later, merged label wins).
//   verdict (choice ready|hold)   P(ready)  label  top    hit   Σ(p-1[label])²
//     a77 (Triage:repo-a, 77)     .95       ready  ready  yes   .05²+.05² = .0050
//     a78 (Triage:repo-a, 78)     .80       ready  ready  yes   .20²+.20² = .0800
//     b77 (Triage:repo-b, 77)     .60       hold   ready  no    .60²+.60² = .7200
//     b78 (Triage:repo-b, 78)     .25       hold   hold   yes   .25²+.25² = .1250
//   accuracy 3/4 = .75; Brier (.005+.08+.72+.125)/4 = .93/4 = .2325
//   bins on top p: .95→[.9,1]; .80,.75→[.7,.9) (both hit, observed 1, meanP .775); .60→[.5,.7) (miss, observed 0)
//   wrongWhenChosen: ready chosen 3 (a77,a78,b77), wrong 1 (b77); hold chosen 1, wrong 0
//   risky (noul)   p      label  (p-label)²
//     a77          .1     false  .01
//     a78          .2     false  .04
//     b77          .7     true   .09
//     b78          .4     true   .36        Brier .50/4 = .125
//   bins: [0,.5): a77,a78,b78 n3 meanP (.1+.2+.4)/3=.2333 observed 1/3=.3333; [.7,.9): b77 n1 meanP .7 observed 1
//   severity (score, levels 0-3; the score is Σ level·p, as Clef's is)
//     a77  p .2/.7/.1/0   score .9   label 1  |err| .1
//     a78  p 0/.2/.6/.2   score 2    label 1  |err| 1
//     b77  p .6/.3/.1/0   score .5   label 2  |err| 1.5
//     b78  p 0/0/.3/.7    score 2.7  label 3  |err| .3     mean (.1+1+1.5+.3)/4 = 2.9/4 = .725
//   recorded 5, shadow 1, labelled 4, acted 3 (a77, a78, b77)
// extract.invoice (Clairic): one extraction in each of Invoices:acme and Invoices:globex, both keyed inv-1, each
// field labelled in both:
//   amount: .95 correct, .55 wrong → correct .5; byConfidence [.5,.7) n1 correct 0, [.9,1] n1 correct 1
//   vendor: .6 wrong, .92 correct → correct .5; byConfidence [.5,.7) n1 correct 0, [.9,1] n1 correct 1
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.ts";
import { parseEvents, readEvents } from "../src/model/events.ts";
import { scorecard } from "../src/model/scorecard.ts";

const repo = join(import.meta.dirname, "..", "..", "..");
const file = join(repo, "fixtures/events/decisions.ndjson");
const events = readEvents(file)!.events;
const card = scorecard(events);
const triage = card.effects.find((e) => e.effect === "decide.triage")!;
const q = (id: string) => triage.questions.find((x) => x.id === id)!;

describe("scorecard", () => {
  it("counts recorded, shadow, labelled and acted decisions per effect", () => {
    expect(card.effects.map((e) => e.effect)).toEqual(["decide.triage", "extract.invoice"]);
    expect(triage).toMatchObject({ model: "@cf/cloudflare/clef-flash", recorded: 5, shadow: 1, labelled: 4, acted: 3 });
    expect(card.orphanLabels).toBe(0);
  });

  it("scores a choice question: accuracy, Brier, bins, wrongWhenChosen", () => {
    const v = q("verdict");
    if (v.type !== "choice") throw new Error("choice");
    expect(v.labelled).toBe(4);
    expect(v.accuracy).toBe(0.75);
    expect(v.brier).toBe(0.2325);
    expect(v.bins).toEqual([
      { from: 0, to: 0.5, n: 0, meanP: 0, observed: 0 },
      { from: 0.5, to: 0.7, n: 1, meanP: 0.6, observed: 0 },
      { from: 0.7, to: 0.9, n: 2, meanP: 0.775, observed: 1 },
      { from: 0.9, to: 1, n: 1, meanP: 0.95, observed: 1 },
    ]);
    expect(v.wrongWhenChosen.ready).toEqual({ chosen: 3, wrong: 1 });
    expect(v.wrongWhenChosen.hold).toEqual({ chosen: 1, wrong: 0 });
  });

  it("scores a noul question and a score question", () => {
    const r = q("risky");
    if (r.type !== "noul") throw new Error("noul");
    expect(r.brier).toBe(0.125);
    expect(r.bins[0]).toEqual({ from: 0, to: 0.5, n: 3, meanP: 0.2333, observed: 0.3333 });
    expect(r.bins[2]).toEqual({ from: 0.7, to: 0.9, n: 1, meanP: 0.7, observed: 1 });
    expect(q("severity")).toEqual({ id: "severity", type: "score", labelled: 4, meanAbsError: 0.725 });
  });

  it("scores extraction fields by confidence", () => {
    const fx = card.effects.find((e) => e.effect === "extract.invoice")!;
    expect(fx).toMatchObject({ model: "@cf/cloudflare/clairic", recorded: 2, shadow: 0, labelled: 2, acted: 0 });
    const amount = fx.questions.find((x) => x.id === "amount")!;
    expect(amount).toMatchObject({ type: "field", labelled: 2, correct: 0.5 });
    if (amount.type !== "field") throw new Error("field");
    expect(amount.byConfidence).toEqual([
      { from: 0, to: 0.5, n: 0, correct: 0 },
      { from: 0.5, to: 0.7, n: 1, correct: 0 },
      { from: 0.7, to: 0.9, n: 0, correct: 0 },
      { from: 0.9, to: 1, n: 1, correct: 1 },
    ]);
  });

  it("reports null statistics when nothing is labelled, and filters by effect", () => {
    const unlabelled = parseEvents(
      events
        .filter((e) => e.kind === "decision.recorded")
        .map((e) => JSON.stringify(e))
        .join("\n"),
    ).events;
    const v = scorecard(unlabelled).effects.find((e) => e.effect === "decide.triage")!.questions.find((x) => x.id === "verdict")!;
    expect(v).toMatchObject({ labelled: 0, accuracy: null, brier: null });
    const nulls = scorecard(unlabelled).effects.flatMap((e) => e.questions);
    expect(nulls.find((x) => x.id === "risky")).toMatchObject({ labelled: 0, brier: null });
    expect(nulls.find((x) => x.id === "severity")).toMatchObject({ labelled: 0, meanAbsError: null });
    expect(nulls.find((x) => x.id === "amount")).toMatchObject({ labelled: 0, correct: null });
    expect(scorecard(events, { effect: "decide.triage" }).effects.map((e) => e.effect)).toEqual(["decide.triage"]);
  });

  // Two instances of one actor decide with the same key, so both records are "decide.triage:77".
  //   Triage:repo-a  P(ready) .9, hold .1   label ready  hit  Σ(p-1[label])² = .1²+.1² = .02
  //   Triage:repo-b  P(ready) .2, hold .8   label hold   hit  Σ(p-1[label])² = .2²+.2² = .08
  //   recorded 2, labelled 2, acted 1 (repo-a); accuracy 2/2 = 1; Brier (.02+.08)/2 = .05
  //   bins on top p: .9→[.9,1] n1 hit; .8→[.7,.9) n1 hit; wrongWhenChosen ready 1/0, hold 1/0
  it("keys a record and its labels by instance: two instances' decisions with the same key are two records", () => {
    const recorded = (actor: string, ready: number) => ({ $actord: 1 as const, kind: "decision.recorded", at: 1, actor, effect: "decide.triage", effectKey: "77", detail: { decision: "decide.triage:77", effect: "decide.triage", key: "77", kind: "decision", model: "@cf/cloudflare/clef-flash", mode: "act", answers: { verdict: { type: "choice", choice: ready >= 0.5 ? "ready" : "hold", probabilities: { ready, hold: Math.round((1 - ready) * 10) / 10 } } } } });
    const label = (actor: string, kind: string, detail: Record<string, unknown>) => ({ $actord: 1 as const, kind, at: 2, actor, effect: "decide.triage", effectKey: "77", detail: { decision: "decide.triage:77", ...detail } });
    const log = [
      recorded("Triage:repo-a", 0.9),
      recorded("Triage:repo-b", 0.2),
      label("Triage:repo-a", "decision.acted", { action: "routed:ready" }),
      label("Triage:repo-a", "decision.outcome", { actual: { verdict: "ready" } }),
      label("Triage:repo-b", "decision.outcome", { actual: { verdict: "hold" } }),
    ];
    const two = scorecard(log as never);
    expect(two.orphanLabels).toBe(0);
    expect(two.effects).toEqual([
      {
        effect: "decide.triage",
        model: "@cf/cloudflare/clef-flash",
        recorded: 2,
        shadow: 0,
        labelled: 2,
        acted: 1,
        questions: [
          {
            id: "verdict",
            type: "choice",
            labelled: 2,
            accuracy: 1,
            brier: 0.05,
            bins: [
              { from: 0, to: 0.5, n: 0, meanP: 0, observed: 0 },
              { from: 0.5, to: 0.7, n: 0, meanP: 0, observed: 0 },
              { from: 0.7, to: 0.9, n: 1, meanP: 0.8, observed: 1 },
              { from: 0.9, to: 1, n: 1, meanP: 0.9, observed: 1 },
            ],
            wrongWhenChosen: { ready: { chosen: 1, wrong: 0 }, hold: { chosen: 1, wrong: 0 } },
          },
        ],
      },
    ]);
    // A third instance's label for the same id finds no record of its own: an orphan, never another instance's.
    const stray = scorecard([...log, label("Triage:repo-c", "decision.outcome", { actual: { verdict: "hold" } })] as never);
    expect(stray.orphanLabels).toBe(1);
    expect(stray.effects).toEqual(two.effects);
  });

  it("counts labels whose decision.recorded isn't in the log, whatever their order", () => {
    // A label written before its record in the file still finds it: records are read first.
    const [first, ...rest] = events;
    const reordered = [...rest.filter((e) => e.kind !== "decision.recorded"), first!, ...rest.filter((e) => e.kind === "decision.recorded")];
    expect(scorecard(reordered)).toEqual(card);
    // Without b77's record (Triage:repo-b, decide.triage:77): its decision.acted and decision.outcome are orphans,
    // and repo-a's record with the same id keeps only its own labels.
    const lost = events.filter((e) => !(e.kind === "decision.recorded" && e.actor === "Triage:repo-b" && e.effectKey === "77"));
    const partial = scorecard(lost);
    expect(partial.orphanLabels).toBe(2);
    expect(partial.effects.find((e) => e.effect === "decide.triage")).toMatchObject({ recorded: 4, labelled: 3, acted: 2 });
    // --effect counts only the named effect's orphans.
    expect(scorecard(lost, { effect: "extract.invoice" }).orphanLabels).toBe(0);
    expect(scorecard(lost, { effect: "decide.triage" }).orphanLabels).toBe(2);
  });
});

describe("actord scorecard", () => {
  const run = async (...args: string[]) => {
    let out = "";
    let err = "";
    const dir = mkdtempSync(join(tmpdir(), "actord-scorecard-"));
    try {
      const code = await main(["scorecard", ...args], { out: { write: (s: string) => ((out += s), true) } as never, err: { write: (s: string) => ((err += s), true) } as never, cwd: dir });
      return { code, out, err };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("--json returns the same object", async () => {
    const r = await run("--json", "--file", file);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ command: "scorecard", unparseable: 0, orphanLabels: 0, ...JSON.parse(JSON.stringify(card)) });
  });

  it("reports unreadable lines and labels with no record, in --json and in the text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actord-scorecard-log-"));
    try {
      // Two lines that aren't events (a torn write, and JSON without $actord), and b77's record lost: its two labels
      // (decision.acted, decision.outcome) are orphans.
      const all = readFileSync(file, "utf8").split("\n").filter((l) => l);
      const lines = all.filter((l) => !(l.includes('"kind":"decision.recorded"') && l.includes('"actor":"Triage:repo-b"') && l.includes('"effectKey":"77"')));
      expect(lines).toHaveLength(all.length - 1);
      const log = join(dir, "events.ndjson");
      writeFileSync(log, [...lines.slice(0, 3), '{"seq":99,"$actord":1,"kind":"decision.rec', '{"not":"an event"}', ...lines.slice(3)].join("\n") + "\n");
      const json = await run("--json", "--file", log);
      expect(JSON.parse(json.out)).toMatchObject({ unparseable: 2, orphanLabels: 2 });
      const text = await run("--file", log);
      expect(text.out).toContain("2 lines of the log couldn't be read; 2 labels have no decision.recorded in this log.");
      writeFileSync(log, [...all, '{"$actord":1'].join("\n") + "\n");
      const torn = await run("--file", log);
      expect(torn.out).toContain("\n\n1 line of the log couldn't be read.");
      expect(torn.out).not.toContain("no decision.recorded");
      expect((await run("--file", file)).out).not.toContain("couldn't be read");
      expect((await run("--file", file)).out).not.toContain("no decision.recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints one table per effect, and honours --effect", async () => {
    const r = await run("--file", file);
    expect(r.out).toContain("decide.triage");
    expect(r.out).toContain("extract.invoice");
    expect(r.out).toContain("verdict");
    expect(r.out).toContain("0.75");
    const only = await run("--effect", "extract.invoice", "--file", file);
    expect(only.out).not.toContain("decide.triage");
  });

  // Option names that are Object.prototype keys, as own keys: JSON.parse makes "__proto__" an own property, as the
  // runtime's events do, where an object literal would set the prototype instead.
  //   P(__proto__) .4, P(constructor) .6; top __proto__ (the model's choice); label constructor → a miss
  //   accuracy 0; Brier (.4-0)² + (.6-1)² = .16 + .16 = .32; bins: .4→[0,.5) n1 meanP .4 observed 0
  it("handles option names that are Object.prototype keys", () => {
    const probabilities = JSON.parse('{"__proto__":0.4,"constructor":0.6}') as Record<string, number>;
    expect(Object.keys(probabilities)).toEqual(["__proto__", "constructor"]);
    const rec = { $actord: 1 as const, kind: "decision.recorded", at: 1, actor: "A:k", detail: { decision: "e:k", effect: "e", key: "k", kind: "decision", model: "m", mode: "act", answers: { constructor: { type: "choice", choice: "__proto__", probabilities } } } };
    const out = { $actord: 1 as const, kind: "decision.outcome", at: 2, actor: "A:k", detail: { decision: "e:k", actual: { constructor: "constructor" } } };
    const r = scorecard([rec, out] as never).effects[0]!.questions[0]!;
    if (r.type !== "choice") throw new Error("choice");
    expect(r).toEqual({
      id: "constructor",
      type: "choice",
      labelled: 1,
      accuracy: 0,
      brier: 0.32,
      bins: [
        { from: 0, to: 0.5, n: 1, meanP: 0.4, observed: 0 },
        { from: 0.5, to: 0.7, n: 0, meanP: 0, observed: 0 },
        { from: 0.7, to: 0.9, n: 0, meanP: 0, observed: 0 },
        { from: 0.9, to: 1, n: 0, meanP: 0, observed: 0 },
      ],
      wrongWhenChosen: JSON.parse('{"__proto__":{"chosen":1,"wrong":1}}'),
    });
    expect(Object.keys(r.wrongWhenChosen)).toEqual(["__proto__"]);
  });

  it("names the effect when --effect matches nothing", async () => {
    const r = await run("--effect", "nope", "--file", file);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No decisions or extractions recorded for effect nope");
  });

  it("says so when there are no decisions", async () => {
    const r = await run("--file", join(repo, "fixtures/events/release-radar-flow.ndjson"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("No decisions");
  });
});
