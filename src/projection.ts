import { randomUUID } from "node:crypto";
import { stableSessionNodeId } from "./operation-identity.js";
import type { ExecutionEvent, GraphDelta, GraphEdge, GraphNode, GraphSnapshot } from "./types.js";

export type ProjectionObservationKind = "action" | "task_outcome" | "connectivity" | "runtime_error";

const TASK_OUTCOME_EVENT_TYPES = new Set([
  "task_completed",
  "task_partial",
  "task_blocked",
  "task_failed"
]);

const LEGACY_RAW_RESULT_INTERPRETATION = "No recorded Executor interpretation; use only the raw result as evidence.";
const MISSING_RESULT_INTERPRETATION = "Executor continued without recording a conclusion for the previous result; treat it as inconclusive.";
const MAX_REPEATED_ACTIONS_PER_OBSERVATION = 16;
export const PROJECTOR_MAX_DELTA_NODES = 24;
export const PROJECTOR_MAX_DELTA_EDGES = 40;
export const PROJECTOR_MAX_DELTA_BYTES = 128 * 1024;

const PROJECTION_NODE_KEYS = new Set(["id", "graphKind", "type", "label", "properties", "evidenceRefs"]);
const PROJECTION_EDGE_KEYS = new Set(["from", "to", "type", "properties", "evidenceRefs"]);
export const PROJECTION_OPERATION_NODE_TYPES = [
  "Host", "Port", "Service", "WebEndpoint", "Parameter", "Credential",
  "AgentSession", "ShellSession", "Session", "File", "Process"
] as const;
export const PROJECTION_REASONING_NODE_TYPES = [
  "Evidence", "Hypothesis", "Vulnerability", "Exploit"
] as const;
const PROJECTION_NODE_TYPES: Record<string, readonly string[]> = {
  operation: PROJECTION_OPERATION_NODE_TYPES,
  reasoning: PROJECTION_REASONING_NODE_TYPES
};
export const PROJECTION_EDGE_TYPES = [
  "supports", "contradicts", "confirms", "promoted_to", "exploited_by", "produces_evidence",
  "observed_on", "affects", "has_port", "runs_service", "exposes_endpoint", "has_parameter",
  "authenticates_to", "creates_session", "session_on", "tunnels_to", "proxy_route",
  "contains_file", "spawns_process"
] as const;

export type ProjectionObservation = {
  ref: string;
  kind: ProjectionObservationKind;
  seqStart: number;
  seqEnd: number;
  intent?: string;
  interpretation?: string;
  action?: string;
  inputDigest?: string;
  outcomeDigest: string;
  status: "ok" | "error" | "incomplete";
  artifactRefs: string[];
  capabilityRefs?: string[];
  anchors: string[];
  sourceEventIds: string[];
  repeatCount?: number;
  actions?: Array<{
    action: string;
    inputDigest?: string;
    outcomeDigest: string;
    status: "ok" | "error" | "incomplete";
    seqStart?: number;
    seqEnd?: number;
    artifactRefs?: string[];
    anchors?: string[];
    sourceEventIds?: string[];
  }>;
  fragmentIndex?: number;
  fragmentCount?: number;
};

export type ProjectionBatch = {
  observations: ProjectionObservation[];
  toSeq: number;
  sourceEventIds: string[];
};

export class ProjectionObservationEnvelopeTooLargeError extends Error {
  constructor(readonly minimumBytes: number, readonly maxBytes: number) {
    super(`Projection observation envelope requires ${minimumBytes} UTF-8 bytes; maximum is ${maxBytes}`);
    this.name = "ProjectionObservationEnvelopeTooLargeError";
  }
}

export class ProjectionDeltaLimitError extends Error {
  constructor(readonly field: "nodes" | "edges", readonly actual: number, readonly maximum: number) {
    super(`Projection delta ${field} contains ${actual} items; maximum per submission is ${maximum}`);
    this.name = "ProjectionDeltaLimitError";
  }
}

export class ProjectionDraftIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionDraftIntegrityError";
  }
}

export type ProjectionGraphContext = {
  nodes: Array<{
    ref: string;
    id: string;
    graphKind: GraphNode["graphKind"];
    type: string;
    label: string;
    properties: Record<string, unknown>;
    evidenceRefs: string[];
  }>;
  edges: Array<{
    id?: string;
    from: string;
    to: string;
    type: string;
    properties: Record<string, unknown>;
  }>;
  nodeAliases: Map<string, string>;
  sourceNodeCount: number;
  sourceEdgeCount: number;
};

export type ProjectionExistingAliasContext = ReadonlyMap<string, {
  graphKind: GraphNode["graphKind"];
  type: string;
}>;

export type ProjectionDraftValidationOptions = {
  existingAliases?: ProjectionExistingAliasContext;
};

export class ProjectorGraphRefRegistry {
  private readonly nodesByAlias = new Map<string, GraphNode>();
  private readonly aliasesByNodeId = new Map<string, string>();
  private readonly aliases = new Map<string, { graphKind: GraphNode["graphKind"]; type: string }>();
  private nextAliasIndex = 1;

  constructor(context: ProjectionGraphContext) {
    for (const node of context.nodes.filter(isProjectorSemanticNode)) {
      this.register(node.ref, {
        id: node.id,
        graphKind: node.graphKind,
        type: node.type,
        label: node.label,
        properties: node.properties,
        evidenceRefs: node.evidenceRefs
      });
    }
  }

  aliasContext(): ProjectionExistingAliasContext {
    return this.aliases;
  }

  resolveNodeId(ref: string): string {
    if (!ref.startsWith("existing:")) {
      return ref;
    }
    const node = this.nodesByAlias.get(ref);
    if (!node) {
      throw new ProjectionDraftIntegrityError(`Unknown Projector graph alias ${ref}`);
    }
    return node.id;
  }

  resolveSearchQuery(query: string): string {
    return query.replace(/existing:[1-9][0-9]*/g, (alias) => this.resolveNodeId(alias));
  }

  intern(node: GraphNode): string {
    const existingAlias = this.aliasesByNodeId.get(node.id);
    if (existingAlias) {
      this.register(existingAlias, node);
      return existingAlias;
    }
    const alias = `existing:${this.nextAliasIndex}`;
    this.register(alias, node);
    return alias;
  }

  nodeEntries(): Array<[string, GraphNode]> {
    return [...this.nodesByAlias.entries()].map(([alias, node]) => [alias, { ...node }]);
  }

  aliasSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
    const visible = filterProjectorSemanticGraph(snapshot);
    for (const node of visible.nodes) {
      this.intern(node);
    }
    const nodes = visible.nodes.map((node) => ({
      ...node,
      id: this.intern(node),
      label: this.aliasValue(node.label) as string,
      properties: this.aliasValue(node.properties) as Record<string, unknown>,
      evidenceRefs: this.aliasValue(node.evidenceRefs) as string[] | undefined
    }));
    const edges = visible.edges.map((edge) => ({
      from: this.aliasesByNodeId.get(edge.from) ?? edge.from,
      to: this.aliasesByNodeId.get(edge.to) ?? edge.to,
      type: edge.type,
      properties: this.aliasValue(edge.properties) as Record<string, unknown> | undefined,
      evidenceRefs: this.aliasValue(edge.evidenceRefs) as string[] | undefined
    }));
    return {
      ...snapshot,
      nodes,
      edges,
      summary: this.aliasValue(snapshot.summary) as Record<string, unknown>
    };
  }

  private register(alias: string, node: GraphNode): void {
    const currentNode = this.nodesByAlias.get(alias);
    if (currentNode && currentNode.id !== node.id) {
      throw new ProjectionDraftIntegrityError(`Projector graph alias ${alias} is already assigned to ${currentNode.id}`);
    }
    const currentAlias = this.aliasesByNodeId.get(node.id);
    if (currentAlias && currentAlias !== alias) {
      throw new ProjectionDraftIntegrityError(`Projector graph node ${node.id} is already assigned to ${currentAlias}`);
    }
    this.nodesByAlias.set(alias, { ...node });
    this.aliasesByNodeId.set(node.id, alias);
    this.aliases.set(alias, { graphKind: node.graphKind, type: node.type });
    const aliasIndex = Number(alias.slice("existing:".length));
    if (Number.isInteger(aliasIndex)) {
      this.nextAliasIndex = Math.max(this.nextAliasIndex, aliasIndex + 1);
    }
  }

  private aliasValue(value: unknown): unknown {
    if (typeof value === "string") {
      let aliased = value;
      const nodeIds = [...this.aliasesByNodeId.keys()].sort((left, right) => right.length - left.length);
      for (const nodeId of nodeIds) {
        aliased = aliased.split(nodeId).join(this.aliasesByNodeId.get(nodeId)!);
      }
      return aliased;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.aliasValue(entry));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, this.aliasValue(entry)])
      );
    }
    return value;
  }
}

