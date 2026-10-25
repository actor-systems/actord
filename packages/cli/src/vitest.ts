// @actord/toolkit/vitest: a Vitest plugin that records the runtime's structured events.
// Each `{"$actord":1,...}` console line from workerd becomes one line of .actord/events.ndjson.
// The file starts empty for every Vitest run, so it is the evidence of the latest run only.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ActorEventsOptions {
  /** Where to write events, relative to the Vitest root (default .actord/events.ndjson). */
  file?: string;
  /** Also print event lines to the terminal (default false). */
  echo?: boolean;
}

export function actorEvents(options: ActorEventsOptions = {}) {
  let file = "";
  let seq = 0;
  return {
    name: "@actord/toolkit:events",
    config(config: { root?: string }) {
      file = resolve(config.root ?? process.cwd(), options.file ?? ".actord/events.ndjson");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
      return {
        test: {
          // Vitest 5 hides console output from passing tests unless silent is false.
          silent: false,
          onConsoleLog(log: string): boolean | undefined {
            let kept = false;
            for (const line of log.split("\n")) {
              if (!line.startsWith('{"$actord":1')) continue;
              try {
                const event = JSON.parse(line) as Record<string, unknown>;
                appendFileSync(file, `${JSON.stringify({ seq: ++seq, ...event })}\n`);
                kept = true;
              } catch {
                // Not an event after all; let Vitest print it.
              }
            }
            return kept && !options.echo ? false : undefined;
          },
        },
      };
    },
  };
}
