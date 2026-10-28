// The payloads the runtime itself delivers to actors (approval.decided, agent.failed, agent.exhausted), with their
// hand-written Standard Schemas, so apps declare them with no schema library. This module imports types only, so
// @actord/toolkit/system can export it: `actord check` loads system.ts under Node, and the sources and agents entry
// points import cloudflare:workers (through agents/lifecycle), which Node can't load. They re-export it.
import type { EffectUsage } from "./runtime/index.ts";
import type { StandardResult, StandardSchemaV1 } from "./system.ts";

type Issue = { message: string; path: [string] | [] };

// ---- approval.decided ----

/** The payload of `approval.decided`: a person's answer to an approval request, from a source such as @email. */
export interface ApprovalDecided {
  effect: string;
  effectKey: string;
  decision: "approve" | "deny";
  /** A denial's reason; null when none was given. */
  reason: string | null;
  /** Who decided: for email, the verified sender address. */
  by: string;
  /**
   * "pass": the topmost Authentication-Results header comes from the source's trusted authserv-id and every
   * dmarc result in it is pass, for the owner's domain (header.from). With an authserv configured, nothing else
   * is delivered, so the answer is always "pass". "unknown" is the answer of a source with no authserv, whose
   * replies are never checked. (A dmarc=fail anywhere refuses the reply before this is set.)
   */
  authenticated: "pass" | "unknown";
}

const FIELDS = ["effect", "effectKey", "decision", "reason", "by", "authenticated"] as const;

function validateDecided(value: unknown): StandardResult<ApprovalDecided> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { issues: [{ message: "expected an object", path: [] }] };
  const v = value as Record<string, unknown>;
  const issues: Issue[] = [];
  const nonEmpty = (k: "effect" | "effectKey" | "by") => {
    if (typeof v[k] !== "string" || v[k] === "") issues.push({ message: `${k}: expected a non-empty string`, path: [k] });
  };
  nonEmpty("effect");
  nonEmpty("effectKey");
  if (v.decision !== "approve" && v.decision !== "deny") issues.push({ message: 'decision: expected "approve" or "deny"', path: ["decision"] });
  if (v.reason !== null && typeof v.reason !== "string") issues.push({ message: "reason: expected a string or null", path: ["reason"] });
  nonEmpty("by");
  if (v.authenticated !== "pass" && v.authenticated !== "unknown") issues.push({ message: 'authenticated: expected "pass" or "unknown"', path: ["authenticated"] });
  if (issues.length > 0) return { issues };
  // Only the declared fields go on, as a schema library's object parser would.
  return { value: Object.fromEntries(FIELDS.map((k) => [k, v[k]])) as unknown as ApprovalDecided };
}

/** A fresh copy each call, so a caller that edits it can't change the next one. */
const decidedJsonSchema = (): Record<string, unknown> => ({
  type: "object",
  properties: {
    effect: { type: "string", minLength: 1 },
    effectKey: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["approve", "deny"] },
    reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    by: { type: "string", minLength: 1 },
    authenticated: { type: "string", enum: ["pass", "unknown"] },
  },
  required: [...FIELDS],
  additionalProperties: false,
});

/** The Standard Schema for `approval.decided`'s payload, written by hand so apps need no schema library. */
export const approvalDecided: StandardSchemaV1<ApprovalDecided> = {
  "~standard": {
    version: 1,
    vendor: "actord",
    validate: validateDecided,
    jsonSchema: { input: decidedJsonSchema },
  },
};

// ---- agent.failed and agent.exhausted ----

/** The budgets an agent session can run out of. */
export const AGENT_BUDGETS = ["usd", "turns", "wallClock"] as const;

/** The payload of `agent.failed`: a session ended without a result. `session` is "" when pi never opened one. */
export interface AgentFailed {
  session: string;
  key: string;
  reason: string;
  usage?: EffectUsage;
}
/** The payload of `agent.exhausted`: a session ran out of one of its actor's budgets. */
export interface AgentExhausted {
  session: string;
  key: string;
  budget: (typeof AGENT_BUDGETS)[number];
  usage?: EffectUsage;
}

const USAGE_FIELDS = ["inputTokens", "outputTokens", "costUsd", "containerSeconds"] as const;

/** Checks the fields every session message has, and copies the declared ones. */
function sessionFields(value: unknown, issues: Issue[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push({ message: "expected an object", path: [] });
    return null;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.session !== "string") issues.push({ message: "session: expected a string", path: ["session"] });
  if (typeof v.key !== "string" || v.key === "") issues.push({ message: "key: expected a non-empty string", path: ["key"] });
  if (v.usage !== undefined) {
    const u = v.usage as Record<string, unknown> | null;
    if (typeof u !== "object" || u === null || Array.isArray(u)) issues.push({ message: "usage: expected an object", path: ["usage"] });
    else for (const f of USAGE_FIELDS) if (u[f] !== undefined && (typeof u[f] !== "number" || !Number.isFinite(u[f]) || (u[f] as number) < 0)) issues.push({ message: `usage.${f}: expected a finite number at or above 0`, path: ["usage"] });
  }
  return v;
}
const usageOf = (v: Record<string, unknown>) => (v.usage === undefined ? {} : { usage: Object.fromEntries(USAGE_FIELDS.filter((f) => (v.usage as Record<string, unknown>)[f] !== undefined).map((f) => [f, (v.usage as Record<string, unknown>)[f]])) });

const usageJsonSchema = () => ({ type: "object", properties: Object.fromEntries(USAGE_FIELDS.map((f) => [f, { type: "number", minimum: 0 }])), additionalProperties: false });

/** The Standard Schema for `agent.failed`'s payload, written by hand so apps need no schema library. */
export const agentFailed: StandardSchemaV1<AgentFailed> = {
  "~standard": {
    version: 1,
    vendor: "actord",
    validate(value): StandardResult<AgentFailed> {
      const issues: Issue[] = [];
      const v = sessionFields(value, issues);
      if (v && typeof v.reason !== "string") issues.push({ message: "reason: expected a string", path: ["reason"] });
      if (!v || issues.length > 0) return { issues };
      return { value: { session: v.session, key: v.key, reason: v.reason, ...usageOf(v) } as AgentFailed };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { session: { type: "string" }, key: { type: "string", minLength: 1 }, reason: { type: "string" }, usage: usageJsonSchema() },
        required: ["session", "key", "reason"],
        additionalProperties: false,
      }),
    },
  },
};

/** The Standard Schema for `agent.exhausted`'s payload, written by hand so apps need no schema library. */
export const agentExhausted: StandardSchemaV1<AgentExhausted> = {
  "~standard": {
    version: 1,
    vendor: "actord",
    validate(value): StandardResult<AgentExhausted> {
      const issues: Issue[] = [];
      const v = sessionFields(value, issues);
      if (v && !AGENT_BUDGETS.includes(v.budget as AgentExhausted["budget"])) issues.push({ message: 'budget: expected "usd", "turns" or "wallClock"', path: ["budget"] });
      if (!v || issues.length > 0) return { issues };
      return { value: { session: v.session, key: v.key, budget: v.budget, ...usageOf(v) } as AgentExhausted };
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { session: { type: "string" }, key: { type: "string", minLength: 1 }, budget: { type: "string", enum: [...AGENT_BUDGETS] }, usage: usageJsonSchema() },
        required: ["session", "key", "budget"],
        additionalProperties: false,
      }),
    },
  },
};