type PendingAction = {
  seqStart: number;
  intent?: string;
  action: string;
  inputDigest?: string;
  sourceEventIds: string[];
  artifactRefs: string[];
};

export function buildProjectionObservations(events: ExecutionEvent[]): ProjectionObservation[] {
  const sortedEvents = [...events].sort((left, right) => eventSeq(left) - eventSeq(right));
  const pendingActions = new Map<string, PendingAction>();
  const observations: ProjectionObservation[] = [];
  let pendingIntent: { text: string; eventId: string; seq: number } | undefined;

  const closeOpenActions = (interpretation: string, _sourceEventId: string): void => {
    const openIndexes = observations.flatMap((observation, index) => (
      observation.kind === "action"
        && (!observation.interpretation || observation.interpretation === LEGACY_RAW_RESULT_INTERPRETATION)
        ? [index]
        : []
    ));
    if (openIndexes.length === 0) {
      return;
    }
    const normalizedInterpretation = truncate(interpretation, 260);
    if (openIndexes.length === 1) {
      const observation = observations[openIndexes[0]!]!;
      observation.interpretation = normalizedInterpretation;
      observation.anchors = dedupeStrings([
        ...observation.anchors,
        ...extractAnchors(normalizedInterpretation)
      ]);
      return;
    }
    const grouped = openIndexes.map((index) => observations[index]!);
    const firstIndex = openIndexes[0]!;
    observations[firstIndex] = {
      ref: "",
      kind: "action",
      seqStart: Math.min(...grouped.map((observation) => observation.seqStart)),
      seqEnd: Math.max(...grouped.map((observation) => observation.seqEnd)),
      intent: grouped.find((observation) => observation.intent)?.intent,
      interpretation: normalizedInterpretation,
      action: "tool_group",
      outcomeDigest: `${grouped.length} tool results interpreted together`,
      status: grouped.some((observation) => observation.status === "error") ? "error" : "ok",
      artifactRefs: dedupeStrings(grouped.flatMap((observation) => observation.artifactRefs)),
      anchors: dedupeStrings([
        ...grouped.flatMap((observation) => observation.anchors),
        ...extractAnchors(normalizedInterpretation)
      ]),
      sourceEventIds: dedupeStrings(grouped.flatMap((observation) => observation.sourceEventIds)),
      actions: grouped.map((observation) => ({
        action: observation.action ?? "unknown",
        inputDigest: observation.inputDigest,
        outcomeDigest: observation.outcomeDigest,
        status: observation.status,
        seqStart: observation.seqStart,
        seqEnd: observation.seqEnd,
        artifactRefs: [...observation.artifactRefs],
        anchors: [...observation.anchors],
        sourceEventIds: [...observation.sourceEventIds]
      }))
    };
    const removedIndexes = new Set(openIndexes.slice(1));
    for (let index = observations.length - 1; index >= 0; index -= 1) {
      if (removedIndexes.has(index)) {
        observations.splice(index, 1);
      }
    }
  };

  for (const event of sortedEvents) {
    const seq = eventSeq(event);
    if (event.eventType === "assistant_intent") {
      const text = textProperty(event.payload.text) ?? textProperty(event.summary);
      if (text && !text.startsWith("assistant_intent:")) {
        closeOpenActions(text, event.id);
      }
      pendingIntent = text && !text.startsWith("assistant_intent:")
        ? { text: truncate(text, 140), eventId: event.id, seq }
        : undefined;
      continue;
    }

    if (event.eventType === "tool_started") {
      const toolCallId = textProperty(event.payload.toolCallId) ?? event.id;
      const action = textProperty(event.payload.toolName) ?? "unknown";
      const inputDigest = compactInputValue(event.payload.args);
      if (!isRuntimeContextAction(action, inputDigest, "")) {
        closeOpenActions(MISSING_RESULT_INTERPRETATION, event.id);
      }
      pendingActions.set(toolCallId, {
        seqStart: pendingIntent?.seq ?? seq,
        intent: pendingIntent?.text,
        action,
        inputDigest,
        sourceEventIds: dedupeStrings([
          ...(pendingIntent ? [pendingIntent.eventId] : []),
          event.id
        ]),
        artifactRefs: eventArtifactRefs(event)
      });
      pendingIntent = undefined;
      continue;
    }

    if (event.eventType === "tool_finished") {
      const toolCallId = textProperty(event.payload.toolCallId) ?? event.id;
      const action = textProperty(event.payload.toolName) ?? "unknown";
      const pending = pendingActions.get(toolCallId);
      pendingActions.delete(toolCallId);
      const inputDigest = pending?.inputDigest;
      const outcomeDigest = compactToolOutcome(event);
      const artifactRefs = dedupeStrings([
        ...(pending?.artifactRefs ?? []),
        ...eventArtifactRefs(event)
      ]);
      if (isRuntimeContextAction(action, inputDigest, outcomeDigest)) {
        continue;
      }
      observations.push({
        ref: "",
        kind: "action",
        seqStart: pending?.seqStart ?? seq,
        seqEnd: seq,
        intent: pending?.intent,
        action,
        inputDigest,
        outcomeDigest,
        interpretation: pending
          ? undefined
          : LEGACY_RAW_RESULT_INTERPRETATION,
        status: event.payload.isError === true ? "error" : "ok",
        artifactRefs,
        anchors: extractAnchors(`${inputDigest ?? ""}\n${outcomeDigest}`),
        sourceEventIds: dedupeStrings([...(pending?.sourceEventIds ?? []), event.id])
      });
      continue;
    }

    if (TASK_OUTCOME_EVENT_TYPES.has(event.eventType)) {
      closeOpenActions(compactTaskOutcome(event), event.id);
      const taskResult = isRecord(event.payload.taskResult) ? event.payload.taskResult : undefined;
      observations.push({
        ref: "",
        kind: "task_outcome",
        seqStart: seq,
        seqEnd: seq,
        outcomeDigest: compactTaskOutcome(event),
        status: event.eventType === "task_failed" || event.eventType === "task_blocked" ? "error" : "ok",
        artifactRefs: eventArtifactRefs(event),
        capabilityRefs: stringArray(taskResult?.capabilityRefs),
        anchors: extractAnchors(`${event.summary ?? ""}\n${compactValue(event.payload, 700) ?? ""}`),
        sourceEventIds: dedupeStrings([event.id, ...stringArray(taskResult?.evidenceRefs)])
      });
      continue;
    }

    if (event.eventType === "connectivity_observation") {
      const status = textProperty(event.payload.status);
      observations.push({
        ref: "",
        kind: "connectivity",
        seqStart: seq,
        seqEnd: seq,
        action: textProperty(event.payload.transition) ?? "connectivity_observation",
        inputDigest: textProperty(event.payload.observationKind),
        outcomeDigest: compactValue(event.payload, 900) ?? event.summary ?? "Connectivity state changed",
        status: status === "degraded" || event.payload.failureReason ? "error" : "ok",
        artifactRefs: eventArtifactRefs(event),
        anchors: connectivityAnchors(event.payload),
        sourceEventIds: [event.id]
      });
      continue;
    }

    if (event.eventType === "provider_error") {
      closeOpenActions(event.summary ?? "Provider error interrupted result interpretation.", event.id);
      observations.push({
        ref: "",
        kind: "runtime_error",
        seqStart: seq,
        seqEnd: seq,
        outcomeDigest: truncate(event.summary ?? compactValue(event.payload, 700) ?? "Provider error", 700),
        status: "error",
        artifactRefs: eventArtifactRefs(event),
        anchors: [],
        sourceEventIds: [event.id]
      });
    }
  }

  return coalesceProjectionObservations(observations)
    .map((observation, index) => ({ ...observation, ref: `o${index + 1}` }));
}

