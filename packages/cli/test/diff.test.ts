import { describe, expect, it } from "vitest";
import { comparePayload, diffManifests } from "../src/model/diff.ts";
import type { Manifest } from "../src/model/manifest.ts";

const obj = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: "object", properties, required, ...extra });
const strict = (properties: Record<string, unknown>, required: string[] = []) => obj(properties, required, { additionalProperties: false });
const loose = (properties: Record<string, unknown>, required: string[] = []) => obj(properties, required, { additionalProperties: {} });
const S = { type: "string" };
const N = { type: "number" };

const worst = (findings: Array<{ compatibility: string }>) =>
  findings.some((f) => f.compatibility === "breaking") ? "breaking" : findings.some((f) => f.compatibility === "risky") ? "risky" : "compatible";

describe("comparePayload: will new code accept what is already in flight?", () => {
  it.each([
    // Properties
    ["new optional property", obj({ a: S }, ["a"]), obj({ a: S, b: S }, ["a"]), "compatible"],
    ["new required property", obj({ a: S }, ["a"]), obj({ a: S, b: S }, ["a", "b"]), "breaking"],
    ["optional became required", obj({ a: S }), obj({ a: S }, ["a"]), "breaking"],
    ["required became optional", obj({ a: S }, ["a"]), obj({ a: S }), "compatible"],
    ["property removed (undeclared properties ignored)", obj({ a: S, b: S }, ["a"]), obj({ a: S }, ["a"]), "compatible"],
    ["property removed from a strict object", strict({ a: S, b: S }, ["a", "b"]), strict({ a: S }, ["a"]), "breaking"],
    ["optional property removed from a strict object", strict({ a: S, b: S }, ["a"]), strict({ a: S }, ["a"]), "breaking"],
    ["property removed into a loose object", loose({ a: S, b: S }, ["a"]), loose({ a: S }, ["a"]), "compatible"],
    ["property removed into a typed catchall it doesn't match", obj({ a: S, b: S }, ["a"]), obj({ a: S }, ["a"], { additionalProperties: N }), "breaking"],
    ["new optional property on a loose object", loose({ a: S }, ["a"]), loose({ a: S, b: S }, ["a"]), "risky"],
    ["property type changed", obj({ a: S }, ["a"]), obj({ a: N }, ["a"]), "breaking"],
    // Undeclared properties
    ["plain object made strict", obj({ a: S }, ["a"]), strict({ a: S }, ["a"]), "risky"],
    ["loose object made strict", loose({ a: S }, ["a"]), strict({ a: S }, ["a"]), "breaking"],
    ["strict object made plain", strict({ a: S }, ["a"]), obj({ a: S }, ["a"]), "compatible"],
    // Value sets
    ["enum narrowed", obj({ a: { type: "string", enum: ["x", "y"] } }), obj({ a: { type: "string", enum: ["x"] } }), "breaking"],
    ["enum widened", obj({ a: { type: "string", enum: ["x"] } }), obj({ a: { type: "string", enum: ["x", "y"] } }), "compatible"],
    ["free string limited to an enum", obj({ a: S }), obj({ a: { type: "string", enum: ["x", "y"] } }), "breaking"],
    ["free string limited to a literal", obj({ a: S }), obj({ a: { type: "string", const: "x" } }), "breaking"],
    ["enum lifted to any string", obj({ a: { type: "string", enum: ["x"] } }), obj({ a: S }), "compatible"],
    // Types
    ["made nullable", obj({ a: S }), obj({ a: { type: ["string", "null"] } }), "compatible"],
    ["null no longer accepted", obj({ a: { type: ["string", "null"] } }), obj({ a: S }), "breaking"],
    ["integer widened to number", obj({ a: { type: "integer" } }), obj({ a: N }), "compatible"],
    ["number narrowed to integer", obj({ a: N }), obj({ a: { type: "integer" } }), "breaking"],
    // Bounds and restrictions
    ["minLength added", obj({ a: S }), obj({ a: { type: "string", minLength: 1 } }), "breaking"],
    ["maxLength raised", obj({ a: { type: "string", maxLength: 10 } }), obj({ a: { type: "string", maxLength: 20 } }), "compatible"],
    ["maximum lowered", obj({ a: { type: "number", maximum: 10 } }), obj({ a: { type: "number", maximum: 5 } }), "breaking"],
    ["minimum removed", obj({ a: { type: "number", minimum: 0 } }), obj({ a: N }), "compatible"],
    ["format added", obj({ a: S }), obj({ a: { type: "string", format: "uri" } }), "breaking"],
    ["format removed", obj({ a: { type: "string", format: "uri" } }), obj({ a: S }), "compatible"],
    ["pattern changed", obj({ a: { type: "string", pattern: "^a" } }), obj({ a: { type: "string", pattern: "^b" } }), "risky"],
    // Arrays
    ["array item type changed", obj({ a: { type: "array", items: S } }), obj({ a: { type: "array", items: N } }), "breaking"],
    ["array item enum widened", obj({ a: { type: "array", items: { type: "string", enum: ["x"] } } }), obj({ a: { type: "array", items: { type: "string", enum: ["x", "y"] } } }), "compatible"],
    ["minItems added", obj({ a: { type: "array", items: S } }), obj({ a: { type: "array", items: S, minItems: 1 } }), "breaking"],
    // What this can't decide is never compatible
    ["union changed", obj({ a: { anyOf: [S, N] } }), obj({ a: { anyOf: [S, { type: "boolean" }] } }), "risky"],
    ["union replaced a plain type", obj({ a: S }), obj({ a: { anyOf: [S, N] } }), "risky"],
  ])("%s", (_label, before, after, expected) => {
    expect(worst(comparePayload(before, after))).toBe(expected);
  });

  it("ignores annotation-only changes", () => {
    expect(comparePayload(obj({ a: { type: "string", description: "old" } }), obj({ a: { type: "string", description: "new", default: "d" } }))).toEqual([]);
  });

  it("reports risky when a schema can't be exported", () => {
    expect(comparePayload(null, obj({}))[0]?.compatibility).toBe("risky");
  });

  it("names what old copies would hit", () => {
    const [removed] = comparePayload(strict({ a: S, b: S }, ["a", "b"]), strict({ a: S }, ["a"]));
    expect(removed?.detail).toMatch(/payload\.b was removed.*rejects undeclared properties.*every old copy carries it/);
    const [limited] = comparePayload(obj({ a: S }), obj({ a: { type: "string", enum: ["x", "y"] } }));
    expect(limited?.detail).toMatch(/payload\.a is now limited to "x", "y"/);
  });
});

