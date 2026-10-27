// An agent's workspace: Computer's Workspace in the Durable Object's own SQLite (its vfs_ tables), so what the agent
// writes outlives the container and any restart. With a container backend, commands run in a Cloudflare Container
// that Computer syncs the files to; its local-only paths stay on the container's disk, and its outbound HTTP goes
// nowhere unless the workspace declares egress.
//
// Pi tools over it are Computer's (createPiTools), with this plan's replay classes: a tool pi may run again after a
// restart cut it off is one whose rerun changes nothing (reads, a write of the same bytes, a delete), and the rest
// (edit, exec, publish) pi reports to the model as interrupted. An exec that loses its container is reported the same
// way: the command may have partly run.
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

/** Each Workspace's container backend, which the Durable Object's fetch hands computerd's connection and egress to. */
const backends = new WeakMap<Workspace, ContainerBackend>();

/**
 * A Workspace in the host's SQLite for `spec`. With a container backend, `container` is the host built by Computer's
 * withWorkspaceContainer (the Durable Object, `this`), and `binding` its Durable Object binding, through which the
 * container's requests come back to it. Egress is `none` unless the spec declares `registry-read`, which sends the
 * container's HTTP and HTTPS through `gateway` (default: a RegistryReadGateway).
 */
export function workspaceFor(host: ActorHost, spec: WorkspaceSpec, options: { container?: unknown; gateway?: Gateway; binding?: string } = {}): Workspace {
  const registered: WorkspaceRegisteredBackend[] = [];
  let backend: ContainerBackend | undefined;
  if (spec.backend) {
    const { container, binding } = options;
    if (container === undefined) throw new Error("actord: a workspace with a container backend needs `container`, the Durable Object built with withWorkspaceContainer");
    if (binding === undefined) throw new Error("actord: a workspace with a container backend needs `binding`, the Durable Object binding its container's requests come back through");
    backend = new ContainerBackend({
      container: () => container as ContainerHostHolder,
      workspace: { binding, id: host.ctx.id.toString() },
      id: CONTAINER,
      ...(spec.backend.instance === undefined ? {} : { instance: spec.backend.instance as ContainerInstanceSize }),
      // MOUNT_IGNORE: never synced into the object.
      ...(spec.localOnly === undefined ? {} : { ignore: spec.localOnly }),
      egress: spec.egress === "registry-read" ? { mode: "http-gateway", gateway: (options.gateway ?? new RegistryReadGateway()) as never } : { mode: "none" },
    });
    registered.push(backend);
  }
  const workspace = new Workspace({ storage: host.ctx.storage as unknown as DurableObjectStorageLike, git: createGitClient(), backends: registered });
  if (backend) backends.set(workspace, backend);
  return workspace;
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

/** Marks an exec whose container was lost, in the error Computer's exec tool turns into text. */
const LOST = "[container lost] ";

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
  const { tools, execute } = createPiTools({ workspace: withLostContainers(workspace) });
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
          const result = await execute({ id: api.callId, name: tool.name, arguments: args }, { abortSignal: context.abortSignal });
          const lost = tool.name === "exec" ? lostReason(result.details) : undefined;
          if (lost !== undefined) return { isError: true, output: text(interrupted(lost)) };
          return { output: result.content, isError: result.isError };
        },
      }),
    );
}

const text = (t: string): ToolExecutionResult["output"] => [{ type: "text", text: t }];
const interrupted = (reason: string) =>
  `exec was interrupted: the container was lost before the command finished (${reason}). It may have partly run. Files written or edited before it are kept in the workspace; check what the command changes before you run it again.`;

/** The reason an exec lost its container, from the result Computer's exec tool gives; undefined for any other result. */
function lostReason(details: unknown): string | undefined {
  const error = (details as { error?: unknown } | null | undefined)?.error;
  return typeof error === "string" && error.startsWith(LOST) ? error.slice(LOST.length) : undefined;
}

/** Computer's names for a failure to reach the container (its WorkspaceTransportError), anywhere in the cause chain. */
function isTransportFailure(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e.name === "WorkspaceTransportError" || e.name === "WorkspacePreDispatchTransportError" || /container exited|rpc session was shut down/i.test(e.message)) return true;
  }
  return false;
}

/**
 * The workspace as the tools see it, its exec marking a lost container: a start that fails to reach the container, or
 * a run whose result never arrives. The handle it returns has no event stream, so Computer's exec tool waits for the
 * result (it shows output only at the end). Runs are utf8, as that tool always asks.
 */
function withLostContainers(workspace: Workspace): Workspace {
  const lost = (err: unknown) => new Error(`${LOST}${err instanceof Error ? err.message : String(err)}`);
  const runtime: Pick<Workspace["runtime"], "backends" | "exec"> = {
    backends: () => workspace.runtime.backends(),
    exec: (async (source: string, options?: WorkspaceRuntimeExecOptions<"utf8">) => {
      let handle: WorkspaceRuntimeExecHandle<"utf8">;
      try {
        handle = await workspace.runtime.exec(source, { ...options, encoding: "utf8" });
      } catch (err) {
        throw isTransportFailure(err) ? lost(err) : err;
      }
      return {
        id: handle.id,
        backend: handle.backend,
        kill: (signal?: KillSignal) => handle.kill(signal),
        result: () => handle.result().catch((err: unknown) => Promise.reject(lost(err))),
      };
    }) as Workspace["runtime"]["exec"],
  };
  return new Proxy(workspace, {
    get(target, prop) {
      if (prop === "runtime") return runtime;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The registries a registry-read workspace may read from. */
const REGISTRIES = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

/**
 * The registry-read egress gateway: GET and HEAD to https://registry.npmjs.org and https://registry.yarnpkg.com pass,
 * without the request's credentials; any other method or host gets 403. Redirects come back to the container, whose
 * next request is checked again. `fetch` is where passing requests go (default: the global fetch).
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
    const headers = new Headers(request.headers);
    for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);
    return this.#upstream(new Request(url, { method: request.method, headers, redirect: "manual" }));
  }
}
