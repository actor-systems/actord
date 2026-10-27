// Spikes 2, 4 and 5 (plan 3): Pi on Workers AI working in a Computer workspace on a real container.
//
// One Durable Object, Bench (instance "main", so one container at most), holds:
// - a Computer Workspace in its SQLite, whose one backend is a Cloudflare Container running computerd, started by the
//   object itself. node_modules and /dist are local-only: they stay on the container's disk and are never synced;
// - a PiHarness on DeepSeek V4.1 Flash with Computer's Pi tools over that workspace.
//
// Every command is a job, one at a time, recorded in spike_jobs with its wall time, the vfs_* table sizes before and
// after (what was synced into the object), whether a node_modules directory reached vfs_dirents, and whether the
// object was reset while it ran (computer#179). Each container command is an exec, recorded in spike_execs with its
// exit code, sync status and output tails.
//
// The container's outbound HTTP and HTTPS goes through a gateway in this object. It refuses everything except GET and
// HEAD to registry.npmjs.org while an install runs, and records every request it sees in spike_egress.
//
// HTTP (every request needs Authorization: Bearer <SPIKE_TOKEN>, else 401). The POSTs stream NDJSON: a {"waiting":s}
// line every 15 seconds while the job runs, then the job's record. A dropped connection doesn't stop the job.
//   POST /clone[?fresh=1]          full clone of actor-systems/actord into /workspace/actord, on the object's side
//   POST /install[?ignore=off]     npm ci in the container; ignore=off syncs node_modules too (one way: run it last)
//   POST /test                     npm test -w @actord/toolkit
//   POST /prompt                   Pi adds one line to docs/progress.md with the workspace tools, then runs git diff
//   POST /push                     spike 5: mint an installation token here, push factory/spike-5, search for the token
//   POST /long                     spike 4: start a long task (TODO comments, a test run after each); returns at once
//   POST /evict[?during=exec]      ctx.abort(); with during=exec, once a command is running (waits up to 5 minutes)
//   POST /stop[?force=1]           destroy the container (the watchdog does this after 20 minutes without a job)
//   GET  /status                   the running job and exec, if any
//   GET  /report                   everything recorded, with pi's submissions and tasks, and minute-by-minute snapshots
//
// The long run ends when pi settles, or is stopped at 45 minutes, $5 of model spend or 200 model responses, whichever
// comes first. The watchdog checks every minute and records a snapshot of the workspace's git diff each time.
import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, Workspace, WorkspaceProxy, type WorkspaceRuntimeExecHandle, type WorkspaceRuntimeResult } from "@cloudflare/computer";
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { createGitClient } from "@cloudflare/computer/git";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, GenerationTask, Harness, hook, ToolTask, type ToolRegistration, type UsageState } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { appJwt, branchHead, installationToken, revoke } from "./github.ts";

// The container's egress reaches this object through WorkspaceProxy, built from ctx.exports, so the entry must export it.
export { WorkspaceProxy };

/** Secrets the owner puts with `wrangler secret put`; wrangler.jsonc doesn't declare them. */
type SpikeEnv = Env & { SPIKE_TOKEN?: string; GITHUB_APP_ID?: string; GITHUB_APP_INSTALLATION_ID?: string; GITHUB_APP_PRIVATE_KEY?: string };

const REPOSITORY = "actor-systems/actord";
const REPO = "/workspace/actord";
const BACKEND_ID = "container";
const MODEL_ID = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
/** Workers AI's price for the model in dollars per million tokens (developers.cloudflare.com/workers-ai/platform/pricing, 2026-10-27). */
const PRICE = { input: 0.3, cacheRead: 0.006, output: 1.2 };
/** Never synced into the object. Patterns are relative to the mount, /workspace. */
const LOCAL_ONLY = ["**/node_modules", "/dist"];
const REGISTRY = "registry.npmjs.org";
/** Written by the platform once the backend registers its HTTPS intercept; the image points NODE_EXTRA_CA_CERTS at it. */
const EGRESS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const BRANCH = "factory/spike-5";
const IDENTITY = { name: "actord spike 5", email: "spike-5@actord.dev" };

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 15 * 60_000;
const MODEL_EXEC_TIMEOUT_MS = 10 * 60_000;
const PROMPT_TURNS = 15;
/** No prompt starts once pi's model spend in this object reaches this, in dollars. */
const SPEND_CAP_USD = 8;
const PROMPT_WAIT_MS = 10 * 60_000;
/** The watchdog destroys an idle container after this long without a job. */
const IDLE_STOP_MS = 20 * 60_000;
/** How long the container outlives an inactive object, as across a deploy. The platform's default is "shortly". */
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const TICK_MS = 60_000;
const OUTPUT_TAIL = 4000;

/** Spike 4's limits: the long run is stopped at the first one it reaches. */
const LONG_MS = 45 * 60_000;
const LONG_USD_CAP = 5;
const LONG_TURNS = 200;
/** After a stop, how long pi gets to settle before the job is closed anyway. */
const LONG_SETTLE_MS = 5 * 60_000;
/** The repository has no TODO comments, so the long run plants its own: one at the top of each of these files. */
const TODO_MARK = "TODO(spike-4)";
const TODO_FILES = 30;
const TODO_DIR = `${REPO}/packages/toolkit/src`;
const EVICT_WAIT_MS = 5 * 60_000;

const LONG_PROMPT = `Work through the open ${TODO_MARK} comments in the repository at ${REPO}, one file at a time. Find them with grep for "${TODO_MARK}" under ${TODO_DIR}. For each file: do what its TODO says and remove the TODO line, then run \`npm test -w @actord/toolkit\` with exec, with cwd ${REPO}, and check that it passes before you move on to the next file. If a command is interrupted, or fails for a reason that isn't your change, run it again. Keep going until none are left, then reply with the list of files you changed.`;

const PREAMBLE = `You work in a Linux container through tools. The git repository ${REPOSITORY} is checked out at ${REPO}. Paths are absolute. Use read, ls, find, grep, write and edit for files, and exec for commands, with cwd ${REPO}. Node and npm are installed and the dependencies are already installed. The network is closed: do not install anything. Keep replies short.`;

/** Tools that can run again after an eviction cut them off, as Computer's Pi example classes them; edit and exec can't. */
const REPLAY_SAFE = new Set(["read", "ls", "find", "grep", "write", "delete"]);

type JobKind = "clone" | "install" | "test" | "prompt" | "push";
interface JobOptions {
  fresh?: boolean;
  ignore?: boolean;
}

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  output?: { maxBytes: number; maxLines: number };
  /** False keeps only the output's length: for output that may hold another process's secrets. */
  keepOutput?: boolean;
  source: "spike" | "model";
}

/** What #exec hands back: the runtime's handle, with its result recorded when it settles. */
interface RecordedExec {
  readonly id: string;
  result(): Promise<WorkspaceRuntimeResult<"utf8">>;
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;
}

interface ExecSummary {
  row: number;
  exitCode: number;
  status: string;
  ms: number;
  sync: unknown;
  pushed: number;
  pulled: number;
  stdout: string;
  stderr: string;
}

