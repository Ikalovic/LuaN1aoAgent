import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PROJECTION_ALL_NODE_TYPES,
  PROJECTION_EDGE_TYPES,
  normalizeProjectionDraft,
  type ProjectionDraftValidationOptions,
  type ProjectorGraphRefRegistry
} from "../projection.js";
import type { ArtifactStore } from "../stores/artifact-store.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import type { SQLiteGraphStore } from "../stores/graph-store.js";
import type { ArtifactRecord, ExecutionEvent, GraphEdge, GraphNode, GraphSnapshot, GraphView } from "../types.js";

export const GRAPH_TOOL_MAX_OUTPUT_BYTES = 10_000;
export const EVIDENCE_TOOL_DEFAULT_READ_BYTES = 12_000;
const GraphNodeCommonProperties = {
  id: Type.String({ minLength: 1, maxLength: 256 }),
  label: Type.String({ minLength: 1 }),
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  evidenceRefs: Type.Optional(Type.Array(Type.String()))
};

const ProjectorGraphNodeUpdateProperties = {
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: "Node metadata including status, target, description and severity."
  })),
  evidenceRefs: Type.Optional(Type.Array(Type.String())),
  artifactRef: Type.Optional(Type.String({ pattern: "^artifact:.+" })),
  artifactRefs: Type.Optional(Type.Array(Type.String({ pattern: "^artifact:.+" })))
};

const ProjectorGraphRefSchema = Type.String({ pattern: "^(existing|new):[1-9][0-9]*$", maxLength: 32 });

const ProjectorCreateNodeOperationSchema = Type.Object({
  op: Type.Literal("create_node"),
  ref: Type.String({ pattern: "^new:[1-9][0-9]*$", maxLength: 32 }),
  type: Type.Union(PROJECTION_ALL_NODE_TYPES.map((type) => Type.Literal(type))),
  label: Type.String({ minLength: 1, maxLength: 500 }),
  ...ProjectorGraphNodeUpdateProperties
}, { additionalProperties: false });

const ProjectorUpdateNodeOperationSchema = Type.Object({
  op: Type.Literal("update_node"),
  ref: ProjectorGraphRefSchema,
  ...ProjectorGraphNodeUpdateProperties
}, { additionalProperties: false });

const ProjectorCreateEdgeOperationSchema = Type.Object({
  op: Type.Literal("create_edge"),
  from: ProjectorGraphRefSchema,
  to: ProjectorGraphRefSchema,
  type: Type.Union(PROJECTION_EDGE_TYPES.map((type) => Type.Literal(type))),
  properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  evidenceRefs: Type.Optional(Type.Array(Type.String()))
}, { additionalProperties: false });

