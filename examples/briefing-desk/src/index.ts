// Worker entry: HTTP front door into the desk, plus the actor class exports.
import { ingress } from "@actord/toolkit/runtime";
import system from "../system.ts";

export { Analyst } from "./actors/analyst.ts";
export { Desk } from "./actors/desk.ts";
export { Intake } from "./actors/intake.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "POST" && url.pathname === "/items") {
      const body = (await request.json()) as { itemId: string; source: string; title: string; body: string };
      const receipt = await ingress(env, system, "Intake", "item.submitted", body);
      return Response.json(receipt, { status: receipt.status === "rejected" ? 400 : 202 });
    }
    if (request.method === "POST" && parts[0] === "items" && parts[2] === "cancel" && parts[1]) {
      const { reason } = (await request.json()) as { reason: string };
      return Response.json(await ingress(env, system, "Analyst", "item.cancelled", { itemId: parts[1], reason }, { key: parts[1] }));
    }
    if (request.method === "POST" && parts[0] === "briefings" && parts[2] === "decision" && parts[1]) {
      const { decision, by } = (await request.json()) as { decision: "approve" | "deny"; by: string };
      return Response.json(await ingress(env, system, "Analyst", "briefing.decided", { itemId: parts[1], decision, by }, { key: parts[1] }));
    }
    if (request.method === "GET" && url.pathname === "/briefings") {
      return Response.json(await env.DESK.getByName("main").board());
    }
    return new Response("briefing-desk: POST /items · POST /items/:id/cancel · POST /briefings/:id/decision · GET /briefings\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
