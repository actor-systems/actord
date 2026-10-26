import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkProject, type Diagnostic } from "../../model/check.ts";
import { type DiffResult, diffManifests, EMPTY_MANIFEST } from "../../model/diff.ts";
import { fingerprint } from "../../model/fingerprint.ts";
import { loadProject, type Project } from "../../model/load.ts";
import { MANIFEST_FILE, type Manifest, scheduleLabel, serializeManifest } from "../../model/manifest.ts";
import { renderMermaid } from "../../model/mermaid.ts";
import type { CommandResult } from "../output.ts";
import { findProjectRoot } from "../project.ts";

/** Exit status when the command runs outside an actor project. Hooks treat it as "skip quietly". */
export const EXIT_NO_PROJECT = 3;

function noProject<T extends object>(cwd: string, data: T): CommandResult<T & { projectRoot: null }> {
  return {
    data: { ...data, projectRoot: null },
    text: `No actor project at ${cwd} (no system.ts with a package.json here or above).`,
    exitCode: EXIT_NO_PROJECT,
  };
}

// Files whose edits can change what `actord check` reports.
const RELEVANT = [/(^|\/)system\.ts$/, /(^|\/)src\/actors\//, /(^|\/)src\/messages\//, /(^|\/)wrangler\.jsonc?$/, /(^|\/)src\/index\.ts$/, new RegExp(`(^|/)${MANIFEST_FILE.replace(".", "\\.")}$`)];

export interface CheckData {
  projectRoot: string | null;
  skipped: boolean;
  ok: boolean;
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
}

export async function check(cwd: string, opts: { changed?: string[]; format?: string }): Promise<CommandResult<CheckData>> {
  const root = findProjectRoot(cwd);
  if (!root) return noProject(cwd, { skipped: true, ok: true, errors: 0, warnings: 0, diagnostics: [] });
  if (opts.changed && opts.changed.length > 0) {
    const touched = opts.changed.map((f) => relative(root, resolve(cwd, f))).filter((f) => !f.startsWith(".."));
    if (!touched.some((f) => RELEVANT.some((re) => re.test(f)))) {
      return { data: { projectRoot: root, skipped: true, ok: true, errors: 0, warnings: 0, diagnostics: [] }, text: opts.format === "brief" ? "" : "No actor files changed; nothing to check.", exitCode: 0 };
    }
  }
  const project = await loadProject(root);
  const diagnostics = checkProject(project);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const data = { projectRoot: root, skipped: false, ok: errors === 0, errors, warnings, diagnostics };
  recordCheck(root, data);
  let text: string;
  if (opts.format === "brief") {
    // For the edit-time hook: hard errors only, nothing when clean.
    text = diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `actord check: ${d.code} ${d.subject ?? ""}: ${d.message}${d.fix ? ` (fix: ${d.fix})` : ""}`)
      .join("\n");
  } else {
    const lines = diagnostics.map((d) => `${d.severity === "error" ? "✗" : "!"} ${d.code}${d.subject ? ` ${d.subject}` : ""}: ${d.message}${d.fix ? `\n    fix: ${d.fix}` : ""}`);
    lines.push(`${errors === 0 ? "✓" : "✗"} ${project.manifest?.system.name ?? "system"}: ${errors} error(s), ${warnings} warning(s)`);
    text = lines.join("\n");
  }
  return { data, text, exitCode: errors === 0 ? 0 : 1 };
}

export const LAST_CHECK_FILE = ".actord/last-check.json";

