// Files `actord init` writes. The starter is a complete, tested two-actor system; the `.claude/` files
// and CLAUDE.md keep the project self-describing to sessions that don't have the plugin.
import { hostFiles, type AgentHost } from "./host.ts";
export { claudeMd, settingsJson, verifySkill } from "./claude.ts";

export const PINNED = {
  "@cloudflare/vitest-plugin": "1.4.7",
  typescript: "7.0.2",
  vitest: "5.0.5",
  wrangler: "4.152.0",
  zod: "4.6.5",
};

export function starterFiles(name: string, toolkitSpec: string, host: AgentHost = "claude"): Record<string, string> {
  return {
    "package.json": `${JSON.stringify(
      {
        name,
        private: true,
        actord: { host },
        type: "module",
        scripts: {
          types: "wrangler types",
          typecheck: "wrangler types >/dev/null && tsc --noEmit",
          test: "vitest run",
          check: "actord check",
          verify: "actord verify",
          dev: "wrangler dev",
        },
        devDependencies: { "@actord/toolkit": toolkitSpec, ...PINNED },
      },
      null,
      2,
    )}\n`,
    ".gitignore": "node_modules/\n.wrangler/\n.actord/\nworker-configuration.d.ts\n.dev.vars\n.env\n",
    "system.ts": `import { defineSystem } from "@actord/toolkit/system";
import { GreetingRecorded, GreetingRequested } from "./src/messages/index.ts";

export default defineSystem({
  name: "${name}",
  description: "A starter: a greeter that accepts greetings and a guestbook that keeps them",
  messages: {
    "greeting.requested": GreetingRequested,
    "greeting.recorded": GreetingRecorded,
  },
  actors: {
    Greeter: {
      binding: "GREETER",
      kind: "deterministic",
      purpose: "Accepts greeting requests from the outside world and forwards valid ones",
      justification: ["permissions"],
    },
    Guestbook: {
      binding: "GUESTBOOK",
      kind: "deterministic",
      purpose: "Owns the list of greetings and records each one once",
      justification: ["state"],
    },
  },
  routes: [
    { from: "@ingress", message: "greeting.requested", to: "Greeter" },
    { from: "Greeter", message: "greeting.recorded", to: "Guestbook" },
  ],
});
`,
    "src/messages/index.ts": `import { message } from "@actord/toolkit/system";
import { z } from "zod";

export const GreetingRequested = message({
  version: 1,
  description: "Someone asked to sign the guestbook",
  payload: z.object({ name: z.string().min(1).max(100) }),
});

export const GreetingRecorded = message({
  version: 1,
  description: "A greeting to keep",
  payload: z.object({ name: z.string(), text: z.string() }),
});
`,
    "src/actors/greeter.ts": `import { DurableObject } from "cloudflare:workers";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import system from "../../system.ts";

export class Greeter extends DurableObject<Env> {
  actor = actorRuntime({ ctx: this.ctx, env: this.env }, system, "Greeter", {
    "greeting.requested": ({ payload }, ctx) => {
      ctx.send("greeting.recorded", { name: payload.name, text: \`Hello, \${payload.name}!\` });
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  alarm() {
    return this.actor.alarm();
  }
}
`,
    "src/actors/guestbook.ts": `import { DurableObject } from "cloudflare:workers";
import { actorRuntime, type Envelope } from "@actord/toolkit/runtime";
import system from "../../system.ts";

export class Guestbook extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS entries (message_id TEXT PRIMARY KEY, name TEXT NOT NULL, text TEXT NOT NULL)");
  }

  actor = actorRuntime({ ctx: this.ctx, env: this.env }, system, "Guestbook", {
    "greeting.recorded": ({ id, payload }, ctx) => {
      ctx.sql.exec("INSERT INTO entries (message_id, name, text) VALUES (?, ?, ?)", id, payload.name, payload.text);
    },
  });

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  alarm() {
    return this.actor.alarm();
  }

  entries(): Array<{ name: string; text: string }> {
    return this.ctx.storage.sql.exec<{ name: string; text: string }>("SELECT name, text FROM entries ORDER BY name").toArray();
  }
}
`,
    "src/index.ts": `import { ingress } from "@actord/toolkit/runtime";
import system from "../system.ts";

export { Greeter } from "./actors/greeter.ts";
export { Guestbook } from "./actors/guestbook.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/greet") {
      const { name } = (await request.json()) as { name: string };
      return Response.json(await ingress(env, system, "Greeter", "greeting.requested", { name }));
    }
    if (request.method === "GET" && url.pathname === "/guestbook") {
      return Response.json(await env.GUESTBOOK.getByName("main").entries());
    }
    return new Response("POST /greet {name} · GET /guestbook\\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
`,
    "wrangler.jsonc": `{
  "name": "${name}",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "durable_objects": {
    "bindings": [
      { "name": "GREETER", "class_name": "Greeter" },
      { "name": "GUESTBOOK", "class_name": "Guestbook" }
    ]
  },
  "exports": {
    "Greeter": { "type": "durable-object", "storage": "sqlite" },
    "Guestbook": { "type": "durable-object", "storage": "sqlite" }
  }
}
`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "es2024",
          module: "es2022",
          moduleResolution: "bundler",
          lib: ["es2024"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          erasableSyntaxOnly: true,
          verbatimModuleSyntax: true,
          types: ["@cloudflare/vitest-plugin/types"],
        },
        include: ["system.ts", "src/**/*.ts", "tests/**/*.ts", "worker-configuration.d.ts"],
      },
      null,
      2,
    )}\n`,
    "vitest.config.ts": `import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { actorEvents } from "@actord/toolkit/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }), actorEvents()],
});
`,
    "tests/greeting.test.ts": `import { env } from "cloudflare:workers";
