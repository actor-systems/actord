// Git from the Durable Object's side, with Computer's git client. The token is minted by the caller and handed to the
// git client as an Authorization header for one call; it never reaches the container, a row, an event or an error.
// Where the header goes is the app's choice, never the workspace's: the agent can write .git/config, and isomorphic-git
// takes a missing `url` from `remote.<name>.url` (or `pushurl`) and a missing `corsProxy` from `http.corsProxy`.
import type { Workspace } from "@cloudflare/computer";
import type { GitPushOptions } from "@cloudflare/computer/git";
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

/** The Authorization header for a token: Basic `x-access-token`, as GitHub Actions sends it. GitHub's git endpoint answers Bearer with 401 (spike 5). */
const basic = (token: string) => `Basic ${btoa(`x-access-token:${token}`)}`;

/** `url` if it is an https URL with no credentials in it; otherwise a throw, since a header sent there could leave in clear. */
function httpsUrl(url: string, what: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {}
  if (parsed?.protocol !== "https:" || parsed.username || parsed.password) throw new Error(`actord: ${what} must be an https URL with no credentials in it`);
  return url;
}

/**
 * Clone in full (a branch that will be pushed must not be shallow) on the Durable Object side; the token never reaches
 * the container. `corsProxy: ""` keeps a proxy in an existing .git/config from receiving the request.
 */
export async function gitClone(workspace: Workspace, options: { url: string; dir: string; ref?: string; token?: () => Promise<string> }): Promise<void> {
  const url = httpsUrl(options.url, "the clone URL");
  const token = options.token ? await options.token() : undefined;
  await scrubbed(token ?? "", () =>
    workspace.git.clone({ url, dir: options.dir, ref: options.ref, singleBranch: true, corsProxy: "", headers: token ? { Authorization: basic(token) } : undefined }),
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

/**
 * An effect adapter that pushes `input.branch` from `dir` to `url`, the repository's https URL, which the app supplies
 * and the workspace never does; declare it `idempotency: "key"` (pushing the same commit again is harmless).
 * It makes one push, authenticated with Basic `x-access-token:<token>`, as GitHub Actions does: GitHub's git endpoint
 * answers Bearer with 401 (spike 5). A failure (authentication, non-fast-forward, network) surfaces as itself, with the
 * token scrubbed from it.
 *
 * Computer 0.8.0's push drops `corsProxy`, so isomorphic-git falls back to the repo's `http.corsProxy`: a push from a
 * repo whose config names one is refused, before the token is minted and again just before the push. Minting waits on
 * the network, when the container's writes can land; between the last check and the push's own read of the config
 * there is only storage, so they can't. (pi's own file tools, which run here, refuse .git paths.) `corsProxy: ""` is
 * passed as well, for a client that forwards it.
 */
export function gitPushEffect(options: { workspace: () => Workspace; dir: string; url: string; token: () => Promise<string>; allow?: (branch: string) => boolean }): EffectAdapter<{ branch: string }, { branch: string; refs: unknown }> {
  const url = httpsUrl(options.url, "gitPushEffect's url");
  const allow = options.allow ?? factoryBranch;
  return {
    async run({ branch }, { signal }) {
      if (typeof branch !== "string" || !allow(branch)) throw new EffectRejected("may push only factory/ branches");
      const git = options.workspace().git;
      const unproxied = async () => {
        if (await git.configGet({ dir: options.dir, path: "http.corsProxy" })) throw new EffectRejected("the repo's .git/config sets http.corsProxy; refusing to push through it");
      };
      await unproxied();
      const token = await options.token();
      const scrub = scrubber(token);
      signal.throwIfAborted();
      await unproxied();
      let failure: unknown;
      try {
        const push: GitPushOptions & { corsProxy: string } = { dir: options.dir, url, ref: branch, remoteRef: `refs/heads/${branch}`, corsProxy: "", headers: { Authorization: basic(token) } };
        const result = await git.push(push);
        if (result.ok) return { branch, refs: JSON.parse(scrub(JSON.stringify(result.refs ?? {}))) };
        failure = result.error ?? "push was refused";
      } catch (e) {
        failure = e;
      }
      throw new Error(`git push failed: ${scrub(failure instanceof Error ? failure.message : String(failure))}`);
    },
  };
}
