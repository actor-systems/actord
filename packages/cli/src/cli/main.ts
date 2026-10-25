import { parseArgs } from "node:util";
import { VERSION } from "../version.ts";
import { doctor } from "./commands/doctor.ts";
import { claimMonitor, events, followEvents, trace } from "./commands/events.ts";
import { hook } from "./commands/hook.ts";
import { init } from "./commands/init.ts";
import { followRoom, guard, room } from "./commands/room.ts";
import { test, verify } from "./commands/verify.ts";
import { check, diff, graph } from "./commands/model.ts";
import { type CommandResult, toJson, UsageError } from "./output.ts";

const HELP = `actord ${VERSION}: conventions, checks, and inspection for actor systems on Cloudflare

Usage: actord <command> [options]

Commands:
  doctor                       Check the environment, project, pins, and Cloudflare tooling
  init [dir] [--adopt]         Create a starter project in an empty dir, or add the verify skill,
       [--name N] [--host H]   host guidance (claude, codex, none) to an existing one (never overwrites)
  check [--changed <file>...]  Validate the declaration, routes, schemas, config, and manifest
        [--format brief]       (brief: hard errors only, silent when clean; for hooks)
  graph [--write]              Print the topology; --write updates actord.manifest.json
  diff [--base <ref>]          Classify architectural changes against the committed manifest
       [--base-file <path>]    (default base: HEAD) and print a deploy plan, never a deploy
  events [--follow] [--notable] Query or follow local structured events (.actord/events.ndjson);
         [--actor A] [--kind K] --json prints NDJSON; --notable keeps faults only; --exclusive
         [--correlation C]     (the monitor's) exits quietly if this session already follows
         [--file F] [--exclusive] the project
  trace <message-id> [--file F] Follow a message's causes and consequences in the local event log
  test [--profile extended]    Run the project's workerd tests (standard skips [extended] tests)
  verify [--out F]             Typecheck, check, test, and classify reliability claims; writes
         [--profile extended]  .actord/evidence.json (verdict pass, fail, or blocked)
  room [--follow]              The Room's view: topology with changes, mailboxes, contracts, and
       [--base-file <path>]    evidence; --follow --json prints a snapshot whenever they change
  guard -- <command>           Whether the Room's effect guard holds a shell command, and the diff
                               and deploy plan it shows (deploy and remote-write patterns)

Options:
  --json            Print machine-readable output (with schemaVersion)
  --exit-zero       Exit 0 whatever the result (for skill injection, where any other exit aborts)
  -h, --help        Show help
  -v, --version     Show the toolkit version

Exit status: 0 ok · 1 hard errors · 2 usage · 3 not in an actor project.
Read-only commands never contact Cloudflare. Deploys belong to wrangler, after a person approves.`;

interface Args {
  positionals: string[];
  json: boolean;
  cwd: string;
  values: Record<string, string | boolean | string[] | undefined>;
}
type Handler = (args: Args) => Promise<CommandResult<object>> | CommandResult<object>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const commands: Record<string, Handler> = {
  doctor: ({ cwd }) => doctor(cwd),
  check: ({ cwd, values, positionals }) =>
    check(cwd, { changed: [...((values.changed as string[] | undefined) ?? []), ...(values.changed !== undefined ? positionals : [])], format: str(values.format) }),
  graph: ({ cwd, values }) => graph(cwd, { write: values.write === true }),
  diff: ({ cwd, values }) => diff(cwd, { base: str(values.base), baseFile: str(values["base-file"]) }),
  events: ({ cwd, values }) =>
    events(cwd, { notable: values.notable === true, actor: str(values.actor), kind: str(values.kind), correlation: str(values.correlation), file: str(values.file) }),
  trace: ({ cwd, values, positionals }) => trace(cwd, positionals[0], { file: str(values.file) }),
  init: ({ cwd, values, positionals }) => init(cwd, positionals[0], { adopt: values.adopt === true, name: str(values.name), toolkit: str(values.toolkit), host: str(values.host) }),
  verify: ({ cwd, values }) => verify(cwd, { out: str(values.out), profile: str(values.profile) }),
  test: ({ cwd, values }) => test(cwd, { profile: str(values.profile) }),
  room: ({ cwd, values }) => room(cwd, { baseFile: str(values["base-file"]) }),
  guard: ({ cwd, positionals }) => {
    if (positionals.length === 0) throw new UsageError("guard needs the command to judge: actord guard -- <command>");
    return guard(cwd, positionals.join(" "));
  },
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[], io = { out: process.stdout, err: process.stderr, cwd: process.cwd() }): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: "boolean" },
        "exit-zero": { type: "boolean" },
        changed: { type: "string", multiple: true },
        format: { type: "string" },
        write: { type: "boolean" },
        base: { type: "string" },
        "base-file": { type: "string" },
        follow: { type: "boolean" },
        notable: { type: "boolean" },
        exclusive: { type: "boolean" },
        actor: { type: "string" },
        kind: { type: "string" },
        correlation: { type: "string" },
        file: { type: "string" },
        adopt: { type: "boolean" },
        name: { type: "string" },
        toolkit: { type: "string" },
        host: { type: "string" },
        out: { type: "string" },
        profile: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    const [name, ...rest] = positionals;
    if (values.version) {
      io.out.write(`${VERSION}\n`);
      return 0;
    }
    if (!name || values.help) {
      io.out.write(`${HELP}\n`);
      return name || values.help ? 0 : 2;
    }
    if (name === "hook") return await hook(rest[0], await readStdin(), process.env, io.out, io.err);
    const handler = commands[name];
    if (!handler) throw new UsageError(`unknown command "${name}"`);
    const json = values.json === true;
    if (name === "events" && values.follow === true) {
      if (values.exclusive === true && !claimMonitor(io.cwd)) return 0;
      const filter = { notable: values.notable === true, actor: str(values.actor), kind: str(values.kind), correlation: str(values.correlation), file: str(values.file), json };
      return await followEvents(io.cwd, filter, io.out);
    }
    if (name === "room" && values.follow === true) return await followRoom(io.cwd, io.out, process.argv[1] ?? "");
    if (name === "events" && json) {
      // NDJSON: one event per line, so the output can be piped and tailed like the log itself.
      const r = events(io.cwd, { notable: values.notable === true, actor: str(values.actor), kind: str(values.kind), correlation: str(values.correlation), file: str(values.file) });
      io.out.write(r.data.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
      return r.exitCode;
    }
    const result = await handler({ positionals: rest, json, cwd: io.cwd, values: values as Args["values"] });
    io.out.write(json ? toJson(name, result.data) : result.text ? `${result.text}\n` : "");
    return values["exit-zero"] === true ? 0 : result.exitCode;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err.write(`actord: ${err.message}\nRun \`actord --help\` for usage.\n`);
      return 2;
    }
    io.err.write(`actord: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 70;
  }
}
