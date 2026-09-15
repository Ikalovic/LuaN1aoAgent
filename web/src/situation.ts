import type { CollectionCoverage, GraphEdge, GraphKind, GraphNode, JsonRecord, RuntimeState } from "./types";

export interface CountMetric {
  value: number | null;
  state: CollectionCoverage["state"];
}
export const TASK_STATUSES = ["open", "completed", "blocked", "failed", "archived", "unknown"] as const;
export const HYPOTHESIS_STATUSES = ["open", "inconclusive", "confirmed", "refuted", "superseded", "unknown"] as const;

function metric(value: number, available: boolean, coverage?: CollectionCoverage): CountMetric {
  const state = !available ? "unavailable" : coverage?.state ?? "unknown";
  return { value: state === "unavailable" ? null : value, state };
}

function latestFirst(a: GraphNode | GraphEdge, b: GraphNode | GraphEdge): number {
  const time = (item: GraphNode | GraphEdge) => Date.parse(item.updatedAt ?? "") || 0;
  const key = (item: GraphNode | GraphEdge) => item.id || ("from" in item ? JSON.stringify([item.from, item.type, item.to]) : "");
  return time(b) - time(a) || key(a).localeCompare(key(b));
}

function uniqueNodes(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const node of [...nodes].sort(latestFirst)) if (!byId.has(node.id)) byId.set(node.id, node);
  return [...byId.values()];
}

export function assetValidation(node: GraphNode): "candidate" | "verified" | "unknown" {
  if (node.properties.classification === "candidate_only" || node.properties.validationStatus === "pending") return "candidate";
  return ["verified", "validated"].includes(String(node.properties.validationStatus)) ? "verified" : "unknown";
}

export function hasFindingEvidence(node: GraphNode): boolean {
  return Array.isArray(node.evidenceRefs) && node.evidenceRefs.some((ref) => typeof ref === "string" && ref.trim().length > 0);
}

// Counts describe loaded collections. Only explicit coverage may establish completeness.
export function buildSituation(state?: RuntimeState) {
  const graphAvailable = Array.isArray(state?.graph?.nodes) && state?.graph?.source !== "unavailable";
  const nodes = uniqueNodes(state?.graph?.nodes ?? []);
  const edges = state?.graph?.edges ?? [];
  const count = (value: number) => metric(value, graphAvailable, state?.coverage?.nodes);
  const assets = nodes.filter((node) => node.graphKind === "operation" && ["Host", "Service", "WebEndpoint"].includes(node.type));
  const findings = nodes.filter((node) => node.graphKind === "reasoning" && ["Vulnerability", "Exploit", "Hypothesis"].includes(node.type));
  const tasks = nodes.filter((node) => node.graphKind === "task" && node.type === "Task");
  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, count(tasks.filter((node) => {
    const raw = node.properties.status;
    return (TASK_STATUSES.some((known) => known === raw) ? raw : "unknown") === status;
  }).length)])) as Record<typeof TASK_STATUSES[number], CountMetric>;
  const hypotheses = findings.filter((node) => node.type === "Hypothesis");
  const hypothesisByStatus: Record<string, CountMetric> = Object.fromEntries(HYPOTHESIS_STATUSES.map((status) => [status, count(0)]));
  for (const node of hypotheses) {
    const status = typeof node.properties.status === "string" && node.properties.status.trim() ? node.properties.status : "unknown";
    hypothesisByStatus[status] = count((hypothesisByStatus[status]?.value ?? 0) + 1);
  }
  const denominator = byStatus.archived.value === null ? null : tasks.length - byStatus.archived.value;
  return {
    nodes, edges, coverage: state?.coverage,
    assets: {
      all: assets,
      hosts: count(assets.filter((node) => node.type === "Host").length),
      services: count(assets.filter((node) => node.type === "Service").length),
      webEndpoints: count(assets.filter((node) => node.type === "WebEndpoint").length),
      candidates: count(assets.filter((node) => assetValidation(node) === "candidate").length),
      verified: count(assets.filter((node) => assetValidation(node) === "verified").length),
      unknown: count(assets.filter((node) => assetValidation(node) === "unknown").length)
    },
    findings: {
      all: findings,
      vulnerabilities: count(findings.filter((node) => node.type === "Vulnerability" && hasFindingEvidence(node)).length),
      exploits: count(findings.filter((node) => node.type === "Exploit" && node.properties.status === "succeeded" && hasFindingEvidence(node)).length),
      hypotheses: { all: hypotheses, total: count(hypotheses.length), byStatus: hypothesisByStatus },
      missingEvidence: count(findings.filter((node) => !hasFindingEvidence(node) && (
        node.type === "Vulnerability" || (node.type === "Exploit" && node.properties.status === "succeeded")
        || (node.type === "Hypothesis" && node.properties.status === "refuted")
      )).length)
    },
    tasks: { all: tasks, total: count(tasks.length), byStatus, denominator,
      completion: denominator ? (byStatus.completed.value ?? 0) / denominator : null },
    counts: {
      nodes: count(nodes.length),
      edges: metric(edges.length, Array.isArray(state?.graph?.edges) && state?.graph?.source !== "unavailable", state?.coverage?.edges),
      events: metric(state?.events?.length ?? 0, Array.isArray(state?.events), state?.coverage?.events),
      artifacts: metric(state?.artifacts?.records?.length ?? 0, Array.isArray(state?.artifacts?.records), state?.coverage?.artifacts),
      taskOutcomes: metric(state?.reports?.taskOutcomes?.length ?? 0, Array.isArray(state?.reports?.taskOutcomes), state?.coverage?.taskOutcomes),
      epochOutcomes: metric(state?.reports?.epochOutcomes?.length ?? 0, Array.isArray(state?.reports?.epochOutcomes), state?.coverage?.epochOutcomes)
    }
  };
}