export function selectProjectionBatch(
  events: ExecutionEvent[],
  options: { fromSeq: number; maxObservations?: number }
): ProjectionBatch {
  const sortedEvents = [...events].sort((left, right) => eventSeq(left) - eventSeq(right));
  const allObservations = buildProjectionObservations(sortedEvents);
  const projectableObservations = allObservations.filter(isClosedObservation);
  const observations = projectableObservations.slice(0, options.maxObservations ?? 4)
    .map((observation, index) => ({ ...observation, ref: `o${index + 1}` }));
  const hasMoreObservations = projectableObservations.length > observations.length;
  const firstIncompleteObservationSeq = allObservations
    .filter((observation) => !isClosedObservation(observation))
    .map((observation) => observation.seqStart)
    .sort((left, right) => left - right)[0];
  const pendingIntentSeq = pendingExecutorIntentSeq(sortedEvents);
  const firstIncompleteSeq = [firstIncompleteObservationSeq, pendingIntentSeq]
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];
  const lastSelectedSeq = observations.at(-1)?.seqEnd;
  const toSeq = lastSelectedSeq !== undefined
    ? hasMoreObservations
      ? lastSelectedSeq
      : firstIncompleteSeq !== undefined
        ? lastSelectedSeq
        : Math.max(lastSelectedSeq, sortedEvents.at(-1)?.seq ?? lastSelectedSeq)
    : firstIncompleteSeq !== undefined
      ? Math.max(options.fromSeq, firstIncompleteSeq - 1)
      : sortedEvents.at(-1)?.seq ?? options.fromSeq;
  return {
    observations,
    toSeq,
    sourceEventIds: dedupeStrings(observations.flatMap((observation) => observation.sourceEventIds))
  };
}

export function aliasProjectionGraphContext(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}): ProjectionGraphContext {
  const nodeAliases = new Map<string, string>();
  const nodes = input.nodes.map((node, index) => {
    const ref = `existing:${index + 1}`;
    nodeAliases.set(ref, node.id);
    return {
      ref,
      id: node.id,
      graphKind: node.graphKind,
      type: node.type,
      label: truncate(node.label, 120),
      properties: compactNodeProperties(node.properties),
      evidenceRefs: (node.evidenceRefs ?? []).slice(0, 4)
    };
  });
  const aliasesByNodeId = new Map([...nodeAliases.entries()].map(([alias, nodeId]) => [nodeId, alias]));
  const edges = input.edges
    .map((edge) => ({
      id: edge.id,
      from: aliasesByNodeId.get(edge.from) ?? "",
      to: aliasesByNodeId.get(edge.to) ?? "",
      type: edge.type,
      properties: compactNodeProperties(edge.properties ?? {})
    }))
    .filter((edge) => Boolean(edge.from && edge.to));
  return {
    nodes,
    edges,
    nodeAliases,
    sourceNodeCount: nodes.length,
    sourceEdgeCount: edges.length
  };
}

export function filterProjectorSemanticGraph<T extends {
  nodes: GraphNode[];
  edges: GraphEdge[];
}>(input: T): T {
  const nodes = input.nodes.filter(isProjectorSemanticNode);
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edges = input.edges.filter((edge) => (
    visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)
  ));
  return {
    ...input,
    nodes,
    edges
  };
}

export function compactProjectionGraphContextForInput(
  context: ProjectionGraphContext,
  maxBytes: number
): ProjectionGraphContext {
  const sourceNodeCount = context.sourceNodeCount;
  const sourceEdgeCount = context.sourceEdgeCount;
  const compacted: ProjectionGraphContext = {
    nodes: [],
    edges: [],
    nodeAliases: new Map(),
    sourceNodeCount,
    sourceEdgeCount
  };
  const byteLimit = Math.max(256, Math.floor(maxBytes));
  const nodeByteLimit = Math.max(192, Math.floor(byteLimit * 0.7));
  for (const node of context.nodes) {
    const candidate: ProjectionGraphContext = {
      ...compacted,
      nodes: [...compacted.nodes, node],
      nodeAliases: new Map([...compacted.nodeAliases, [node.ref, node.id]])
    };
    if (Buffer.byteLength(renderProjectionGraphContext(candidate), "utf8") > nodeByteLimit) {
      break;
    }
    compacted.nodes = candidate.nodes;
    compacted.nodeAliases = candidate.nodeAliases;
  }
  const visibleRefs = new Set(compacted.nodes.map((node) => node.ref));
  for (const edge of context.edges) {
    if (!visibleRefs.has(edge.from) || !visibleRefs.has(edge.to)) {
      continue;
    }
    const candidate = { ...compacted, edges: [...compacted.edges, edge] };
    if (Buffer.byteLength(renderProjectionGraphContext(candidate), "utf8") > byteLimit) {
      break;
    }
    compacted.edges = candidate.edges;
  }
  return compacted;
}

export function expandProjectionDraft(input: {
  value: unknown;
  batch: ProjectionBatch;
  graphContext: ProjectionGraphContext;
  references?: ProjectorGraphRefRegistry;
  validationOptions?: Omit<ProjectionDraftValidationOptions, "existingAliases">;
}): GraphDelta {
  validateProjectionDraftIntegrity(input.value, {
    existingAliases: input.references?.aliasContext() ?? projectionExistingAliasContext(input.graphContext),
    ...input.validationOptions
  });
  const record = isRecord(input.value) ? input.value : {};
  const draft = isRecord(record.graphDelta) ? record.graphDelta : record;
  const observationRefs = new Map(input.batch.observations.map((observation) => [observation.ref, observation.sourceEventIds]));
  const sourceEventIds = new Set(input.batch.sourceEventIds);
  const resolveEvidenceRefs = (value: unknown): string[] => dedupeStrings(
    stringArray(value).flatMap((ref) => observationRefs.get(ref) ?? (sourceEventIds.has(ref) ? [ref] : []))
  );
  const referenceEntries = input.references?.nodeEntries()
    ?? input.graphContext.nodes.map((node) => [node.ref, {
      id: node.id,
      graphKind: node.graphKind,
      type: node.type,
      label: node.label,
      properties: node.properties,
      evidenceRefs: node.evidenceRefs
    } as GraphNode] as [string, GraphNode]);
  const existingNodesById = new Map(referenceEntries.map(([, node]) => [node.id, node]));
  const staticNodeAliases = input.references ? undefined : input.graphContext.nodeAliases;
  const submittedNodeRefs = new Map<string, string>();
  const resolveNodeRef = (value: unknown): string => {
    const ref = String(value ?? "").trim();
    if (!ref) {
      return "";
    }
    if (ref.startsWith("existing:")) {
      return input.references?.resolveNodeId(ref) ?? staticNodeAliases?.get(ref) ?? "";
    }
    return submittedNodeRefs.get(ref) ?? "";
  };
  const nodesById = new Map<string, GraphNode>();
  const submittedNodes = Array.isArray(draft.nodes) ? draft.nodes.filter(isRecord) : [];
  if (submittedNodes.length > PROJECTOR_MAX_DELTA_NODES) {
    throw new ProjectionDeltaLimitError("nodes", submittedNodes.length, PROJECTOR_MAX_DELTA_NODES);
  }
  if (submittedNodes.length > 0) {
    for (const node of submittedNodes) {
      const submittedRef = String(node.id ?? "").trim();
      const existingId = submittedRef.startsWith("existing:")
        ? input.references?.resolveNodeId(submittedRef) ?? staticNodeAliases?.get(submittedRef)
        : undefined;
      const submittedGraphKind = normalizeGraphKind(node.graphKind);
      if (submittedGraphKind === "task" || (existingId && existingNodesById.get(existingId)?.graphKind === "task")) {
        throw new ProjectionDraftIntegrityError(
          `Projection node alias ${submittedRef || "<empty>"} targets the task graph; no part of the delta was accepted`
        );
      }
      const resolvedId = existingId ?? (submittedRef.startsWith("new:")
          ? stableOperationNodeId(node) ?? `projected:${randomUUID()}`
          : "");
      if (!resolvedId) {
        throw new ProjectionDraftIntegrityError(
          `Projection node references unknown existing alias ${submittedRef || "<empty>"}; no part of the delta was accepted`
        );
      }
      if (!existingId) {
        submittedNodeRefs.set(submittedRef, resolvedId);
      }
      const existing = existingNodesById.get(resolvedId);
      const type = existing?.type ?? String(node.type ?? "Evidence");
      const nextNode: GraphNode = {
        id: resolvedId,
        graphKind: existing?.graphKind ?? submittedGraphKind,
        type,
        label: truncate(String(node.label ?? existing?.label ?? node.id ?? "Observation"), 500),
        properties: compactSubmittedProperties(node.properties),
        evidenceRefs: resolveEvidenceRefs(node.evidenceRefs)
      };
      const previous = nodesById.get(resolvedId);
      nodesById.set(resolvedId, previous ? {
        ...nextNode,
        properties: { ...previous.properties, ...nextNode.properties },
        evidenceRefs: dedupeStrings([...(previous.evidenceRefs ?? []), ...(nextNode.evidenceRefs ?? [])])
      } : nextNode);
    }
  }
  const nodes = [...nodesById.values()];
  const nodeById = new Map<string, GraphNode>([
    ...[...existingNodesById.entries()].map(([nodeId, node]) => [nodeId, {
      id: node.id,
      graphKind: node.graphKind,
      type: node.type,
      label: node.label,
      properties: node.properties,
      evidenceRefs: node.evidenceRefs
    }] as const),
    ...nodes.map((node) => [node.id, node] as const)
  ]);
  const submittedEdges = Array.isArray(draft.edges) ? draft.edges.filter(isRecord) : [];
  if (submittedEdges.length > PROJECTOR_MAX_DELTA_EDGES) {
    throw new ProjectionDeltaLimitError("edges", submittedEdges.length, PROJECTOR_MAX_DELTA_EDGES);
  }
  const edges = submittedEdges.length > 0
    ? submittedEdges.map((edge): GraphEdge => {
      const type = String(edge.type ?? "supports");
      const properties = compactSubmittedProperties(edge.properties);
      const submittedFrom = String(edge.from ?? "").trim();
      const submittedTo = String(edge.to ?? "").trim();
      const from = resolveNodeRef(submittedFrom);
      const to = resolveNodeRef(submittedTo);
      if (!from || !to) {
        throw new ProjectionDraftIntegrityError(
          `Projection edge references unknown existing alias: ${submittedFrom || "<empty>"} -> ${submittedTo || "<empty>"}; no part of the delta was accepted`
        );
      }
      const id = stableOperationalEdgeId(type, properties);
      return {
        ...(id ? { id } : {}),
        from,
        to,
        type,
        properties,
        evidenceRefs: resolveEvidenceRefs(edge.evidenceRefs)
      };
    }).map((edge): GraphEdge => {
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (!fromNode || !toNode) {
        throw new ProjectionDraftIntegrityError(
          `Projection edge resolved to unavailable endpoints ${edge.from} -> ${edge.to}; no part of the delta was accepted`
        );
      }
      if (fromNode.graphKind === "task" || toNode.graphKind === "task") {
        throw new ProjectionDraftIntegrityError(
          `Projection edge resolved to the task graph ${edge.from} -> ${edge.to}; no part of the delta was accepted`
        );
      }
      return edge;
    })
    : [];
  return {
    sourceEventIds: input.batch.sourceEventIds,
    nodes,
    edges
  };
}

