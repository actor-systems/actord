import { describe, expect, it } from "vitest";
import { starterFiles } from "../src/templates/project.ts";

describe("starter actors", () => {
  it("compose a Lifecycle and forward no alarm()", () => {
    const files = starterFiles("demo", "0.2.0");
    for (const path of ["src/actors/greeter.ts", "src/actors/guestbook.ts"]) {
      expect(files[path]).toContain("Lifecycle.install(this)");
      expect(files[path]).not.toMatch(/\balarm\(\)/);
    }
    expect(JSON.parse(files["package.json"]!).devDependencies.agents).toBe("0.30.1");
  });
});
