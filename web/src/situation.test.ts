import { describe, expect, it } from "vitest";
import { bucketActivity, buildSituation, projectGraph } from "./situation";
import type { GraphNode, RuntimeState } from "./types";

const node = (id: string, type: string, properties = {}, evidenceRefs: string[] = []): GraphNode => ({
  id, type, graphKind: ["Host", "Service", "WebEndpoint"].includes(type) ? "operation" : type === "Task" ? "task" : "reasoning",
  label: id, properties, evidenceRefs
});
const state = (nodes: GraphNode[], edges: RuntimeState["graph"]["edges"] = []): RuntimeState => ({
  graph: { nodes, edges, source: "sqlite", summary: {} }, events: [], artifacts: { records: [] },
  reports: { taskOutcomes: [], epochOutcomes: [] }
} as unknown as RuntimeState);

describe("situation statistics", () => {
  it("distinguishes missing, legacy loaded, unavailable, and known empty collections", () => {
    expect(buildSituation().assets.hosts.value).toBeNull();
    expect(buildSituation(state([])).assets.hosts).toMatchObject({ value: 0, state: "unknown" });
    const input = state([]);
    input.coverage = { nodes: { source: "sqlite", state: "complete", returned: 0, limit: 1200, truncated: false, skippedRecords: 0 } } as RuntimeState["coverage"];
    expect(buildSituation(input).assets.hosts).toMatchObject({ value: 0, state: "complete" });
    input.coverage!.nodes.state = "unavailable";
    expect(buildSituation(input).assets.hosts.value).toBeNull();
    const unavailable = state([]);
    unavailable.graph.source = "unavailable";
    expect(buildSituation(unavailable).assets.hosts.value).toBeNull();
  });
  it("deduplicates IDs, separates asset types, and only calls explicit validation verified", () => {
    const input = state([node("h", "Host"), node("h", "Host"), node("s", "Service", { validationStatus: "verified" }),
      node("w", "WebEndpoint", { classification: "candidate_only", validationStatus: "verified" }),
      node("p", "Host", { validationStatus: "pending" }), node("u", "Host", { validationStatus: "unexpected" })]);
    const result = buildSituation(input);
    expect(result.assets.hosts.value).toBe(3);
    expect(result.assets.services.value).toBe(1);
    expect(result.assets.webEndpoints.value).toBe(1);
    expect(result.assets.candidates.value).toBe(2);
    expect(result.assets.verified.value).toBe(1);
    expect(result.assets.unknown.value).toBe(2);
  });
  it("recognizes the runtime's validated status and exposes canonical hypothesis states", () => {
    const result = buildSituation(state([node("h", "Host", { validationStatus: "validated" })]));
    expect(result.assets.verified.value).toBe(1);
    expect(result.findings.hypotheses.byStatus.inconclusive.value).toBe(0);
  });
  it("counts only grounded vulnerabilities and successful grounded exploits; retains all findings", () => {
    const result = buildSituation(state([node("v", "Vulnerability", {}, ["event:1"]),
      node("missing", "Vulnerability", { evidenceRefs: ["nested"] }), node("blank", "Vulnerability", {}, [" "]),
      node("e", "Exploit", { status: "succeeded" }, ["a"]), node("ef", "Exploit", { status: "failed" }, ["a"]),
      node("em", "Exploit", { status: "succeeded" }), node("hyp", "Hypothesis", { status: "confirmed" }, ["a"])]));
    expect(result.findings.vulnerabilities.value).toBe(1);
    expect(result.findings.exploits.value).toBe(1);
    expect(result.findings.all).toHaveLength(7);
    expect(result.findings.missingEvidence.value).toBe(3);
    expect(result.findings.hypotheses.byStatus.confirmed.value).toBe(1);
  });
  it("uses all task nodes and includes unknown states in nonarchived completion denominator", () => {
    const tasks = Array.from({ length: 35 }, (_, i) => node(`t${i}`, "Task", { status: "completed" }));
    const result = buildSituation(state([...tasks, node("a", "Task", { status: "archived" }), node("u", "Task"), node("x", "Task", { status: "strange" })]));
    expect(result.tasks.all).toHaveLength(38);
    expect(result.tasks.byStatus.unknown.value).toBe(2);
    expect(result.tasks.denominator).toBe(37);
    expect(result.tasks.completion).toBeCloseTo(35 / 37);
    expect(buildSituation(state([])).tasks.completion).toBeNull();
    expect(buildSituation(state([node("a", "Task", { status: "archived" })])).tasks.completion).toBeNull();
  });
});

it("bounds graph projection and prioritizes selected and explicitly linked assets with deterministic order", () => {
  const nodes: GraphNode[] = Array.from({ length: 80 }, (_, i) => ({ ...node(`h${String(i).padStart(2, "0")}`, "Host"), updatedAt: "2026-01-01" }));
  nodes.push(node("finding", "Vulnerability", {}, ["a"]));
  const edges: RuntimeState["graph"]["edges"] = [{ id: "link", from: "finding", to: "h79", type: "affects", properties: {}, evidenceRefs: [] },
    ...nodes.slice(0, 79).map((n, i) => ({ id: `edge${i}`, from: n.id, to: nodes[i + 1].id, type: "relates", properties: {}, evidenceRefs: [] }))];
  const result = projectGraph(buildSituation(state(nodes, edges)), { selectedId: "h78", maxNodes: 100, maxEdges: 200 });
  expect(result.nodes).toHaveLength(60);
  expect(result.nodes[0].id).toBe("h78");
  expect(result.nodes.slice(0, 4).map((n) => n.id)).toContain("h79");
  expect(result.edges.length).toBeLessThanOrEqual(120);
  expect(result.edges.every((e) => result.nodes.some((n) => n.id === e.from) && result.nodes.some((n) => n.id === e.to))).toBe(true);
  expect(result.edges.every((e) => edges.includes(e))).toBe(true);
  expect(projectGraph(buildSituation(state([...nodes].reverse(), edges)), { selectedId: "h78" }).nodes).toEqual(result.nodes);
});