/** Local evidence for the evidence gate and the Room: the outcome of the latest full check. */
function recordCheck(root: string, data: { ok: boolean; errors: number; warnings: number; diagnostics: Diagnostic[] }): void {
  try {
    mkdirSync(join(root, ".actord"), { recursive: true });
    const record = {
      schemaVersion: 1,
      ok: data.ok,
      errors: data.errors,
      warnings: data.warnings,
      codes: data.diagnostics.map((d) => `${d.severity}:${d.code}`),
      fingerprint: fingerprint(root),
      checkedAt: new Date().toISOString(),
    };
    writeFileSync(join(root, LAST_CHECK_FILE), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // A read-only checkout still gets its check result; only the local record is skipped.
  }
}

export interface GraphData {
  projectRoot: string | null;
  manifest: Manifest | null;
  written: string | null;
  /** With --format mermaid: the topology as a Mermaid flowchart. */
  mermaid?: string;
}

export async function graph(cwd: string, opts: { write?: boolean; format?: string }): Promise<CommandResult<GraphData>> {
  if (opts.format !== undefined && opts.format !== "text" && opts.format !== "mermaid") {
    return { data: { projectRoot: null, manifest: null, written: null }, text: `✗ unknown --format "${opts.format}" (text or mermaid)`, exitCode: 2 };
  }
  const root = findProjectRoot(cwd);
  if (!root) return noProject(cwd, { manifest: null, written: null });
  const project = await loadProject(root);
  if (!project.manifest) return { data: { projectRoot: root, manifest: null, written: null }, text: `✗ ${project.loadError}`, exitCode: 1 };
  let written: string | null = null;
  if (opts.write) {
    writeFileSync(join(root, MANIFEST_FILE), serializeManifest(project.manifest));
    written = MANIFEST_FILE;
  }
  if (opts.format === "mermaid") {
    const mermaid = renderMermaid(project.manifest);
    return { data: { projectRoot: root, manifest: project.manifest, written, mermaid }, text: mermaid, exitCode: 0 };
  }
  const text = renderGraph(project.manifest) + (written ? `\n\nwrote ${written}` : "");
  return { data: { projectRoot: root, manifest: project.manifest, written }, text, exitCode: 0 };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function renderGraph(m: Manifest): string {
  const ver = new Map(m.messages.map((x) => [x.name, x.version]));
  const width = Math.max(0, ...m.routes.map((r) => r.from.length));
  const lines = [
    `${m.system.name} · ${count(m.actors.length, "actor")} · ${count(m.routes.length, "route")} · ${count(m.messages.length, "message")} · ${count(m.effects.length, "effect")}`,
    "",
    "Routes",
    ...m.routes.map((r) => `  ${r.from.padEnd(width)}  ──${r.message}@${ver.get(r.message) ?? "?"}──▶  ${r.to}`),
    "",
    "Actors",
  ];
  for (const a of m.actors) {
    const facts = [a.kind, a.schedules.length ? a.schedules.map(scheduleLabel).join(" · ") : null, a.effects.length ? `effects ${a.effects.join(", ")}` : null, `justified by ${a.justification.join(", ") || "nothing"}`].filter(Boolean);
    lines.push(`  ${a.name} (${a.binding}): ${facts.join(" · ")}`, `    ${a.purpose}`);
  }
  if (m.effects.length) {
    lines.push("", "Effects");
    for (const e of m.effects) lines.push(`  ${e.name}: idempotency ${e.idempotency}${e.reconcile ? ", reconcilable" : ""}, approval ${e.approval}. ${e.description}`);
  }
  return lines.join("\n");
}

export interface DiffData extends DiffResult {
  projectRoot: string | null;
  base: { source: string; system: string };
  head: { system: string };
  notes: string[];
}

export async function diff(cwd: string, opts: { base?: string; baseFile?: string }): Promise<CommandResult<DiffData>> {
  const root = findProjectRoot(cwd);
  if (!root) return noProject(cwd, { ...diffManifests(EMPTY_MANIFEST, EMPTY_MANIFEST), base: { source: "none", system: "" }, head: { system: "" }, notes: [] });
  const project: Project = await loadProject(root);
  if (!project.manifest) return { data: { projectRoot: root, ...diffManifests(EMPTY_MANIFEST, EMPTY_MANIFEST), base: { source: "none", system: "" }, head: { system: "" }, notes: [project.loadError ?? ""] }, text: `✗ ${project.loadError}`, exitCode: 1 };
  const notes: string[] = [];
  let base = EMPTY_MANIFEST;
  let source = "none";
  if (opts.baseFile) {
    base = JSON.parse(readFileSync(resolve(cwd, opts.baseFile), "utf8")) as Manifest;
    source = `file:${opts.baseFile}`;
  } else {
    const ref = opts.base ?? "HEAD";
    const fromGit = gitShow(root, ref, MANIFEST_FILE);
    const onDisk = join(root, MANIFEST_FILE);
    if (fromGit.text) {
      base = JSON.parse(fromGit.text) as Manifest;
      source = `git:${ref}`;
    } else if (!fromGit.usable && existsSync(onDisk)) {
      // Without git (a sandbox that can't start it, or no repository), the manifest on disk is the
      // architecture last recorded by `actord graph --write`: the best base there is, said plainly.
      base = JSON.parse(readFileSync(onDisk, "utf8")) as Manifest;
      source = `file:${MANIFEST_FILE}`;
      notes.push(`git isn't usable here (${fromGit.why}), so this compares against ${MANIFEST_FILE} on disk, the architecture last recorded by \`actord graph --write\`. Run \`actord diff\` before regenerating it, or pass --base-file.`);
    } else {
      notes.push(`No ${MANIFEST_FILE} at ${ref}; the whole system is shown as added. Commit the manifest (\`actord graph --write\`) to diff against it.`);
    }
  }
  const result = diffManifests(base, project.manifest);
  const data: DiffData = { projectRoot: root, base: { source, system: base.system.name }, head: { system: project.manifest.system.name }, notes, ...result };
  return { data, text: renderDiff(data), exitCode: 0 };
}

function gitShow(root: string, ref: string, file: string): { text: string | null; usable: boolean; why: string } {
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) {
    const why = top.error?.message ?? (top.stderr ?? "").trim().split("\n").pop() ?? `exit ${top.status}`;
    return { text: null, usable: false, why: why || `exit ${top.status}` };
  }
  const rel = relative(top.stdout.trim(), join(root, file));
  const r = spawnSync("git", ["-C", root, "show", `${ref}:${rel}`], { encoding: "utf8" });
  return { text: r.status === 0 ? r.stdout : null, usable: true, why: "" };
}

function renderDiff(d: DiffData): string {
  const sign = (k: string) => (k.endsWith(".added") ? "+" : k.endsWith(".removed") ? "-" : "~");
  const lines = [`actord diff: ${d.head.system} against ${d.base.source}`, ...d.notes.map((n) => `  note: ${n}`), ""];
  if (d.changes.length === 0) lines.push("  No architectural changes.");
  for (const c of d.changes) {
    const flags = [c.compatibility, c.requiresApproval ? "needs approval" : null, c.irreversible ? "IRREVERSIBLE" : null].filter(Boolean).join(", ");
    lines.push(`  ${sign(c.kind)} ${c.kind.padEnd(20)} ${c.subject}  [${flags}]`, `      ${c.detail}`);
  }
  lines.push("", "Deploy plan (a plan, not a deploy):", ...d.plan.map((s, i) => `  ${i + 1}. ${s.text}`));
  return lines.join("\n");
}