export type Situation = ReturnType<typeof buildSituation>;

export function projectGraph(situation: Pick<Situation, "nodes" | "edges">, options: { kind?: GraphKind; selectedId?: string; maxNodes?: number; maxEdges?: number } = {}) {
  const maxNodes = Math.max(0, Math.min(60, Math.floor(options.maxNodes ?? 60)));
  const maxEdges = Math.max(0, Math.min(120, Math.floor(options.maxEdges ?? 120)));
  const nodes = uniqueNodes(situation.nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const findings = new Set(nodes.filter((node) => node.graphKind === "reasoning" && ["Vulnerability", "Exploit", "Hypothesis"].includes(node.type)).map((node) => node.id));
  const linked = new Set<string>();
  for (const edge of situation.edges) {
    if (findings.has(edge.from) && byId.get(edge.to)?.graphKind === "operation") linked.add(edge.to);
    if (findings.has(edge.to) && byId.get(edge.from)?.graphKind === "operation") linked.add(edge.from);
  }
  const neighbors = new Set<string>();
  const centers = new Set([...linked, ...(options.selectedId ? [options.selectedId] : [])]);
  for (const edge of situation.edges) {
    if (centers.has(edge.from)) neighbors.add(edge.to);
    if (centers.has(edge.to)) neighbors.add(edge.from);
  }
  const priority = (node: GraphNode) => node.id === options.selectedId ? 0 : linked.has(node.id) ? 1 : neighbors.has(node.id) ? 2 : 3;
  const eligible = nodes.filter((node) => node.graphKind === (options.kind ?? "operation"));
  const visible = eligible.sort((a, b) => priority(a) - priority(b) || latestFirst(a, b)).slice(0, maxNodes);
  const visibleIds = new Set(visible.map((node) => node.id));
  const edgePriority = (edge: GraphEdge) => edge.from === options.selectedId || edge.to === options.selectedId ? 0 : 1;
  const edges = [...situation.edges].filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
    .sort((a, b) => edgePriority(a) - edgePriority(b) || latestFirst(a, b)).slice(0, maxEdges);
  const eligibleIds = new Set(eligible.map((node) => node.id));
  const eligibleEdges = situation.edges.filter((edge) => eligibleIds.has(edge.from) && eligibleIds.has(edge.to));
  // Missing endpoint kinds cannot be inferred: this count covers the entire supplied graph.
  const unloadedEdges = situation.edges.filter((edge) => !byId.has(edge.from) || !byId.has(edge.to)).length;
  return { nodes: visible, edges, omittedNodes: eligible.length - visible.length, omittedEdges: eligibleEdges.length - edges.length, unloadedEdges };
}

export function bucketActivity(events: JsonRecord[], options: { start?: string; end?: string; bucketCount?: number; now?: string; relativeMs?: number } = {}) {
  const valid = events.map((event) => typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN).filter(Number.isFinite).sort((a, b) => a - b);
  const now = Date.parse(options.now ?? "");
  const timestamps = valid.filter((timestamp) => !Number.isFinite(now) || timestamp <= now);
  const invalidTimestamps = events.length - valid.length;
  const futureTimestamps = valid.length - timestamps.length;
  const empty = { buckets: [] as Array<{ start: string; end: string; count: number }>, range: null as { start: string; end: string } | null, invalidTimestamps, futureTimestamps };
  if (!timestamps.length) return empty;
  const parsedStart = Date.parse(options.start ?? "");
  const parsedEnd = Date.parse(options.end ?? "");
  const relativeStart = Number.isFinite(now) && options.relativeMs !== undefined && Number.isFinite(options.relativeMs) && options.relativeMs >= 0 ? now - options.relativeMs : -Infinity;
  const start = Math.max(timestamps[0], Number.isFinite(parsedStart) ? parsedStart : -Infinity, relativeStart);
  const end = Math.min(timestamps[timestamps.length - 1], Number.isFinite(parsedEnd) ? parsedEnd : Infinity);
  if (start > end) return empty;
  const size = start === end ? 1 : Math.max(1, Math.min(60, Math.floor(options.bucketCount ?? 30)));
  const width = (end - start) / size;
  const buckets = Array.from({ length: size }, (_, index) => ({ start: new Date(start + index * width).toISOString(), end: new Date(start + (index + 1) * width).toISOString(), count: 0 }));
  for (const timestamp of timestamps) if (timestamp >= start && timestamp <= end) buckets[width ? Math.min(size - 1, Math.floor((timestamp - start) / width)) : 0].count++;
  return { buckets, range: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }, invalidTimestamps, futureTimestamps };
}
