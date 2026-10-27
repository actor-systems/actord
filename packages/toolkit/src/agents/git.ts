// Git from the Durable Object's side, with Computer's git client. The token is minted by the caller and handed to the
// git client as an Authorization header for one call; it never reaches the container, a row, an event or an error.
import type { Workspace } from "@cloudflare/computer";
import { type EffectAdapter, EffectRejected } from "../runtime/index.ts";

/** The forms a token can take in anything that quotes the request: raw, as Bearer, and as Basic. */
function scrubber(token: string): (text: string) => string {
  const forms = [`Basic ${btoa(`x-access-token:${token}`)}`, btoa(`x-access-token:${token}`), `Bearer ${token}`, token];
  return (text) => forms.reduce((t, form) => t.replaceAll(form, "[token]"), text);
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
 * An effect adapter that pushes `input.branch` from `dir`; declare it `idempotency: "key"` (pushing the same commit again is harmless).
 * It tries Bearer first and Basic (`x-access-token`, as GitHub Actions does) if that push is refused or throws, since
 * GitHub's acceptance of Bearer on the git endpoint is unconfirmed until spike 5 runs.
 */
export function gitPushEffect(options: { workspace: () => Workspace; dir: string; remote?: string; token: () => Promise<string>; allow?: (branch: string) => boolean }): EffectAdapter<{ branch: string }, { branch: string; refs: unknown }> {
  const allow = options.allow ?? ((branch: string) => branch.startsWith("factory/"));
  return {
    async run({ branch }) {
      if (typeof branch !== "string" || !allow(branch)) throw new EffectRejected("may push only factory/ branches");
      const token = await options.token();
      const git = options.workspace().git;
      let failure = "push was refused";
      for (const authorization of [`Bearer ${token}`, `Basic ${btoa(`x-access-token:${token}`)}`]) {
        try {
          const result = await git.push({ dir: options.dir, remote: options.remote ?? "origin", ref: branch, remoteRef: `refs/heads/${branch}`, headers: { Authorization: authorization } });
          if (result.ok) return { branch, refs: JSON.parse(scrubber(token)(JSON.stringify(result.refs ?? {}))) };
          failure = result.error ?? failure;
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
        }
      }
      throw new Error(`git push failed: ${scrubber(token)(failure)}`);
    },
  };
}
