import { parseArgs } from "node:util";
import { VERSION } from "../version.ts";
import { doctor } from "./commands/doctor.ts";
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
