// The Worker's handler for webhook sources (spec §6.2): verify, map, validate, deliver, answer.
//
// - Verify: X-Hub-Signature-256 must be the HMAC-SHA256 of the raw request bytes, keyed with the secret
//   that `env[source.secret]` holds. It is checked before the body is parsed, and compared in constant time.
// - Id: X-GitHub-Delivery becomes the envelope id, so a redelivery is deduplicated by the receiver's inbox.
// - Map: the event is `${X-GitHub-Event}.${payload.action}` (the bare event name when the payload has no
//   action). Its `key` names the receiving actor's instance, and `map` builds the message's payload,
//   which is validated against the message's schema before delivery.
// - Answer: 202 handled or duplicate, 204 unmapped, 400 invalid, 401 refused, 405 not POST, 500 failed.
//   Every refusal and failure is recorded as a `source.*` event with `actor` "@<source>".
// Not guaranteed: GitHub signs only the body, so a captured delivery replayed under a new X-GitHub-Delivery
// (or a new X-GitHub-Event) passes verification and is delivered again. The receiver's own idempotency
// is what protects it.
import { type ActorEvent, type EventKind, type Receipt, deliverExternal, emit } from "../runtime/index.ts";
import type { StandardSchemaV1, System, WebhookEventSpec, WebhookSourceSpec } from "../system.ts";

const enc = new TextEncoder();
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
/** Header values recorded before they are trusted are cut to this length. */
const UNTRUSTED_MAX = 200;

/** Handle a request if its path belongs to a declared webhook source; null otherwise, so the app's own routes run. */
export async function handleWebhook(request: Request, env: unknown, system: System): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const found = Object.entries(system.sources ?? {}).find(([, s]) => s.kind === "webhook" && s.path === path) as [string, WebhookSourceSpec] | undefined;
  if (!found) return null;
  const [name, source] = found;
  const sender = `@${name}` as const;
  const record = (kind: EventKind, fields: Omit<ActorEvent, "$actord" | "kind" | "at" | "actor">) => emit({ kind, at: Date.now(), actor: sender, ...fields });

  if (request.method !== "POST") return answer(405, "only POST", { allow: "POST" });
  // The raw bytes, exactly as signed: nothing may parse or re-encode them before the signature is checked.
  const body = new Uint8Array(await request.arrayBuffer());
  const secret = (env as Record<string, unknown> | null)?.[source.secret];
  if (typeof secret !== "string" || secret === "") {
    record("source.rejected", { reason: "secret_missing", detail: { source: name, secret: source.secret } });
    return answer(500, `the webhook secret ${source.secret} is not configured`);
  }
  if (!(await signatureValid(secret, body, request.headers.get("x-hub-signature-256")))) {
    record("source.rejected", { reason: "signature", detail: { source: name, deliveryId: untrusted(request.headers.get("x-github-delivery")) } });
    return answer(401, "signature mismatch");
  }

  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId) {
    record("source.invalid", { reason: "delivery_id_missing", detail: { source: name } });
    return answer(400, "missing X-GitHub-Delivery");
  }
  const invalid = (reason: string, fields: { event?: string; type?: string; error?: string } = {}) => {
    const { type, ...rest } = fields;
    record("source.invalid", { messageId: deliveryId, ...(type ? { type } : {}), reason, detail: { source: name, deliveryId, ...rest } });
    return answer(400, rest.error ? `${reason}: ${rest.error}` : reason);
  };
  const failed = (reason: string, fields: { event: string; type: string; error?: string }) => {
    const { type, ...rest } = fields;
    record("source.failed", { messageId: deliveryId, type, reason, detail: { source: name, deliveryId, ...rest } });
    return answer(500, reason);
  };

  const ghEvent = request.headers.get("x-github-event");
  if (!ghEvent) return invalid("event_missing");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (err) {
    return invalid("invalid_json", { event: ghEvent, error: messageOf(err) });
  }
  const action = typeof payload === "object" && payload !== null ? (payload as { action?: unknown }).action : undefined;
  const event = typeof action === "string" ? `${ghEvent}.${action}` : ghEvent;
  // Own keys only: an event named like an inherited property ("constructor") has no mapping.
  const spec: WebhookEventSpec | undefined = Object.hasOwn(source.events, event) ? source.events[event] : undefined;
  if (!spec) {
    record("source.ignored", { messageId: deliveryId, detail: { source: name, event, deliveryId } });
    return answer(204);
  }

  const type = spec.message;
  let key: unknown;
  let mapped: unknown;
  try {
    key = spec.key(payload);
    mapped = spec.map(payload);
  } catch (err) {
    return invalid("mapping_failed", { event, type, error: messageOf(err) });
  }
  const msgSpec = system.messages[type];
  if (!msgSpec) return failed("unknown_message", { event, type, error: `${type} is not declared` });
  let issues: string | null;
  try {
    const validated = await (msgSpec.payload as StandardSchemaV1)["~standard"].validate(mapped);
    issues = validated.issues ? validated.issues.map((i) => i.message).join("; ") : null;
  } catch (err) {
    issues = messageOf(err);
  }
  if (issues !== null) return invalid("invalid_payload", { event, type, error: issues });
  if (typeof key !== "string" || key === "") return invalid("invalid_key", { event, type, error: `key(event) returned ${JSON.stringify(key) ?? String(key)}, not a non-empty string` });

  // `actord check` guarantees exactly one route from a webhook source for each mapped message.
  const route = system.routes.find((r) => r.from === sender && r.message === type);
  if (!route) return failed("no_route", { event, type, error: `no route ${sender} → ${type}` });
  let receipt: Receipt;
  try {
    receipt = await deliverExternal(env, system, sender, route.to, type, mapped, { key, id: deliveryId });
  } catch (err) {
    return failed("delivery_failed", { event, type, error: messageOf(err) });
  }
  if (receipt.status === "handled" || receipt.status === "duplicate") return answer(202, receipt.status);
  if (receipt.status === "rejected") return invalid(receipt.reason, { event, type, ...(receipt.detail ? { error: receipt.detail } : {}) });
  // GitHub doesn't redeliver on its own: this record is what lets someone find the delivery and redeliver it.
  return failed("handler_failed", { event, type, error: receipt.error });
}

/** `header` must be "sha256=" and the lowercase hex HMAC-SHA256 of `body` keyed with `secret`. */
async function signatureValid(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  const given = SIGNATURE.exec(header ?? "")?.[1];
  if (!given) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return equalConstantTime(expected, hexBytes(given));
}

/** Compares every byte whatever the first difference, so the time taken says nothing about where they differ. */
function equalConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function answer(status: number, text?: string, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : (text ?? null), { status, headers: status === 204 ? headers : { "content-type": "text/plain; charset=utf-8", ...headers } });
}

const untrusted = (value: string | null) => (value === null ? null : value.slice(0, UNTRUSTED_MAX));
const messageOf = (err: unknown) => (err as { message?: string } | null)?.message ?? String(err);
