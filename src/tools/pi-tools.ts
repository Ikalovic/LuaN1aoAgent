import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compactExecutionEvents } from "../log-summary.js";
import {
  PROJECTOR_MAX_DELTA_EDGES,
  PROJECTOR_MAX_DELTA_NODES,
  validateProjectionDraftIntegrity,
  type ProjectionDraftValidationOptions,
  type ProjectorGraphRefRegistry
} from "../projection.js";
import type { ArtifactStore } from "../stores/artifact-store.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import type { SQLiteGraphStore } from "../stores/graph-store.js";
import type { ArtifactRecord, GraphEdge, GraphNode, GraphSnapshot, GraphView } from "../types.js";

export const GRAPH_TOOL_MAX_OUTPUT_BYTES = 10_000;
const GraphNodeCommonProperties = {
  id: Type.String({ minLength: 1, maxLength: 256 }),
  label: Type.String({ minLength: 1 }),
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  evidenceRefs: Type.Optional(Type.Array(Type.String()))
};

const ProjectorGraphNodeCommonProperties = {
  ...GraphNodeCommonProperties,
  id: Type.String({ pattern: "^(existing|new):[1-9][0-9]*$", maxLength: 32 })
};

// graphKind/type vocabulary and unexpected keys are rejected by
// validateProjectionDraftIntegrity with actionable messages; the wire schema
// only checks field shapes so model mistakes get precise feedback.
const ProjectorGraphNodeSchema = Type.Object({
  ...ProjectorGraphNodeCommonProperties,
  graphKind: Type.String({ minLength: 1, maxLength: 32 }),
  type: Type.String({ minLength: 1, maxLength: 64 })
});

const ProjectorGraphEdgeSchema = Type.Object({
  from: Type.String({ pattern: "^(existing|new):[1-9][0-9]*$", maxLength: 32 }),
  to: Type.String({ pattern: "^(existing|new):[1-9][0-9]*$", maxLength: 32 }),
  type: Type.String({ minLength: 1, maxLength: 64 }),
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  evidenceRefs: Type.Optional(Type.Array(Type.String()))
});

const PlannerTaskIdSchema = Type.String({ pattern: "^task:.+", minLength: 6, maxLength: 256 });
const PlannerNodeIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const PlannerRefArraySchema = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 });
const PlannerCommandBasisProperties = {
  basedOnRefs: Type.Optional(PlannerRefArraySchema),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 }))
};
const PlannerTaskBudgetSchema = Type.Object({
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 }))
}, { additionalProperties: false });
const PlannerTaskSpecSchema = Type.Object({
  id: PlannerTaskIdSchema,
  goal: Type.String({ minLength: 1, maxLength: 2_000 }),
  targetRefs: PlannerRefArraySchema,
  scopeRef: Type.String({ pattern: "^scope:.+", minLength: 7, maxLength: 256 }),
  constraints: Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 32 }),
  successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 32 }),
  budget: Type.Optional(PlannerTaskBudgetSchema),
  priority: Type.Number({ minimum: 1 }),
  parentTaskId: Type.Optional(Type.String({ pattern: "^(goal|task):.+", maxLength: 256 })),
  dependsOnTaskRefs: Type.Optional(Type.Array(PlannerTaskIdSchema, { maxItems: 32 })),
  parallelGroup: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
}, { additionalProperties: false });
const PlannerTaskPatchSchema = Type.Object({
  goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  constraints: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 32 })),
  successCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 32 })),
  budget: Type.Optional(PlannerTaskBudgetSchema),
  priority: Type.Optional(Type.Number({ minimum: 1 })),
  parallelGroup: Type.Optional(Type.String({ maxLength: 256 }))
}, { additionalProperties: false });
const PlannerTaskStatusSchema = Type.Union([
  Type.Literal("open"),
  Type.Literal("partial"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
  Type.Literal("archived")
]);
const PlannerCommandSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("create_tasks"),
    tasks: Type.Array(PlannerTaskSpecSchema, { minItems: 1, maxItems: 16 }),
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("patch_task"),
    taskId: PlannerTaskIdSchema,
    patch: PlannerTaskPatchSchema,
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("replace_dependencies"),
    taskId: PlannerTaskIdSchema,
    dependencyTaskIds: Type.Array(PlannerTaskIdSchema, { maxItems: 32 }),
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("set_task_status"),
    taskId: PlannerTaskIdSchema,
    status: PlannerTaskStatusSchema,
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("set_node_status"),
    nodeId: PlannerNodeIdSchema,
    status: Type.String({ minLength: 1, maxLength: 64 }),
    ...PlannerCommandBasisProperties
  }, { additionalProperties: false })
]);