import { type Envelope, ingress } from "@actord/toolkit/runtime";
import { settle } from "@actord/toolkit/testing";
import { expect, it } from "vitest";
import system from "../system.ts";

// Durable Object storage persists across the tests in one file (each file starts empty), and effects
// dedupe by key per instance: give each test its own instance keys and ids.

it("[end-to-end] a greeting reaches the guestbook", async () => {
  expect(await ingress(env, system, "Greeter", "greeting.requested", { name: "Ada" })).toMatchObject({ status: "handled" });
  await settle(env, system);
  expect(await env.GUESTBOOK.getByName("main").entries()).toContainEqual({ name: "Ada", text: "Hello, Ada!" });
});

it("[duplicate-delivery] a redelivered message is recorded once", async () => {
  const envelope: Envelope = {
    v: 1, id: "dup-1", type: "greeting.recorded", version: 1, from: "Greeter:main", to: "Guestbook:main",
    correlationId: "dup-1", causationId: null, attempt: 1, sentAt: 0, payload: { name: "Grace", text: "Hello, Grace!" },
  };
  const guestbook = env.GUESTBOOK.getByName("main");
  expect(await guestbook.receive(envelope)).toMatchObject({ status: "handled" });
  expect(await guestbook.receive({ ...envelope, attempt: 2 })).toMatchObject({ status: "duplicate" });
  expect((await guestbook.entries()).filter((e) => e.name === "Grace")).toHaveLength(1);
});

it("[refuse-invalid] an empty name is refused before any handler runs", async () => {
  expect(await ingress(env, system, "Greeter", "greeting.requested", { name: "" })).toMatchObject({ status: "rejected", reason: "invalid_payload" });
});
`,
    "actord.claims.json": `${JSON.stringify(
      {
        $comment: "Reliability claims and the tagged tests that establish them. `actord verify` classifies each from the latest run.",
        claims: [
          { id: "end-to-end", basis: "workerd", tests: ["end-to-end"], statement: "A greeting request reaches the guestbook." },
          { id: "dedupe-delivery", basis: "workerd", tests: ["duplicate-delivery"], statement: "A redelivered message is recorded once." },
          { id: "refuse-invalid", basis: "workerd", tests: ["refuse-invalid"], statement: "Invalid payloads are refused before any handler runs." },
          { id: "exactly-once-external", basis: "not-guaranteed", statement: "Exactly-once external effects.", why: "The starter has no external effects; when you add one, say what its destination guarantees." },
        ],
      },
      null,
      2,
    )}\n`,
    ...hostFiles(host, name),
  };
}
