// Command hooks the plugin registers (hooks/hooks.json). Both are deterministic, call no model, and
// exit within milliseconds outside actor projects. Neither blocks an edit; the evidence gate may hold
// a stop once per turn, and only when the user opted in.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fingerprint } from "../../model/fingerprint.ts";
import { findProjectRoot } from "../project.ts";
import { check, LAST_CHECK_FILE } from "./model.ts";

interface HookInput {
  cwd?: string;
  tool_input?: { file_path?: string };
  stop_hook_active?: boolean;
}

const RELEVANT = /(^|\/)(system\.ts|wrangler\.jsonc?|actors\.manifest\.json)$|\/src\/(actors|messages)\/|\/src\/index\.ts$/;
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
  err.write(`actors hook: unknown hook "${name ?? ""}"\n`);
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
    err.write(`actors: check-on-edit skipped (over its ${BUDGET_MS / 1000}s budget); run \`actors check\`\n`);
    return 0;
  }
  if (result.data.errors === 0) return 0;
  const context = `${result.text}\nThese are hard errors from \`actors check\` after editing ${relative(root, file)}. Fix them, or explain why the declaration should change.`;
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
    `${JSON.stringify({ decision: "block", reason: "Actor files changed since the last passing check: run `actors check` and the affected tests before reporting." })}\n`,
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
