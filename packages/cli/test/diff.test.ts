import { describe, expect, it } from "vitest";
import { comparePayload } from "../src/model/diff.ts";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const S = { type: "string" };

describe("comparePayload: will new code accept what is already in flight?", () => {
  it.each([
    ["new optional property", obj({ a: S }, ["a"]), obj({ a: S, b: S }, ["a"]), "compatible"],
    ["new required property", obj({ a: S }, ["a"]), obj({ a: S, b: S }, ["a", "b"]), "breaking"],
    ["optional became required", obj({ a: S }), obj({ a: S }, ["a"]), "breaking"],
    ["required became optional", obj({ a: S }, ["a"]), obj({ a: S }), "compatible"],
    ["property removed", obj({ a: S, b: S }, ["a"]), obj({ a: S }, ["a"]), "compatible"],
    ["property type changed", obj({ a: S }, ["a"]), obj({ a: { type: "number" } }, ["a"]), "breaking"],
    ["enum narrowed", obj({ a: { type: "string", enum: ["x", "y"] } }), obj({ a: { type: "string", enum: ["x"] } }), "breaking"],
    ["enum widened", obj({ a: { type: "string", enum: ["x"] } }), obj({ a: { type: "string", enum: ["x", "y"] } }), "compatible"],
  ])("%s → %s", (_label, before, after, expected) => {
    const findings = comparePayload(before, after);
    const worst = findings.some((f) => f.compatibility === "breaking") ? "breaking" : findings.some((f) => f.compatibility === "risky") ? "risky" : "compatible";
    expect(worst).toBe(expected);
  });

  it("reports risky when a schema can't be exported", () => {
    expect(comparePayload(null, obj({}))[0]?.compatibility).toBe("risky");
  });
});
