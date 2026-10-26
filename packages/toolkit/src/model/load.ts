// Load an actor project: evaluate system.ts (Node strips its types natively), read the Worker config,
// and collect the class names the Worker entry exports. Loading never writes anything.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DECLARATION_FILE, readJson, readJsonc } from "../cli/project.ts";
import { isSystem, type System } from "../system.ts";
import { MANIFEST_FILE, type Manifest, normalize } from "./manifest.ts";

export interface WorkerConfig {
  name?: string;
  main?: string;
  durable_objects?: { bindings?: Array<{ name: string; class_name: string; script_name?: string }> };
  exports?: Record<string, { type?: string; state?: string; storage?: string; renamed_to?: string }>;
  migrations?: unknown[];
}

export interface Project {
  root: string;
  system: System | null;
  manifest: Manifest | null;
  loadError: string | null;
  config: WorkerConfig | null;
  configFile: string | null;
  entryFile: string | null;
  entryExports: Set<string> | null;
  committedManifest: Manifest | null;
  committedManifestRaw: string | null;
}

export async function loadProject(root: string): Promise<Project> {
  const project: Project = {
    root,
    system: null,
    manifest: null,
    loadError: null,
    config: null,
    configFile: null,
    entryFile: null,
    entryExports: null,
    committedManifest: null,
    committedManifestRaw: null,
  };
  try {
    const mod = (await import(pathToFileURL(join(root, DECLARATION_FILE)).href)) as { default?: unknown; system?: unknown };
    const candidate = mod.default ?? mod.system;
    if (!isSystem(candidate)) {
      project.loadError = "system.ts must `export default defineSystem({...})` from @actord/toolkit/system";
    } else {
      project.system = candidate;
      project.manifest = normalize(candidate);
    }
  } catch (err) {
    project.loadError = explainLoadError(err);
  }

  for (const file of ["wrangler.jsonc", "wrangler.json"]) {
    if (existsSync(join(root, file))) {
      project.configFile = file;
      project.config = readJsonc<WorkerConfig>(join(root, file));
      break;
    }
  }
  if (project.config?.main) {
    project.entryFile = project.config.main;
    project.entryExports = collectExports(resolve(root, project.config.main), new Set());
  }
  const manifestPath = join(root, MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    project.committedManifestRaw = readFileSync(manifestPath, "utf8");
    project.committedManifest = readJson<Manifest>(manifestPath);
  }
  return project;
}

function explainLoadError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const msg = (e.message ?? String(err)).split("\n")[0] ?? "";
  if (e.code === "ERR_MODULE_NOT_FOUND") return `system.ts imports a module that isn't installed or doesn't exist: ${msg}. Run \`npm install\`, and use explicit .ts extensions for relative imports.`;
  if (e.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") return `system.ts uses TypeScript syntax Node can't strip (enums, namespaces, parameter properties): ${msg}`;
  if (/Cannot use import statement outside a module/.test(msg)) return `${msg}. Set "type": "module" in package.json.`;
  return `system.ts failed to load: ${msg}`;
}

const EXPORT_RE = /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|export\s*\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?|export\s*\*\s*from\s*["']([^"']+)["']/g;

/** Class and re-exported names reachable from a module, following relative `export ... from` chains. */
export function collectExports(file: string, seen: Set<string>): Set<string> {
  const names = new Set<string>();
  if (seen.has(file) || !existsSync(file) || !statSync(file).isFile()) return names;
  seen.add(file);
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  for (const m of source.matchAll(EXPORT_RE)) {
    if (m[1]) names.add(m[1]);
    if (m[2] !== undefined) {
      for (const part of m[2].split(",")) {
        const spec = part.trim().replace(/^type\s+/, "");
        if (!spec || part.trim().startsWith("type ")) continue;
        const alias = spec.split(/\s+as\s+/).at(-1)!.trim();
        if (alias) names.add(alias);
      }
    }
    if (m[4]) {
      const target = resolveRelative(dirname(file), m[4]);
      if (target) for (const n of collectExports(target, seen)) names.add(n);
    }
  }
  return names;
}

function resolveRelative(dir: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dir, spec);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}
