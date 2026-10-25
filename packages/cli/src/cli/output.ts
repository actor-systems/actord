import { SCHEMA_VERSION, VERSION } from "../version.ts";

export interface CommandResult<T> {
  /** Machine-readable payload; serialized under `--json` with schemaVersion and command. */
  data: T;
  /** Human text, printed without `--json`. */
  text: string;
  exitCode: number;
}

export function toJson(command: string, data: object): string {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, toolkitVersion: VERSION, ...data }, null, 2)}\n`;
}

/** Stable key order for anything that reaches JSON output, so identical input gives identical bytes. */
export function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    ) as T;
  }
  return value;
}

export class UsageError extends Error {}
