// An agent's workspace: Computer's Workspace in the Durable Object's own SQLite (its vfs_ tables), so what the agent
// writes outlives the container and any restart. With a container backend, commands run in a Cloudflare Container
// that Computer syncs the files to; its local-only paths stay on the container's disk, and its outbound HTTP goes
// nowhere unless the workspace declares egress.
//
// Pi tools over it are Computer's (createPiTools), with this plan's replay classes: a tool pi may run again after a
// restart cut it off is one whose rerun changes nothing (reads, a write of the same bytes, a delete), and the rest
// (edit, exec, publish) pi reports to the model as interrupted. An exec that loses its container is reported the same
// way: the command may have partly run. Nothing is pulled from the container before a session resumes: across an
// eviction no edit was lost and no sync was left pending (spike 4), and the next exec's sync brings back what an
// interrupted command wrote.
//
// With registry-read egress, every exec through `workspace.runtime`, the tools' and the app's own, gets the gateway's
// CA (one through Computer's RPC stub, `workspace.stub()`, doesn't): computerd's commands never see the image's ENV,
// and Node refuses the gateway's certificate without NODE_EXTRA_CA_CERTS (spike 2). Each exec the tools run also gets
// the workspace's timeout (10 minutes unless it declares execTimeoutMs; spike 2's longest command was a 185 s install),
// and one whose result is lost once that has passed is reported as timed out, not as a lost container.
import {
  type DurableObjectStorageLike,
  type KillSignal,
  Workspace,
  type WorkspaceRegisteredBackend,
  type WorkspaceRuntimeExecHandle,
  type WorkspaceRuntimeExecOptions,
} from "@cloudflare/computer";
import { ContainerBackend, type ContainerHostHolder, type ContainerInstanceSize } from "@cloudflare/computer/backends/container";
import { createGitClient } from "@cloudflare/computer/git";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { ActorHost } from "../runtime/index.ts";
import type { WorkspaceSpec } from "../system.ts";

/** What egress hands the container's requests to (structurally a Fetcher's fetch). */
export interface Gateway {
  fetch(request: Request): Promise<Response>;
}

/** The container backend's id: what exec runs on. */
const CONTAINER = "container";

/**
 * By the Workspace workspaceFor returned (which may be a view of Computer's, below): its container backend, which the
 * Durable Object's fetch hands computerd's connection and egress to, and the timeout the tools give its execs.
 */
const backends = new WeakMap<Workspace, ContainerBackend>();
const execTimeouts = new WeakMap<Workspace, number>();
/** The tools' exec timeout for a workspace that declares none, or that workspaceFor didn't build. */
const DEFAULT_EXEC_TIMEOUT_MS = 600_000;
/** Where the platform puts the certificate the egress gateway's HTTPS interception presents. */
const EGRESS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/**
 * A Workspace in the host's SQLite for `spec`. With a container backend, `container` is the host built by Computer's
 * withWorkspaceContainer (the Durable Object, `this`), and `binding` its Durable Object binding, through which the
 * container's requests come back to it. Egress is `none` unless the spec declares `registry-read`, which sends the
 * container's HTTP and HTTPS through `gateway` (default: a RegistryReadGateway).
 */
