// Spike 6: does an approval email survive a real Gmail round trip through Cloudflare Email Routing?
//
// One actor (Desk, instance "main") asks for one harmless effect that needs a person's approval. The runtime
// queues the system's approvals.notify effect, whose adapter (approvalEmail) emails the owner from
// approvals@actord.dev. The owner replies "approve" from Gmail; Email Routing hands the reply to email() below,
// which stores every raw header line in Desk's SQLite, then calls handleEmail as an app would.
//
// The email source deliberately has no `authserv`: the spike's job is to observe which authserv-id Cloudflare
// writes, so every reply is "unknown" here, and spike.act is not `publishes: true`, so an "approve" goes through.
//
// HTTP (every request needs Authorization: Bearer <SPIKE_TOKEN>, else 401):
//   GET  /spike                   everything stored: inbound headers, outbound sends, decisions, outcomes
//   POST /spike/ask[?key=...]     park a new approval (emails the owner)
//   POST /spike/message-id-probe  try once to send with a Message-ID header of our own; record the answer
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { z } from "zod";
import { defineSystem, inboundEmail, message } from "@actord/toolkit/system";
import { actorRuntime, type Envelope, ingress } from "@actord/toolkit/runtime";
import { type ApprovalDecided, type ForwardableEmailLike, type SendEmailLike, applyDecision, approvalDecided, approvalEmail, handleEmail } from "@actord/toolkit/sources";

/** Secrets the owner puts with `wrangler secret put`; wrangler.jsonc doesn't declare them. */
type SpikeEnv = Env & { SPIKE_APPROVAL_SECRET?: string; SPIKE_TOKEN?: string };

const Outcome = z.object({ key: z.string(), status: z.enum(["confirmed", "failed", "in_doubt"]), value: z.unknown().optional(), error: z.string().optional(), usage: z.record(z.string(), z.number()).optional() });

export const system = defineSystem({
  name: "spike-email-approval",
  description: "Spike 6: a parked effect approved by a real Gmail reply",
  messages: {
    "spike.ask": message({ version: 1, description: "Ask for the harmless effect, which parks for approval", payload: z.object({ key: z.string() }) }),
    "spike.outcome": message({ version: 1, description: "The harmless effect's outcome", payload: Outcome }),
    "approval.decided": message({ version: 1, description: "The owner answered an approval request by email", payload: approvalDecided }),
  },
  sources: {
    // No authserv, on purpose (see the header comment).
    mail: inboundEmail({ secret: "SPIKE_APPROVAL_SECRET", owner: "SPIKE_OWNER", from: "SPIKE_FROM", send: "EMAIL", message: "approval.decided" }),
  },
  approvals: { notify: "notify.approval" },
  actors: {
    Desk: {
      binding: "DESK",
      kind: "deterministic",
      purpose: "Parks one harmless effect for approval and records how the emailed answer arrives",
      justification: ["state"],
      effects: ["spike.act", "notify.approval"],
    },
  },
  effects: {
    "spike.act": { description: "A harmless action: it only records that it ran", idempotency: "key", approval: "human", result: "spike.outcome" },
    "notify.approval": { description: "Email the owner that an approval is waiting", idempotency: "none" },
  },
  routes: [
    { from: "@ingress", message: "spike.ask", to: "Desk" },
    { from: "Desk", message: "spike.outcome", to: "Desk" },
    { from: "@mail", message: "approval.decided", to: "Desk" },
  ],
});

/** One header line of a received message, unfolded, in the order it appeared. */
interface HeaderLine {
  name: string;
  /** Null for DKIM-Signature, whose value isn't kept. */
  value: string | null;
}

interface InboundRecord {
  envelopeFrom: string;
  envelopeTo: string;
  rawSize: number;
  headers: HeaderLine[];
}

interface OutboundRecord {
  via: "notify" | "handleEmail" | "probe";
  subject: string;
  headers: Record<string, string>;
  ok: boolean;
  /** What send() returned (Email Service answers { messageId }), or the error it threw. */
  result: unknown;
}

export class Desk extends DurableObject<SpikeEnv> {
  readonly lifecycle = Lifecycle.install(this);