type Row = Record<string, SqlStorageValue>;

export class Bench extends withWorkspaceContainer(class extends DurableObject<SpikeEnv> {}) {
  /** This boot's row in spike_boots. Runs first: the tables below exist before anything reads them. */
  readonly boot = openSpike(this.ctx, this.env);
  readonly lifecycle = Lifecycle.install(this);
  readonly ai = createAI({ binding: this.env.AI });
  /**
   * Rebuilt when /install?ignore=off changes the local-only paths, which relaunches the container. Declared before
   * `workspace`, whose initializer sets it: declared after, it would be reset to undefined.
   */
  #backend!: ContainerBackend;
  workspace: Workspace = this.#buildWorkspace(this.#setting("ignore") !== "off");
  /** The install job the gateway lets through to the registry, if one is running. Not kept: a reset ends the install. */
  #registryJob: number | null = null;
  // One per object, never at module scope: pi keeps each Harness subscribed to its registry until it closes.
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          // Workers AI allows this model 20 requests a minute: retries back off for about two minutes in all.
          settings: { retry: { enabled: true, maxRetries: 6, baseDelayMs: 2000 } },
          onReport: (report) => this.#event("pi.report", report),
        },
        context,
      );
    },
    // The catalog maps only "high" and "max" for this model, so pi raises any lower level to "high".
    defaults: { model: this.ai(MODEL_ID), thinkingLevel: "high" },
  });

  constructor(ctx: DurableObjectState, env: SpikeEnv) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
    this.registry.install({
      name: "spike",
      sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
      tools: this.#tools(),
      hooks: [
        hook(GenerationTask, { afterResponse: () => this.#countTurn() }),
        // A hook can't stop a run, but it can refuse every further tool call, which ends it at the next answer.
        hook(ToolTask, { beforeTool: () => (this.#overTurns() ? { block: "The turn limit for this task is reached. Call no more tools: reply now with what you have." } : undefined) }),
      ],
    });
    // A restarted object starts without the container's inactivity timeout, so set it again while the container runs.
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
  }

  /** computerd's /api WebSocket, and the egress gateway's requests, arrive here. With fetch defined, Lifecycle leaves it alone. */
  override async fetch(request: Request): Promise<Response> {
    return this.#backend.handleFetch(request);
  }

  /** Runs one job to its end, unless another is running. The work continues if the caller goes away. */
  async run(kind: JobKind, options: JobOptions = {}): Promise<Record<string, unknown>> {
    await this.lifecycle.start();
    const busy = this.#runningJob();
    if (busy) return { refused: `job ${busy.id} (${busy.kind}) is still running; read GET /status` };
    const id = this.#sql<{ id: number }>("INSERT INTO spike_jobs (kind, boot, status, started_at, options, before) VALUES (?, ?, 'running', ?, ?, ?) RETURNING id", kind, this.boot, Date.now(), JSON.stringify(options), JSON.stringify(this.#vfs()))[0]!.id;
    await this.#armWatchdog();
    const work = this.#job(id, kind, options);
    this.ctx.waitUntil(work);
    return work;
  }

  async status() {
    await this.lifecycle.start();
    const job = this.#runningJob();
    const exec = this.#sql<Row>("SELECT id, job, source, command, started_at FROM spike_execs WHERE ended_at IS NULL AND boot = ? ORDER BY id DESC LIMIT 1", this.boot)[0];
    const since = (at: SqlStorageValue) => Math.round((Date.now() - Number(at)) / 1000);
    return {
      job: job ? { id: job.id, kind: job.kind, seconds: since(job.started_at), ...(job.kind === "long" ? { turns: this.#turns(job.id), minutesLeft: Math.max(0, Math.round((Number(job.started_at) + LONG_MS - Date.now()) / 60_000)) } : {}) } : null,
      exec: exec ? { id: exec.id, job: exec.job, source: exec.source, command: exec.command, seconds: since(exec.started_at) } : null,
      container: { running: this.ctx.container?.running ?? null },
      boot: this.boot,
    };
  }

  /**
   * Spike 4: plants the TODO comments, submits the long task to pi and returns. pi carries the run across restarts;
   * the watchdog snapshots it every minute, stops it at its limits, and closes the job once pi settles.
   */
  async startLong(): Promise<Record<string, unknown>> {
    await this.lifecycle.start();
    const busy = this.#runningJob();
    if (busy) return { refused: `job ${busy.id} (${busy.kind}) is still running; read GET /status` };
    if (!(await this.#cloned())) return { refused: "no clone yet: POST /clone first" };
    const usage = usageTotals(await this.#usage());
    if (usage.priceUsd >= SPEND_CAP_USD) return { refused: `model spend has reached the spike's $${SPEND_CAP_USD} cap` };
    const started = Date.now();
    const id = this.#sql<{ id: number }>("INSERT INTO spike_jobs (kind, boot, status, started_at, options, before) VALUES ('long', ?, 'running', ?, '{}', ?) RETURNING id", this.boot, started, JSON.stringify(this.#vfs()))[0]!.id;
    try {
      const container = await this.#connect();
      // node_modules is local-only, so a container the watchdog stopped has lost it.
      const deps = await this.#run(id, "test -d node_modules/vitest && echo present || echo missing", { cwd: REPO, timeoutMs: 60_000, source: "spike" });
      if (!deps.stdout.includes("present")) throw new Error("the container has no node_modules (it was stopped since the install): POST /install, then POST /long again");
      const seeded = await this.#seedTodos();
      await this.#snapshot(id, "start");
      this.#limitTurns(id, LONG_TURNS);
      const operationId = `long-${id}`;
      const receipt = await this.harness.submit(LONG_PROMPT, { operationId });
      const options: LongOptions = { operationId, accepted: receipt.accepted, deadline: started + LONG_MS, usdAtStart: usage.priceUsd, seeded, container };
      this.#sql("UPDATE spike_jobs SET options = ? WHERE id = ?", JSON.stringify(options), id);
      await this.#armWatchdog();
    } catch (err) {
      this.#sql("UPDATE spike_jobs SET status = 'failed', ended_at = ?, after = ?, error = ? WHERE id = ?", Date.now(), JSON.stringify(this.#vfs()), JSON.stringify(errorOf(err)), id);
    }
    return this.#jobRecord(id);
  }

  /** Spike 4: resets the object, as an eviction would. With duringExec, waits for a command to be running first. */
  async evict(duringExec: boolean): Promise<Record<string, unknown>> {
    await this.lifecycle.start();
    const running = () => this.#sql<Row>("SELECT id, job, source, command, started_at FROM spike_execs WHERE ended_at IS NULL AND boot = ? ORDER BY id DESC LIMIT 1", this.boot)[0];
    const until = Date.now() + EVICT_WAIT_MS;
    while (duringExec && !running()) {
      if (Date.now() >= until) return { refused: "no command started within 5 minutes; nothing was evicted" };
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const exec = running() ?? null;
    const long = this.#runningJob();
    await this.#snapshot(long?.id ?? null, "before evict");
    this.#event("evict", { boot: this.boot, exec, job: long?.id ?? null });
    // abort() drops writes not yet durable, so wait for the evidence above first.
    await this.ctx.storage.sync();
    this.ctx.abort("spike 4: evict");
    return { evicted: true, exec };
  }

  /** Destroys the container. Refused while a job runs, unless forced. */
  async stop(force: boolean) {
    await this.lifecycle.start();
    const job = this.#runningJob();
    if (job && !force) return { refused: `job ${job.id} (${job.kind}) is still running; add ?force=1 to stop the container anyway` };
    return { stopped: await this.#stopContainer(force ? "stop, forced" : "stop") };
  }

  async report() {
    await this.lifecycle.start();
    const json = (v: SqlStorageValue) => (typeof v === "string" ? (JSON.parse(v) as unknown) : null);
    const iso = (at: SqlStorageValue) => (at === null ? null : new Date(Number(at)).toISOString());
    const egress = this.#sql<Row>("SELECT host, method, allowed, status, COUNT(*) AS n FROM spike_egress GROUP BY host, method, allowed, status ORDER BY host, n DESC");
    return {
      settings: { model: MODEL_ID, localOnly: this.#setting("ignore") === "off" ? [] : LOCAL_ONLY, registry: REGISTRY },
      boots: this.#sql<Row>("SELECT * FROM spike_boots ORDER BY id").map((b) => ({ id: b.id, at: iso(b.at), version: b.version, containerRunning: b.container_running === 1, firstModelResponseAt: iso(b.first_turn_at) })),
      jobs: this.#sql<{ id: number }>("SELECT id FROM spike_jobs ORDER BY id").map((j) => this.#jobRecord(j.id)),
      egress: {
        seen: egress.map((e) => ({ host: e.host, method: e.method, allowed: e.allowed === 1, status: e.status, requests: e.n })),
        refused: this.#sql<Row>("SELECT at, job, method, host, path, error FROM spike_egress WHERE allowed = 0 ORDER BY id LIMIT 50").map((e) => ({ ...e, at: iso(e.at) })),
      },
      events: this.#sql<Row>("SELECT * FROM spike_events ORDER BY id").map((e) => ({ at: iso(e.at), kind: e.kind, detail: json(e.detail) })),
      vfs: this.#vfs(),
      syncOperations: this.#rows("SELECT backend, direction, status, mode, created_at, updated_at, last_error FROM _vfs_sync_operations"),
      container: { running: this.ctx.container?.running ?? null },
      // Computer's record of which runtime each exec belongs to, kept so a restart can settle or resume it.
      executionRuntimes: this.#rows("SELECT * FROM computer_execution_runtime"),
      snapshots: this.#sql<Row>("SELECT * FROM spike_snapshots ORDER BY id").map((n) => ({ id: n.id, at: iso(n.at), job: n.job, boot: n.boot, reason: n.reason, diffSha256: n.diff_sha256, diffBytes: n.diff_bytes, changed: json(n.changed), todosLeft: n.todos_left, pending: json(n.pending), exec: json(n.exec), sync: json(n.sync), error: n.error })),
      pi: await this.#piReport(),
    };
  }

  /**
   * The watchdog. It looks after a long run (see #tickLong), and destroys a container left idle, so an open computerd
   * socket can't keep it billing.
   */
  async onJob({ job }: LifecycleJobContext): Promise<{ rescheduleAt: number } | undefined> {
    if (job.fn !== "watchdog") return undefined;
    const long = this.#runningJob();
    if (long?.kind === "long") await this.#tickLong(long.id, Number(long.started_at));
    const running = this.#runningJob();
    const container = this.ctx.container;
    if (!running && container?.running) {
      const last = this.#sql<{ at: number | null }>("SELECT MAX(COALESCE(ended_at, started_at)) AS at FROM spike_jobs")[0]?.at ?? 0;
      if (Date.now() - Number(last) >= IDLE_STOP_MS) {
        await this.#stopContainer("idle");
        return undefined;
      }
    }
    return running || container?.running ? { rescheduleAt: Date.now() + TICK_MS } : undefined;
  }

  async #job(id: number, kind: JobKind, options: JobOptions): Promise<Record<string, unknown>> {
    let detail: unknown = null;
    let error: unknown = null;
    try {
      detail = await this.#perform(id, kind, options);
    } catch (err) {
      error = errorOf(err);
    }
    this.#sql("UPDATE spike_jobs SET status = ?, ended_at = ?, after = ?, detail = ?, error = ? WHERE id = ?", error === null ? "done" : "failed", Date.now(), JSON.stringify(this.#vfs()), JSON.stringify(detail), error === null ? null : JSON.stringify(error), id);
    return this.#jobRecord(id);
  }

  #perform(job: number, kind: JobKind, options: JobOptions): Promise<unknown> {
    switch (kind) {
      case "clone":
        return this.#clone(options.fresh === true);
      case "install":
        return this.#install(job, options.ignore !== false);
      case "test":
        return this.#test(job);
      case "prompt":
        return this.#prompt(job);
      case "push":
        return this.#push(job);
    }
  }

  async #clone(fresh: boolean) {
    // The lockfile, not .git, marks a clone: the git client's branch() on a bare directory creates a partial .git.
    if (!fresh && (await this.#cloned())) return { skipped: `${REPO} is already a clone; POST /clone?fresh=1 deletes it and clones again` };
    await this.workspace.fs.rm(REPO, { recursive: true, force: true });
    await this.workspace.fs.mkdir("/workspace", { recursive: true });
    const phases: Record<string, { loaded: number; total?: number }> = {};
    const started = Date.now();
    // Full history: no depth, so the clone can be pushed from (spike 5).
    await this.workspace.git.clone({ url: `https://github.com/${REPOSITORY}`, dir: REPO, onProgress: (e) => void (phases[e.phase] = { loaded: e.loaded, total: e.total }) });
    const cloneMs = Date.now() - started;
    const [head] = await this.workspace.git.log({ dir: REPO, depth: 1 });
    const files = await this.workspace.fs.find(REPO, "**/*", { exclude: [".git/**"] });
    return { cloneMs, head: head ? { oid: head.oid, message: head.message.split("\n")[0] } : null, workingTreeEntries: files.length, phases };
  }

  async #install(job: number, ignore: boolean) {
    if (!(await this.#cloned())) throw new Error("no clone yet: POST /clone first");
    const switched = this.#useLocalOnly(ignore);
    const container = await this.#connect();
    const probe = await this.#run(job, "node --version; npm --version; uname -r; nproc; head -2 /proc/meminfo; df -h / | tail -1", { cwd: REPO, timeoutMs: 120_000, source: "spike" });
    this.#registryJob = job;
    let npmCi: ExecSummary;
    try {
      // The CA appears once the HTTPS intercept is registered; give it up to 10 seconds, as Cloudflare's sandbox does.
      npmCi = await this.#run(job, `timeout 10 sh -c 'until [ -s ${EGRESS_CA} ]; do sleep 0.2; done'; npm ci --no-audit --no-fund --loglevel=warn`, { cwd: REPO, timeoutMs: INSTALL_TIMEOUT_MS, source: "spike" });
    } finally {
      this.#registryJob = null;
    }
    const tree = await this.#run(job, "du -sk node_modules; find node_modules -type f | wc -l", { cwd: REPO, timeoutMs: 300_000, source: "spike" });
    const [kb, files] = tree.stdout.trim().split(/\s+/);
    return { localOnly: ignore ? LOCAL_ONLY : [], switched, container, probe: probe.stdout.trim().split("\n"), exitCode: npmCi.exitCode, installMs: npmCi.ms, sync: npmCi.sync, pushed: npmCi.pushed, pulled: npmCi.pulled, nodeModules: { kilobytes: Number(kb), files: Number(files) } };
  }

  async #test(job: number) {
    const container = await this.#connect();
    const r = await this.#run(job, "npm test -w @actord/toolkit", { cwd: REPO, timeoutMs: TEST_TIMEOUT_MS, source: "spike" });
    const plain = stripAnsi(`${r.stdout}\n${r.stderr}`);
    return { container, exitCode: r.exitCode, testMs: r.ms, testFiles: /Test Files\s+(.+)/.exec(plain)?.[1]?.trim() ?? null, tests: /\n\s*Tests\s+(.+)/.exec(plain)?.[1]?.trim() ?? null, sync: r.sync };
  }

  async #prompt(job: number) {
    const marker = `spike-2-job-${job}`;
    const line = `- ${new Date().toISOString().slice(0, 10)}: ${marker}, a line an agent added through Computer's workspace tools.`;
    const text = `In the git repository at ${REPO}, add exactly this line at the end of docs/progress.md, and change nothing else:\n\n${line}\n\nChange the file with the read and edit (or write) tools, not with exec. Then run \`git diff\` with exec, with cwd ${REPO}, and reply with its output and nothing else.`;
    const usageBefore = await this.#usage();
    if (usageTotals(usageBefore).priceUsd >= SPEND_CAP_USD) throw new Error(`model spend has reached the spike's $${SPEND_CAP_USD} cap`);
    await this.#connect();
    this.#limitTurns(job, PROMPT_TURNS);
    const operationId = `prompt-${job}`;
    const started = Date.now();
    const receipt = await this.harness.submit(text, { operationId });
    let result: Awaited<ReturnType<PiHarness["wait"]>> | { status: "timed_out" };
    try {
      result = await this.harness.wait(operationId, { signal: AbortSignal.timeout(PROMPT_WAIT_MS) });
    } catch {
      // abort({ operationId }) only withdraws a queued operation; with no id, it stops the running one too.
      await this.harness.abort();
      result = { status: "timed_out" };
    }
    const promptMs = Date.now() - started;
    const usage = usageDelta(usageBefore, await this.#usage());
    // The spike's own look at the change, on both sides of the sync.
    const containerDiff = await this.#run(job, "git diff -- docs/progress.md", { cwd: REPO, timeoutMs: 120_000, source: "spike" });
    const objectDiff = await this.workspace.git.diff({ dir: REPO, paths: ["docs/progress.md"] });
    const reply = "text" in result ? result.text : undefined;
    return {
      operationId,
      accepted: receipt.accepted,
      status: result.status,
      reason: "reason" in result ? result.reason : undefined,
      promptMs,
      turns: this.#turns(job),
      usage,
      line,
      reply: reply?.slice(0, OUTPUT_TAIL),
      replyHasLine: reply?.includes(marker) ?? false,
      inContainerDiff: containerDiff.stdout.includes(marker),
      inObjectDiff: objectDiff.includes(marker),
      objectDiff: objectDiff.slice(0, OUTPUT_TAIL),
    };
  }

  /**
   * Spike 5. Mints an installation token here, pushes factory/spike-5 with it as a header, then looks for it in the
   * container three ways, each with a positive control so a search that sees nothing can't pass as a clean one.
   */
  async #push(job: number) {
    const { GITHUB_APP_ID: appId, GITHUB_APP_INSTALLATION_ID: installationId, GITHUB_APP_PRIVATE_KEY: key } = this.env;
    if (!appId || !installationId || !key) throw new Error("set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY first");
    if (!(await this.#cloned())) throw new Error("no clone yet: POST /clone first");
    const { token, grant } = await installationToken(await appJwt(appId, key), installationId, REPOSITORY.split("/")[1]!);
    const scrub = (text: string | null | undefined) => (text ?? "").replaceAll(token, "[token]");
    try {
      const git = this.workspace.git;
      await git.branch({ dir: REPO, name: BRANCH, checkout: true, force: true });
      const changed = (await git.status({ dir: REPO })).some((e) => e.path === "docs/progress.md");
      if (!changed) await this.#append(`${REPO}/docs/progress.md`, `- ${new Date().toISOString().slice(0, 10)}: spike-5-job-${job}, pushed from the Durable Object.\n`);
      await git.add({ dir: REPO, paths: ["docs/progress.md"] });
      const { oid } = await git.commit({ dir: REPO, message: "Spike 5: a push from the Durable Object\n\nPlan 3, spike 5: an installation token minted in the Durable Object and passed to the git client as a header.", author: IDENTITY });
      // Bearer first, as the plan has it; if GitHub's git endpoint refuses that, Basic with x-access-token, as Actions does.
      const attempts: Array<{ scheme: string; ok: boolean; error: string | null; refs?: unknown }> = [];
      for (const [scheme, authorization] of [["bearer", `Bearer ${token}`], ["basic", `Basic ${btoa(`x-access-token:${token}`)}`]] as const) {
        try {
          const r = await git.push({ dir: REPO, remote: "origin", ref: BRANCH, remoteRef: `refs/heads/${BRANCH}`, force: true, headers: { Authorization: authorization } });
          attempts.push({ scheme, ok: r.ok, error: r.error === null ? null : scrub(r.error), refs: JSON.parse(scrub(JSON.stringify(r.refs))) });
          if (r.ok) break;
        } catch (err) {
          attempts.push({ scheme, ok: false, error: scrub(errorOf(err).message) });
        }
      }
      const remoteHead = await branchHead(token, REPOSITORY, BRANCH);
      const search = await this.#searchForToken(job, token);
      return { grant, commit: oid, attempts, landed: remoteHead === oid, remoteHead, search };
    } finally {
      this.#event("push.token-revoked", { status: await revoke(token).catch((err: unknown) => scrub(errorOf(err).message)) });
    }
  }

  /** env, a grep -r of the workspace for the token's first 8 characters, and every process's environment. */
  async #searchForToken(job: number, token: string) {
    const prefix = token.slice(0, 8);
    const canary = () => `cnry${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const control = { env: canary(), grep: canary(), proc: canary() };
    const canaryFile = "/workspace/.spike-5-canary";
    const has = (text: string) => ({ token: text.includes(token), prefix: text.includes(prefix) });
    await this.workspace.fs.writeFile(canaryFile, `${control.grep}\n`);
    try {
      const env = await this.#run(job, "env", { env: { SPIKE_CANARY: control.env }, timeoutMs: 60_000, keepOutput: false, source: "spike" });
      // The patterns go in on stdin, so neither is in grep's argv or environment for the search to find.
      const grep = await this.#run(job, "grep -rl -F -f - /workspace; echo \"grep exit $?\"", { stdin: `${prefix}\n${control.grep}\n`, timeoutMs: 600_000, source: "spike" });
      const proc = await this.#run(job, "for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < \"$f\" 2>/dev/null; echo '--- process'; done", { env: { SPIKE_CANARY: control.proc }, timeoutMs: 60_000, keepOutput: false, output: { maxBytes: 1024 * 1024, maxLines: 20_000 }, source: "spike" });
      const grepLines = grep.stdout.trim().split("\n").filter(Boolean);
      const grepHits = grepLines.filter((l) => !l.startsWith("grep exit") && l !== canaryFile);
      const objectHits = await this.workspace.fs.grep(prefix, "/workspace");
      const objectControl = await this.workspace.fs.grep(control.grep, "/workspace");
      return {
        env: { controlSeen: env.stdout.includes(control.env), found: has(env.stdout), names: [...new Set(env.stdout.split("\n").map((l) => l.split("=")[0]).filter(Boolean))].sort() },
        grep: { controlSeen: grepLines.includes(canaryFile), found: grepHits.length > 0, files: grepHits.slice(0, 50), exit: grepLines.find((l) => l.startsWith("grep exit")) ?? null },
        processEnvironments: { controlSeen: proc.stdout.includes(`SPIKE_CANARY=${control.proc}`), found: has(proc.stdout), processes: proc.stdout.split("--- process").length - 1 },
        objectVfs: { controlSeen: objectControl.length > 0, found: objectHits.length > 0 },
      };
    } finally {
      await this.workspace.fs.rm(canaryFile, { force: true });
    }
  }

  /** One watchdog tick of a long run: a snapshot, then a stop at a limit, or the end once pi has settled. */
  async #tickLong(job: number, startedAt: number): Promise<void> {
    const options = this.#longOptions(job);
    if (!options) return;
    await this.#snapshot(job, "tick");
    const pending = await this.harness.pending();
    if (!pending.some((p) => p.operationId === options.operationId)) return this.#finishLong(job, options);
    if (options.stop) {
      if (Date.now() - options.stop.at >= LONG_SETTLE_MS) await this.#finishLong(job, options);
      return;
    }
    const spent = usageTotals(await this.#usage()).priceUsd - options.usdAtStart;
    const responses = this.#turns(job)?.responses ?? 0;
    const reason = Date.now() - startedAt >= LONG_MS ? "45 minutes" : spent >= LONG_USD_CAP ? `$${LONG_USD_CAP} of model spend` : responses >= LONG_TURNS ? `${LONG_TURNS} model responses` : null;
    if (reason === null) return;
    options.stop = { at: Date.now(), reason };
    this.#sql("UPDATE spike_jobs SET options = ? WHERE id = ?", JSON.stringify(options), job);
    this.#event("long.stop", { job, reason, spentUsd: spent, responses });
    // Stop pi first, so it starts nothing new, then any command still running for it.
    await this.harness.abort();
    for (const e of this.#sql<{ exec_id: string | null }>("SELECT exec_id FROM spike_execs WHERE job = ? AND source = 'model' AND ended_at IS NULL AND boot = ?", job, this.boot)) {
      if (e.exec_id) await this.workspace.runtime.killExec(e.exec_id, { backend: BACKEND_ID }).catch(() => {});
    }
  }

  async #finishLong(job: number, options: LongOptions): Promise<void> {
    const result = await this.harness.wait(options.operationId, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    const usage = usageTotals(await this.#usage());
    const detail = {
      operationId: options.operationId,
      stoppedBy: options.stop?.reason ?? null,
      result: result ? { status: result.status, reason: result.reason, text: result.text?.slice(0, OUTPUT_TAIL) } : null,
      turns: this.#turns(job),
      spentUsd: usage.priceUsd - options.usdAtStart,
      seeded: options.seeded.length,
      todosLeft: await this.#todosLeft(),
    };
    this.#sql("UPDATE spike_jobs SET status = ?, ended_at = ?, after = ?, detail = ? WHERE id = ?", options.stop ? "stopped" : "done", Date.now(), JSON.stringify(this.#vfs()), JSON.stringify(detail), job);
    await this.#snapshot(job, "end");
  }

  #longOptions(job: number): LongOptions | null {
    const raw = this.#sql<{ options: string | null }>("SELECT options FROM spike_jobs WHERE id = ?", job)[0]?.options;
    const options = raw ? (JSON.parse(raw) as Partial<LongOptions>) : {};
    return typeof options.operationId === "string" ? (options as LongOptions) : null;
  }

  /** Puts a TODO comment at the top of up to TODO_FILES source files that don't have one yet. Returns them all. */
  async #seedTodos(): Promise<string[]> {
    const found = await this.workspace.fs.find(TODO_DIR, "**/*.ts");
    // A declaration file isn't compiled, and a shebang must stay the first line.
    const paths = found.map((f) => f.path).filter((p) => !p.endsWith(".d.ts") && !p.endsWith("/cli/bin.ts")).sort().slice(0, TODO_FILES);
    const seeded: string[] = [];
    for (const path of paths) {
      const text = await this.workspace.fs.readFile(path, "utf8");
      if (text.startsWith("#!")) continue;
      if (!text.includes(TODO_MARK)) await this.workspace.fs.writeFile(path, `// ${TODO_MARK}: replace this line with a one-sentence comment that says what this file is for.\n${text}`);
      seeded.push(path.slice(REPO.length + 1));
    }
    return seeded;
  }

  async #todosLeft(): Promise<number> {
    return (await this.workspace.fs.grep(TODO_MARK, TODO_DIR, { limit: 1000 })).length;
  }

  /** The workspace as git sees it from the object's side, pi's queue, and the running command, at one moment. */
  async #snapshot(job: number | null, reason: string): Promise<void> {
    const at = Date.now();
    const exec = this.#sql<Row>("SELECT id, source, command, started_at FROM spike_execs WHERE ended_at IS NULL AND boot = ? ORDER BY id DESC LIMIT 1", this.boot)[0] ?? null;
    const sync = this.#rows("SELECT backend, direction, status, updated_at, last_error FROM _vfs_sync_operations");
    try {
      const diff = await this.workspace.git.diff({ dir: REPO });
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(diff)));
      const changed = (await this.workspace.git.status({ dir: REPO })).map((e) => `${e.index}${e.worktree} ${e.path}`);
      const pending = await this.harness.pending();
      this.#sql("INSERT INTO spike_snapshots (at, job, boot, reason, diff_sha256, diff_bytes, changed, todos_left, pending, exec, sync) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", at, job, this.boot, reason, [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""), diff.length, JSON.stringify(changed), await this.#todosLeft(), JSON.stringify(pending), JSON.stringify(exec), JSON.stringify(sync));
    } catch (err) {
      this.#sql("INSERT INTO spike_snapshots (at, job, boot, reason, exec, sync, error) VALUES (?, ?, ?, ?, ?, ?, ?)", at, job, this.boot, reason, JSON.stringify(exec), JSON.stringify(sync), errorOf(err).message);
    }
  }

  /** Runs one command to its end and summarises it. */
  async #run(job: number, command: string, options: ExecOptions): Promise<ExecSummary> {
    const exec = await this.#exec(job, command, options);
    const started = Date.now();
    const r = await exec.result();
    return { row: Number(exec.id), exitCode: r.exitCode, status: r.status, ms: Date.now() - started, sync: r.sync, pushed: r.pushed, pulled: r.pulled, stdout: r.stdout, stderr: r.stderr };
  }

  /** Starts a command in the container and records it from start to result. `id` is the spike_execs row. */
  async #exec(job: number | null, command: string, options: ExecOptions): Promise<RecordedExec> {
    const row = this.#sql<{ id: number }>("INSERT INTO spike_execs (job, source, command, cwd, boot, started_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", job, options.source, command, options.cwd ?? null, this.boot, Date.now())[0]!.id;
    const fail = (err: unknown) => void this.#sql("UPDATE spike_execs SET ended_at = ?, error = ? WHERE id = ?", Date.now(), JSON.stringify(errorOf(err)), row);
    let handle: WorkspaceRuntimeExecHandle<"utf8">;
    try {
      handle = await this.workspace.runtime.exec(command, { backend: BACKEND_ID, encoding: "utf8", cwd: options.cwd, env: options.env, stdin: options.stdin, timeoutMs: options.timeoutMs, ...(options.output ? { output: options.output } : {}) });
    } catch (err) {
      fail(err);
      throw err;
    }
    this.#sql("UPDATE spike_execs SET exec_id = ? WHERE id = ?", handle.id, row);
    const keep = options.keepOutput !== false;
    return {
      id: String(row),
      result: async () => {
        try {
          const r = await handle.result();
          const tail = (s: string) => (keep ? s.slice(-OUTPUT_TAIL) : `[${s.length} characters, not kept]`);
          this.#sql("UPDATE spike_execs SET ended_at = ?, status = ?, exit_code = ?, sync = ?, pushed = ?, pulled = ?, stdout_tail = ?, stderr_tail = ? WHERE id = ?", Date.now(), r.status, r.exitCode, JSON.stringify(r.sync), r.pushed, r.pulled, tail(r.stdout), tail(r.stderr), row);
          return r;
        } catch (err) {
          fail(err);
          throw err;
        }
      },
      kill: (signal) => handle.kill(signal),
    };
  }

  /** Computer's Pi tools as pi-durable registrations, with exec recorded and given a timeout. */
  #tools(): ToolRegistration[] {
    // The tools read the workspace through this view, so they follow a rebuilt one and their exec goes through #exec.
    const runtime = {
      exec: (command: string, options: { cwd?: string; env?: Record<string, string>; output?: { maxBytes: number; maxLines: number } }) => this.#exec(this.#turnJob(), command, { cwd: options.cwd, env: options.env, output: options.output, timeoutMs: MODEL_EXEC_TIMEOUT_MS, source: "model" }),
      backends: () => this.workspace.runtime.backends(),
    };
    const view = new Proxy(this.workspace, {
      get: (_target, prop) => {
        if (prop === "runtime") return runtime;
        const value: unknown = Reflect.get(this.workspace, prop, this.workspace);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(this.workspace) : value;
      },
    });
    const { tools, execute } = createPiTools({ workspace: view, exec: { [BACKEND_ID]: { description: `A Linux container with node, npm and git. The repository is at ${REPO}; pass that as cwd.` } } });
    return tools.map((tool): ToolRegistration => ({
      name: tool.name,
      description: tool.description,
      // Plain JSON Schema: pi validates calls against it (spike 3).
      parameters: tool.parameters as ToolRegistration["parameters"],
      replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
      async execute(args, api, context) {
        const { content, isError } = await execute({ id: api.callId, name: tool.name, arguments: args }, { abortSignal: context.abortSignal });
        return { output: content, isError };
      },
    }));
  }

  #buildWorkspace(localOnly: boolean): Workspace {
    this.#backend = new ContainerBackend({
      container: () => this,
      workspace: { binding: "BENCH", id: this.ctx.id.toString() },
      id: BACKEND_ID,
      name: "app",
      instance: "standard-2",
      ...(localOnly ? { ignore: LOCAL_ONLY } : {}),
      // Not "none": an install needs registry reads. The gateway refuses everything else, and everything outside an install.
      egress: { mode: "http-gateway", gateway: { fetch: (input: RequestInfo | URL, init?: RequestInit) => this.#gate(new Request(input, init)) } as unknown as Fetcher },
    });
    return new Workspace({ storage: this.ctx.storage as unknown as DurableObjectStorageLike, git: createGitClient(), defaultGitIdentity: IDENTITY, backends: [this.#backend] });
  }

  /** Switches the local-only paths. The container is relaunched with the new MOUNT_IGNORE at the next command. */
  #useLocalOnly(on: boolean): boolean {
    if ((this.#setting("ignore") !== "off") === on) return false;
    this.#sql("INSERT OR REPLACE INTO spike_settings (k, v) VALUES ('ignore', ?)", on ? "on" : "off");
    this.workspace = this.#buildWorkspace(on);
    this.#event("local-only", { paths: on ? LOCAL_ONLY : [] });
    return true;
  }

  /** Starts or adopts the container and reports how long that took and what computerd says it ignores. */
  async #connect() {
    const started = Date.now();
    await this.workspace.ready(BACKEND_ID);
    const handle = await this.#backend.connect();
    await this.ctx.container?.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return { connectMs: Date.now() - started, runtimeId: handle.runtimeId, ignore: (handle as { ignore?: unknown }).ignore ?? null };
  }

  async #stopContainer(reason: string): Promise<boolean> {
    const container = this.ctx.container;
    if (!container?.running) return false;
    await container.destroy();
    this.#event("container.stopped", { reason });
    return true;
  }

  /** The container's outbound HTTP(S): GET and HEAD to the registry during an install, and nothing else. */
  async #gate(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const job = this.#registryJob;
    const allowed = job !== null && (request.method === "GET" || request.method === "HEAD") && url.protocol === "https:" && url.hostname === REGISTRY;
    const row = this.#sql<{ id: number }>("INSERT INTO spike_egress (at, job, method, host, path, allowed) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", Date.now(), job, request.method, url.host, url.pathname.slice(0, 300), allowed ? 1 : 0)[0]!.id;
    if (!allowed) return new Response(`The spike's gateway allows only GET and HEAD to https://${REGISTRY}/, and only during an install.\n`, { status: 403 });
    try {
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.delete("cookie");
      const response = await fetch(url, { method: request.method, headers, redirect: "manual" });
      this.#sql("UPDATE spike_egress SET status = ? WHERE id = ?", response.status, row);
      return response;
    } catch (err) {
      this.#sql("UPDATE spike_egress SET error = ? WHERE id = ?", errorOf(err).message, row);
      return new Response("The spike's gateway could not reach the registry.\n", { status: 502 });
    }
  }

  async #armWatchdog(): Promise<void> {
    await this.lifecycle.jobs.push({ id: "spike-watchdog", fn: "watchdog", time: Date.now() + TICK_MS });
  }

  // Turn limits: the job a prompt belongs to, and how many model responses it has had. Kept in SQLite, so a restart
  // mid-run keeps counting.
  #limitTurns(job: number, cap: number): void {
    this.#sql("INSERT OR REPLACE INTO spike_turns (job, n, cap) VALUES (?, 0, ?)", job, cap);
    this.#sql("INSERT OR REPLACE INTO spike_settings (k, v) VALUES ('turn_job', ?)", String(job));
  }
  #turnJob(): number | null {
    const v = this.#setting("turn_job");
    return v === null ? null : Number(v);
  }
  #countTurn(): void {
    this.#sql("UPDATE spike_turns SET n = n + 1 WHERE job = ?", this.#turnJob());
    // When pi first answered after this boot: with the boot's time, how long a restart left the run waiting.
    this.#sql("UPDATE spike_boots SET first_turn_at = ? WHERE id = ? AND first_turn_at IS NULL", Date.now(), this.boot);
  }
  #overTurns(): boolean {
    const t = this.#sql<{ n: number; cap: number }>("SELECT n, cap FROM spike_turns WHERE job = ?", this.#turnJob())[0];
    return t !== undefined && t.n >= t.cap;
  }
  #turns(job: number) {
    const t = this.#sql<{ n: number; cap: number }>("SELECT n, cap FROM spike_turns WHERE job = ?", job)[0];
    return t ? { responses: t.n, cap: t.cap } : null;
  }

  async #usage(): Promise<UsageState> {
    return (await this.harness.pi()).usage(BACKGROUND_CONTEXT);
  }

  async #piReport() {
    const usage = await this.#usage();
    const entries = await this.harness.messages();
    return {
      usage: usageTotals(usage),
      pending: await this.harness.pending(),
      // pi's record of how the wire treated each request, such as a reasoning level the model's format dropped.
      diagnostics: [...new Set(entries.flatMap((e) => findDiagnostics(e)).map((d) => JSON.stringify(d)))].map((d) => JSON.parse(d) as unknown),
      submissions: this.#rows("SELECT id, conversation_id, request_id, status, record FROM pi_submissions ORDER BY id").map((r) => ({ ...r, record: String(r.record).slice(0, 1500) })),
      tasks: this.#rows("SELECT id, conversation_id, kind, status, abort_requested, background, record FROM pi_tasks ORDER BY id").map((r) => ({ ...r, record: String(r.record).slice(0, 600) })),
      // What pi told the model about tool calls a restart cut off.
      interrupted: entries.map((e) => JSON.stringify(e)).filter((e) => e.includes("interrupted")).map((e) => e.slice(0, 1500)),
      transcript: entries.map((e) => JSON.stringify(e).slice(0, 800)),
    };
  }

  #jobRecord(id: number): Record<string, unknown> {
    const j = this.#sql<Row>("SELECT * FROM spike_jobs WHERE id = ?", id)[0]!;
    const parse = (v: SqlStorageValue) => (typeof v === "string" ? (JSON.parse(v) as unknown) : null);
    const before = parse(j.before) as VfsSizes | null;
    const after = parse(j.after) as VfsSizes | null;
    const execs = this.#sql<Row>("SELECT * FROM spike_execs WHERE job = ? ORDER BY id", id).map((e) => ({
      id: e.id,
      source: e.source,
      command: e.command,
      cwd: e.cwd,
      boot: e.boot,
      ms: e.ended_at === null ? null : Number(e.ended_at) - Number(e.started_at),
      status: e.status ?? (e.ended_at === null ? "no result" : null),
      exitCode: e.exit_code,
      sync: parse(e.sync),
      pushed: e.pushed,
      pulled: e.pulled,
      stdoutTail: e.stdout_tail,
      stderrTail: e.stderr_tail,
      error: parse(e.error),
    }));
    return {
      id: j.id,
      kind: j.kind,
      status: j.status,
      options: parse(j.options),
      boot: j.boot,
      startedAt: new Date(Number(j.started_at)).toISOString(),
      wallMs: j.ended_at === null ? null : Number(j.ended_at) - Number(j.started_at),
      // computer#179: a storage timeout resets the object. A job a reset cut off is closed by the next boot.
      resetBy: j.reset_by,
      vfsBefore: before,
      vfsAfter: after,
      vfsDelta: before && after ? vfsDelta(before, after) : null,
      nodeModulesInVfs: after ? (after.nodeModulesDirs ?? 0) > 0 : null,
      detail: parse(j.detail),
      error: parse(j.error),
      execs,
    };
  }

  #runningJob(): { id: number; kind: string; started_at: number } | undefined {
    return this.#sql<{ id: number; kind: string; started_at: number }>("SELECT id, kind, started_at FROM spike_jobs WHERE status = 'running' ORDER BY id DESC LIMIT 1")[0];
  }

  /** Rows, sizes and bytes of Computer's tables: what the workspace holds in this object. */
  #vfs(): VfsSizes {
    const n = (query: string): number | null => {
      try {
        return Number(this.ctx.storage.sql.exec<{ n: number }>(query).one().n);
      } catch {
        return null;
      }
    };
    return {
      databaseBytes: this.ctx.storage.sql.databaseSize,
      nodes: n("SELECT COUNT(*) AS n FROM vfs_nodes"),
      fileBytes: n("SELECT COALESCE(SUM(size), 0) AS n FROM vfs_nodes WHERE type = 'file'"),
      blobs: n("SELECT COUNT(*) AS n FROM vfs_blobs"),
      blobBytes: n("SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS n FROM vfs_blob_bytes"),
      chunks: n("SELECT COUNT(*) AS n FROM vfs_chunks"),
      manifests: n("SELECT COUNT(*) AS n FROM vfs_manifests"),
      manifestBytes: n("SELECT COALESCE(SUM(LENGTH(encoded)), 0) AS n FROM vfs_manifests"),
      changes: n("SELECT COUNT(*) AS n FROM vfs_changes"),
      nodeModulesDirs: n("SELECT COUNT(*) AS n FROM vfs_dirents WHERE name = 'node_modules'"),
    };
  }

  #cloned(): Promise<boolean> {
    return this.#exists(`${REPO}/package-lock.json`);
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await this.workspace.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async #append(path: string, text: string): Promise<void> {
    const current = await this.workspace.fs.readFile(path, "utf8");
    await this.workspace.fs.writeFile(path, `${current}${current.endsWith("\n") ? "" : "\n"}${text}`);
  }

  #setting(k: string): string | null {
    return this.#sql<{ v: string }>("SELECT v FROM spike_settings WHERE k = ?", k)[0]?.v ?? null;
  }

  #event(kind: string, detail: unknown): void {
    this.#sql("INSERT INTO spike_events (at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail ?? null));
  }

  #sql<T extends Row>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /** Rows of a table this spike doesn't own, or an empty list before it exists. */
  #rows(query: string): Row[] {
    try {
      return this.#sql<Row>(query);
    } catch {
      return [];
    }
  }
}