export function createPlannerSubmitTool(input: {
  validate?: (value: unknown) => unknown | Promise<unknown>;
} = {}) {
  return defineTool({
    name: "planner_submit",
    label: "Submit Planner Decision",
    description: "Submit the final Planner decision using commands discriminated by the required kind field, then terminate this Planner invocation.",
    parameters: Type.Object({
      decision: Type.Union([Type.Literal("apply_commands")]),
      commands: Type.Optional(Type.Array(PlannerCommandSchema, { maxItems: 32 })),
      reason: Type.String({ minLength: 1, maxLength: 4_000 }),
      basedOnRefs: PlannerRefArraySchema
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      // validate may return a normalized replacement (e.g. abbreviated
      // Artifact Refs resolved to their full form); persist that version.
      const validated = await input.validate?.(params);
      return {
        content: [{ type: "text", text: "Planner decision submitted" }],
        details: validated ?? params,
        terminate: true
      };
    }
  });
}

export function createTaskResultSubmitTool() {
  return defineTool({
    name: "task_result_submit",
    label: "Submit Task Result",
    description: "Submit the final Executor epoch result and terminate this Executor invocation.",
    parameters: Type.Object({
      taskId: Type.String(),
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("partial"),
        Type.Literal("failed")
      ]),
      summary: Type.String(),
      evidenceRefs: Type.Array(Type.String()),
      artifactRefs: Type.Array(Type.String()),
      capabilityRefs: Type.Optional(Type.Array(Type.String())),
      blockerReason: Type.Optional(Type.String()),
      suggestedNextGoal: Type.Optional(Type.String()),
      checkpointReason: Type.Optional(Type.String()),
      retryable: Type.Optional(Type.Boolean())
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Task result submitted" }],
      details: params,
      terminate: true
    })
  });
}

export function createControlSubmitTool() {
  return defineTool({
    name: "control_submit",
    label: "Submit Control Signal",
    description: "Submit the final Supervisor control signal and terminate this Supervisor invocation.",
    parameters: Type.Object({
      decision: Type.Union([
        Type.Literal("continue"),
        Type.Literal("redirect"),
        Type.Literal("checkpoint"),
        Type.Literal("stop_executor"),
        Type.Literal("need_planner")
      ]),
      reason: Type.String(),
      evidenceRefs: Type.Array(Type.String()),
      confidence: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high")
      ])),
      guidance: Type.Optional(Type.String())
    }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Control signal submitted" }],
      details: params,
      terminate: true
    })
  });
}