export function validateProjectionDraftIntegrity(
  value: unknown,
  options: ProjectionDraftValidationOptions = {}
): void {
  const record = isRecord(value) ? value : undefined;
  const draft = record && isRecord(record.graphDelta) ? record.graphDelta : record;
  if (!draft) {
    throw new ProjectionDraftIntegrityError("Projection delta must be an object; no part of the delta was accepted");
  }
  if (!Array.isArray(draft.nodes) || !Array.isArray(draft.edges)) {
    throw new ProjectionDraftIntegrityError(
      "Projection delta must contain both nodes and edges arrays; no part of the delta was accepted"
    );
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(draft), "utf8");
  if (serializedBytes > PROJECTOR_MAX_DELTA_BYTES) {
    throw new ProjectionDraftIntegrityError(
      `Projection delta requires ${serializedBytes} UTF-8 bytes; maximum is ${PROJECTOR_MAX_DELTA_BYTES}`
    );
  }
  if (draft.nodes.length > PROJECTOR_MAX_DELTA_NODES) {
    throw new ProjectionDeltaLimitError("nodes", draft.nodes.length, PROJECTOR_MAX_DELTA_NODES);
  }
  if (draft.edges.length > PROJECTOR_MAX_DELTA_EDGES) {
    throw new ProjectionDeltaLimitError("edges", draft.edges.length, PROJECTOR_MAX_DELTA_EDGES);
  }

  const errors: string[] = [];
  const declaredAliases = new Set<string>();
  const declaredNodes = new Map<string, Record<string, unknown>>();
  const aliasTypes = new Map<string, { graphKind: GraphNode["graphKind"]; type: string }>(
    options.existingAliases ? [...options.existingAliases.entries()] : []
  );
  const unknownExistingAliases = new Set<string>();
  const taskGraphAliases = new Map<string, string>();
  const conflictingExistingAliases = new Set<string>();
  for (const [index, valueNode] of draft.nodes.entries()) {
    if (!isRecord(valueNode)) {
      errors.push(`Projection node at index ${index} is not an object`);
      continue;
    }
    const unexpectedNodeKeys = Object.keys(valueNode).filter((key) => !PROJECTION_NODE_KEYS.has(key));
    if (unexpectedNodeKeys.length > 0) {
      errors.push(
        `Projection node at index ${index} has unexpected top-level keys [${unexpectedNodeKeys.join(", ")}]; nodes only allow id, graphKind, type, label, properties, evidenceRefs — move metadata such as status/target/description into properties`
      );
    }
    const nodeGraphKind = String(valueNode.graphKind ?? "");
    const allowedNodeTypes = PROJECTION_NODE_TYPES[nodeGraphKind];
    if (!allowedNodeTypes) {
      errors.push(
        `Projection node at index ${index} has graphKind ${JSON.stringify(valueNode.graphKind ?? null)}; expected "operation" or "reasoning"`
      );
    }
    const nodeType = String(valueNode.type ?? "");
    if (allowedNodeTypes && !allowedNodeTypes.includes(nodeType)) {
      errors.push(
        `Projection node at index ${index} (${nodeGraphKind}) has type ${JSON.stringify(valueNode.type ?? null)}; valid ${nodeGraphKind} types: ${allowedNodeTypes.join(", ")}`
      );
    }
    const alias = String(valueNode.id ?? "").trim();
    if (!/^(existing|new):[1-9][0-9]*$/.test(alias)) {
      errors.push(`Projection node at index ${index} has invalid alias ${alias || "<empty>"}`);
      continue;
    }
    if (declaredAliases.has(alias)) {
      errors.push(`Projection node alias ${alias} is declared more than once`);
      continue;
    }
    declaredAliases.add(alias);
    declaredNodes.set(alias, valueNode);
    if (allowedNodeTypes?.includes(nodeType)) {
      aliasTypes.set(alias, {
        graphKind: nodeGraphKind as GraphNode["graphKind"],
        type: nodeType
      });
    }
    if (alias.startsWith("existing:") && options.existingAliases) {
      const existing = options.existingAliases.get(alias);
      if (!existing) {
        unknownExistingAliases.add(alias);
      } else if (existing.graphKind === "task") {
        taskGraphAliases.set(alias, existing.type);
      } else if (valueNode.graphKind !== existing.graphKind || valueNode.type !== existing.type) {
        conflictingExistingAliases.add(
          `${alias} expected ${existing.graphKind}/${existing.type}, received ${String(valueNode.graphKind)}/${String(valueNode.type)}`
        );
      }
    }
  }

  const missingNewAliases = new Set<string>();
  const referencedNewAliases = new Set<string>();
  for (const [index, valueEdge] of draft.edges.entries()) {
    if (!isRecord(valueEdge)) {
      errors.push(`Projection edge at index ${index} is not an object`);
      continue;
    }
    const unexpectedEdgeKeys = Object.keys(valueEdge).filter((key) => !PROJECTION_EDGE_KEYS.has(key));
    if (unexpectedEdgeKeys.length > 0) {
      errors.push(
        `Projection edge at index ${index} has unexpected top-level keys [${unexpectedEdgeKeys.join(", ")}]; edges only allow from, to, type, properties, evidenceRefs`
      );
    }
    const edgeType = String(valueEdge.type ?? "");
    if (!(PROJECTION_EDGE_TYPES as readonly string[]).includes(edgeType)) {
      const suggestion = suggestProjectionEdgeType(valueEdge, aliasTypes);
      errors.push(
        `Projection edge at index ${index} has type ${JSON.stringify(valueEdge.type ?? null)}; ${
          suggestion
            ? suggestion
            : `valid edge types: ${PROJECTION_EDGE_TYPES.join(", ")}`
        }`
      );
    }
    for (const endpoint of [valueEdge.from, valueEdge.to]) {
      const alias = String(endpoint ?? "").trim();
      if (!/^(existing|new):[1-9][0-9]*$/.test(alias)) {
        errors.push(`Projection edge at index ${index} has invalid endpoint alias ${alias || "<empty>"}`);
        continue;
      }
      if (alias.startsWith("new:") && !declaredAliases.has(alias)) {
        missingNewAliases.add(alias);
      }
      if (alias.startsWith("new:")) {
        referencedNewAliases.add(alias);
      }
      if (alias.startsWith("existing:") && options.existingAliases) {
        const existing = options.existingAliases.get(alias);
        if (!existing) {
          unknownExistingAliases.add(alias);
        } else if (existing.graphKind === "task") {
          taskGraphAliases.set(alias, existing.type);
        }
      }
    }
  }
  if (missingNewAliases.size > 0) {
    errors.push(
      `Projection delta is incomplete: edges reference undeclared new aliases ${[...missingNewAliases].join(", ")}; re-submit the complete nodes and edges together`
    );
  }
  if (unknownExistingAliases.size > 0) {
    errors.push(
      `Projection delta references unknown existing aliases ${[...unknownExistingAliases].join(", ")}; use only existing aliases from this graph context`
    );
  }
  if (taskGraphAliases.size > 0) {
    errors.push(
      `Projection delta cannot mutate task graph aliases ${[...taskGraphAliases].map(([alias, type]) => `${alias}(${type})`).join(", ")}`
    );
  }
  if (conflictingExistingAliases.size > 0) {
    errors.push(
      `Projection delta conflicts with existing node identity: ${[...conflictingExistingAliases].join(", ")}`
    );
  }
  const unconnectedSemanticAliases = [...declaredAliases].filter((alias) => {
    const node = declaredNodes.get(alias);
    return alias.startsWith("new:")
      && isRecord(node)
      && node.graphKind === "reasoning"
      && !referencedNewAliases.has(alias);
  });
  if (unconnectedSemanticAliases.length > 0) {
    errors.push(
      `Projection delta contains unconnected semantic nodes ${unconnectedSemanticAliases.join(", ")}; connect each node with evidence-backed edges or omit it, then re-submit the complete delta`
    );
  }
  if (errors.length > 0) {
    throw new ProjectionDraftIntegrityError(
      `Projection delta has ${errors.length} validation error${errors.length === 1 ? "" : "s"}: ${
        errors.map((error, index) => `[${index + 1}] ${error}`).join("; ")
      }; No part of the delta was accepted`
    );
  }
}