it("buckets valid events only within the loaded timestamp range and clamps custom filters", () => {
  const events = [{ timestamp: "2026-01-01T02:00:00Z" }, { timestamp: "bad" }, { timestamp: "2026-01-01T01:00:00Z" }];
  const result = bucketActivity(events, { start: "2025-01-01", end: "2027-01-01", bucketCount: 100 });
  expect(result.buckets.length).toBeLessThanOrEqual(60);
  expect(result.range).toEqual({ start: "2026-01-01T01:00:00.000Z", end: "2026-01-01T02:00:00.000Z" });
  expect(result.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(2);
  expect(result.invalidTimestamps).toBe(1);
  expect(bucketActivity(events, { start: "2027-01-01" }).buckets).toEqual([]);
  expect(bucketActivity([]).range).toBeNull();
});

it("projects graph kinds separately while keeping dense real edges bounded", () => {
  const nodes = Array.from({ length: 20 }, (_, i) => node(`h${i}`, "Host"));
  nodes.push(node("v", "Vulnerability"), node("t", "Task"));
  const edges = nodes.flatMap((from) => nodes.map((to) => ({ from: from.id, to: to.id, type: "related", properties: {}, evidenceRefs: [] })));
  const input = buildSituation(state(nodes, edges));
  expect(projectGraph(input).nodes.every((n) => n.graphKind === "operation")).toBe(true);
  expect(projectGraph(input).edges).toHaveLength(120);
  expect(projectGraph(input, { kind: "reasoning" }).nodes.map((n) => n.id)).toEqual(["v"]);
  expect(projectGraph(input, { kind: "task" }).nodes.map((n) => n.id)).toEqual(["t"]);
});

it("uses an explicit snapshot time to exclude future events and bound relative activity windows", () => {
  const events = [{ timestamp: "2026-01-01T00:00:00Z" }, { timestamp: "2026-01-01T01:00:00Z" }, { timestamp: "2026-01-02T00:00:00Z" }];
  const result = bucketActivity(events, { now: "2026-01-01T02:00:00Z", relativeMs: 90 * 60_000 });
  expect(result.futureTimestamps).toBe(1);
  expect(result.range).toEqual({ start: "2026-01-01T00:30:00.000Z", end: "2026-01-01T01:00:00.000Z" });
  expect(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
});

it("flags missing evidence only for graph-store claims that require it", () => {
  const findings = [node("open", "Hypothesis", { status: "open" }), node("inconclusive", "Hypothesis", { status: "inconclusive" }),
    node("failed", "Exploit", { status: "failed" }), node("v", "Vulnerability"), node("succeeded", "Exploit", { status: "succeeded" }),
    node("refuted", "Hypothesis", { status: "refuted" })];
  expect(buildSituation(state(findings)).findings.missingEvidence.value).toBe(3);
  expect(buildSituation(state(findings)).findings.all).toHaveLength(6);
});

it("keeps selected adjacency ahead of newer edges and sorts anonymous edges deterministically", () => {
  const nodes = [node("a", "Host"), node("b", "Host"), node("c", "Host")];
  const edges = [
    { from: "b", to: "c", type: "z", properties: {}, evidenceRefs: [], updatedAt: "2026-02-01" },
    { from: "a", to: "c", type: "z", properties: {}, evidenceRefs: [], updatedAt: "2026-01-01" },
    { from: "a", to: "b", type: "z", properties: {}, evidenceRefs: [], updatedAt: "2026-01-01" }
  ];
  const expected = projectGraph({ nodes, edges }, { selectedId: "a", maxEdges: 1 });
  expect(expected.edges).toEqual([edges[2]]);
  expect(projectGraph({ nodes, edges: [...edges].reverse() }, { selectedId: "a", maxEdges: 1 }).edges).toEqual(expected.edges);
});

it("reports globally unloaded endpoints separately from kind-specific projection omissions", () => {
  const nodes = [node("a", "Host"), node("b", "Host"), node("c", "Host"), node("v", "Vulnerability")];
  const edges = [
    { from: "a", to: "b", type: "relates", properties: {}, evidenceRefs: [] },
    { from: "b", to: "c", type: "relates", properties: {}, evidenceRefs: [] },
    { from: "a", to: "missing", type: "relates", properties: {}, evidenceRefs: [] },
    { from: "v", to: "missing", type: "relates", properties: {}, evidenceRefs: [] }
  ];
  expect(projectGraph({ nodes, edges }, { maxEdges: 1 })).toMatchObject({ unloadedEdges: 2, omittedEdges: 1 });
  expect(projectGraph({ nodes, edges }, { kind: "reasoning" })).toMatchObject({ unloadedEdges: 2, omittedEdges: 0 });
});