export function createGraphDeltaSubmitTool(options: ProjectionDraftValidationOptions = {}) {
  return defineTool({
    name: "graph_delta_submit",
    label: "Submit Graph Delta",
    description: "Submit the final Projector GraphDelta and terminate this Projector invocation.",
    parameters: Type.Object({
      nodes: Type.Array(ProjectorGraphNodeSchema, { maxItems: PROJECTOR_MAX_DELTA_NODES }),
      edges: Type.Array(ProjectorGraphEdgeSchema, { maxItems: PROJECTOR_MAX_DELTA_EDGES })
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      validateProjectionDraftIntegrity(params, options);
      return {
        content: [{ type: "text", text: "Graph delta submitted atomically" }],
        details: params,
        terminate: true
      };
    }
  });
}

export function createGraphQueryTool(
  graphStore: SQLiteGraphStore,
  references?: ProjectorGraphRefRegistry,
  cache?: Map<string, string>,
  materials?: GraphToolMaterialsResolver
) {
  return defineTool({
    name: "graph_query",
    label: "Graph Query",
    description: "Read a byte-bounded closed tri-graph page when the initial view is insufficient. Returned edges always include both endpoint nodes; use nextCursor with unchanged arguments for continuation.",
    parameters: Type.Object({
      view: Type.Union([
        Type.Literal("planner"),
        Type.Literal("reasoning"),
        Type.Literal("operation"),
        Type.Literal("task"),
        Type.Literal("sessions")
      ]),
      focusNodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const cacheKey = `graph_query:${JSON.stringify(params)}`;
      const cached = cache?.get(cacheKey);
      if (cached !== undefined) {
        return { content: [{ type: "text", text: cached }], details: {} };
      }
      const focusNodeIds = params.focusNodeIds ?? [];
      const resolvedFocusNodeIds = references
        ? focusNodeIds.map((nodeId) => references.resolveNodeId(nodeId))
        : focusNodeIds;
      const snapshot = graphStore.query(params.view as GraphView, resolvedFocusNodeIds, params.limit);
      const text = renderBoundedGraphSnapshot(
          references?.aliasSnapshot(snapshot) ?? snapshot,
          {
            toolName: "graph_query",
            request: {
              view: params.view,
              focusNodeIds,
              limit: params.limit ?? 200
            },
            focusNodeIds,
            cursor: params.cursor,
            materialsByEvidenceRef: resolveGraphToolMaterials(materials, snapshot)
          }
        );
      cache?.set(cacheKey, text);
      return {
        content: [{ type: "text", text }],
        details: {}
      };
    }
  });
}

export function createGraphTraceTool(
  graphStore: SQLiteGraphStore,
  references?: ProjectorGraphRefRegistry,
  cache?: Map<string, string>,
  materials?: GraphToolMaterialsResolver
) {
  return defineTool({
    name: "graph_trace",
    label: "Graph Trace",
    description: "Trace one real graph reference through a byte-bounded closed graph page. Returned edges always include both endpoint nodes; use nextCursor with unchanged arguments for continuation.",
    parameters: Type.Object({
      ref: Type.String({ minLength: 1, maxLength: 256 }),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const cacheKey = `graph_trace:${JSON.stringify(params)}`;
      const cached = cache?.get(cacheKey);
      if (cached !== undefined) {
        return { content: [{ type: "text", text: cached }], details: {} };
      }
      const resolvedRef = references?.resolveNodeId(params.ref) ?? params.ref;
      const snapshot = graphStore.trace({ nodeId: resolvedRef });
      const text = renderBoundedGraphSnapshot(
          references?.aliasSnapshot(snapshot) ?? snapshot,
          {
            toolName: "graph_trace",
            request: {
              ref: params.ref
            },
            focusNodeIds: [params.ref],
            cursor: params.cursor,
            materialsByEvidenceRef: resolveGraphToolMaterials(materials, snapshot)
          }
        );
      cache?.set(cacheKey, text);
      return {
        content: [{ type: "text", text }],
        details: {}
      };
    }
  });
}

export function createGraphSearchTool(
  graphStore: SQLiteGraphStore,
  references?: ProjectorGraphRefRegistry,
  cache?: Map<string, string>,
  materials?: GraphToolMaterialsResolver
) {
  return defineTool({
    name: "graph_search",
    label: "Graph Search",
    description: "Search semantic nodes in a byte-bounded closed graph page. Returned edges always include both endpoint nodes; use nextCursor with unchanged arguments for continuation.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1_000 }),
      graphKind: Type.Optional(Type.Union([
        Type.Literal("operation"),
        Type.Literal("reasoning")
      ])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const cacheKey = `graph_search:${JSON.stringify(params)}`;
      const cached = cache?.get(cacheKey);
      if (cached !== undefined) {
        return { content: [{ type: "text", text: cached }], details: {} };
      }
      const snapshot = graphStore.searchSemanticNodes({
        query: references?.resolveSearchQuery(params.query) ?? params.query,
        graphKind: params.graphKind,
        limit: params.limit
      });
      const visibleSnapshot = references?.aliasSnapshot(snapshot) ?? snapshot;
      const text = renderBoundedGraphSnapshot(visibleSnapshot, {
        toolName: "graph_search",
        request: {
          query: params.query,
          graphKind: params.graphKind ?? null,
          limit: params.limit ?? 20
        },
        focusNodeIds: visibleSnapshot.nodes[0] ? [visibleSnapshot.nodes[0].id] : [],
        cursor: params.cursor,
        materialsByEvidenceRef: resolveGraphToolMaterials(materials, snapshot)
      });
      cache?.set(cacheKey, text);
      return {
        content: [{ type: "text", text }],
        details: {}
      };
    }
  });
}

type GraphToolNodeRecord = {
  id: string;
  graphKind: GraphNode["graphKind"];
  type: string;
  label: string;
  properties: Record<string, unknown>;
  evidenceRefs: string[];
  materialRefs?: string[];
  recordMeta?: Record<string, number>;
};

export type GraphToolMaterialsResolver = (evidenceRefs: string[]) => ReadonlyMap<string, string[]>;

const GRAPH_TOOL_MAX_MATERIAL_REFS_PER_NODE = 8;

function resolveGraphToolMaterials(
  resolver: GraphToolMaterialsResolver | undefined,
  snapshot: GraphSnapshot
): ReadonlyMap<string, string[]> | undefined {
  if (!resolver) {
    return undefined;
  }
  const evidenceRefs = [...new Set([
    ...snapshot.nodes.flatMap((node) => node.evidenceRefs ?? []),
    ...snapshot.edges.flatMap((edge) => edge.evidenceRefs ?? [])
  ])];
  if (evidenceRefs.length === 0) {
    return undefined;
  }
  const resolved = resolver(evidenceRefs);
  return resolved.size > 0 ? resolved : undefined;
}

function graphToolMaterialRefs(
  evidenceRefs: string[],
  materialsByEvidenceRef: ReadonlyMap<string, string[]>
): string[] {
  const materialRefs: string[] = [];
  for (const evidenceRef of evidenceRefs) {
    for (const materialRef of materialsByEvidenceRef.get(evidenceRef) ?? []) {
      if (!materialRefs.includes(materialRef)) {
        materialRefs.push(materialRef);
      }
      if (materialRefs.length >= GRAPH_TOOL_MAX_MATERIAL_REFS_PER_NODE) {
        return materialRefs;
      }
    }
  }
  return materialRefs;
}

type GraphToolEdgeRecord = {
  id?: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
  evidenceRefs: string[];
  recordMeta?: Record<string, number>;
};

type GraphPageUnit = {
  nodeIds: string[];
  edge?: GraphToolEdgeRecord;
};

const GRAPH_TOOL_IDENTITY_PROPERTY_KEYS = [
  "hostRef", "routeRef", "connectionRef", "sessionRef", "credentialRef", "artifactRef",
  "host", "hostname", "ip", "port", "protocol", "scheme", "url", "path", "method",
  "sessionId", "agentSessionId", "shellSessionId", "routeId", "tunnelId", "dialAddress",
  "targetCidrs", "username", "status"
];

export function renderBoundedGraphSnapshot(
  snapshot: GraphSnapshot,
  options: {
    toolName: "graph_query" | "graph_trace" | "graph_search";
    request: Record<string, unknown>;
    focusNodeIds?: string[];
    cursor?: string;
    maxBytes?: number;
    materialsByEvidenceRef?: ReadonlyMap<string, string[]>;
  }
): string {
  const maxBytes = Math.max(2_000, Math.floor(options.maxBytes ?? GRAPH_TOOL_MAX_OUTPUT_BYTES));
  const signature = graphToolRequestSignature(options.toolName, options.request);
  const sourceNodes = dedupeGraphToolNodes(snapshot.nodes);
  const sourceNodeIds = new Set(sourceNodes.map((node) => node.id));
  const sourceEdges = dedupeGraphToolEdges(snapshot.edges);
  const closedEdges = sourceEdges.filter((edge) => sourceNodeIds.has(edge.from) && sourceNodeIds.has(edge.to));
  const danglingSourceEdgeCount = sourceEdges.length - closedEdges.length;
  const compactNodes = new Map(sourceNodes.map((node) => [node.id, compactGraphToolNode(node)]));
  if (options.materialsByEvidenceRef) {
    for (const [nodeId, record] of compactNodes) {
      const materialRefs = graphToolMaterialRefs(record.evidenceRefs, options.materialsByEvidenceRef);
      if (materialRefs.length > 0) {
        compactNodes.set(nodeId, { ...record, materialRefs });
      }
    }
  }
  const compactEdges = closedEdges.map(compactGraphToolEdge);
  const requestedFocusIds = [...new Set(options.focusNodeIds ?? [])];
  const availableFocusIds = requestedFocusIds.filter((nodeId) => compactNodes.has(nodeId));
  const priorityNodeIds = availableFocusIds.length > 0
    ? availableFocusIds
    : sourceNodes[0]
      ? [sourceNodes[0].id]
      : [];
  const prioritySet = new Set(priorityNodeIds);
  const incidentEdges = compactEdges.filter((edge) => prioritySet.has(edge.from) || prioritySet.has(edge.to));
  const remainingEdges = compactEdges.filter((edge) => !prioritySet.has(edge.from) && !prioritySet.has(edge.to));
  const units: GraphPageUnit[] = [
    ...priorityNodeIds.map((nodeId) => ({ nodeIds: [nodeId] })),
    ...[...incidentEdges, ...remainingEdges].map((edge) => ({ nodeIds: [edge.from, edge.to], edge })),
    ...sourceNodes.filter((node) => !prioritySet.has(node.id)).map((node) => ({ nodeIds: [node.id] }))
  ];
  const startOffset = decodeGraphToolCursor(options.cursor, signature, units.length);
  let nextOffset = startOffset;
  let selectedNodes = new Map<string, GraphToolNodeRecord>();
  let selectedEdges = new Map<string, GraphToolEdgeRecord>();

  while (nextOffset < units.length) {
    const unit = units[nextOffset]!;
    const candidateNodes = new Map(selectedNodes);
    const candidateEdges = new Map(selectedEdges);
    for (const nodeId of unit.nodeIds) {
      const node = compactNodes.get(nodeId);
      if (node) candidateNodes.set(nodeId, node);
    }
    if (unit.edge) candidateEdges.set(graphToolEdgeKey(unit.edge), unit.edge);
    const candidateOffset = nextOffset + 1;
    const candidateText = serializeGraphToolPage({
      snapshot,
      signature,
      sourceNodes,
      sourceEdges,
      danglingSourceEdgeCount,
      requestedFocusIds,
      units,
      nextOffset: candidateOffset,
      selectedNodes: candidateNodes,
      selectedEdges: candidateEdges,
      maxBytes
    });
    if (Buffer.byteLength(candidateText, "utf8") > maxBytes) {
      break;
    }
    selectedNodes = candidateNodes;
    selectedEdges = candidateEdges;
    nextOffset = candidateOffset;
  }

  if (nextOffset === startOffset && nextOffset < units.length) {
    const unit = units[nextOffset]!;
    for (const nodeId of unit.nodeIds) {
      const node = compactNodes.get(nodeId);
      if (node) selectedNodes.set(nodeId, graphToolNodeIdentity(node));
    }
    if (unit.edge) selectedEdges.set(graphToolEdgeKey(unit.edge), graphToolEdgeIdentity(unit.edge));
    nextOffset += 1;
  }

  const text = serializeGraphToolPage({
    snapshot,
    signature,
    sourceNodes,
    sourceEdges,
    danglingSourceEdgeCount,
    requestedFocusIds,
    units,
    nextOffset,
    selectedNodes,
    selectedEdges,
    maxBytes
  });
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`Bounded graph page exceeded ${maxBytes} UTF-8 bytes`);
  }
  return text;
}

function serializeGraphToolPage(input: {
  snapshot: GraphSnapshot;
  signature: string;
  sourceNodes: GraphNode[];
  sourceEdges: GraphEdge[];
  danglingSourceEdgeCount: number;
  requestedFocusIds: string[];
  units: GraphPageUnit[];
  nextOffset: number;
  selectedNodes: Map<string, GraphToolNodeRecord>;
  selectedEdges: Map<string, GraphToolEdgeRecord>;
  maxBytes: number;
}): string {
  const nextCursor = input.nextOffset < input.units.length
    ? encodeGraphToolCursor(input.signature, input.nextOffset)
    : undefined;
  const page = {
    view: input.snapshot.view,
    nodes: [...input.selectedNodes.values()],
    edges: [...input.selectedEdges.values()],
    summary: compactGraphToolSummary(input.snapshot.summary),
    page: {
      byteLimit: input.maxBytes,
      sourceNodeCount: input.sourceNodes.length,
      sourceEdgeCount: input.sourceEdges.length,
      returnedNodeCount: input.selectedNodes.size,
      returnedEdgeCount: input.selectedEdges.size,
      omittedNodeCount: Math.max(0, input.sourceNodes.length - input.selectedNodes.size),
      omittedEdgeCount: Math.max(0, input.sourceEdges.length - input.selectedEdges.size),
      danglingSourceEdgeCount: input.danglingSourceEdgeCount,
      missingFocusNodeIds: input.requestedFocusIds.filter((nodeId) => !input.sourceNodes.some((node) => node.id === nodeId)),
      hasMore: Boolean(nextCursor),
      ...(nextCursor ? { nextCursor } : {})
    }
  };
  return JSON.stringify(page);
}

function graphToolRequestSignature(toolName: string, request: Record<string, unknown>): string {
  return createHash("sha256").update(`${toolName}\u0000${JSON.stringify(request)}`).digest("hex").slice(0, 20);
}

function encodeGraphToolCursor(signature: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, signature, offset }), "utf8").toString("base64url");
}