const PlannerTaskIdSchema = Type.String({ pattern: "^task:.+", minLength: 6, maxLength: 256 });
const PlannerRefArraySchema = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 });
const PlannerCommandBasisProperties = {
  basedOnRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
    maxItems: 32,
    description: "Persisted references supporting this specific graph command."
  }))
};
const PlannerTaskBudgetSchema = Type.Object({
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 }))
}, { additionalProperties: false });
const PlannerTaskGoalAdditionSchema = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 2_000 }),
  successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
    minItems: 1,
    maxItems: 32
  })
}, { additionalProperties: false });
const PlannerTaskSpecSchema = Type.Object({
  id: PlannerTaskIdSchema,
  goal: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "A decidable question or result for this Task. It may be technically specific without prescribing the Executor's only method."
  }),
  targetRefs: PlannerRefArraySchema,
  scopeRef: Type.String({ pattern: "^scope:.+", minLength: 7, maxLength: 256 }),
  successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), {
    minItems: 1,
    maxItems: 32,
    description: "Observable signals that establish the Task result, not a mandatory sequence of actions."
  }),
  budget: Type.Optional(PlannerTaskBudgetSchema),
  priority: Type.Number({ minimum: 1 }),
  parentTaskId: Type.Optional(Type.String({ pattern: "^(goal|task):.+", maxLength: 256 })),
  dependsOnTaskRefs: Type.Optional(Type.Array(PlannerTaskIdSchema, { maxItems: 32 })),
  continueFromTaskRef: Type.Optional(Type.String({
    pattern: "^task:.+",
    minLength: 6,
    maxLength: 256,
    description: "Completed direct dependency whose Executor session and workspace should move to this sequential successor. Omit for independent or parallel work."
  }))
}, { additionalProperties: false });
const PlannerTaskPatchSchema = Type.Object({
  additionalTurns: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 40,
    description: "Turns to add to this Task's cumulative maxTurns. This is an increment, not the new total."
  })),
  priority: Type.Optional(Type.Number({ minimum: 1 })),
  appendObjectives: Type.Optional(Type.Array(PlannerTaskGoalAdditionSchema, {
    minItems: 1,
    maxItems: 16,
    description: "Append newly discovered results and their observable completion criteria without replacing the original Task goal."
  }))
}, { additionalProperties: false });
const PlannerTaskStatusSchema = Type.Union([
  Type.Literal("open"),
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
    nodeId: Type.String({
      minLength: 1,
      maxLength: 256,
      description: "Non-Task planning node id. Never use task:*; Task lifecycle uses set_task_status."
    }),
    status: Type.String({
      minLength: 1,
      maxLength: 64,
      description: "Status for a non-Task planning node, not an Executor progress label."
    }),
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
      commands: Type.Optional(Type.Array(PlannerCommandSchema, { maxItems: 32 })),
      reason: Type.String({ minLength: 1, maxLength: 4_000 })
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

export function createScopeSubmitTool() {
  return defineTool({
    name: "scope_submit",
    label: "Submit Authorized Scope",
    description: "Submit only the explicit IPv4 addresses and CIDRs found in the user's Goal, then terminate scope extraction.",
    parameters: Type.Object({
      cidrs: Type.Array(Type.String({ minLength: 3, maxLength: 18 }), { minItems: 1, maxItems: 64 })
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Authorized scope submitted" }],
      details: params,
      terminate: true
    })
  });
}

export function createScopeDocumentSubmitTool() {
  return defineTool({
    name: "scope_document_submit",
    label: "Submit Document Scope Candidates",
    description: "Submit only literal domain, IPv4, and CIDR candidates with the exact source fragment index, then terminate.",
    parameters: Type.Object({
      candidates: Type.Array(Type.Object({
        value: Type.String({ minLength: 3, maxLength: 253 }),
        fragmentIndex: Type.Integer({ minimum: 0 })
      }, { additionalProperties: false }), { maxItems: 256 })
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Document scope candidates submitted" }],
      details: params,
      terminate: true
    })
  });
}

export function createTaskResultSubmitTool() {
  return defineTool({
    name: "task_result_submit",
    label: "Submit Task Result",
    description: "Submit the final Executor epoch result and terminate this Executor invocation. A completed result must omit blockerReason and checkpointReason and must not set retryable=true.",
    parameters: Type.Object({
      taskId: Type.String(),
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("partial"),
        Type.Literal("blocked"),
        Type.Literal("failed")
      ]),
      summary: Type.String(),
      evidenceRefs: Type.Array(Type.String()),
      artifactRefs: Type.Array(Type.String()),
      capabilityRefs: Type.Optional(Type.Array(Type.String())),
      blockerReason: Type.Optional(Type.String({
        description: "The exact unresolved condition or last failed boundary that prevents completion."
      })),
      suggestedNextGoal: Type.Optional(Type.String()),
      checkpointReason: Type.Optional(Type.String()),
      retryable: Type.Optional(Type.Boolean())
    }, { additionalProperties: false }),
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
        Type.Literal("handoff"),
        Type.Literal("stop_executor")
      ]),
      reason: Type.String(),
      evidenceRefs: Type.Array(Type.String()),
      guidance: Type.Optional(Type.String())
    }, { additionalProperties: false }),
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
    description: "Submit one complete semantic change set and terminate this invocation. Use create_node for new identities, update_node for existing metadata, and create_edge for relations. Validation rejects the entire draft.",
    parameters: Type.Object({
      changes: Type.Optional(Type.Array(Type.Union([
        ProjectorCreateNodeOperationSchema,
        ProjectorUpdateNodeOperationSchema,
        ProjectorCreateEdgeOperationSchema
      ])))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const nodes: Array<Record<string, unknown>> = [];
      const edges: Array<Record<string, unknown>> = [];
      for (const change of params.changes ?? []) {
        if (change.op === "create_edge") {
          const { op: _op, ...edge } = change;
          edges.push(edge);
          continue;
        }
        const { op: _op, ref, ...node } = change;
        nodes.push({ id: ref, ...node });
      }
      const draft = normalizeProjectionDraft({ nodes, edges }, options);
      return {
        content: [{ type: "text", text: "Graph delta draft accepted; graph transaction commit is pending" }],
        details: draft,
        terminate: true
      };
    }
  });
}