  actor = actorRuntime({ lifecycle: this.lifecycle, ctx: this.ctx, env: this.env }, system, "Desk", {
    "spike.ask": ({ payload }, ctx) => {
      ctx.effect("spike.act", { key: payload.key }, { key: payload.key });
    },
    "spike.outcome": ({ payload }, ctx) => {
      ctx.sql.exec("INSERT INTO spike_outcomes (at, key, status, body) VALUES (?, ?, ?, ?)", Date.now(), payload.key, payload.status, JSON.stringify(payload));
    },
    "approval.decided": ({ payload }, ctx) => {
      const ok = applyDecision(ctx, payload);
      ctx.sql.exec("INSERT INTO spike_decisions (at, ok, body) VALUES (?, ?, ?)", Date.now(), ok ? 1 : 0, JSON.stringify(payload));
    },
  }, {
    effects: {
      "spike.act": { run: async (input) => ({ ran: true, at: new Date().toISOString(), input }) },
      "notify.approval": approvalEmail({
        send: recording(this.env.EMAIL, async (r) => this.recordOutbound(r), "notify"),
        from: this.env.SPIKE_FROM,
        to: this.env.SPIKE_OWNER,
        secret: (this.env.SPIKE_APPROVAL_SECRET ?? "").trim(),
      }),
    },
  });

