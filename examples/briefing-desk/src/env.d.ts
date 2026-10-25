// Optional settings that wrangler.jsonc doesn't declare. Set secrets with `wrangler secret put` (a person's step).
interface Env {
  /** Without it, the analyst reports the model as unavailable and routes every item to a person. */
  ANTHROPIC_API_KEY?: string;
  /** Defaults to claude-opus-5-5. */
  ANALYST_MODEL?: string;
  /** Without it, approved briefings fail as "no gateway configured" rather than pretending to send. */
  BRIEFING_WEBHOOK_URL?: string;
}
