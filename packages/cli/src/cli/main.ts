import { parseArgs } from "node:util";
import { VERSION } from "../version.ts";
import { doctor } from "./commands/doctor.ts";
import { type CommandResult, toJson, UsageError } from "./output.ts";

const HELP = `actors ${VERSION}: conventions, checks, and inspection for actor systems on Cloudflare

Usage: actors <command> [options]

Commands:
  doctor            Check the environment, project, pins, and Cloudflare tooling

Options:
  --json            Print machine-readable output (with schemaVersion)
  -h, --help        Show help
  -v, --version     Show the toolkit version

Read-only commands never contact Cloudflare. Deploys belong to wrangler, after a person approves.`;

type Handler = (args: { positionals: string[]; json: boolean; cwd: string }) => Promise<CommandResult<object>> | CommandResult<object>;

const commands: Record<string, Handler> = {
  doctor: ({ cwd }) => doctor(cwd),
};

export async function main(argv: string[], io = { out: process.stdout, err: process.stderr, cwd: process.cwd() }): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: "boolean" },
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
    const result = await handler({ positionals: rest, json, cwd: io.cwd });
    io.out.write(json ? toJson(name, result.data) : `${result.text}\n`);
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
