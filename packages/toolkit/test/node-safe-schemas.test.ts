// The hand-written payload schemas for approval.decided, agent.failed and agent.exhausted come from
// @actord/toolkit/system, which Node loads. `actord check` imports system.ts under Node, and the sources and agents
// entry points import cloudflare:workers (through agents/lifecycle), which Node can't load. Runs the shipped CLI
// (rebuilt by `npm run build`) on a project whose system.ts declares all three.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "plugins/claude/dist/actord.mjs");
const tmp = mkdtempSync(join(tmpdir(), "actord-node-safe-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
// The project resolves @actord/toolkit (a workspace link to packages/toolkit) and zod from the repository.
symlinkSync(join(repo, "node_modules"), join(tmp, "node_modules"));
writeFileSync(join(tmp, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
writeFileSync(
  join(tmp, "system.ts"),
  `import { agentExhausted, agentFailed, approvalDecided, defineSystem, inboundEmail, message, pi } from "@actord/toolkit/system";
import { z } from "zod";

export default defineSystem({
  name: "node-safe-schemas",
  messages: {
    "task.started": message({ version: 1, description: "Start a session", payload: z.object({ topic: z.string() }) }),
    "task.done": message({ version: 1, description: "The session's result", payload: z.object({ summary: z.string() }) }),
    "agent.failed": message({ version: 1, description: "A session ended without a result", payload: agentFailed }),
    "agent.exhausted": message({ version: 1, description: "A session ran out of budget", payload: agentExhausted }),
    "approval.decided": message({ version: 1, description: "The owner answered an approval request", payload: approvalDecided }),
  },
  sources: { email: inboundEmail({ secret: "APPROVAL_SECRET", owner: "OWNER", from: "APPROVAL_FROM", send: "MAIL", message: "approval.decided" }) },
  actors: {
    Writer: {
      binding: "WRITER",
      kind: "agent",
      purpose: "Writes up a task",
      justification: ["state"],
      harness: pi(),
      model: { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" },
      on: { "task.started": "start" },
      returns: "task.done",
      budget: { usd: 1, turns: 10, wallClock: "10m" },
    },
  },
  routes: [
    { from: "@ingress", message: "task.started", to: "Writer" },
    { from: "Writer", message: "task.done", to: "Writer" },
    { from: "Writer", message: "agent.failed", to: "Writer" },
    { from: "Writer", message: "agent.exhausted", to: "Writer" },
    { from: "@email", message: "approval.decided", to: "Writer" },
  ],
});
`,
);

const run = (...args: string[]) => {
  const r = spawnSync("node", [cli, ...args], { cwd: tmp, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("schemas a system.ts imports from @actord/toolkit/system", () => {
  it("load under the CLI: check isn't refused with DECLARATION_LOAD_FAILED", () => {
    const r = run("check", "--json");
    const doc = JSON.parse(r.out) as { skipped: boolean; diagnostics: Array<{ code: string; message: string }> };
    expect(doc.skipped).toBe(false);
    expect(doc.diagnostics.filter((d) => d.code === "DECLARATION_LOAD_FAILED"), r.out + r.err).toEqual([]);
  });

  it("carry their JSON Schemas into the manifest", () => {
    const r = run("graph", "--json");
    const messages = (JSON.parse(r.out) as { manifest: { messages: Array<{ name: string; payload: { required?: string[] } }> } }).manifest.messages;
    const required = (name: string) => messages.find((m) => m.name === name)?.payload.required;
    expect(required("agent.failed")).toEqual(["session", "key", "reason"]);
    expect(required("agent.exhausted")).toEqual(["session", "key", "budget"]);
    expect(required("approval.decided")).toEqual(["effect", "effectKey", "decision", "reason", "by", "authenticated"]);
  });
});
