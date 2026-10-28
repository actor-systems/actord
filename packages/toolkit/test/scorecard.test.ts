// `actord scorecard`: calibration of decision effects from the event log. The fixture
// (fixtures/events/decisions.ndjson) holds events shaped field for field like the runtime's, with these hand-worked numbers.
//
// triage (Clef), four labelled decisions + one shadow decision (t5, unlabelled); t1 is labelled twice (the later, merged label wins):
//   verdict (choice ready|hold)   P(ready)  label  top    hit   Σ(p-1[label])²
//     t1                          .95       ready  ready  yes   .05²+.05² = .0050
//     t2                          .80       ready  ready  yes   .20²+.20² = .0800
//     t3                          .60       hold   ready  no    .60²+.60² = .7200
//     t4                          .25       hold   hold   yes   .25²+.25² = .1250
//   accuracy 3/4 = .75; Brier (.005+.08+.72+.125)/4 = .93/4 = .2325
//   bins on top p: .95→[.9,1]; .80,.75→[.7,.9) (both hit, observed 1, meanP .775); .60→[.5,.7) (miss, observed 0)
//   wrongWhenChosen: ready chosen 3 (t1,t2,t3), wrong 1 (t3); hold chosen 1, wrong 0
//   risky (noul)   p      label  (p-label)²
//     t1           .1     false  .01
//     t2           .2     false  .04
//     t3           .7     true   .09
//     t4           .4     true   .36        Brier .50/4 = .125
//   bins: [0,.5): t1,t2,t4 n3 meanP (.1+.2+.4)/3=.2333 observed 1/3=.3333; [.7,.9): t3 n1 meanP .7 observed 1
//   severity (score)  predicted label |err|: t1 1/1 0, t2 2/1 1, t3 0/2 2, t4 3/3 0 → mean 3/4 = .75
//   recorded 5, shadow 1, labelled 4, acted 3 (t1,t2,t3)
// extractInvoice (Clairic), two extractions, each field labelled in both:
//   amount: .95 correct, .55 wrong → correct .5; byConfidence [.5,.7) n1 correct 0, [.9,1] n1 correct 1
//   vendor: .6 wrong, .92 correct → correct .5; byConfidence [.5,.7) n1 correct 0, [.9,1] n1 correct 1
import { mkdtempSync, rmSync } from "node:fs";
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
const triage = card.effects.find((e) => e.effect === "triage")!;
const q = (id: string) => triage.questions.find((x) => x.id === id)!;

describe("scorecard", () => {
  it("counts recorded, shadow, labelled and acted decisions per effect", () => {
    expect(card.effects.map((e) => e.effect)).toEqual(["extractInvoice", "triage"]);
    expect(triage).toMatchObject({ model: "clef-flash", recorded: 5, shadow: 1, labelled: 4, acted: 3 });
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
    expect(q("severity")).toEqual({ id: "severity", type: "score", labelled: 4, meanAbsError: 0.75 });
  });

  it("scores extraction fields by confidence", () => {
    const fx = card.effects[0]!;
    expect(fx).toMatchObject({ effect: "extractInvoice", model: "clairic-flash", recorded: 2, shadow: 0, labelled: 2, acted: 0 });
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
    const v = scorecard(unlabelled).effects.find((e) => e.effect === "triage")!.questions.find((x) => x.id === "verdict")!;
    expect(v).toMatchObject({ labelled: 0, accuracy: null, brier: null });
    const nulls = scorecard(unlabelled).effects.flatMap((e) => e.questions);
    expect(nulls.find((x) => x.id === "risky")).toMatchObject({ labelled: 0, brier: null });
    expect(nulls.find((x) => x.id === "severity")).toMatchObject({ labelled: 0, meanAbsError: null });
    expect(nulls.find((x) => x.id === "amount")).toMatchObject({ labelled: 0, correct: null });
    expect(scorecard(events, { effect: "triage" }).effects.map((e) => e.effect)).toEqual(["triage"]);
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
    expect(JSON.parse(r.out)).toMatchObject({ command: "scorecard", ...JSON.parse(JSON.stringify(card)) });
  });

  it("prints one table per effect, and honours --effect", async () => {
    const r = await run("--file", file);
    expect(r.out).toContain("triage");
    expect(r.out).toContain("extractInvoice");
    expect(r.out).toContain("verdict");
    expect(r.out).toContain("0.75");
    const only = await run("--effect", "extractInvoice", "--file", file);
    expect(only.out).not.toContain("triage");
  });

  it("handles option names that are Object.prototype keys", () => {
    const rec = { $actord: 1 as const, kind: "decision.recorded", at: 1, actor: "A", detail: { decision: "e:k", effect: "e", key: "k", kind: "decision", model: "m", mode: "act", answers: { constructor: { type: "choice", choice: "__proto__", probabilities: { __proto__: 0.4, constructor: 0.6 } } } } };
    const out = { $actord: 1 as const, kind: "decision.outcome", at: 2, actor: "A", detail: { decision: "e:k", actual: { constructor: "constructor" } } };
    const r = scorecard([rec, out] as never).effects[0]!.questions[0]!;
    if (r.type !== "choice") throw new Error("choice");
    expect(r.labelled).toBe(1);
    expect(r.wrongWhenChosen).toEqual({ ["__proto__"]: { chosen: 1, wrong: 1 } });
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
