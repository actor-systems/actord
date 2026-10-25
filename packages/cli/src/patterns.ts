// The one table of commands that deploy, touch secrets, or write to a remote Cloudflare account.
// Consumers: `actord init` (Claude Code `ask` rules), the Room's effect guard (regex), and eval
// graders (regex). Matching command text is a convenience, not a security boundary: other spellings
// (`sh -c`, absolute paths) slip past. Cloudflare token scopes are the enforceable layer.

export type EffectKind = "deploy" | "secret" | "remote-write" | "credential";

export interface EffectPattern {
  id: string;
  kind: EffectKind;
  description: string;
  /** Claude Code permission rules (Bash rule syntax) generated into a project's `ask` list. */
  rules: string[];
  /** Matches the command text, anywhere in a compound command. */
  regex: RegExp;
  /** Commands that must match; used by tests. */
  examples: string[];
}

const W = String.raw`(?:^|[\s;&|(])(?:\S*/)?wrangler`; // wrangler, npx wrangler, ./node_modules/.bin/wrangler

export const EFFECT_PATTERNS: readonly EffectPattern[] = [
  {
    id: "wrangler-deploy",
    kind: "deploy",
    description: "Deploy or publish a Worker",
    rules: ["Bash(*wrangler deploy*)", "Bash(*wrangler publish*)"],
    regex: new RegExp(`${W}\\s+(?:.*\\s)?(?:deploy|publish)\\b`),
    examples: ["wrangler deploy", "npx wrangler deploy --env production", "cd app && pnpm exec wrangler publish"],
  },
  {
    id: "wrangler-versions",
    kind: "deploy",
    description: "Upload or deploy a Worker version",
    rules: ["Bash(*wrangler versions upload*)", "Bash(*wrangler versions deploy*)"],
    regex: new RegExp(`${W}\\s+versions\\s+(?:upload|deploy)\\b`),
    examples: ["wrangler versions upload", "npx wrangler versions deploy 1234@100%"],
  },
  {
    id: "wrangler-rollback",
    kind: "deploy",
    description: "Roll back, delete, or change triggers of a deployed Worker",
    rules: ["Bash(*wrangler rollback*)", "Bash(*wrangler delete*)", "Bash(*wrangler triggers deploy*)"],
    regex: new RegExp(`${W}\\s+(?:rollback|delete|triggers\\s+deploy)\\b`),
    examples: ["wrangler rollback", "npx wrangler delete", "wrangler triggers deploy"],
  },
  {
    id: "wrangler-secret",
    kind: "secret",
    description: "Create, change, or delete Worker secrets",
    rules: ["Bash(*wrangler secret*)", "Bash(*wrangler versions secret*)"],
    regex: new RegExp(`${W}\\s+(?:versions\\s+)?secrets?(?:-store)?\\b`),
    examples: ["wrangler secret put API_KEY", "npx wrangler versions secret put X", "wrangler secrets-store secret create"],
  },
  {
    id: "wrangler-remote",
    kind: "remote-write",
    description: "Run a storage or dev command against the remote account",
    rules: ["Bash(*wrangler * --remote*)"],
    regex: new RegExp(`${W}\\s+.*\\s--remote\\b`),
    examples: ["wrangler d1 execute DB --remote --command 'DELETE FROM t'", "npx wrangler kv key put k v --remote"],
  },
  {
    id: "wrangler-resource-write",
    kind: "remote-write",
    description: "Create or delete account resources (KV, R2, D1, Queues, and similar)",
    rules: ["Bash(*wrangler * create*)", "Bash(*wrangler * delete*)"],
    regex: new RegExp(`${W}\\s+\\S+(?:\\s+\\S+)?\\s+(?:create|delete)\\b`),
    examples: ["wrangler kv namespace create CACHE", "npx wrangler r2 bucket delete archive", "wrangler queues create q"],
  },
  {
    id: "wrangler-login",
    kind: "credential",
    description: "Sign in to Cloudflare",
    rules: ["Bash(*wrangler login*)"],
    regex: new RegExp(`${W}\\s+login\\b`),
    examples: ["wrangler login", "npx wrangler login --browser=false"],
  },
  {
    id: "script-deploy",
    kind: "deploy",
    description: "A package script named deploy",
    rules: ["Bash(* run deploy*)", "Bash(yarn deploy*)"],
    regex: /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy\b/,
    examples: ["npm run deploy", "pnpm run deploy -- --env prod", "yarn deploy"],
  },
  {
    id: "cf-deploy",
    kind: "deploy",
    description: "Deploy with Cloudflare's cf CLI or Void",
    rules: ["Bash(cf deploy*)", "Bash(cf * deploy*)", "Bash(*void deploy*)"],
    regex: /(?:^|[\s;&|(])(?:cf(?:\s+\S+)?\s+deploy|(?:\S*\/)?void\s+deploy)\b/,
    examples: ["cf deploy", "cf previews deploy", "npx void deploy"],
  },
];

/** The patterns a command matches, in table order. */
export function matchEffect(command: string): EffectPattern[] {
  return EFFECT_PATTERNS.filter((p) => p.regex.test(command));
}

/** Every `ask` rule a generated project should carry, deduplicated, in table order. */
export function askRules(): string[] {
  return [...new Set(EFFECT_PATTERNS.flatMap((p) => p.rules))];
}

/**
 * Approximates Claude Code's Bash rule matching for tests and `doctor`: `*` matches any text and
 * the rest is literal. Claude Code also splits compound commands; callers pass one subcommand.
 */
export function bashRuleMatches(rule: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const pattern = m[1]!.replace(/:\*$/, " *");
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  // A trailing " *" also matches the bare command (documented Claude Code behavior).
  const re = pattern.endsWith(" *") && pattern.indexOf("*") === pattern.length - 1 ? `${source.slice(0, -3)}(?: .*)?` : source;
  return new RegExp(`^${re}$`, "s").test(command);
}
