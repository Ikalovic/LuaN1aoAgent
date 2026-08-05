export type AgentRole = "planner" | "executor" | "observer";

export type GraphKind = "reasoning" | "operation" | "task";

export type ReasoningNodeType =
  | "Evidence"
  | "Hypothesis"
  | "Vulnerability"
  | "Exploit";

export type OperationNodeType =
  | "Host"
  | "Port"
  | "Service"
  | "WebEndpoint"
  | "Parameter"
  | "Credential"
  | "AgentSession"
  | "ShellSession"
  | "Session"
  | "File"
  | "Process";

export type TaskNodeType =
  | "Goal"
  | "Task"
  | "Milestone"
  | "Blocker"
  | "Scope";

export type GraphNodeType =
  | ReasoningNodeType
  | OperationNodeType
  | TaskNodeType;

export type EdgeType =
  | "supports"
  | "contradicts"
  | "confirms"
  | "promoted_to"
  | "exploited_by"
  | "produces_evidence"
  | "observed_on"
  | "affects"
  | "has_port"
  | "runs_service"
  | "exposes_endpoint"
  | "has_parameter"
  | "authenticates_to"
  | "creates_session"
  | "session_on"
  | "tunnels_to"
  | "proxy_route"
  | "contains_file"
  | "spawns_process"
  | "decomposes_to"
  | "depends_on"
  | "within_scope"
  | "produces_milestone"
  | "blocked_by"
  | "unblocked_by"
  | "requires_evidence";

export type JsonObject = Record<string, unknown>;

export type OperationalStatus = "live" | "degraded" | "stale" | "closed";

export interface AgentSession {
  id: string;
  graphKind: "operation";
  type: "AgentSession";
  label: string;
  properties: JsonObject & {
    status: OperationalStatus;
    sessionId?: string;
    agentSessionId?: string;
  };
  evidenceRefs?: string[];
}

export interface ShellSession {
  id: string;
  graphKind: "operation";
  type: "ShellSession";
  label: string;
  properties: JsonObject & {
    status: OperationalStatus;
    sessionId?: string;
    shellSessionId?: string;
  };
  evidenceRefs?: string[];
}

export type GraphNode = {
  id: string;
  graphKind: GraphKind;
  type: GraphNodeType | string;
  label: string;
  properties: JsonObject;
  evidenceRefs?: string[];
};

export type GraphEdge = {
  id?: string;
  from: string;
  to: string;
  type: EdgeType | string;
  evidenceRefs?: string[];
  properties?: JsonObject;
};

