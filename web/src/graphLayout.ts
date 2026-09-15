import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { elkLayout } from "./graph";
import type { GraphNode, GraphEdge, GraphKind } from "./types";
export type GraphPositions = Record<string, { x: number; y: number }>;
export function layoutStructureKey(nodes: GraphNode[], edges: GraphEdge[], kind: GraphKind): string {
  return JSON.stringify([kind, nodes.map((node) => node.id).sort(), edges.map((edge) => [edge.from, edge.type, edge.to].join(":" )).sort()]);
}
export function createLayoutRunner(engine: { layout: (graph: ElkNode) => Promise<ElkNode> }) {
  const cache = new Map<string, GraphPositions>();
  return async (nodes: GraphNode[], edges: GraphEdge[], kind: GraphKind = "operation", signal?: AbortSignal, runtimeDir = ""): Promise<GraphPositions | undefined> => {
    if (signal?.aborted) return undefined;
    const key = JSON.stringify([runtimeDir, layoutStructureKey(nodes, edges, kind)]);
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    const width = kind === "task" ? 230 : 172;
    const height = kind === "task" ? 96 : 68;
    const ids = new Set(nodes.map((node) => node.id));
    const options = elkLayout(kind, nodes.length).elk as Record<string, unknown>;
    const result = await engine.layout({ id: "root", layoutOptions: Object.fromEntries(Object.entries(options).map(([key, value]) => [key, String(value)])), children: nodes.map((node) => ({ id: node.id, width, height })), edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge, index) => ({ id: `edge-${index}`, sources: [edge.from], targets: [edge.to] })) });
    // ELK cannot cancel computation. Check ownership before handing results to a renderer.
    if (signal?.aborted) return undefined;
    const positions = Object.fromEntries((result.children ?? []).map((node) => [node.id, { x: (node.x ?? 0) + (node.width ?? width) / 2, y: (node.y ?? 0) + (node.height ?? height) / 2 }]));
    cache.set(key, positions);
    while (cache.size > 20) cache.delete(cache.keys().next().value!);
    return positions;
  };
}
export const layoutGraph = createLayoutRunner(new ELK());