function suggestProjectionEdgeType(
  edge: Record<string, unknown>,
  aliasTypes: ReadonlyMap<string, { graphKind: GraphNode["graphKind"]; type: string }>
): string | undefined {
  const fromAlias = String(edge.from ?? "").trim();
  const toAlias = String(edge.to ?? "").trim();
  const from = aliasTypes.get(fromAlias);
  const to = aliasTypes.get(toAlias);
  if (!from || !to) {
    return undefined;
  }
  const relation = projectionEdgeTypeForEndpoints(from, to);
  if (relation) {
    return `for ${from.type} -> ${to.type}, use ${JSON.stringify(relation)}`;
  }
  if (from.type === "Exploit" && to.type === "Vulnerability") {
    return `reverse the endpoints and use "exploited_by" for Vulnerability -> Exploit`;
  }
  return undefined;
}

function projectionEdgeTypeForEndpoints(
  from: { graphKind: GraphNode["graphKind"]; type: string },
  to: { graphKind: GraphNode["graphKind"]; type: string }
): string | undefined {
  if (from.type === "Host" && to.type === "Port") return "has_port";
  if (from.type === "Port" && to.type === "Service") return "runs_service";
  if (from.type === "Service" && to.type === "WebEndpoint") return "exposes_endpoint";
  if (from.type === "WebEndpoint" && to.type === "Parameter") return "has_parameter";
  if (from.type === "Credential" && ["Service", "WebEndpoint"].includes(to.type)) return "authenticates_to";
  if (from.type === "Credential" && isProjectionSessionType(to.type)) return "creates_session";
  if (isProjectionSessionType(from.type) && to.type === "Host") return "session_on";
  if (from.type === "Host" && to.type === "File") return "contains_file";
  if ((from.type === "Host" || isProjectionSessionType(from.type)) && to.type === "Process") return "spawns_process";
  if (from.type === "Evidence" && to.graphKind === "operation") return "observed_on";
  if (from.type === "Evidence" && to.type === "Hypothesis") return "supports";
  if (from.type === "Evidence" && to.type === "Vulnerability") return "confirms";
  if (from.type === "Hypothesis" && to.type === "Vulnerability") return "promoted_to";
  if (from.type === "Vulnerability" && to.type === "Exploit") return "exploited_by";
  if (["Vulnerability", "Exploit"].includes(from.type) && to.graphKind === "operation") return "affects";
  if (["Evidence", "Exploit"].includes(from.type) && to.type === "Evidence") return "produces_evidence";
  return undefined;
}

function isProjectionSessionType(type: string): boolean {
  return ["AgentSession", "ShellSession", "Session"].includes(type);
}

export function projectionExistingAliasContext(
  context: ProjectionGraphContext
): Map<string, { graphKind: GraphNode["graphKind"]; type: string }> {
  return new Map(context.nodes.map((node) => [node.ref, {
    graphKind: node.graphKind,
    type: node.type
  }]));
}

export function renderProjectionObservations(observations: ProjectionObservation[]): string {
  if (observations.length === 0) {
    return "无可投影 observation。";
  }
  return observations.map((observation) => [
    `${observation.ref} [${observation.kind}] seq=${observation.seqStart}-${observation.seqEnd} status=${observation.status}`,
    observation.fragmentCount && observation.fragmentCount > 1
      ? `  fragment: ${observation.fragmentIndex ?? 1}/${observation.fragmentCount}`
      : undefined,
    observation.intent ? `  intent: ${observation.intent}` : undefined,
    observation.action ? `  action: ${observation.action}` : undefined,
    ...(observation.actions ?? []).flatMap((action, index) => [
      `  tool[${index + 1}]: ${action.action} status=${action.status}`,
      action.inputDigest ? `    input: ${action.inputDigest}` : undefined,
      action.outcomeDigest ? `    outcome: ${action.outcomeDigest}` : undefined
    ]),
    (observation.repeatCount ?? 1) > 1 ? `  repeated: ${observation.repeatCount}` : undefined,
    !observation.actions && observation.inputDigest ? `  input: ${observation.inputDigest}` : undefined,
    !observation.actions && observation.outcomeDigest ? `  outcome: ${observation.outcomeDigest}` : undefined,
    observation.interpretation ? `  executor_interpretation: ${observation.interpretation}` : undefined,
    observation.artifactRefs.length > 0 ? `  artifacts: ${observation.artifactRefs.join(", ")}` : undefined,
    (observation.capabilityRefs ?? []).length > 0
      ? `  capabilities: ${(observation.capabilityRefs ?? []).join(", ")}`
      : undefined,
    observation.anchors.length > 0 ? `  anchors: ${observation.anchors.join(", ")}` : undefined
  ].filter((line): line is string => Boolean(line)).join("\n")).join("\n");
}

export function compactProjectionBatchForInput(
  batch: ProjectionBatch,
  options: { maxObservations: number; maxBytes: number }
): ProjectionBatch {
  const maxObservations = Math.max(1, options.maxObservations);
  const maxBytes = Math.max(128, options.maxBytes);
  if (batch.observations.length === 0) {
    return batch;
  }
  const candidates = batch.observations.slice(0, maxObservations);
  for (let count = candidates.length; count >= 1; count -= 1) {
    const selected = candidates.slice(0, count);
    const observations = compactProjectionObservationsToBytes(selected, maxBytes);
    if (observations) {
      const coveredWholeBatch = count === batch.observations.length;
      return {
        observations,
        toSeq: coveredWholeBatch ? batch.toSeq : observations.at(-1)!.seqEnd,
        sourceEventIds: coveredWholeBatch
          ? [...batch.sourceEventIds]
          : dedupeStrings(observations.flatMap((observation) => observation.sourceEventIds))
      };
    }
  }
  const minimum = compactProjectionObservation(batch.observations[0]!, 0, "o1");
  throw new ProjectionObservationEnvelopeTooLargeError(
    projectionObservationBytes([minimum]),
    maxBytes
  );
}