function decodeGraphToolCursor(cursor: string | undefined, signature: string, unitCount: number): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    const offset = Number(value.offset);
    if (value.version !== 1 || value.signature !== signature || !Number.isInteger(offset) || offset < 0 || offset > unitCount) {
      throw new Error("mismatch");
    }
    return offset;
  } catch {
    throw new Error("Invalid graph continuation cursor for these request arguments");
  }
}

function dedupeGraphToolNodes(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const node of nodes) byId.set(node.id, node);
  return [...byId.values()];
}

function dedupeGraphToolEdges(edges: GraphEdge[]): GraphEdge[] {
  const byKey = new Map<string, GraphEdge>();
  for (const edge of edges) byKey.set(graphToolEdgeKey(edge), edge);
  return [...byKey.values()];
}

function compactGraphToolNode(node: GraphNode): GraphToolNodeRecord {
  const sourceProperties = Object.entries(node.properties ?? {}).sort(([leftKey], [rightKey]) => (
    graphIdentityPropertyRank(leftKey) - graphIdentityPropertyRank(rightKey) || leftKey.localeCompare(rightKey)
  ));
  let properties: Record<string, unknown> = {};
  let omittedPropertyCount = 0;
  const base = {
    id: node.id,
    graphKind: node.graphKind,
    type: node.type,
    label: compactUtf8Prefix(node.label, 700),
    properties,
    evidenceRefs: [] as string[]
  };
  for (const [key, value] of sourceProperties) {
    const candidateProperties = { ...properties, [key]: compactGraphToolValue(value, 0) };
    if (Buffer.byteLength(JSON.stringify({ ...base, properties: candidateProperties }), "utf8") <= 2_300) {
      properties = candidateProperties;
    } else {
      omittedPropertyCount += 1;
    }
  }
  let evidenceRefs: string[] = [];
  let omittedEvidenceRefCount = 0;
  for (const evidenceRef of node.evidenceRefs ?? []) {
    const candidateEvidenceRefs = [...evidenceRefs, evidenceRef];
    if (Buffer.byteLength(JSON.stringify({ ...base, properties, evidenceRefs: candidateEvidenceRefs }), "utf8") <= 2_500) {
      evidenceRefs = candidateEvidenceRefs;
    } else {
      omittedEvidenceRefCount += 1;
    }
  }
  const recordMeta = omittedPropertyCount > 0 || omittedEvidenceRefCount > 0
    ? {
        sourcePropertyCount: sourceProperties.length,
        omittedPropertyCount,
        sourceEvidenceRefCount: node.evidenceRefs?.length ?? 0,
        omittedEvidenceRefCount
      }
    : undefined;
  return { ...base, properties, evidenceRefs, ...(recordMeta ? { recordMeta } : {}) };
}

