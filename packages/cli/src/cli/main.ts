import { parseArgs } from "node:util";
import { VERSION } from "../version.ts";
import { doctor } from "./commands/doctor.ts";
import { events, followEvents, trace } from "./commands/events.ts";
import { check, diff, graph } from "./commands/model.ts";
import { type CommandResult, toJson, UsageError } from "./output.ts";

const HELP = `actors ${VERSION}: conventions, checks, and inspection for actor systems on Cloudflare

Usage: actors <command> [options]

Commands:
  doctor                       Check the environment, project, pins, and Cloudflare tooling
  check [--changed <file>...]  Validate the declaration, routes, schemas, config, and manifest
        [--format brief]       (brief: hard errors only, silent when clean; for hooks)
  graph [--write]              Print the topology; --write updates actors.manifest.json
  diff [--base <ref>]          Classify architectural changes against the committed manifest
       [--base-file <path>]    (default base: HEAD) and print a deploy plan, never a deploy
  events [--follow] [--notable] Query or follow local structured events (.actors/events.ndjson);
         [--actor A] [--kind K] --json prints NDJSON; --notable keeps faults only
         [--correlation C] [--file F]
  trace <message-id> [--file F] Follow a message's causes and consequences in the local event log

Options:
  --json            Print machine-readable output (with schemaVersion)
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
};

export async function main(argv: string[], io = { out: process.stdout, err: process.stderr, cwd: process.cwd() }): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: "boolean" },
        changed: { type: "string", multiple: true },
        format: { type: "string" },
        write: { type: "boolean" },
        base: { type: "string" },
        "base-file": { type: "string" },
        follow: { type: "boolean" },
        notable: { type: "boolean" },
        actor: { type: "string" },
        kind: { type: "string" },
        correlation: { type: "string" },
        file: { type: "string" },
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
    const handler = commands[name];
    if (!handler) throw new UsageError(`unknown command "${name}"`);
    const json = values.json === true;
    if (name === "events" && values.follow === true) {
      const filter = { notable: values.notable === true, actor: str(values.actor), kind: str(values.kind), correlation: str(values.correlation), file: str(values.file), json };
      return await followEvents(io.cwd, filter, io.out);
    }
    if (name === "events" && json) {
      // NDJSON: one event per line, so the output can be piped and tailed like the log itself.
      const r = events(io.cwd, { notable: values.notable === true, actor: str(values.actor), kind: str(values.kind), correlation: str(values.correlation), file: str(values.file) });
      io.out.write(r.data.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
      return r.exitCode;
    }
    const result = await handler({ positionals: rest, json, cwd: io.cwd, values: values as Args["values"] });
    io.out.write(json ? toJson(name, result.data) : result.text ? `${result.text}\n` : "");
    return result.exitCode;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err.write(`actors: ${err.message}\nRun \`actors --help\` for usage.\n`);
      return 2;
    }
    io.err.write(`actors: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 70;
  }
}