export function partitionProjectionBatchForInput(
  batch: ProjectionBatch,
  options: { maxObservations: number; maxBytes: number }
): ProjectionBatch[] {
  if (batch.observations.length === 0) {
    return [batch];
  }
  const maxObservations = Math.max(1, options.maxObservations);
  const maxBytes = Math.max(128, options.maxBytes);
  const fragments = batch.observations.flatMap((observation) => (
    splitProjectionObservationForInput(observation, maxBytes)
  ));
  const chunks: ProjectionBatch[] = [];
  let offset = 0;
  while (offset < fragments.length) {
    const candidates = fragments.slice(offset, offset + maxObservations);
    let selected: ProjectionObservation[] | undefined;
    for (let count = candidates.length; count >= 1; count -= 1) {
      selected = compactProjectionObservationsToBytes(candidates.slice(0, count), maxBytes);
      if (selected) {
        break;
      }
    }
    if (!selected) {
      const minimum = compactProjectionObservation(candidates[0]!, 0, "o1");
      throw new ProjectionObservationEnvelopeTooLargeError(
        projectionObservationBytes([minimum]),
        maxBytes
      );
    }
    chunks.push({
      observations: selected,
      toSeq: batch.toSeq,
      sourceEventIds: dedupeStrings(selected.flatMap((observation) => observation.sourceEventIds))
    });
    offset += selected.length;
  }
  const representedSourceEventIds = new Set(chunks.flatMap((chunk) => chunk.sourceEventIds));
  const unassignedSourceEventIds = batch.sourceEventIds.filter((eventId) => !representedSourceEventIds.has(eventId));
  if (unassignedSourceEventIds.length > 0) {
    const lastChunk = chunks.at(-1)!;
    lastChunk.sourceEventIds = dedupeStrings([...lastChunk.sourceEventIds, ...unassignedSourceEventIds]);
  }
  return chunks;
}

function splitProjectionObservationForInput(
  observation: ProjectionObservation,
  maxBytes: number
): ProjectionObservation[] {
  const base: ProjectionObservation = {
    ...observation,
    ref: "",
    artifactRefs: [],
    capabilityRefs: [],
    anchors: [],
    sourceEventIds: [],
    actions: undefined,
    fragmentIndex: undefined,
    fragmentCount: undefined
  };
  const fragments: ProjectionObservation[] = [];
  for (const action of observation.actions ?? []) {
    fragments.push({
      ...base,
      actions: [{ ...action }],
      seqStart: action.seqStart ?? observation.seqStart,
      seqEnd: action.seqEnd ?? observation.seqEnd,
      artifactRefs: [...(action.artifactRefs ?? [])],
      anchors: [...(action.anchors ?? [])],
      sourceEventIds: [...(action.sourceEventIds ?? [])]
    });
  }
  if (fragments.length === 0) {
    fragments.push({ ...base });
  }

  const assignedArtifactRefs = new Set(fragments.flatMap((fragment) => fragment.artifactRefs));
  const assignedCapabilityRefs = new Set(fragments.flatMap((fragment) => fragment.capabilityRefs ?? []));
  const assignedAnchors = new Set(fragments.flatMap((fragment) => fragment.anchors));
  const assignedSourceEventIds = new Set(fragments.flatMap((fragment) => fragment.sourceEventIds));
  distributeRenderedStructuralValues(
    fragments,
    observation.artifactRefs.filter((ref) => !assignedArtifactRefs.has(ref)),
    "artifactRefs",
    base,
    maxBytes
  );
  distributeRenderedStructuralValues(
    fragments,
    (observation.capabilityRefs ?? []).filter((ref) => !assignedCapabilityRefs.has(ref)),
    "capabilityRefs",
    base,
    maxBytes
  );
  distributeRenderedStructuralValues(
    fragments,
    observation.anchors.filter((anchor) => !assignedAnchors.has(anchor)),
    "anchors",
    base,
    maxBytes
  );
  const unassignedSourceEventIds = observation.sourceEventIds
    .filter((eventId) => !assignedSourceEventIds.has(eventId));
  for (const [index, eventId] of unassignedSourceEventIds.entries()) {
    const target = fragments[index % fragments.length]!;
    target.sourceEventIds = dedupeStrings([...target.sourceEventIds, eventId]);
  }

  for (const fragment of fragments) {
    const minimum = compactProjectionObservation(fragment, 0, "o1");
    const minimumBytes = projectionObservationBytes([minimum]);
    if (minimumBytes > maxBytes) {
      throw new ProjectionObservationEnvelopeTooLargeError(minimumBytes, maxBytes);
    }
  }
  return fragments.map((fragment, index) => ({
    ...fragment,
    fragmentIndex: index + 1,
    fragmentCount: fragments.length
  }));
}

function distributeRenderedStructuralValues(
  fragments: ProjectionObservation[],
  values: string[],
  key: "artifactRefs" | "capabilityRefs" | "anchors",
  base: ProjectionObservation,
  maxBytes: number
): void {
  for (const value of values) {
    let target = fragments.at(-1)!;
    const candidate = { ...target, [key]: [...(target[key] ?? []), value] };
    const minimum = compactProjectionObservation(candidate, 0, "o1");
    if (projectionObservationBytes([minimum]) > maxBytes) {
      target = { ...base };
      fragments.push(target);
    }
    target[key] = dedupeStrings([...(target[key] ?? []), value]);
  }
}

function compactProjectionObservationsToBytes(
  observations: ProjectionObservation[],
  maxBytes: number
): ProjectionObservation[] | undefined {
  const normalized = observations.map((observation, index) => ({
    ...observation,
    ref: `o${index + 1}`
  }));
  if (projectionObservationBytes(normalized) <= maxBytes) {
    return normalized;
  }
  const minimum = normalized.map((observation, index) => (
    compactProjectionObservation(observation, 0, `o${index + 1}`)
  ));
  if (projectionObservationBytes(minimum) > maxBytes) {
    return undefined;
  }
  let lowerBound = 0;
  let upperBound = maxBytes;
  let best = minimum;
  while (lowerBound <= upperBound) {
    const textBytes = Math.floor((lowerBound + upperBound) / 2);
    const candidate = normalized.map((observation, index) => (
      compactProjectionObservation(observation, textBytes, `o${index + 1}`)
    ));
    if (projectionObservationBytes(candidate) <= maxBytes) {
      best = candidate;
      lowerBound = textBytes + 1;
    } else {
      upperBound = textBytes - 1;
    }
  }
  return best;
}

function compactProjectionObservation(
  observation: ProjectionObservation,
  textBytes: number,
  ref: string
): ProjectionObservation {
  const actions = observation.actions?.map((action) => ({
    ...action,
    inputDigest: action.inputDigest ? compactUtf8HeadTail(action.inputDigest, textBytes) : undefined,
    outcomeDigest: compactUtf8HeadTail(action.outcomeDigest, textBytes)
  }));
  return {
    ...observation,
    ref,
    intent: observation.intent ? compactUtf8HeadTail(observation.intent, textBytes) : undefined,
    interpretation: observation.interpretation ? compactUtf8HeadTail(observation.interpretation, textBytes) : undefined,
    inputDigest: observation.inputDigest ? compactUtf8HeadTail(observation.inputDigest, textBytes) : undefined,
    outcomeDigest: compactUtf8HeadTail(observation.outcomeDigest, textBytes),
    actions,
    artifactRefs: [...observation.artifactRefs],
    capabilityRefs: [...(observation.capabilityRefs ?? [])],
    anchors: [...observation.anchors],
    sourceEventIds: [...observation.sourceEventIds]
  };
}

function projectionObservationBytes(observations: ProjectionObservation[]): number {
  return Buffer.byteLength(renderProjectionObservations(observations), "utf8");
}