function compactGraphToolEdge(edge: GraphEdge): GraphToolEdgeRecord {
  const sourceProperties = Object.entries(edge.properties ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  let properties: Record<string, unknown> = {};
  let omittedPropertyCount = 0;
  const base = {
    ...(edge.id ? { id: edge.id } : {}),
    from: edge.from,
    to: edge.to,
    type: edge.type,
    properties,
    evidenceRefs: [] as string[]
  };
  for (const [key, value] of sourceProperties) {
    const candidateProperties = { ...properties, [key]: compactGraphToolValue(value, 0) };
    if (Buffer.byteLength(JSON.stringify({ ...base, properties: candidateProperties }), "utf8") <= 1_100) {
      properties = candidateProperties;
    } else {
      omittedPropertyCount += 1;
    }
  }
  let evidenceRefs: string[] = [];
  let omittedEvidenceRefCount = 0;
  for (const evidenceRef of edge.evidenceRefs ?? []) {
    const candidateEvidenceRefs = [...evidenceRefs, evidenceRef];
    if (Buffer.byteLength(JSON.stringify({ ...base, properties, evidenceRefs: candidateEvidenceRefs }), "utf8") <= 1_300) {
      evidenceRefs = candidateEvidenceRefs;
    } else {
      omittedEvidenceRefCount += 1;
    }
  }
  const recordMeta = omittedPropertyCount > 0 || omittedEvidenceRefCount > 0
    ? {
        sourcePropertyCount: sourceProperties.length,
        omittedPropertyCount,
        sourceEvidenceRefCount: edge.evidenceRefs?.length ?? 0,
        omittedEvidenceRefCount
      }
    : undefined;
  return { ...base, properties, evidenceRefs, ...(recordMeta ? { recordMeta } : {}) };
}

function graphToolNodeIdentity(node: GraphToolNodeRecord): GraphToolNodeRecord {
  return {
    id: node.id,
    graphKind: node.graphKind,
    type: node.type,
    label: compactUtf8Prefix(node.label, 320),
    properties: Object.fromEntries(Object.entries(node.properties).filter(([key]) => graphIdentityPropertyRank(key) === 0)),
    evidenceRefs: node.evidenceRefs,
    recordMeta: {
      sourcePropertyCount: Object.keys(node.properties).length,
      omittedPropertyCount: Object.keys(node.properties).filter((key) => graphIdentityPropertyRank(key) !== 0).length,
      sourceEvidenceRefCount: node.evidenceRefs.length,
      omittedEvidenceRefCount: 0
    }
  };
}

function graphToolEdgeIdentity(edge: GraphToolEdgeRecord): GraphToolEdgeRecord {
  return {
    ...(edge.id ? { id: edge.id } : {}),
    from: edge.from,
    to: edge.to,
    type: edge.type,
    properties: {},
    evidenceRefs: edge.evidenceRefs,
    recordMeta: {
      sourcePropertyCount: Object.keys(edge.properties).length,
      omittedPropertyCount: Object.keys(edge.properties).length,
      sourceEvidenceRefCount: edge.evidenceRefs.length,
      omittedEvidenceRefCount: 0
    }
  };
}

function graphIdentityPropertyRank(key: string): number {
  return GRAPH_TOOL_IDENTITY_PROPERTY_KEYS.includes(key) ? 0 : 1;
}

function graphToolEdgeKey(edge: Pick<GraphEdge, "id" | "from" | "to" | "type" | "properties">): string {
  return edge.id ?? `${edge.from}\u0000${edge.type}\u0000${edge.to}\u0000${JSON.stringify(edge.properties ?? {})}`;
}

function compactGraphToolValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return compactUtf8Prefix(value, 700);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => compactGraphToolValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= 2) return compactUtf8Prefix(JSON.stringify(value), 700);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20)
      .map(([key, nestedValue]) => [key, compactGraphToolValue(nestedValue, depth + 1)]));
  }
  return String(value ?? "");
}

