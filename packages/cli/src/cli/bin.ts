import { main } from "./main.ts";

// Loading system.ts uses Node's type stripping, which warns on every run. The warning reaches hooks and
// skill injections (stderr is merged there) and says nothing about the project, so it's dropped here.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/Type Stripping is an experimental feature/.test(text)) return;
  return (emit as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

process.exitCode = await main(process.argv.slice(2));
