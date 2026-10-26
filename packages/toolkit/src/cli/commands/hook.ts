// Command hooks the plugin registers (hooks/hooks.json). All are deterministic, call no model, and
// exit within milliseconds outside actor projects. None blocks an edit or decides a tool call; the
// evidence gate may hold a stop once per turn, and only when the user opted in.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fingerprint } from "../../model/fingerprint.ts";
import { findProjectRoot } from "../project.ts";
import { check, LAST_CHECK_FILE } from "./model.ts";

interface HookInput {
  cwd?: string;
  permission_mode?: string;
  tool_input?: { file_path?: string; command?: string };
  stop_hook_active?: boolean;
}

const RELEVANT = /(^|\/)(system\.ts|wrangler\.jsonc?|actord\.manifest\.json)$|\/src\/(actors|messages)\/|\/src\/index\.ts$/;
const BUDGET_MS = 2_000;

export async function hook(name: string | undefined, stdin: string, env: NodeJS.ProcessEnv, out: NodeJS.WritableStream, err: NodeJS.WritableStream): Promise<number> {
  let input: HookInput = {};
  try {
    input = stdin.trim() ? (JSON.parse(stdin) as HookInput) : {};
  } catch {
    return 0; // not our input; never break the session
  }
  if (name === "check-on-edit") return checkOnEdit(input, env, out, err);
  if (name === "evidence-gate") return evidenceGate(input, env, out);
  if (name === "heredoc-note") return heredocNote(input, out);
  err.write(`actord hook: unknown hook "${name ?? ""}"\n`);
  return 0;
}

export const HEREDOC_NOTE =
  "actord: this session runs in don't-ask mode, which refuses shell heredocs. If this command is refused, only this command is: Bash is still available for tests, `actord`, and git. Write or change files with the Write and Edit tools.";

/** A heredoc: `<<WORD` or `<<-'WORD'` (not a `<<<` here-string), closed later by a line holding only WORD. */
export function hasHeredoc(command: string): boolean {
  for (const m of command.matchAll(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g)) {
    const rest = command.slice(m.index + m[0].length).split("\n").slice(1);
    if (rest.some((line) => line.replace(/^\t+/, "").trimEnd() === m[2])) return true;
  }
  return false;
}

// Don't-ask mode refuses heredocs, and the refusal reads "Permission to use Bash has been denied", which
// agents take for all of Bash. This adds a note beside the refusal; it never decides the call.
function heredocNote(input: HookInput, out: NodeJS.WritableStream): number {
  if (input.permission_mode !== "dontAsk") return 0;
  const command = input.tool_input?.command;
  if (!command || !hasHeredoc(command)) return 0;
  if (!findProjectRoot(input.cwd ?? process.cwd())) return 0;
  out.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: HEREDOC_NOTE } })}\n`);
  return 0;
}

async function checkOnEdit(input: HookInput, env: NodeJS.ProcessEnv, out: NodeJS.WritableStream, err: NodeJS.WritableStream): Promise<number> {
  if (env.CLAUDE_PLUGIN_OPTION_CHECK_ON_EDIT === "false") return 0;
  const file = input.tool_input?.file_path;
  if (!file || !RELEVANT.test(file.replaceAll("\\", "/"))) return 0;
  const root = findProjectRoot(dirname(file));
  if (!root) return 0;
  const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), BUDGET_MS).unref());
  const result = await Promise.race([check(root, { changed: [file], format: "brief" }), timer]);
  if (result === "timeout") {
    err.write(`actord: check-on-edit skipped (over its ${BUDGET_MS / 1000}s budget); run \`actord check\`\n`);
    return 0;
  }
  if (result.data.errors === 0) return 0;
  const context = `${result.text}\nThese are hard errors from \`actord check\` after editing ${relative(root, file)}. Fix them, or explain why the declaration should change.`;
  out.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } })}\n`);
  return 0;
}

function evidenceGate(input: HookInput, env: NodeJS.ProcessEnv, out: NodeJS.WritableStream): number {
  if (env.CLAUDE_PLUGIN_OPTION_STRICT_EVIDENCE !== "true") return 0;
  if (input.stop_hook_active) return 0; // never block twice in a turn
  const root = findProjectRoot(input.cwd ?? process.cwd());
  if (!root) return 0;
  let last: { ok?: boolean; fingerprint?: string } | null = null;
  try {
    last = JSON.parse(readFileSync(join(root, LAST_CHECK_FILE), "utf8"));
  } catch {
    last = null;
  }
  if (last?.ok && last.fingerprint === fingerprint(root)) return 0;
  if (!last && !actorFilesModified(root)) return 0; // nothing checked, nothing changed: a read-only session
  out.write(
    `${JSON.stringify({ decision: "block", reason: "Actor files changed since the last passing check: run `actord check` and the affected tests before reporting." })}\n`,
  );
  return 0;
}

function actorFilesModified(root: string): boolean {
  if (!existsSync(join(root, ".git")) && spawnSync("git", ["-C", root, "rev-parse"], { stdio: "ignore" }).status !== 0) return false;
  const r = spawnSync("git", ["-C", root, "status", "--porcelain", "--", "system.ts", "src/actors", "src/messages", "src/index.ts", "wrangler.jsonc"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim().length > 0;
}