/** What a long run keeps in its job's options: set at the start, and `stop` once a limit is reached. */
interface LongOptions {
  operationId: string;
  accepted: boolean;
  deadline: number;
  usdAtStart: number;
  seeded: string[];
  container: unknown;
  stop?: { at: number; reason: string };
}

interface VfsSizes {
  databaseBytes: number;
  nodes: number | null;
  fileBytes: number | null;
  blobs: number | null;
  blobBytes: number | null;
  chunks: number | null;
  manifests: number | null;
  manifestBytes: number | null;
  changes: number | null;
  nodeModulesDirs: number | null;
}

/** Creates the spike's tables, records this boot, and closes any job a reset cut off. Returns the boot's id. */
function openSpike(ctx: DurableObjectState, env: SpikeEnv): number {
  const sql = ctx.storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS spike_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS spike_boots (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, version TEXT, container_running INTEGER, first_turn_at INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS spike_jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, boot INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, options TEXT, before TEXT, after TEXT, detail TEXT, error TEXT, reset_by INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS spike_execs (id INTEGER PRIMARY KEY, job INTEGER, source TEXT NOT NULL, exec_id TEXT, command TEXT NOT NULL, cwd TEXT, boot INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT, exit_code INTEGER, sync TEXT, pushed INTEGER, pulled INTEGER, stdout_tail TEXT, stderr_tail TEXT, error TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS spike_egress (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, job INTEGER, method TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, allowed INTEGER NOT NULL, status INTEGER, error TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS spike_turns (job INTEGER PRIMARY KEY, n INTEGER NOT NULL, cap INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS spike_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS spike_snapshots (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, job INTEGER, boot INTEGER NOT NULL, reason TEXT NOT NULL, diff_sha256 TEXT, diff_bytes INTEGER, changed TEXT, todos_left INTEGER, pending TEXT, exec TEXT, sync TEXT, error TEXT)");
  const now = Date.now();
  const boot = sql.exec<{ id: number }>("INSERT INTO spike_boots (at, version, container_running) VALUES (?, ?, ?) RETURNING id", now, env.CF_VERSION_METADATA.id, ctx.container?.running ? 1 : 0).one().id;
  // A long run is pi's, which resumes it, and the watchdog closes that job. One cut off before it reached pi (its options
  // still empty) is over, like any other job a reset cut off.
  sql.exec("UPDATE spike_jobs SET status = 'interrupted', ended_at = ?, reset_by = ? WHERE status = 'running' AND boot < ? AND (kind != 'long' OR options = '{}')", now, boot, boot);
  return boot;
}

function usageTotals(usage: UsageState) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, piCostUsd: 0 };
  for (const u of Object.values(usage.models)) {
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.totalTokens += u.totalTokens;
    total.piCostUsd += u.cost.total;
  }
  // Workers AI bills cached input at its own rate; pi's cost uses the catalog's prices, which should agree.
  return { ...total, priceUsd: (total.input * PRICE.input + total.cacheRead * PRICE.cacheRead + total.output * PRICE.output) / 1e6, byModel: usage.models };
}

function usageDelta(before: UsageState, after: UsageState) {
  const a = usageTotals(after);
  const b = usageTotals(before);
  return { input: a.input - b.input, output: a.output - b.output, cacheRead: a.cacheRead - b.cacheRead, totalTokens: a.totalTokens - b.totalTokens, priceUsd: a.priceUsd - b.priceUsd, piCostUsd: a.piCostUsd - b.piCostUsd };
}

function vfsDelta(before: VfsSizes, after: VfsSizes) {
  const d = (k: keyof VfsSizes) => (before[k] === null || after[k] === null ? null : Number(after[k]) - Number(before[k]));
  return { databaseBytes: d("databaseBytes"), nodes: d("nodes"), fileBytes: d("fileBytes"), blobBytes: d("blobBytes"), manifestBytes: d("manifestBytes"), nodeModulesDirs: d("nodeModulesDirs") };
}

/** Every `diagnostics` array anywhere in a transcript entry. */
function findDiagnostics(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(findDiagnostics);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => (k === "diagnostics" && Array.isArray(v) ? v : findDiagnostics(v)));
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const errorOf = (err: unknown) => ({ name: (err as { name?: string } | null)?.name ?? null, code: (err as { code?: unknown } | null)?.code ?? null, message: (err as { message?: string } | null)?.message ?? String(err) });

async function authorized(request: Request, env: SpikeEnv): Promise<boolean> {
  const expected = (env.SPIKE_TOKEN ?? "").trim();
  const given = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (expected === "" || given === undefined) return false;
  const digest = async (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Streams NDJSON: a line every 15 seconds while `work` runs, so nothing between here and curl times out, then its result. */
function streamed(work: Promise<unknown>, ctx: ExecutionContext): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const line = (value: unknown) => writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  const started = Date.now();
  ctx.waitUntil(
    (async () => {
      const beat = setInterval(() => void line({ waiting: Math.round((Date.now() - started) / 1000) }).catch(() => {}), 15_000);
      try {
        await line(await work);
      } catch (err) {
        await line({ error: errorOf(err) }).catch(() => {});
      } finally {
        clearInterval(beat);
        await writer.close().catch(() => {});
      }
    })(),
  );
  return new Response(readable, { headers: { "Content-Type": "application/x-ndjson" } });
}

export default {
  async fetch(request, env, ctx) {
    if (!(await authorized(request, env))) return new Response("unauthorized\n", { status: 401 });
    const url = new URL(request.url);
    const flag = (name: string, value = "1") => url.searchParams.get(name) === value;
    // One object name, so one container at most.
    const bench = env.BENCH.getByName("main");
    switch (`${request.method} ${url.pathname}`) {
      case "GET /report":
        return Response.json(await bench.report());
      case "GET /status":
        return Response.json(await bench.status());
      case "POST /clone":
        return streamed(bench.run("clone", { fresh: flag("fresh") }), ctx);
      case "POST /install":
        return streamed(bench.run("install", { ignore: !flag("ignore", "off") }), ctx);
      case "POST /test":
        return streamed(bench.run("test"), ctx);
      case "POST /prompt":
        return streamed(bench.run("prompt"), ctx);
      case "POST /push":
        return streamed(bench.run("push"), ctx);
      case "POST /long":
        return Response.json(await bench.startLong());
      case "POST /evict":
        try {
          return Response.json(await bench.evict(flag("during", "exec")));
        } catch (err) {
          // The abort rejects this call: that is the eviction.
          return Response.json({ evicted: true, error: errorOf(err).message });
        }
      case "POST /stop":
        return Response.json(await bench.stop(flag("force")));
      default:
        return new Response("not found\n", { status: 404 });
    }
  },
} satisfies ExportedHandler<SpikeEnv>;