describe("diffManifests: the deploy plan drains whatever may refuse copies in flight", () => {
  const manifest = (payload: Record<string, unknown>, version = 1): Manifest => ({
    schemaVersion: 1,
    $comment: "",
    system: { name: "s", description: "" },
    actors: [],
    messages: [{ name: "m", version, description: "", payload }],
    routes: [],
    effects: [],
  });
  const drain = (base: Manifest, head: Manifest) => diffManifests(base, head).plan.find((s) => s.kind === "drain")?.text;

  it("drains for a breaking payload change, and says how to avoid it", () => {
    const text = drain(manifest(strict({ a: S, b: S }, ["a", "b"])), manifest(strict({ a: S }, ["a"])));
    expect(text).toMatch(/Drain first: m /);
    expect(text).toMatch(/accept the old shape|new message beside the old one/);
  });

  it("drains for a payload change it can't decide", () => {
    expect(drain(manifest(obj({ a: S }, ["a"])), manifest(strict({ a: S }, ["a"])))).toMatch(/Drain first: m /);
  });

  it("drains for a version bump, which refuses every old copy", () => {
    expect(drain(manifest(obj({ a: S })), manifest(obj({ a: S }), 2))).toMatch(/Drain first: m /);
  });

  it("doesn't drain for a compatible change", () => {
    expect(drain(manifest(obj({ a: S })), manifest(obj({ a: S, b: S })))).toBeUndefined();
  });

  it("never advises a version bump as a way to keep old copies working", () => {
    const d = diffManifests(manifest(strict({ a: S, b: S }, ["a", "b"])), manifest(strict({ a: S }, ["a"])));
    for (const c of d.changes) expect(c.detail).not.toMatch(/bump the version/);
  });
});
