// Worker entry: an HTTP front door into the actor system, plus the actor class exports.
import { ingress } from "@actord/toolkit/runtime";
import system from "../system.ts";

export { DigestWriter } from "./actors/digest-writer.ts";
export { FeedPoller } from "./actors/feed-poller.ts";
export { ReleaseLedger } from "./actors/release-ledger.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/feeds") {
      const body = (await request.json()) as { feedId: string; url: string };
      const receipt = await ingress(env, system, "FeedPoller", "feed.watch", body, { key: body.feedId });
      return Response.json(receipt, { status: receipt.status === "rejected" ? 400 : 202 });
    }
    if (request.method === "GET" && url.pathname === "/findings") {
      return Response.json(await env.DIGEST_WRITER.getByName("main").findings());
    }
    return new Response("release-radar: POST /feeds {feedId,url} · GET /findings\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