function compactGraphToolSummary(value: unknown): unknown {
  const compacted = compactGraphToolValue(value, 0);
  const serialized = JSON.stringify(compacted);
  if (Buffer.byteLength(serialized, "utf8") <= 1_200) return compacted;
  return {
    preview: compactUtf8Prefix(serialized, 1_100),
    truncated: true
  };
}

function compactUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "...[truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let prefix = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > budget) break;
    prefix += character;
    usedBytes += characterBytes;
  }
  return `${prefix}${suffix}`;
}

export function createLogWindowTool(
  executionLog: ExecutionLog,
  options: { maxLimit?: number; allowFull?: boolean } = {}
) {
  return defineTool({
    name: "log_window",
    label: "Log Window",
    description: "Read a bounded execution log window for Observer projection.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      cursor: Type.Optional(Type.String()),
      limit: Type.Number(),
      eventTypes: Type.Optional(Type.Array(Type.String())),
      roles: Type.Optional(Type.Array(Type.String())),
      mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("full")]))
    }),
    execute: async (_toolCallId, params) => {
      const limit = Math.min(params.limit, options.maxLimit ?? params.limit);
      const window = await executionLog.window({
        ...params,
        limit,
        roles: (params.roles as Array<"planner" | "executor" | "observer" | "runtime"> | undefined) ?? ["executor", "runtime"]
      });
      const mode = options.allowFull === false ? "summary" : params.mode ?? "summary";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...window,
            mode,
            requestedMode: params.mode ?? "summary",
            requestedLimit: params.limit,
            effectiveLimit: limit,
            events: mode === "full" ? window.events : compactExecutionEvents(window.events)
          }, null, 2)
        }],
        details: {}
      };
    }
  });
}