export function renderProjectionGraphContext(context: ProjectionGraphContext): string {
  const omittedNodeCount = Math.max(0, context.sourceNodeCount - context.nodes.length);
  const omittedEdgeCount = Math.max(0, context.sourceEdgeCount - context.edges.length);
  const sourceSummary = omittedNodeCount > 0 || omittedEdgeCount > 0
    ? `GraphStore closure: nodes=${context.sourceNodeCount} edges=${context.sourceEdgeCount}; byte view omitted nodes=${omittedNodeCount} edges=${omittedEdgeCount}. Use graph_search/query/trace for omitted semantics.`
    : undefined;
  if (context.nodes.length === 0) {
    return ["无已有相关图节点。", sourceSummary].filter((line): line is string => Boolean(line)).join("\n");
  }
  const nodeLines = context.nodes.map((node) => (
    `${node.ref} ${node.graphKind}/${node.type} ${node.label}${Object.keys(node.properties).length > 0 ? ` ${JSON.stringify(node.properties)}` : ""}`
  ));
  const edgeLines = context.edges.map((edge) => (
    `${edge.from} -${edge.type}-> ${edge.to}${Object.keys(edge.properties).length > 0 ? ` ${JSON.stringify(edge.properties)}` : ""}`
  ));
  return [
    "相关图节点：",
    ...(nodeLines.length > 0 ? nodeLines : ["无"]),
    "可见拓扑：",
    ...(edgeLines.length > 0 ? edgeLines : ["无"]),
    sourceSummary
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function stableOperationNodeId(node: Record<string, unknown>): string | undefined {
  if (normalizeGraphKind(node.graphKind) !== "operation") {
    return undefined;
  }
  return stableSessionNodeId({
    type: String(node.type ?? ""),
    properties: isRecord(node.properties) ? node.properties : {}
  });
}

function stableOperationalEdgeId(type: string, properties: Record<string, unknown>): string | undefined {
  if (type === "tunnels_to") {
    return stableIdentity("tunnel", properties.tunnelId);
  }
  if (type === "proxy_route") {
    return stableIdentity("proxy-route", properties.routeId);
  }
  return undefined;
}

function stableIdentity(prefix: string, value: unknown): string | undefined {
  const identity = typeof value === "string" ? value.trim() : "";
  return identity ? `${prefix}:${encodeURIComponent(identity)}` : undefined;
}

function isProjectorSemanticNode(node: Pick<GraphNode, "graphKind">): boolean {
  return node.graphKind === "operation" || node.graphKind === "reasoning";
}

export function observationDigest(observations: ProjectionObservation[], maxChars = 900, limit = 6): string {
  const selected = selectDecisionObservations(observations, limit);
  return truncate(selected.map((observation) => [
    `${observation.ref}:${observation.action ?? observation.kind}:${observation.status}`,
    observation.intent ? `intent=${observation.intent}` : undefined,
    observation.inputDigest ? `input=${observation.inputDigest}` : undefined,
    observation.interpretation ? `interpretation=${observation.interpretation}` : undefined,
    (observation.repeatCount ?? 1) > 1 ? `repeated=${observation.repeatCount}` : undefined,
    `outcome=${observation.outcomeDigest}`,
    observation.anchors.length > 0 ? `anchors=${observation.anchors.join(",")}` : undefined
  ].filter((part): part is string => Boolean(part)).join(" ")).join("\n"), maxChars);
}

export function causalObservationDigest(observations: ProjectionObservation[], maxChars = 6_000): string {
  if (observations.length === 0 || maxChars <= 0) {
    return "";
  }
  const ordered = [...observations].sort((left, right) => left.seqEnd - right.seqEnd);
  const perObservationChars = Math.max(48, Math.min(320, Math.floor(maxChars / ordered.length) - 8));
  return ordered.map((observation) => {
    const interpretationFirst = observation.interpretation && !isRuntimeInterruptionInterpretation(observation.interpretation);
    return truncate([
      `${observation.ref}:${observation.action ?? observation.kind}:${observation.status}`,
      interpretationFirst ? `interpretation=${observation.interpretation}` : `outcome=${observation.outcomeDigest}`,
      interpretationFirst ? `outcome=${observation.outcomeDigest}` : observation.interpretation ? `interpretation=${observation.interpretation}` : undefined,
      observation.anchors.length > 0 ? `anchors=${observation.anchors.join(",")}` : undefined
    ].filter((part): part is string => Boolean(part)).join(" "), perObservationChars);
  }).join("\n");
}

function isRuntimeInterruptionInterpretation(value: string): boolean {
  return value === LEGACY_RAW_RESULT_INTERPRETATION
    || value === MISSING_RESULT_INTERPRETATION
    || value.startsWith("provider_error:")
    || value.startsWith("Provider error");
}

export function capabilityDigest(observations: ProjectionObservation[], maxChars = 1200): string {
  const selected = selectDecisionObservations(
    observations.filter((observation) => observation.kind === "task_outcome" || observation.status === "ok"),
    4
  );
  if (selected.length === 0) {
    return "";
  }
  return truncate(selected.map((observation) => [
    observation.action ? `action=${observation.action}` : `kind=${observation.kind}`,
    observation.inputDigest ? `input=${observation.inputDigest}` : undefined,
    `outcome=${observation.outcomeDigest}`,
    (observation.repeatCount ?? 1) > 1 ? `repeated=${observation.repeatCount}` : undefined,
    observation.artifactRefs.length > 0 ? `artifacts=${observation.artifactRefs.join(",")}` : undefined
  ].filter((part): part is string => Boolean(part)).join(" ")).join("\n"), maxChars);
}

function selectDecisionObservations(
  observations: ProjectionObservation[],
  limit: number
): ProjectionObservation[] {
  if (limit <= 0) {
    return [];
  }
  const latestTaskOutcome = observations
    .filter((observation) => observation.kind === "task_outcome")
    .sort((left, right) => right.seqEnd - left.seqEnd)[0];
  const newestByFingerprint = new Map<string, ProjectionObservation>();
  for (const observation of observations.filter((candidate) => candidate.kind !== "task_outcome")) {
    const fingerprint = [
      observation.kind,
      observation.action ?? "",
      observation.status,
      observation.anchors.join("|")
    ].join(":");
    newestByFingerprint.set(fingerprint, observation);
  }
  const maxSeq = Math.max(1, ...observations.map((observation) => observation.seqEnd));
  const remainingLimit = Math.max(0, limit - (latestTaskOutcome ? 1 : 0));
  const selected = [...newestByFingerprint.values()]
    .map((observation) => ({
      observation,
      score: decisionObservationScore(observation, maxSeq)
    }))
    .sort((left, right) => right.score - left.score || right.observation.seqEnd - left.observation.seqEnd)
    .slice(0, remainingLimit)
    .map((entry) => entry.observation);
  return latestTaskOutcome ? [latestTaskOutcome, ...selected] : selected;
}

function decisionObservationScore(
  observation: ProjectionObservation,
  maxSeq: number
): number {
  const kindScore = observation.kind === "task_outcome"
    ? 100
    : observation.kind === "runtime_error"
      ? 70
      : 20;
  const structuralScore = Math.min(observation.anchors.length, 5) * 8
    + Math.min(observation.artifactRefs.length, 3) * 4
    + (observation.intent ? 3 : 0)
    + (observation.status === "error" ? 2 : 0);
  const recencyScore = (observation.seqEnd / maxSeq) * 10;
  return kindScore + structuralScore + recencyScore;
}

function compactToolOutcome(event: ExecutionEvent): string {
  const result = event.payload.result;
  return compactHeadTail(toolResultText(result) ?? event.summary ?? "Tool completed", 700);
}

function compactInputValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return compactHeadTail(value, 320);
  }
  try {
    return compactHeadTail(JSON.stringify(value), 320);
  } catch {
    return compactHeadTail(String(value), 320);
  }
}

function compactTaskOutcome(event: ExecutionEvent): string {
  const taskResult = isRecord(event.payload.taskResult) ? event.payload.taskResult : undefined;
  return compactHeadTail(
    textProperty(taskResult?.summary)
      ?? event.summary
      ?? compactValue(event.payload, 700)
      ?? event.eventType,
    520
  );
}

function connectivityAnchors(payload: Record<string, unknown>): string[] {
  const scalarKeys = [
    "routeRef",
    "connectionRef",
    "sessionRef",
    "pivotHostRef",
    "hostRef",
    "dialAddress"
  ];
  return dedupeStrings([
    ...scalarKeys.flatMap((key) => {
      const value = textProperty(payload[key]);
      return value ? [value] : [];
    }),
    ...stringArray(payload.targetCidrs)
  ]);
}

function compactValue(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncate(value.replace(/\s+/g, " ").trim(), maxChars);
  }
  try {
    return truncate(JSON.stringify(value), maxChars);
  } catch {
    return truncate(String(value), maxChars);
  }
}

