// Significance rules. A plain function, not an actor: it owns no state and has no identity.
// Each release is judged on its own content, so the outcome doesn't depend on arrival order.
import type { FeedItem } from "./messages/index.ts";

export type Severity = "major" | "security";

export interface Classification {
  severity: Severity | null;
  reason: string;
}

const SECURITY = /\b(security|cve-\d{4}-\d+|vulnerabilit(y|ies))\b/i;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

export function parseVersion(v: string): [number, number, number, string | null] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
}

/** Negative, zero, or positive as a is older than, equal to, or newer than b (pre-releases sort first). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  return x[3] === null ? 1 : y[3] === null ? -1 : (x[3] as string) < (y[3] as string) ? -1 : 1;
}

export function classify(item: Pick<FeedItem, "title" | "version">): Classification {
  if (SECURITY.test(item.title)) return { severity: "security", reason: "title mentions a security fix" };
  const v = parseVersion(item.version);
  if (!v) return { severity: null, reason: `version "${item.version}" isn't semver` };
  if (v[3] !== null) return { severity: null, reason: "pre-release" };
  if (v[0] >= 1 && v[1] === 0 && v[2] === 0) return { severity: "major", reason: `new major version ${v[0]}` };
  return { severity: null, reason: "minor or patch release" };
}