export type GraphDelta = {
  sourceEventIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type TaskDefinition = {
  taskId: string;
  goal: string;
  targetRefs: string[];
  basisRefs?: string[];
  scopeRef: string;
  constraints: string[];
  successCriteria: string[];
  goalAdditions?: TaskGoalAddition[];
};

export type TaskGoalAddition = {
  goal: string;
  successCriteria: string[];
};

export type TaskSchedulingPolicy = {
  dependsOnTaskRefs?: string[];
  continueFromTaskRef?: string;
  parentTaskId?: string;
  budget?: {
    maxTurns?: number;
  };
};

export type TaskRuntimeContext = {
  availableSessionRefs?: string[];
};

/** Executor wire view assembled from separately owned definition, scheduling and runtime state. */
export type TaskEnvelope = TaskDefinition & TaskSchedulingPolicy & TaskRuntimeContext;

export type TaskBudget = NonNullable<TaskSchedulingPolicy["budget"]>;

export type TaskResultStatus = "completed" | "partial" | "blocked" | "failed";

export type TaskResult = {
  taskId: string;
  status: TaskResultStatus;
  summary: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  capabilityRefs?: string[];
  blockerReason?: string;
  suggestedNextGoal?: string;
  checkpointReason?: string;
  retryable?: boolean;
  attempt?: number;
  resumeCursor?: string;
  lastEventId?: string;
};

export type TaskGraphStatus = "open" | "completed" | "blocked" | "failed" | "archived";

export type PlannerDecision = {
  /** Historical persisted decisions may still carry this constant. */
  decision?: "apply_commands";
  commands?: PlannerCommand[];
  reason: string;
  /** Historical persisted decisions may still carry transaction-wide provenance. */
  basedOnRefs?: string[];
};

export type PlannerTaskSpec = {
  id: string;
  goal: string;
  targetRefs: string[];
  scopeRef: string;
  successCriteria: string[];
  budget?: TaskBudget;
  priority: number;
  parentTaskId?: string;
  dependsOnTaskRefs?: string[];
  continueFromTaskRef?: string;
};

export type PlannerTaskPatch = {
  /** Planner-facing incremental extension; Runtime resolves this to cumulative budget.maxTurns. */
  additionalTurns?: number;
  /** Historical decisions and Runtime-internal resolved patches only. */
  budget?: TaskBudget;
  priority?: number;
  appendObjectives?: TaskGoalAddition[];
};

type PlannerCommandBasis = {
  basedOnRefs?: string[];
  /** Historical persisted commands may still carry a duplicated reason. */
  reason?: string;
};

export type PlannerCommand =
  | ({
      kind: "create_tasks";
      tasks: PlannerTaskSpec[];
    } & PlannerCommandBasis)
  | ({
      kind: "patch_task";
      taskId: string;
      patch: PlannerTaskPatch;
    } & PlannerCommandBasis)
  | ({
      kind: "replace_dependencies";
      taskId: string;
      dependencyTaskIds: string[];
    } & PlannerCommandBasis)
  | ({
      kind: "set_task_status";
      taskId: string;
      status: TaskGraphStatus;
    } & PlannerCommandBasis)
  | ({
      kind: "set_node_status";
      nodeId: string;
      status: string;
    } & PlannerCommandBasis);

export type ControlSignalDecision =
  | "continue"
  | "redirect"
  | "handoff"
  | "stop_executor"
  /** Historical persisted signals only. */
  | "checkpoint"
  | "need_planner";

export type ControlSignal = {
  decision: ControlSignalDecision;
  reason: string;
  evidenceRefs: string[];
  /** Historical persisted signals may still carry this display-only field. */
  confidence?: "low" | "medium" | "high";
  guidance?: string;
};

export type SupervisorVerdict = ControlSignal & {
  epochRef: string;
  throughSeq: number;
};

export type TaskOutcome = {
  taskRef: string;
  epochRef: string;
  /** Task objective definition evaluated by this outcome. */
  objectiveRevision?: number;
  status: TaskResultStatus;
  summary: string;
  evidenceRefs: string[];
  artifactRefs: string[];
  capabilityRefs: string[];
  blockerReason?: string;
  suggestedNextGoal?: string;
  checkpoint?: {
    reason?: string;
    retryable?: boolean;
    resumeCursor?: string;
  };
  terminalSeq: number;
  createdAt: string;
};

export type EpochOutcomeStatus =
  | "submitted"
  | "checkpointed"
  | "provider_error"
  | "failed"
  | "aborted";

export type EpochOutcome = {
  epochRef: string;
  taskRef: string;
  status: EpochOutcomeStatus;
  reason: string;
  terminalSeq: number;
  taskOutcomeRef?: string;
  retryable: boolean;
  createdAt: string;
};

export type RuntimeAbortKind =
  | "budget_abort"
  | "observer_abort"
  | "controller_abort";

export type RuntimeAbortContext = {
  kind: RuntimeAbortKind;
  reason: string;
  controlSignal?: ControlSignal;
};

export type ObserverProjection = {
  graphDelta: GraphDelta;
  controlSignal: ControlSignal;
};

export type ObserverMode = "supervise" | "project";

export type ExecutionEvent = {
  id: string;
  seq?: number;
  epochId?: string;
  taskId?: string;
  role: AgentRole | "runtime";
  eventType: string;
  timestamp: string;
  summary?: string;
  payload: JsonObject;
  artifactRefs?: string[];
};

export type ExecutionEpochState = "created" | "running" | "closing" | "closed";

export type ExecutionEpochTerminationReason =
  | "executor_submitted"
  | "supervisor_checkpoint"
  | "budget_exhausted"
  | "time_slice_exhausted"
  | "provider_error"
  | "timeout"
  | "shutdown";

export type ExecutionEpochRecord = {
  epochId: string;
  taskId: string;
  attempt: number;
  state: ExecutionEpochState;
  terminationReason?: ExecutionEpochTerminationReason;
  startedAt: string;
  closedAt?: string;
  startSeq?: number;
  endSeq?: number;
};

export type ProjectionState = {
  taskId: string;
  committedSeq: number;
  desiredSeq: number;
  generation: number;
  activeGeneration?: number;
  priority: number;
  pendingSince?: string;
  terminalTargetSeq?: number;
  updatedAt: string;
};

export type ProjectionClaim = {
  taskId: string;
  fromSeq: number;
  toSeq: number;
  generation: number;
};

export type ArtifactRecord = {
  artifactRef: string;
  taskId?: string;
  kind: "http_body" | "screenshot" | "stdout" | "stderr" | "poc" | "json" | "text" | "report" | "credential" | "other";
  mediaType: string;
  path: string;
  byteLength: number;
  createdAt: string;
  preview: string;
  contentHash?: string;
};

export type GraphView = "planner" | "reasoning" | "operation" | "task" | "sessions";

export const HYPOTHESIS_STATUSES = [
  "open",
  "inconclusive",
  "confirmed",
  "refuted",
  "superseded"
] as const;

export type HypothesisStatus = typeof HYPOTHESIS_STATUSES[number];

export type GraphSnapshot = {
  view: GraphView;
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: JsonObject;
};

export type PlannerTaskLedgerItem = {
  taskId: string;
  status: string;
  goal: string;
  targetRefs?: string[];
  basisRefs?: string[];
  scopeRef?: string;
  successCriteria?: string[];
  goalAdditions?: TaskGoalAddition[];
  parentTaskId?: string;
  executionState?: "running" | "awaiting_planner" | "queued" | "blocked";
  maxTurns?: number;
  consumedTurns?: number;
  remainingTurns?: number;
  ready?: boolean;
  blockedByTaskRefs?: string[];
  dependencyStatuses?: Record<string, string>;
  priority?: number;
  dependsOnTaskRefs?: string[];
  projection?: {
    committedSeq: number;
    desiredSeq: number;
  };
};

export type PlannerDigestItem = {
  id: string;
  graphKind: GraphKind;
  type: string;
  label: string;
  status?: string;
  score: number;
  reasons: string[];
  edgeCount: number;
  evidenceRefCount: number;
  properties: JsonObject;
};

export type PlannerDecisionView = {
  view: "planner_decision";
  rootRefs: {
    goalRef: string | null;
    scopeRef: string | null;
  };
  taskLedger: PlannerTaskLedgerItem[];
  taskOutcomes?: TaskOutcome[];
  epochOutcomes?: EpochOutcome[];
  projectionDegradations?: Array<{
    taskRef: string;
    status: "degraded";
    reason: "terminal_projection_incomplete" | "projection_watermark_lag";
    committedSeq: number;
    desiredSeq: number;
    terminalTargetSeq?: number;
  }>;
  reasoningDigest: PlannerDigestItem[];
  operationDigest: PlannerDigestItem[];
  blockers: PlannerDigestItem[];
  graphSummary: JsonObject;
};
