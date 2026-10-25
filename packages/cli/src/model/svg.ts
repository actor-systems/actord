// A deterministic SVG of the topology for surfaces that draw SVG (the Room on Desktop). External senders
// sit in the first column; each actor's column is its distance from them. Changes against a base are
// colored: added green, removed red and dashed.
import type { Manifest } from "./manifest.ts";

export type Change = "added" | "removed" | null;

export interface TopologyNode {
  name: string;
  kind: string;
  change: Change;
}

export interface TopologyEdge {
  from: string;
  message: string;
  to: string;
  change: Change;
}

export interface Topology {
  actors: TopologyNode[];
  routes: TopologyEdge[];
}

/** The head topology plus whatever the base had that the head lost, each marked by change. */
export function topologyWithChanges(base: Manifest | null, head: Manifest): Topology {
  const key = (r: { from: string; message: string; to: string }) => `${r.from} ${r.message} ${r.to}`;
  const baseActors = new Set(base?.actors.map((a) => a.name) ?? []);
  const headActors = new Set(head.actors.map((a) => a.name));
  const baseRoutes = new Set(base?.routes.map(key) ?? []);
  const headRoutes = new Set(head.routes.map(key));
  const actors: TopologyNode[] = [
    ...head.actors.map((a) => ({ name: a.name, kind: a.kind, change: (base && !baseActors.has(a.name) ? "added" : null) as Change })),
    ...(base?.actors.filter((a) => !headActors.has(a.name)).map((a) => ({ name: a.name, kind: a.kind, change: "removed" as Change })) ?? []),
  ].sort((a, b) => (a.name < b.name ? -1 : 1));
  const routes: TopologyEdge[] = [
    ...head.routes.map((r) => ({ ...r, change: (base && !baseRoutes.has(key(r)) ? "added" : null) as Change })),
    ...(base?.routes.filter((r) => !headRoutes.has(key(r))).map((r) => ({ ...r, change: "removed" as Change })) ?? []),
  ].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return { actors, routes };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COLOR = { added: "#1a7f37", removed: "#cf222e" } as const;

export function topologySvg(t: Topology): string {
  const external = [...new Set(t.routes.map((r) => r.from).filter((f) => f.startsWith("@")))].sort();
  const depth = new Map<string, number>(external.map((e) => [e, 0]));
  // Longest-path layering from the external senders, bounded so cycles terminate.
  for (let pass = 0; pass < t.actors.length + 1; pass++) {
    for (const r of t.routes) {
      if (r.from === r.to) continue;
      const d = (depth.get(r.from) ?? 0) + 1;
      if (d <= t.actors.length && d > (depth.get(r.to) ?? 0)) depth.set(r.to, d);
    }
  }
  for (const a of t.actors) if (!depth.has(a.name)) depth.set(a.name, 1);
  const columns = new Map<number, string[]>();
  for (const name of [...external, ...t.actors.map((a) => a.name)]) {
    const d = depth.get(name) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), name]);
  }
  const W = 170;
  const H = 46;
  const GX = 90;
  const GY = 34;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, names] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    names.forEach((n, i) => pos.set(n, { x: 20 + d * (W + GX), y: 20 + i * (H + GY) }));
  }
  const width = Math.max(...[...pos.values()].map((p) => p.x + W)) + 20;
  const height = Math.max(...[...pos.values()].map((p) => p.y + H)) + 30;
  const kind = new Map(t.actors.map((a) => [a.name, a]));
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-sans-serif, system-ui" font-size="12">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`,
  ];
  for (const r of t.routes) {
    const a = pos.get(r.from);
    const b = pos.get(r.to);
    if (!a || !b) continue;
    const color = r.change ? COLOR[r.change] : "#57606a";
    const dash = r.change === "removed" ? ` stroke-dasharray="5 4"` : "";
    if (r.from === r.to) {
      parts.push(
        `<path d="M${a.x + W - 30},${a.y} C${a.x + W - 10},${a.y - 28} ${a.x + W + 22},${a.y + 4} ${a.x + W},${a.y + 16}" fill="none" stroke="${color}" color="${color}"${dash} marker-end="url(#arrow)"/>`,
        `<text x="${a.x + W - 4}" y="${a.y - 14}" fill="${color}">${esc(r.message)}</text>`,
      );
      continue;
    }
    const x1 = a.x + W;
    const y1 = a.y + H / 2;
    const x2 = b.x;
    const y2 = b.y + H / 2;
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" color="${color}"${dash} marker-end="url(#arrow)"/>`,
      `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle" fill="${color}">${esc(r.message)}</text>`,
    );
  }
  for (const [name, p] of pos) {
    const node = kind.get(name);
    const color = node?.change ? COLOR[node.change] : name.startsWith("@") ? "#8c959f" : "#24292f";
    const dash = node?.change === "removed" ? ` stroke-dasharray="5 4"` : "";
    parts.push(
      `<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="${name.startsWith("@") ? 23 : 8}" fill="none" stroke="${color}" stroke-width="1.5"${dash}/>`,
      `<text x="${p.x + W / 2}" y="${p.y + (node ? 20 : 28)}" text-anchor="middle" font-weight="600" fill="${color}">${esc(name)}</text>`,
    );
    if (node) parts.push(`<text x="${p.x + W / 2}" y="${p.y + 36}" text-anchor="middle" fill="#57606a">${esc(node.kind)}${node.change ? ` · ${node.change}` : ""}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}
