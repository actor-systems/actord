// Git from the Durable Object's side, with Computer's git client. The token is minted by the caller and handed to the
// git client as an Authorization header for one call; it never reaches the container, a row, an event or an error.
import type { Workspace } from "@cloudflare/computer";
import { type EffectAdapter, EffectRejected } from "../runtime/index.ts";

/** The forms a token can take in anything that quotes the request: raw, as Bearer, and as Basic. */
function scrubber(token: string): (text: string) => string {
  const forms = [`Basic ${btoa(`x-access-token:${token}`)}`, btoa(`x-access-token:${token}`), `Bearer ${token}`, token];
  return (text) => forms.filter(Boolean).reduce((t, form) => t.replaceAll(form, "[token]"), text);
}

/** Run `fn`; an error it throws leaves with the token scrubbed from its message, and without its cause. */
async function scrubbed<T>(token: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EffectRejected) throw e;
    const error = new Error(scrubber(token)(e instanceof Error ? e.message : String(e)));
    if (e instanceof Error) error.name = e.name;
    throw error;
  }
}

/** Clone in full (a branch that will be pushed must not be shallow) on the Durable Object side; the token never reaches the container. */
export async function gitClone(workspace: Workspace, options: { url: string; dir: string; ref?: string; token?: () => Promise<string> }): Promise<void> {
  const token = options.token ? await options.token() : undefined;
  await scrubbed(token ?? "", () =>
    workspace.git.clone({ url: options.url, dir: options.dir, ref: options.ref, singleBranch: true, headers: token ? { Authorization: `Bearer ${token}` } : undefined }),
  );
}

/**
 * The default `allow`: a valid git refname under factory/. Beyond the prefix it refuses what git's check-ref-format
 * does (`..`, `@{`, `//`, a component that starts with `.` or ends with `.lock`, a trailing `/` or `.`), whitespace,
 * control characters and `~^:?*[\`, so the guard doesn't rely on the client or the server to refuse them.
 */
export function factoryBranch(branch: string): boolean {
  if (!/^factory\/[A-Za-z0-9._\/-]+$/.test(branch)) return false;
  if (branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".")) return false;
  return branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** An authentication failure: a 401/403 status or message, or words that say so. */
function isAuthFailure(failure: unknown): boolean {
  const status = (failure as { status?: unknown; statusCode?: unknown; code?: unknown } | null) ?? {};
  if ([status.status, status.statusCode, status.code].some((c) => c === 401 || c === 403 || c === "401" || c === "403")) return true;
  const text = failure instanceof Error ? `${failure.name} ${failure.message}` : String(failure);
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|authentication|permission denied|bad credentials/i.test(text);
}

/**
 * An effect adapter that pushes `input.branch` from `dir`; declare it `idempotency: "key"` (pushing the same commit again is harmless).
 * It tries Bearer first and Basic (`x-access-token`, as GitHub Actions does) only if that push fails to authenticate,
 * since GitHub's acceptance of Bearer on the git endpoint is unconfirmed until spike 5 runs. Any other failure
 * (non-fast-forward, network) surfaces as itself.
 */
export function gitPushEffect(options: { workspace: () => Workspace; dir: string; remote?: string; token: () => Promise<string>; allow?: (branch: string) => boolean }): EffectAdapter<{ branch: string }, { branch: string; refs: unknown }> {
  const allow = options.allow ?? factoryBranch;
  return {
    async run({ branch }, { signal }) {
      if (typeof branch !== "string" || !allow(branch)) throw new EffectRejected("may push only factory/ branches");
      const token = await options.token();
      const scrub = scrubber(token);
      const git = options.workspace().git;
      let failure = "push was refused";
      for (const authorization of [`Bearer ${token}`, `Basic ${btoa(`x-access-token:${token}`)}`]) {
        signal.throwIfAborted();
        let cause: unknown;
        try {
          const result = await git.push({ dir: options.dir, remote: options.remote ?? "origin", ref: branch, remoteRef: `refs/heads/${branch}`, headers: { Authorization: authorization } });
          if (result.ok) return { branch, refs: JSON.parse(scrub(JSON.stringify(result.refs ?? {}))) };
          cause = result.error ?? failure;
        } catch (e) {
          cause = e;
        }
        failure = cause instanceof Error ? cause.message : String(cause);
        if (!isAuthFailure(cause)) break;
      }
      throw new Error(`git push failed: ${scrub(failure)}`);
    },
  };
}