  constructor(ctx: DurableObjectState, env: SpikeEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS spike_inbound (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, envelope_from TEXT, envelope_to TEXT, raw_size INTEGER, headers TEXT NOT NULL, outcome TEXT, events TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS spike_outbound (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, via TEXT NOT NULL, subject TEXT, headers TEXT, ok INTEGER NOT NULL, result TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS spike_decisions (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, body TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS spike_outcomes (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)");
  }

  receive(envelope: Envelope) {
    return this.actor.receive(envelope);
  }

  /** Stored before handleEmail runs, so the headers are kept whatever it does. Returns the row id. */
  recordInbound(r: InboundRecord): number {
    return this.ctx.storage.sql
      .exec<{ id: number }>("INSERT INTO spike_inbound (at, envelope_from, envelope_to, raw_size, headers) VALUES (?, ?, ?, ?, ?) RETURNING id", Date.now(), r.envelopeFrom, r.envelopeTo, r.rawSize, JSON.stringify(r.headers))
      .one().id;
  }

  recordHandled(id: number, outcome: unknown, events: unknown[]): void {
    this.ctx.storage.sql.exec("UPDATE spike_inbound SET outcome = ?, events = ? WHERE id = ?", JSON.stringify(outcome), JSON.stringify(events), id);
  }

  recordOutbound(r: OutboundRecord): void {
    this.ctx.storage.sql.exec("INSERT INTO spike_outbound (at, via, subject, headers, ok, result) VALUES (?, ?, ?, ?, ?, ?)", Date.now(), r.via, r.subject, JSON.stringify(r.headers), r.ok ? 1 : 0, JSON.stringify(r.result));
  }

  report() {
    const rows = <T extends Record<string, SqlStorageValue>>(query: string) => this.ctx.storage.sql.exec<T>(query).toArray();
    const json = (v: SqlStorageValue) => (typeof v === "string" ? (JSON.parse(v) as unknown) : null);
    const iso = (at: SqlStorageValue) => new Date(Number(at)).toISOString();
    return {
      inbound: rows("SELECT * FROM spike_inbound ORDER BY id").map((r) => ({ id: r.id, at: iso(r.at), envelopeFrom: r.envelope_from, envelopeTo: r.envelope_to, rawSize: r.raw_size, headers: json(r.headers), outcome: json(r.outcome), events: json(r.events) })),
      outbound: rows("SELECT * FROM spike_outbound ORDER BY id").map((r) => ({ id: r.id, at: iso(r.at), via: r.via, subject: r.subject, headers: json(r.headers), ok: r.ok === 1, result: json(r.result) })),
      decisions: rows("SELECT * FROM spike_decisions ORDER BY id").map((r) => ({ at: iso(r.at), applied: r.ok === 1, payload: json(r.body) as ApprovalDecided })),
      outcomes: rows("SELECT * FROM spike_outcomes ORDER BY id").map((r) => ({ at: iso(r.at), key: r.key, status: r.status, outcome: json(r.body) })),
      outbox: this.actor.outbox(),
    };
  }
}

/** A send binding that records every send (and what it returned or threw) before passing the answer on. */
function recording(binding: SendEmail, sink: (r: OutboundRecord) => Promise<void>, via: OutboundRecord["via"]): SendEmailLike {
  return {
    async send(m) {
      const base = { via, subject: m.subject, headers: m.headers ?? {} };
      // SendEmailLike allows { email } without a name; the Workers EmailAddress type requires one.
      const from = typeof m.from === "string" ? m.from : m.from.name === undefined ? m.from.email : { email: m.from.email, name: m.from.name };
      let result: unknown;
      try {
        result = await binding.send({ ...m, from });
      } catch (err) {
        await sink({ ...base, ok: false, result: errorOf(err) });
        throw err;
      }
      await sink({ ...base, ok: true, result });
      return result;
    },
  };
}

const errorOf = (err: unknown) => ({ code: (err as { code?: unknown } | null)?.code ?? null, message: (err as { message?: string } | null)?.message ?? String(err) });

/** Every header line of a raw message, unfolded and in order. DKIM-Signature keeps its name only. */
function headerLines(raw: Uint8Array): HeaderLine[] {
  const text = new TextDecoder("utf-8").decode(raw);
  const end = /\r?\n\r?\n/.exec(text);
  const block = end ? text.slice(0, end.index) : text;
  const lines: HeaderLine[] = [];
  for (const line of block.split(/\r?\n/)) {
    const last = lines[lines.length - 1];
    if (/^[ \t]/.test(line) && last) {
      if (last.value !== null) last.value += `\n${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    lines.push({ name, value: name.toLowerCase() === "dkim-signature" ? null : value });
  }
  return lines;
}

async function authorized(request: Request, env: SpikeEnv): Promise<boolean> {
  const expected = (env.SPIKE_TOKEN ?? "").trim();
  const given = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (expected === "" || given === undefined) return false;
  const digest = async (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    if (!(await authorized(request, env))) return new Response("unauthorized\n", { status: 401 });
    const url = new URL(request.url);
    const desk = env.DESK.getByName("main");

    if (request.method === "GET" && url.pathname === "/spike") return Response.json(await desk.report());

    if (request.method === "POST" && url.pathname === "/spike/ask") {
      const key = url.searchParams.get("key") ?? `ask-${Date.now()}`;
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) return new Response("key: 1-64 of A-Z a-z 0-9 . _ -\n", { status: 400 });
      const receipt = await ingress(env, system, "Desk", "spike.ask", { key }, { key: "main", id: `spike.ask:${key}` });
      return Response.json({ key, receipt });
    }

    if (request.method === "POST" && url.pathname === "/spike/message-id-probe") {
      // Email Service documents Message-ID as platform-controlled (E_HEADER_NOT_ALLOWED). This checks it once.
      const send = recording(env.EMAIL, async (r) => desk.recordOutbound(r), "probe");
      const messageId = `<spike6-probe-${Date.now()}@actord.dev>`;
      try {
        const result = await send.send({ from: env.SPIKE_FROM, to: env.SPIKE_OWNER, subject: "spike 6: Message-ID probe (no action needed)", text: `This email tried to set Message-ID: ${messageId}\n`, headers: { "Message-ID": messageId } });
        return Response.json({ ok: true, tried: messageId, result });
      } catch (err) {
        return Response.json({ ok: false, tried: messageId, error: errorOf(err) });
      }
    }

    return new Response("not found\n", { status: 404 });
  },

  async email(message, env) {
    const desk = env.DESK.getByName("main");
    // message.raw can be read once: buffer it, keep the headers, then hand handleEmail a fresh stream.
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const id = await desk.recordInbound({ envelopeFrom: message.from, envelopeTo: message.to, rawSize: message.rawSize, headers: headerLines(raw) });

    // handleEmail returns nothing; its outcomes are source.* events written with console.log. Capture them
    // while it runs (one email at a time is all this spike sees). When Desk runs in the same isolate, its own
    // events (received, handled, effect.*) land here too.
    const events: unknown[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith('{"$actord"')) events.push(JSON.parse(args[0]));
      log(...args);
    };
    const buffered: ForwardableEmailLike = { from: message.from, to: message.to, headers: message.headers, raw: new Response(raw).body!, rawSize: message.rawSize };
    let outcome: unknown;
    try {
      await handleEmail(buffered, { ...env, EMAIL: recording(env.EMAIL, async (r) => desk.recordOutbound(r), "handleEmail") }, system);
      outcome = { status: "returned" };
    } catch (err) {
      outcome = { status: "threw", error: errorOf(err) };
    } finally {
      console.log = log;
    }
    await desk.recordHandled(id, outcome, events);
  },
} satisfies ExportedHandler<SpikeEnv>;