export function createGraphQueryTool(
  graphStore: SQLiteGraphStore,
  references?: ProjectorGraphRefRegistry,
  cache?: Map<string, string>,
  materials?: GraphToolMaterialsResolver,
  description?: string
) {
  const viewSchema = references
    ? Type.Union([
      Type.Literal("reasoning"),
      Type.Literal("operation"),
      Type.Literal("sessions")
    ])
    : Type.Union([
      Type.Literal("planner"),
      Type.Literal("reasoning"),
      Type.Literal("operation"),
      Type.Literal("task"),
      Type.Literal("sessions")
    ]);
  return defineTool({
    name: "graph_query",
    label: "Graph Query",
    description: description ?? "Read a byte-bounded closed tri-graph page when the initial view is insufficient. Returned edges always include both endpoint nodes; use nextCursor with unchanged arguments for continuation.",
    parameters: Type.Object({
      view: viewSchema,
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
  materials?: GraphToolMaterialsResolver,
  description?: string
) {
  return defineTool({
    name: "graph_trace",
    label: "Graph Trace",
    description: description ?? "Trace one real graph reference through a byte-bounded closed graph page. Returned edges always include both endpoint nodes; use nextCursor with unchanged arguments for continuation.",
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

type EvidenceToolOptions = {
  allowedTaskIds?: ReadonlySet<string>;
  maxListLimit?: number;
  maxReadBytes?: number;
  description?: string;
};

export function createEvidenceListTool(
  executionLog: ExecutionLog,
  options: EvidenceToolOptions = {}
) {
  const allowedTaskIds = options.allowedTaskIds;
  return defineTool({
    name: "evidence_list",
    label: "Evidence List",
    description: options.description ?? "List an authorized Task's persisted observations as a mechanical index without semantic ranking.",
    parameters: Type.Object({
      taskRef: Type.String({ minLength: 1, maxLength: 256 }),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      eventTypes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      if (allowedTaskIds !== undefined && !allowedTaskIds.has(params.taskRef)) {
        throw new Error(`evidence_list cannot list observations outside the Task boundary: ${params.taskRef}`);
      }
      const limit = Math.min(params.limit ?? 32, options.maxListLimit ?? 100);
      const window = await executionLog.window({
        taskId: params.taskRef,
        cursor: params.cursor,
        limit,
        eventTypes: params.eventTypes,
        direction: "forward"
      });
      const events = window.events.map((event) => evidenceIndexRecord(event));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            taskRef: params.taskRef,
            events,
            nextCursor: window.nextCursor
          }, null, 2)
        }],
        details: {}
      };
    }
  });
}

export function createEvidenceReadTool(
  executionLog: ExecutionLog,
  options: EvidenceToolOptions = {}
) {
  return defineTool({
    name: "evidence_read",
    label: "Evidence Read",
    description: options.description ?? "Read one persisted event as byte-paged canonical JSON. Accepts an exact event Ref or an unambiguous Ref prefix; never invent UUIDs.",
    parameters: Type.Object({
      ref: Type.String({ pattern: "^event:.+", minLength: 7, maxLength: 256 }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      length: Type.Optional(Type.Integer({ minimum: 1, maximum: 64_000 }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const event = resolveEvidenceEvent(executionLog, params.ref);
      const canonical = JSON.stringify(event, null, 2);
      const totalBytes = Buffer.byteLength(canonical, "utf8");
      const offset = params.offset ?? 0;
      const length = Math.min(params.length ?? EVIDENCE_TOOL_DEFAULT_READ_BYTES, options.maxReadBytes ?? 64_000);
      const page = utf8BytePage(canonical, offset, length);
      const nextOffset = page.endOffset < totalBytes ? page.endOffset : undefined;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ref: event.id,
            requestedRef: params.ref === event.id ? undefined : params.ref,
            offset: page.startOffset,
            totalBytes,
            nextOffset,
            content: page.content
          }, null, 2)
        }],
        details: {}
      };
    }
  });
}

function resolveEvidenceEvent(executionLog: ExecutionLog, requestedRef: string): ExecutionEvent {
  const exact = executionLog.eventById(requestedRef);
  if (exact) {
    return exact;
  }
  const matches = executionLog.eventIdsWithPrefix(requestedRef);
  if (matches.length === 1) {
    const byPrefix = executionLog.eventById(matches[0]!);
    if (byPrefix) {
      return byPrefix;
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `evidence_read event Ref is ambiguous: ${requestedRef} (candidates: ${matches.slice(0, 3).join(", ")}); `
      + "use a longer prefix or an exact Ref from evidence_list"
    );
  }
  throw new Error(
    `evidence_read cannot resolve event Ref: ${requestedRef}; call evidence_list and use its exact ref or a unique prefix`
  );
}

function evidenceIndexRecord(event: import("../types.js").ExecutionEvent): Record<string, unknown> {
  const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : undefined;
  const toolCallId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : undefined;
  const args = event.eventType === "tool_started" ? event.payload.args : undefined;
  return {
    ref: event.id,
    seq: event.seq,
    eventType: event.eventType,
    timestamp: event.timestamp,
    toolName,
    toolCallId,
    actionFingerprint: toolName && args !== undefined
      ? createHash("sha256").update(`${toolName}\n${stableCanonicalJson(args)}`).digest("hex")
      : undefined,
    isError: event.payload.isError === true ? true : undefined,
    artifactRefs: event.artifactRefs ?? []
  };
}

function stableCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableCanonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function utf8BytePage(value: string, offset: number, length: number): {
  content: string;
  startOffset: number;
  endOffset: number;
} {
  const bytes = Buffer.from(value, "utf8");
  let startOffset = Math.min(offset, bytes.length);
  while (startOffset < bytes.length && (bytes[startOffset]! & 0xc0) === 0x80) startOffset += 1;
  let endOffset = Math.min(bytes.length, startOffset + length);
  while (endOffset < bytes.length && endOffset > startOffset && (bytes[endOffset]! & 0xc0) === 0x80) {
    endOffset -= 1;
  }
  return {
    content: bytes.subarray(startOffset, endOffset).toString("utf8"),
    startOffset,
    endOffset
  };
}

export function createArtifactReadTool(
  artifactStore: ArtifactStore,
  options: {
    maxReadBytes?: number;
    workspace?: { hostDir: string; visibleRoot: string; sharedWithContainer?: boolean };
    description?: string;
  } = {}
) {
  const readProperties = {
    ref: Type.String(),
    offset: Type.Optional(Type.Number()),
    length: Type.Optional(Type.Number())
  };
  const parameters = options.workspace
    ? Type.Object({ ...readProperties, materialize: Type.Optional(Type.Boolean()) }, { additionalProperties: false })
    : Type.Object(readProperties, { additionalProperties: false });
  return defineTool({
    name: "artifact_read",
    label: "Artifact Read",
    description: options.description ?? (options.workspace
      ? "Read a bounded artifact range by artifact ref, or explicitly materialize the complete artifact into the persistent Executor workspace."
      : "Read a bounded artifact range by artifact ref."),
    parameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        ref: string;
        offset?: number;
        length?: number;
        materialize?: boolean;
      };
      if (!params.ref.startsWith("artifact:")) {
        throw new Error("artifact_read requires a real artifactRef");
      }
      // Models habitually truncate Refs (like git short hashes); accept an
      // unambiguous prefix and resolve it to the canonical full Ref.
      const artifactRef = await resolveArtifactRef(artifactStore, params.ref);
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
  if (exact && exact.kind !== "credential") return exact.artifactRef;
  const matches = (await artifactStore.list())
    .filter((record) => record.kind !== "credential")
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
  const parameters = Type.Object({
    taskId: Type.Optional(Type.String()),
    kind: Type.Union([
      Type.Literal("http_body"),
      Type.Literal("screenshot"),
      Type.Literal("stdout"),
      Type.Literal("stderr"),
      Type.Literal("poc"),
      Type.Literal("json"),
      Type.Literal("text"),
      Type.Literal("report"),
      Type.Literal("other")
    ]),
    mediaType: Type.String(),
    path: Type.String(),
    extension: Type.Optional(Type.String())
  }, { additionalProperties: false });
  return defineTool({
    name: "artifact_write",
    label: "Artifact Write",
    description: "Promote the minimum existing file whose exact content is required across the Task boundary from the persistent workspace into Artifact storage. Use kind=report only for a Root Goal explicitly requiring a report, document, or downloadable deliverable. Same-Task epoch resume and reconstructible persisted evidence do not require promotion; temporary files under /tmp are not a durable handoff boundary.",
    parameters,
    execute: async (_toolCallId, params) => {
      const record: ArtifactRecord = options.readExecutorFile
        ? await artifactStore.write({
            taskId: params.taskId,
            kind: params.kind as ArtifactRecord["kind"],
            mediaType: params.mediaType,
            data: await options.readExecutorFile(params.path),
            extension: params.extension ?? extensionFromPath(params.path)
          })
        : await artifactStore.importFile({
            taskId: params.taskId,
            kind: params.kind as ArtifactRecord["kind"],
            mediaType: params.mediaType,
            sourcePath: await resolveExecutorWorkspaceFile(params.path, options.workspace),
            extension: params.extension
          });
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