function toolResultText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(toolResultText).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  if (!isRecord(value)) {
    return value === undefined || value === null ? undefined : String(value);
  }
  if (typeof value.text === "string") {
    return normalizeWhitespace(value.text);
  }
  const preferredKeys = ["content", "stdout", "stderr", "output", "body", "message"];
  const preferredParts = preferredKeys
    .map((key) => toolResultText(value[key]))
    .filter((part): part is string => Boolean(part));
  if (preferredParts.length > 0) {
    return preferredParts.join(" ");
  }
  try {
    return normalizeWhitespace(JSON.stringify(value));
  } catch {
    return normalizeWhitespace(String(value));
  }
}

function coalesceProjectionObservations(observations: ProjectionObservation[]): ProjectionObservation[] {
  const coalesced: ProjectionObservation[] = [];
  for (const observation of observations) {
    const previous = coalesced.at(-1);
    if (!previous || !canCoalesceObservations(previous, observation)) {
      coalesced.push({ ...observation, repeatCount: observation.repeatCount ?? 1 });
      continue;
    }
    const repeatCount = (previous.repeatCount ?? 1) + (observation.repeatCount ?? 1);
    coalesced[coalesced.length - 1] = {
      ...previous,
      seqEnd: observation.seqEnd,
      intent: observation.intent ?? previous.intent,
      interpretation: observation.interpretation ?? previous.interpretation,
      inputDigest: mergeObservationInputs(previous.inputDigest, observation.inputDigest, repeatCount),
      artifactRefs: dedupeStrings([...previous.artifactRefs, ...observation.artifactRefs]),
      anchors: dedupeStrings([...previous.anchors, ...observation.anchors]),
      sourceEventIds: dedupeStrings([...previous.sourceEventIds, ...observation.sourceEventIds]),
      repeatCount
    };
  }
  return coalesced;
}

function canCoalesceObservations(left: ProjectionObservation, right: ProjectionObservation): boolean {
  if (left.kind !== "action" || right.kind !== "action" || left.actions || right.actions) {
    return false;
  }
  return (left.repeatCount ?? 1) < MAX_REPEATED_ACTIONS_PER_OBSERVATION
    && left.action === right.action
    && left.status === right.status
    && semanticFingerprint(left.outcomeDigest) === semanticFingerprint(right.outcomeDigest)
    && semanticFingerprint(left.anchors.join("|")) === semanticFingerprint(right.anchors.join("|"));
}

function isClosedObservation(observation: ProjectionObservation): boolean {
  return observation.kind !== "action" || Boolean(observation.interpretation);
}

function pendingExecutorIntentSeq(events: ExecutionEvent[]): number | undefined {
  let pendingSeq: number | undefined;
  for (const event of events) {
    if (event.eventType === "assistant_intent") {
      const text = textProperty(event.payload.text) ?? textProperty(event.summary);
      pendingSeq = text && !text.startsWith("assistant_intent:") ? eventSeq(event) : undefined;
      continue;
    }
    if (event.eventType === "tool_started") {
      pendingSeq = undefined;
      continue;
    }
    if (TASK_OUTCOME_EVENT_TYPES.has(event.eventType) || event.eventType === "provider_error") {
      pendingSeq = undefined;
    }
  }
  return pendingSeq;
}

function mergeObservationInputs(left: string | undefined, right: string | undefined, repeatCount: number): string | undefined {
  if (!left) {
    return right;
  }
  if (!right || left === right) {
    return left;
  }
  return compactHeadTail(`variants=${repeatCount}; first=${left}; latest=${right}`, 320);
}

function semanticFingerprint(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactHeadTail(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const marker = ` ...[${normalized.length - maxChars} chars omitted]... `;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.55);
  const tailLength = Math.max(0, available - headLength);
  return `${normalized.slice(0, headLength)}${marker}${normalized.slice(-tailLength)}`;
}

export function compactUtf8HeadTail(value: string, maxBytes: number): string {
  const normalized = normalizeWhitespace(value);
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }
  if (maxBytes <= 0) {
    return "";
  }
  const omittedBytes = Buffer.byteLength(normalized, "utf8") - maxBytes;
  const marker = `...[${Math.max(1, omittedBytes)} bytes omitted]...`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) {
    return utf8Prefix(marker, maxBytes);
  }
  const availableBytes = maxBytes - markerBytes;
  const headBytes = Math.ceil(availableBytes * 0.55);
  const tailBytes = Math.max(0, availableBytes - headBytes);
  return `${utf8Prefix(normalized, headBytes)}${marker}${utf8Suffix(normalized, tailBytes)}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const characters = Array.from(value);
  let result = "";
  let usedBytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }
    result = character + result;
    usedBytes += characterBytes;
  }
  return result;
}

function compactNodeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const allowedKeys = [
    "status", "host", "hostname", "ip", "port", "protocol", "scheme", "service", "url", "endpoint", "path", "method",
    "name", "location", "in", "username", "role", "valid", "confidence", "resultSummary", "checkpointReason",
    "blockerReason", "pendingCondition", "sessionId", "agentSessionId", "shellSessionId", "tunnelId", "routeId",
    "createdAt", "updatedAt", "lastSeenAt", "expiresAt", "closedAt", "transport", "localHost", "localPort",
    "remoteHost", "remotePort", "via"
  ];
  return Object.fromEntries(allowedKeys
    .filter((key) => properties[key] !== undefined)
    .map((key) => [key, compactContextPropertyValue(key, properties[key])]));
}

function compactContextPropertyValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    const limit = key === "resultSummary" ? 140 : ["checkpointReason", "blockerReason"].includes(key) ? 100 : 120;
    return truncate(value.replace(/\s+/g, " ").trim(), limit);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 6).map((item) => typeof item === "string" ? truncate(item, 100) : item);
  }
  return compactPropertyValue(value);
}

function compactSubmittedProperties(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, propertyValue]) => [
    truncate(key, 80),
    compactPropertyValue(propertyValue)
  ]));
}

function compactPropertyValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncate(value, 600);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map(compactPropertyValue);
  }
  return truncate(compactValue(value, 600) ?? "", 600);
}

function eventArtifactRefs(event: ExecutionEvent): string[] {
  return dedupeStrings([
    ...(event.artifactRefs ?? []),
    ...artifactRefsFromValue(event.payload)
  ]);
}

function artifactRefsFromValue(value: unknown): string[] {
  if (typeof value === "string") {
    return value.startsWith("artifact:") ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(artifactRefsFromValue);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, propertyValue]) => (
    key === "artifactRef" && typeof propertyValue === "string"
      ? [propertyValue]
      : artifactRefsFromValue(propertyValue)
  ));
}

function extractAnchors(value: string): string[] {
  const anchors: string[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const url = trimPunctuation(match[0]);
    anchors.push(url);
    try {
      const parsed = new URL(url);
      anchors.push(parsed.host, parsed.hostname, parsed.pathname);
    } catch {
      // Ignore malformed URL-like strings.
    }
  }
  for (const match of value.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g)) {
    anchors.push(match[0]);
  }
  for (const match of value.matchAll(/\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+/g)) {
    const path = trimPunctuation(match[0]);
    if (!path.startsWith("//") && path.length >= 2) {
      anchors.push(path);
    }
  }
  return dedupeStrings(anchors);
}

function isRuntimeContextAction(action: string, inputDigest?: string, outcomeDigest?: string): boolean {
  if (!["read", "grep", "find", "ls", "bash"].includes(action)) {
    return false;
  }
  const normalized = `${inputDigest ?? ""} ${outcomeDigest ?? ""}`.toLowerCase();
  return normalized.includes("/.agents/skills/")
    || normalized.includes("/.codex/skills/")
    || normalized.includes("agents.md")
    || normalized.includes(".agent-runtime")
    || normalized.includes("node_modules")
    || normalized.includes("package-lock.json")
    || normalized.includes("tsconfig.json")
    || /\brecon_a\d*\b/.test(normalized)
    || normalized.includes("system prompt")
    || normalized.includes("observer_projector_system_prompt");
}

function normalizeGraphKind(value: unknown): GraphNode["graphKind"] {
  return value === "operation" || value === "task" ? value : "reasoning";
}

function eventSeq(event: ExecutionEvent): number {
  return typeof event.seq === "number" ? event.seq : 0;
}

function textProperty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function trimPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, "");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 18))}...[truncated]`;
}
