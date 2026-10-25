import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Host-specific project guidance. Runtime, declarations, checks and evidence have no host dependency.
import { claudeMd, settingsJson, verifySkill } from "./claude.ts";

export type AgentHost = "claude" | "codex" | "none";

export function agentHost(value: string | undefined): AgentHost {
  const host = value ?? "claude";
  if (host !== "claude" && host !== "codex" && host !== "none")
    throw new Error(
      `Unknown actor host: ${host}. Choose claude, codex, or none.`,
    );
  return host;
}

export function hostFiles(
  host: AgentHost,
  name: string,
): Record<string, string> {
  if (host === "none") return {};
  if (host === "claude")
    return {
      ".claude/skills/verify/SKILL.md": verifySkill(),
      ".claude/settings.json": settingsJson(),
      "CLAUDE.md": claudeMd(name),
    };
  return {
    ".agents/skills/verify/SKILL.md": `---\nname: verify\ndescription: Run this actor project's typecheck, declaration checks, workerd tests and reliability claims before reporting completion.\n---\n\nRun \`npm run verify\` and read \`.actord/evidence.json\`. Report each claim as proved locally, stub only, not guaranteed, blocked, failing or untested, and report the real verdict. Fix failures. A blocked check is not a pass. Before evolving contracts capture \`actord diff\`, preserve existing APIs and tests, and add tests for the requested behavior. Deployment and real external writes require the user's authorization.\n`,
    "AGENTS.md": `# ${name}\n\nThis project uses the shared @actord/toolkit core on native Cloudflare Durable Objects.\n\n- Read \`system.ts\` for actors, messages, routes, effects and budgets; implementations live in \`src/actors/\`.\n- Run \`npx actord check\`, \`npx actord graph --write\`, and \`npm run verify\` after changes. Read the verdict in \`.actord/evidence.json\`.\n- Use \`npx actord trace <message-id>\` for local causal evidence. Say unknown beyond recorded coverage.\n- Preserve public read methods and existing tests while adding behavior. Add a test proving the requested change.\n- Review \`npx actord diff\` before resource or contract changes. Keep old message shapes accepted until queued messages drain.\n- The user's instructions take precedence. Obtain authorization for deployment or real external writes; verification itself is local.\n`,
  };
}

/** Project pins retain their host outside a plugin-launched process. */
export function projectHost(root: string): AgentHost {
  try {
    const host = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      .actord?.host;
    if (host === "codex" || host === "claude" || host === "none") return host;
  } catch {
    /* An uninitialized directory has no profile yet. */
  }
  if (existsSync(join(root, ".agents/skills/verify/SKILL.md"))) return "codex";
  return "claude";
}