export function workspaceFor(
  host: ActorHost,
  spec: WorkspaceSpec,
  options: {
    container?: unknown;
    gateway?: Gateway;
    binding?: string;
    /**
     * @internal Test seam: a command backend of the test's own (Computer's WorkspaceBackend, with id "container") in
     * place of the container's, which needs a real container to run anything. With it, the spec's localOnly and its
     * egress gateway don't apply, since no container is started; the exec env and timeout still do.
     */
    backend?: WorkspaceRegisteredBackend;
  } = {},
): Workspace {
  const registered: WorkspaceRegisteredBackend[] = [];
  let backend: ContainerBackend | undefined;
  if (spec.backend && options.backend) registered.push(options.backend);
  else if (spec.backend) {
    const { container, binding } = options;
    if (container === undefined) throw new Error("actord: a workspace with a container backend needs `container`, the Durable Object built with withWorkspaceContainer");
    if (binding === undefined) throw new Error("actord: a workspace with a container backend needs `binding`, the Durable Object binding its container's requests come back through");
    backend = new ContainerBackend({
      container: () => container as ContainerHostHolder,
      workspace: { binding, id: host.ctx.id.toString() },
      id: CONTAINER,
      ...(spec.backend.instance === undefined ? {} : { instance: spec.backend.instance as ContainerInstanceSize }),
      // MOUNT_IGNORE: never synced into the object. [] syncs everything, as no ignore does, and asks nothing of computerd.
      ...(spec.localOnly === undefined || spec.localOnly.length === 0 ? {} : { ignore: spec.localOnly }),
      egress: spec.egress === "registry-read" ? { mode: "http-gateway", gateway: (options.gateway ?? new RegistryReadGateway()) as never } : { mode: "none" },
    });
    registered.push(backend);
  }
  const built = new Workspace({ storage: host.ctx.storage as unknown as DurableObjectStorageLike, git: createGitClient(), backends: registered });
  const workspace = spec.egress === "registry-read" ? withExecEnv(built, { NODE_EXTRA_CA_CERTS: EGRESS_CA }) : built;
  if (backend) backends.set(workspace, backend);
  execTimeouts.set(workspace, spec.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
  return workspace;
}

/** A view of `workspace` with `runtime` in its place; everything else is read from it, its methods bound to it. */
function withRuntime(workspace: Workspace, runtime: () => unknown): Workspace {
  return new Proxy(workspace, {
    get(target, prop) {
      if (prop === "runtime") return runtime();
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** `workspace`, its runtime's exec giving every run `env` under the caller's own, key by key. */
function withExecEnv(workspace: Workspace, env: Record<string, string>): Workspace {
  return withRuntime(workspace, () => {
    const runtime = workspace.runtime;
    return new Proxy(runtime, {
      get(target, prop) {
        if (prop === "exec") return (source: string, options?: WorkspaceRuntimeExecOptions<"utf8">) => target.exec(source, { ...options, env: { ...env, ...options?.env } } as never);
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  });
}

/**
 * A request to the Durable Object, for its workspace's container: computerd's connection, and the container's egress.
 * The Durable Object's fetch hands every request here; anything else, or a workspace without a container, is a 404.
 */
export function workspaceFetch(workspace: Workspace, request: Request): Promise<Response> {
  const backend = backends.get(workspace);
  return backend ? backend.handleFetch(request) : Promise.resolve(new Response("not found", { status: 404 }));
}

/** Computer's Pi tools, and whether pi may run each again after a restart cut it off. A tool not listed is unsafe. */
const REPLAY: Record<string, "safe" | "unsafe"> = { read: "safe", ls: "safe", find: "safe", grep: "safe", write: "safe", delete: "safe", edit: "unsafe", exec: "unsafe", publish: "unsafe" };

/** Mark an exec whose container was lost, or whose result was lost once its timeout had passed, in the error Computer's exec tool turns into text. */
const LOST = "[container lost] ";
const TIMED_OUT = "[timed out] ";

/**
 * Workspace tools for Pi with this plan's replay classification: read, ls, find, grep, write, delete "safe"; edit,
 * exec, publish "unsafe". `select` lists "workspace.*" (every tool the workspace has) or "workspace.<name>"; other
 * entries are left to their own tools. Exec is there only with a backend, publish only with assets.
 */
export function workspaceTools(workspace: Workspace, select: readonly string[]): ToolRegistration[] {
  const names = select.filter((s) => s.startsWith("workspace.")).map((s) => s.slice("workspace.".length));
  for (const name of names) {
    if (name !== "*" && !Object.hasOwn(REPLAY, name)) throw new Error(`actord: workspace.${name} isn't one of Computer's workspace tools (${Object.keys(REPLAY).join(", ")})`);
  }
  if (names.length === 0) return [];
  const { tools, execute } = createPiTools({ workspace: toolWorkspace(workspace) });
  return tools
    .filter((tool) => names.includes("*") || names.includes(tool.name))
    .map(
      (tool): ToolRegistration => ({
        name: tool.name,
        description: tool.description,
        // Plain JSON Schema, which pi validates calls against (spike 3).
        parameters: tool.parameters as ToolRegistration["parameters"],
        replay: REPLAY[tool.name] ?? "unsafe",
        async execute(args, api, context) {
          const path = (args as { path?: unknown }).path;
          if (WRITERS.has(tool.name) && typeof path === "string" && (await inGitDir(workspace, path))) {
            return { isError: true, output: text(`${tool.name} refused: ${path} is in a .git directory, which these tools don't change. Run git through exec instead.`) };
          }
          const result = await execute({ id: api.callId, name: tool.name, arguments: args }, { abortSignal: context.abortSignal });
          const failed = tool.name === "exec" ? execFailure(result.details) : undefined;
          if (failed !== undefined) return { isError: true, output: text(failed) };
          return { output: result.content, isError: result.isError };
        },
      }),
    );
}

const text = (t: string): ToolExecutionResult["output"] => [{ type: "text", text: t }];

/**
 * The tools that change files. They run in the Durable Object, beside a push (gitPushEffect), so they refuse git's own
 * files: a .git/config written mid-push could name the proxy its token goes through.
 */
const WRITERS = new Set(["write", "edit", "delete"]);
/** The most links one path may pass through before it counts as a loop. */
const MAX_LINKS = 40;

/** Whether `path`, with ".", ".." and the symlinks that exist resolved (from "/"), names a .git directory or a path in one. */
async function inGitDir(workspace: Workspace, path: string): Promise<boolean> {
  const rest = path.split("/");
  const at: string[] = [];
  for (let links = 0; rest.length > 0; ) {
    const part = rest.shift()!;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      at.pop();
      continue;
    }
    if (part.toLowerCase() === ".git") return true;
    at.push(part);
    const here = `/${at.join("/")}`;
    if (!(await workspace.fs.lstat(here).catch(() => null))?.isSymbolicLink) continue;
    if (++links > MAX_LINKS) return true; // a loop: refused rather than followed
    const target = await workspace.fs.readlink(here);
    at.pop();
    if (target.startsWith("/")) at.length = 0;
    rest.unshift(...target.split("/"));
  }
  return false;
}
/** What the model is told of an exec that lost its container or timed out, from the result Computer's exec tool gives; undefined for any other result. */
function execFailure(details: unknown): string | undefined {
  const error = (details as { error?: unknown } | null | undefined)?.error;
  if (typeof error !== "string") return undefined;
  if (error.startsWith(LOST)) {
    return `exec was interrupted: the container was lost before the command finished (${error.slice(LOST.length)}). It may have partly run. Files written or edited before it are kept in the workspace; check what the command changes before you run it again.`;
  }
  if (error.startsWith(TIMED_OUT)) {
    return `exec timed out: the command ran longer than ${Number(error.slice(TIMED_OUT.length)) / 1000} s (the workspace's execTimeoutMs) and was stopped. It may have partly run. Files written or edited before it are kept in the workspace.`;
  }
  return undefined;
}

/** Computer's names for a failure to reach the container (its WorkspaceTransportError), anywhere in the cause chain. */
function isTransportFailure(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e.name === "WorkspaceTransportError" || e.name === "WorkspacePreDispatchTransportError" || /container exited|rpc session was shut down/i.test(e.message)) return true;
  }
  return false;
}

/**
 * The workspace as the tools see it (exported for tests). Its exec gives each run the workspace's timeout unless the
 * caller passes one, and marks a run that failed: a start that fails to reach the container, or a result that never
 * arrives, is a lost container, unless the timeout had passed by then, counted from the call. How computerd ends a run
 * that times out hasn't been seen, so that is told by the clock, not by the error. The handle it returns has no event
 * stream, so Computer's exec tool waits for the result (it shows output only at the end). Runs are utf8, as that tool
 * always asks.
 */
export function toolWorkspace(workspace: Workspace): Workspace {
  const marked = (mark: string, detail: unknown) => new Error(`${mark}${detail instanceof Error ? detail.message : String(detail)}`);
  const timeoutMs = execTimeouts.get(workspace) ?? DEFAULT_EXEC_TIMEOUT_MS;
  const runtime: Pick<Workspace["runtime"], "backends" | "exec"> = {
    backends: () => workspace.runtime.backends(),
    exec: (async (source: string, options?: WorkspaceRuntimeExecOptions<"utf8">) => {
      const limit = options?.timeoutMs ?? timeoutMs;
      // Before the call, not once computerd accepts the run: its own clock is running by the time the answer arrives,
      // so a doubtful case reads as timed out, which is the side R30 accepts.
      const started = Date.now();
      let handle: WorkspaceRuntimeExecHandle<"utf8">;
      try {
        handle = await workspace.runtime.exec(source, { ...options, encoding: "utf8", timeoutMs: limit });
      } catch (err) {
        throw isTransportFailure(err) ? marked(LOST, err) : err;
      }
      return {
        id: handle.id,
        backend: handle.backend,
        kill: (signal?: KillSignal) => handle.kill(signal),
        result: () => handle.result().catch((err: unknown) => Promise.reject(Date.now() - started >= limit ? marked(TIMED_OUT, limit) : marked(LOST, err))),
      };
    }) as Workspace["runtime"]["exec"],
  };
  return withRuntime(workspace, () => runtime);
}

/** The registries a registry-read workspace may read from. */
const REGISTRIES = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
/** The request headers a registry read needs, and the only ones forwarded: no Host, no credentials (npm-otp included). */
const FORWARDED = new Set(["accept", "accept-encoding", "if-modified-since", "if-none-match", "range", "user-agent"]);

/**
 * The registry-read egress gateway: GET and HEAD to https://registry.npmjs.org and https://registry.yarnpkg.com pass;
 * any other method or host gets 403. The request upstream is built from the URL, with only the headers a read needs
 * (never Host or credentials). A redirect isn't followed: it goes back to the container, whose next request is checked
 * again. `fetch` is where passing requests go (default: the global fetch).
 */
export class RegistryReadGateway {
  readonly #upstream: (request: Request) => Promise<Response>;

  constructor(options: { fetch?: (request: Request) => Promise<Response> } = {}) {
    this.#upstream = options.fetch ?? ((request) => fetch(request));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const read = request.method === "GET" || request.method === "HEAD";
    if (!read || url.protocol !== "https:" || !REGISTRIES.has(url.host) || url.username !== "" || url.password !== "") {
      return new Response(`actord's registry-read egress allows only GET and HEAD to https://${[...REGISTRIES].join(" and https://")}.\n`, { status: 403 });
    }
    const headers = new Headers();
    for (const [name, value] of request.headers) if (FORWARDED.has(name)) headers.set(name, value);
    return this.#upstream(new Request(url, { method: request.method, headers, redirect: "manual" }));
  }
}