export function createArtifactReadTool(
  artifactStore: ArtifactStore,
  options: {
    maxReadBytes?: number;
    workspace?: { hostDir: string; visibleRoot: string; sharedWithContainer?: boolean };
  } = {}
) {
  return defineTool({
    name: "artifact_read",
    label: "Artifact Read",
    description: "Read a bounded artifact range by artifact ref, or explicitly materialize the complete artifact into the persistent workspace.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      length: Type.Optional(Type.Number()),
      materialize: Type.Optional(Type.Boolean())
    }),
    execute: async (_toolCallId, params) => {
      if (!params.path.startsWith("artifact:")) {
        throw new Error("artifact_read requires a real artifactRef");
      }
      // Models habitually truncate Refs (like git short hashes); accept an
      // unambiguous prefix and resolve it to the canonical full Ref.
      const artifactRef = await resolveArtifactRef(artifactStore, params.path);
      if (params.materialize) {
        if (!options.workspace) {
          throw new Error("Artifact materialization requires an Executor workspace");
        }
        if (params.offset !== undefined || params.length !== undefined) {
          throw new Error("Artifact materialization always imports the complete artifact; offset and length are not allowed");
        }
        const materialized = await materializeArtifactIntoWorkspace(
          artifactStore,
          artifactRef,
          options.workspace
        );
        return {
          content: [{ type: "text", text: JSON.stringify(materialized, null, 2) }],
          details: materialized
        };
      }
      return {
        content: [{
          type: "text",
          text: await artifactStore.read(artifactRef, {
            offset: params.offset,
            length: Math.min(params.length ?? options.maxReadBytes ?? Number.MAX_SAFE_INTEGER, options.maxReadBytes ?? Number.MAX_SAFE_INTEGER)
          })
        }],
        details: {}
      };
    }
  });
}

async function resolveArtifactRef(artifactStore: ArtifactStore, artifactRef: string): Promise<string> {
  const exact = await artifactStore.get(artifactRef);
  if (exact) return exact.artifactRef;
  const matches = (await artifactStore.list())
    .map((record) => record.artifactRef)
    .filter((candidate) => candidate.startsWith(artifactRef));
  if (matches.length === 1) return matches[0];
  throw new Error(
    matches.length > 1
      ? `Artifact Ref ${artifactRef} is ambiguous (candidates: ${matches.slice(0, 3).join(", ")}); use the exact full Ref`
      : `Artifact not found: ${artifactRef}`
  );
}

async function materializeArtifactIntoWorkspace(
  artifactStore: ArtifactStore,
  artifactRef: string,
  workspace: { hostDir: string; visibleRoot: string; sharedWithContainer?: boolean }
): Promise<{
  artifactRef: string;
  path: string;
  mediaType: string;
  byteLength: number;
  contentHash?: string;
}> {
  const record = await artifactStore.get(artifactRef);
  if (!record) {
    throw new Error(`Artifact not found: ${artifactRef}`);
  }
  const workspaceDirectory = resolve(workspace.hostDir);
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
  const [workspaceMetadata, canonicalWorkspaceDirectory] = await Promise.all([
    lstat(workspaceDirectory),
    realpath(workspaceDirectory)
  ]);
  if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
    throw new Error("Executor workspace must be a real directory");
  }
  const directory = join(canonicalWorkspaceDirectory, ".artifacts");
  const directoryMode = workspace.sharedWithContainer ? 0o755 : 0o700;
  const fileMode = workspace.sharedWithContainer ? 0o644 : 0o600;
  await mkdir(directory, { recursive: true, mode: directoryMode });
  const [metadata, canonicalDirectory] = await Promise.all([lstat(directory), realpath(directory)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonicalDirectory !== directory) {
    throw new Error("Executor workspace artifact directory must be a real directory");
  }
  await chmod(canonicalDirectory, directoryMode);
  const filename = basename(record.path);
  const destination = join(canonicalDirectory, filename);
  const temporary = join(canonicalDirectory, `.${filename}.${randomUUID()}.tmp`);
  try {
    await copyFile(record.path, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, fileMode);
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return {
    artifactRef: record.artifactRef,
    path: join(workspace.visibleRoot, ".artifacts", filename),
    mediaType: record.mediaType,
    byteLength: record.byteLength,
    contentHash: record.contentHash
  };
}

type ExecutorArtifactWorkspace = {
  hostDir: string;
  visibleRoot: string;
};

export function createArtifactWriteTool(
  artifactStore: ArtifactStore,
  options: {
    workspace?: ExecutorArtifactWorkspace;
    readExecutorFile?: (visiblePath: string) => Promise<Buffer>;
  } = {}
) {
  return defineTool({
    name: "artifact_write",
    label: "Artifact Write",
    description: "Persist inline data or import a complete file from the Executor sandbox (for example /workspace or /tmp). Pass exactly one payload: source={data:\"...\"} for inline text or source={path\":\"/workspace/file\"} for a sandbox file; the optional source.type (\"inline\"|\"file\") is inferred from data/path when omitted.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String()),
      kind: Type.Union([
        Type.Literal("http_body"),
        Type.Literal("screenshot"),
        Type.Literal("stdout"),
        Type.Literal("stderr"),
        Type.Literal("poc"),
        Type.Literal("json"),
        Type.Literal("text"),
        Type.Literal("other")
      ]),
      mediaType: Type.String(),
      source: Type.Object({
        type: Type.Optional(Type.Union([
          Type.Literal("inline"),
          Type.Literal("file")
        ])),
        data: Type.Optional(Type.String()),
        path: Type.Optional(Type.String())
      }, { additionalProperties: false }),
      extension: Type.Optional(Type.String())
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const data = params.source.data;
      const path = params.source.path;
      const sourceType = params.source.type ?? (data !== undefined ? "inline" : "file");
      let record: ArtifactRecord;
      if (sourceType === "file") {
        if (path === undefined || data !== undefined) {
          throw new Error("artifact_write file source requires exactly path (no data); use source={path:\"/workspace/file\"} or source={type:\"file\",path:\"...\"}");
        }
        record = options.readExecutorFile
          ? await artifactStore.write({
              taskId: params.taskId,
              kind: params.kind as ArtifactRecord["kind"],
              mediaType: params.mediaType,
              data: await options.readExecutorFile(path),
              extension: params.extension ?? extensionFromPath(path)
            })
          : await artifactStore.importFile({
              taskId: params.taskId,
              kind: params.kind as ArtifactRecord["kind"],
              mediaType: params.mediaType,
              sourcePath: await resolveExecutorWorkspaceFile(path, options.workspace),
              extension: params.extension
            });
      } else {
        if (data === undefined || path !== undefined) {
          throw new Error("artifact_write inline source requires exactly data (no path); use source={data:\"...\"} or source={type:\"inline\",data:\"...\"}");
        }
        record = await artifactStore.write({
          taskId: params.taskId,
          kind: params.kind as ArtifactRecord["kind"],
          mediaType: params.mediaType,
          data,
          extension: params.extension
        });
      }
      const publicRecord = publicArtifactRecord(record);
      return {
        content: [{ type: "text", text: JSON.stringify(publicRecord, null, 2) }],
        details: publicRecord
      };
    }
  });
}

async function resolveExecutorWorkspaceFile(
  requestedPath: string,
  workspace: ExecutorArtifactWorkspace | undefined
): Promise<string> {
  if (!workspace) {
    throw new Error("Artifact file import requires an Executor workspace");
  }
  const visibleRoot = resolve(workspace.visibleRoot);
  const visiblePath = resolve(visibleRoot, isAbsolute(requestedPath)
    ? relative(visibleRoot, requestedPath)
    : requestedPath);
  const visibleRelativePath = relative(visibleRoot, visiblePath);
  if (
    visibleRelativePath === ""
    || visibleRelativePath === ".."
    || visibleRelativePath.startsWith(`..${sep}`)
    || isAbsolute(visibleRelativePath)
  ) {
    throw new Error(`Artifact source is outside the Executor workspace: ${requestedPath}`);
  }
  const workspaceDirectory = await realpath(resolve(workspace.hostDir));
  const candidate = join(workspaceDirectory, visibleRelativePath);
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Artifact source must be a regular workspace file");
  }
  const canonicalCandidate = await realpath(candidate);
  const canonicalRelativePath = relative(workspaceDirectory, canonicalCandidate);
  if (
    canonicalRelativePath === ".."
    || canonicalRelativePath.startsWith(`..${sep}`)
    || isAbsolute(canonicalRelativePath)
  ) {
    throw new Error(`Artifact source resolves outside the Executor workspace: ${requestedPath}`);
  }
  return canonicalCandidate;
}

function publicArtifactRecord(record: ArtifactRecord): Omit<ArtifactRecord, "path"> {
  const { path: _hostPath, ...publicRecord } = record;
  return publicRecord;
}

function extensionFromPath(filePath: string): string | undefined {
  const extension = extname(filePath).slice(1);
  return extension || undefined;
}
