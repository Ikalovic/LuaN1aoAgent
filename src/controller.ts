import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createExecutorAgentSession, createObserverAgentSession, createPlannerAgentSession, createScopeResolverAgentSession, projectSkillsDirs, type SecurityAgentRuntime, type SecurityAgentSession } from "./agents.js";
import { SkillRegistry, type SkillRegistrySnapshot } from "./skills/skill-registry.js";
import { selectSkillsForTask, type SkillSelectionResult } from "./skills/skill-selector.js";
import { extractJsonObject } from "./json.js";
import { normalizeInferredScopeCidrs, parseAuthorizedScope, type ScopeResolution } from "./scope.js";
import {
  createLlmRuntime,
  providerAdmissionKey,
  type LlmAgentRole,
  type LlmRuntime
} from "./llm-config.js";
import { ConnectivityRuntime } from "./connectivity/connectivity-runtime.js";
import type { MitmFlowClient } from "./connectivity/mitm-flow-client.js";
import type { GatewayReplayInput } from "./connectivity/replay-gateway-runtime.js";
import type { RouteOpenInput, RouteProjectionContext, RouteStatus } from "./connectivity/route-manager.js";
import type { TrafficReplayResult } from "./connectivity/traffic-proxy-client.js";
import { transparentProxyEndpoint, type TransparentSocks5ProxyConfig } from "./proxy-config.js";
import {
  createDockerTaskSandbox,
  executorDockerImage,
  type DockerTaskSandbox
} from "./executor-sandbox-docker.js";
import {
  createExecutorSandbox,
  listExecutorWorkspaceFiles,
  type ExecutorSandbox,
  type ExecutorSandboxRequestedMode
} from "./executor-sandbox.js";
import { getExecutorEnvironmentFacts } from "./executor-environment.js";
import { EpochBudgetClock } from "./epoch-budget-clock.js";
import { summarizeSupervisorTrace } from "./log-summary.js";
import { normalizePlannerDecision, validatePlannerBasedOnRefs } from "./planner-commands.js";
import {
  renderExecutorInput,
  renderExecutorResumeInput,
  renderObserverInput,
  renderPlannerInput,
  renderSupervisorInput
} from "./prompts.js";
import {
  attachExecutionLogging,
  classifyLlmErrorKind,
  invokeStructured,
  isRetryableLlmErrorKind,
  promptAndCollect,
  PromptRuntimeError,
  StructuredInvocationError,
  type LlmErrorKind
} from "./pi-runner.js";
import {
  aliasProjectionGraphContext,
  buildProjectionObservations,
  compactProjectionGraphContextForInput,
  compactProjectionBatchForInput,
  compactUtf8HeadTail,
  expandProjectionDraft,
  filterProjectorSemanticGraph,
  partitionProjectionBatchForInput,
  ProjectorGraphRefRegistry,
  ProjectionObservationEnvelopeTooLargeError,
  renderProjectionGraphContext,
  renderProjectionObservations,
  selectProjectionBatch,
  type ProjectionDraftValidationOptions,
  type ProjectionBatch,
  type ProjectionObservation
} from "./projection.js";
import {
  ProjectorCoordinator,
  type ProjectorWorkItem
} from "./projector-coordinator.js";
import { ArtifactStore } from "./stores/artifact-store.js";
import { ConnectivityStore } from "./stores/connectivity-store.js";
import { ExecutionLog } from "./stores/execution-log.js";
import {
  GraphValidationError,
  PlannerDecisionConflict,
  SQLiteGraphStore,
  type ProjectionNodeStatusChange,
  type PlannerTaskBatchCommand
} from "./stores/graph-store.js";
import { RuntimeStore } from "./stores/runtime-store.js";
import { loadBeekeeperConfig, type BeekeeperConfig } from "./beekeeper/beekeeper-config.js";
import { loadFofaConfig, type FofaConfig } from "./fofa/fofa-config.js";
import type { ReportingContext, TaskType } from "./reporting/task-reporting.js";
import { FofaScopePolicy } from "./fofa/fofa-scope-policy.js";
import { BeekeeperMcpRuntime, type BeekeeperMcpRuntimeOptions } from "./mcp/beekeeper-runtime.js";
import { FofaMcpRuntime, type FofaMcpRuntimeOptions } from "./mcp/fofa-runtime.js";
import {
  createExecutorConnectivityTools,
  type ExecutorConnectivityRuntime
} from "./tools/connectivity-tools.js";
import { createEvidenceListTool, createEvidenceReadTool } from "./tools/pi-tools.js";
import { createExecutorBeekeeperTools } from "./tools/beekeeper-mcp-tools.js";
import { createExecutorFofaTools } from "./tools/fofa-mcp-tools.js";
import { createExecutorCredentialTools } from "./tools/credential-tools.js";
import { CredentialMcpRuntime } from "./mcp/credential-runtime.js";
import { createTopologyValidationTool } from "./tools/topology-validation-tool.js";
import type {
  AgentRole,
  ControlSignal,
  ExecutionEpochTerminationReason,
  EpochOutcome,
  ExecutionEvent,
  GraphDelta,
  GraphEdge,
  GraphNode,
  ObserverMode,
  ObserverProjection,
  PlannerCommand,
  PlannerDecisionView,
  PlannerDecision,
  PlannerTaskSpec,
  ProjectionClaim,
  RuntimeAbortContext,
  SupervisorVerdict,
  TaskBudget,
  TaskEnvelope,
  TaskOutcome,
  TaskResult,
  TaskResultStatus
} from "./types.js";

type PlannerTaskCommand = Extract<PlannerCommand, { kind: "patch_task" | "replace_dependencies" | "set_task_status" }>;
type PlannerCreateTasksCommand = Extract<PlannerCommand, { kind: "create_tasks" }>;
type PlannerNodeStatusCommand = Extract<PlannerCommand, { kind: "set_node_status" }>;

type ActivePlannerDeliveryState = {
  queuedRevision: number;
  queuedView: PlannerDecisionView;
  queuedSeq: number;
  requiresControlUpdateConsumption: boolean;
};

class ActiveTaskMutationError extends GraphValidationError {
  constructor(readonly taskIds: string[]) {
    super(
      `Planner cannot mutate active Task(s): ${taskIds.join(", ")}. `
      + "The current Executor still owns that causal goal. Leave it unchanged and submit no command for it; "
      + "create another Task only for a genuinely independent goal, not as a replacement for the active Task."
    );
    this.name = "ActiveTaskMutationError";
  }
}

class PlannerDecisionRepairExhaustedError extends Error {
  constructor(readonly cause: GraphValidationError) {
    super(`Planner decision repair exhausted: ${cause.message}`, { cause });
    this.name = "PlannerDecisionRepairExhaustedError";
  }
}

class IncompletePlannerTerminalDecisionError extends GraphValidationError {
  constructor() {
    super(
      "Root Goal remains open, but Planner submitted no commands and the runtime has no active, pending, or runnable Task work"
    );
    this.name = "IncompletePlannerTerminalDecisionError";
  }
}

export const DEFAULT_TASK_BUDGET: Required<TaskBudget> = {
  maxTurns: 12
};
const PLANNER_DECISION_REPAIR_ATTEMPTS = 2;

export const MIN_TASK_BUDGET: Required<TaskBudget> = {
  maxTurns: 10
};

export const MAX_TASK_BUDGET: Required<TaskBudget> = {
  maxTurns: 40
};

export const DEFAULT_EPOCH_TURN_SLICE = 20;
export const DEFAULT_RUN_TIME_BUDGET_MS = 900_000;
export const TASK_EPOCH_RUN_TIME_SHARE = 0.5;

const CONTINUE_CONTROL_SIGNAL: ControlSignal = {
  decision: "continue",
  reason: "No runtime intervention required",
  evidenceRefs: []
};

const RUNTIME_HEARTBEAT_MS = positiveIntegerEnv("RUNTIME_HEARTBEAT_MS", 60_000);
const SUPERVISOR_IDLE_TIMEOUT_MS = positiveIntegerEnv("SUPERVISOR_IDLE_TIMEOUT_MS", 60_000);
const SUPERVISOR_HARD_TIMEOUT_MS = positiveIntegerEnv(
  "SUPERVISOR_HARD_TIMEOUT_MS",
  positiveIntegerEnv("SUPERVISOR_TIMEOUT_MS", 90_000)
);
const PROJECTOR_IDLE_TIMEOUT_MS = positiveIntegerEnv("PROJECTOR_IDLE_TIMEOUT_MS", 180_000);
const PROJECTOR_HARD_TIMEOUT_MS = positiveIntegerEnv(
  "PROJECTOR_HARD_TIMEOUT_MS",
  positiveIntegerEnv("PROJECTOR_TIMEOUT_MS", 300_000)
);
const PLANNER_IDLE_TIMEOUT_MS = positiveIntegerEnv("PLANNER_IDLE_TIMEOUT_MS", 180_000);
const PLANNER_HARD_TIMEOUT_MS = positiveIntegerEnv(
  "PLANNER_HARD_TIMEOUT_MS",
  positiveIntegerEnv("PLANNER_TIMEOUT_MS", 360_000)
);
const PLANNER_FRESH_SESSION_ATTEMPTS = positiveIntegerEnv(
  "PLANNER_FRESH_SESSION_ATTEMPTS",
  positiveIntegerEnv("PLANNER_PROVIDER_RETRY_ATTEMPTS", 2)
);
const PLANNER_FRESH_SESSION_BACKOFF_MS = positiveIntegerEnv(
  "PLANNER_FRESH_SESSION_BACKOFF_MS",
  positiveIntegerEnv("PLANNER_PROVIDER_RETRY_BACKOFF_MS", 250)
);
const PLANNER_DEFER_BACKOFF_MAX_MS = 5_000;
const PLANNER_MAX_DEFERRED_FAILURES = positiveIntegerEnv("PLANNER_MAX_DEFERRED_FAILURES", 12);
const MISSING_SUBMIT_RETRY_FEEDBACK = "上一次 Planner 调用未产生 planner_submit（输出在达到 max_completion_tokens 上限时被截断）。请直接调用 planner_submit 提交当前最佳决策：先发起工具调用，参数保持简洁（commands 内只保留必要字段），不要在正文输出推理过程。";
const SUPERVISOR_TURN_WINDOW_SIZE = positiveIntegerEnv("SUPERVISOR_TURN_WINDOW_SIZE", 8);
const PROJECTOR_TOOL_WINDOW_SIZE = positiveIntegerEnv("PROJECTOR_TOOL_WINDOW_SIZE", 16);
const TURN_WINDOW_REASON_PREFIX = "turn_window:";
const PROJECT_WINDOW_REASON_PREFIX = "project_window:";
const DEFAULT_MAX_PARALLEL_TASKS = 2;
const LLM_PROVIDER_MAX_CONCURRENT = positiveIntegerEnv("LLM_PROVIDER_MAX_CONCURRENT", 3);
const BUDGET_PRESSURE_TURNS = 2;
// Mid-epoch constraint refresh cadence: with plenty of budget left, no other
// steer fires, so goal/successCriteria/constraints drift out of attention
// (a-18 violated task bans 3x past turn 40 of a 157-turn epoch). Every 25
// turns the budget steer re-lands them at the context tail.
const BUDGET_STEER_TURN_INTERVAL = 25;
const PROJECTION_CANCEL_GRACE_MS = 2_000;
const PROJECTION_DRAIN_TIMEOUT_MS = positiveIntegerEnv(
  "PROJECTION_DRAIN_TIMEOUT_MS",
  PROJECTOR_HARD_TIMEOUT_MS
);
const MAX_ACTIVE_PROJECTION_JOBS = positiveIntegerEnv("MAX_ACTIVE_PROJECTION_JOBS", 2);
const PROJECTOR_ARTIFACT_MANIFEST_LIMIT = 3;
const PROJECTOR_MAX_OBSERVATIONS_PER_JOB = positiveIntegerEnv("PROJECTOR_MAX_OBSERVATIONS_PER_JOB", 16);
const PROJECTOR_CATCHUP_MAX_OBSERVATIONS_PER_JOB = positiveIntegerEnv(
  "PROJECTOR_CATCHUP_MAX_OBSERVATIONS_PER_JOB",
  32
);
const PROJECTOR_INPUT_TARGET_BYTES = Math.min(
  32_000,
  positiveIntegerEnv("PROJECTOR_INPUT_TARGET_BYTES", 32_000)
);
const DEFAULT_PROJECTOR_CATCHUP_DELAY_MS = 45_000;
const PROJECTOR_OBSERVATION_ROLES: Array<AgentRole | "runtime"> = ["executor", "runtime"];
const PROJECTOR_OBSERVATION_EVENT_TYPES = [
  "assistant_intent",
  "tool_started",
  "tool_finished",
  "connectivity_observation",
  "provider_error",
  "epoch_checkpointed",
  "epoch_provider_error",
  "epoch_failed",
  "epoch_aborted",
  "task_completed",
  "task_partial",
  "task_blocked",
  "task_failed"
];
const EXECUTOR_PROVIDER_RETRY_ATTEMPTS = 2;
const EXECUTOR_PROVIDER_RETRY_BACKOFF_MS = 250;
const EXECUTOR_SESSION_DIR = "executor-sessions";

type ObserverProjectionRequest = {
  reason: string;
  taskEnvelope: TaskEnvelope;
  taskResult?: TaskResult;
  sourceEventIds?: string[];
  queueId?: string;
  queuedAt?: number;
  terminal?: boolean;
  maxObservations?: number;
  admissionSignal?: AbortSignal;
};

type ProjectionRequestContext = ObserverProjectionRequest & {
  desiredSeq: number;
  queueId: string;
  queuedAt: number;
};

type SupervisorCheckRequest = {
  reason: string;
  taskEnvelope: TaskEnvelope;
  sourceEventIds?: string[];
  taskResult?: TaskResult;
  queueId?: string;
  queuedAt?: number;
  epochRef?: string;
  throughSeq?: number;
};

type TaskSupervisionState = {
  taskId: string;
  phase: "recon" | "exploit" | "verify" | "extract" | "unknown";
  progressDigest: string;
  lastVerdict?: Pick<SupervisorVerdict, "decision" | "reason" | "guidance">;
  repeatedPatterns: string[];
  negativeFindings: string[];
  openQuestions: string[];
  recentFingerprints: string[];
};

type ActiveTaskState = {
  epochId: string;
  lifecycleState: "created" | "running" | "closing" | "closed";
  terminationReason?: ExecutionEpochTerminationReason;
  taskEnvelope: TaskEnvelope;
  toolExecutionEndCount: number;
  epochTurnCount: number;
  taskTurnCount: number;
  executorStopRequested: boolean;
  checkpointFinalizationActive: boolean;
  controlSignal?: ControlSignal;
  abortContext?: RuntimeAbortContext;
  terminationFailure?: string;
  epochBudgetClock?: EpochBudgetClock;
  lastObserverProjection?: ObserverProjection;
  executorSession?: SecurityAgentSession;
  dynamicExecutor: boolean;
  attempt: number;
  lastEventId?: string;
  budgetStatusSteerKeys: Set<string>;
  terminationPromise?: Promise<void>;
  invocationAbortController: AbortController;
  runDeadlineAt?: number;
  supervisionState: TaskSupervisionState;
};

type TaskExecution = {
  taskEnvelope: TaskEnvelope;
  taskResult?: TaskResult;
  epochOutcome: EpochOutcome;
  terminalSeq: number;
  graphDelta?: GraphDelta;
  controlSignal: ControlSignal;
};

type ActiveTaskRun = {
  taskEnvelope: TaskEnvelope;
  promise: Promise<TaskExecution>;
};

type TaskCompletion = {
  taskId: string;
  execution?: TaskExecution;
  error?: unknown;
};

type ExecutorSessionLease = {
  session: SecurityAgentSession;
  dynamicExecutor: boolean;
  resumed: boolean;
  resumeCount: number;
  continuedFromTaskRef?: string;
};

export type RetryableProviderFailure = {
  errorKind: LlmErrorKind;
  message: string;
  retryable: boolean;
};

type RunResult = {
  cycles: Array<Awaited<ReturnType<SecurityAgentController["runOnce"]>>>;
  completed: boolean;
  stoppedReason: string;
};

type ActiveRunRecord = {
  invocationId: string;
  startedAt: number;
  maxRunTimeMs: number;
  deadlineAt: number;
  startSeq: number;
  outcome?: RunResult | { completed: false; stoppedReason: string; failed: true };
};

type PiSessionStatsSnapshot = {
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: unknown;
};

export class SecurityAgentController {
  readonly cwd: string;
  readonly runtimeDir: string;
  readonly graphStore: SQLiteGraphStore;
  readonly executionLog: ExecutionLog;
  readonly artifactStore: ArtifactStore;
  readonly runtimeStore: RuntimeStore;
  readonly llmRuntime: LlmRuntime;
  readonly runId: string;
  private readonly environment?: NodeJS.ProcessEnv;
  private readonly executorSandboxMode?: ExecutorSandboxRequestedMode;
  private executorSandbox?: ExecutorSandbox;
  private connectivityRuntime?: ConnectivityRuntime;
  private readonly fofaConfig?: FofaConfig;
  private readonly fofaConfigInvalid: boolean;
  private readonly fofaRuntimeFactory: (input: FofaMcpRuntimeOptions) => FofaMcpRuntime;
  private fofaRuntime?: FofaMcpRuntime;
  private fofaScopeFingerprint?: string;
  private fofaCapabilityReported = false;
  private readonly beekeeperConfig?: BeekeeperConfig;
  private readonly beekeeperConfigInvalid: boolean;
  private readonly beekeeperRuntimeFactory: (input: BeekeeperMcpRuntimeOptions) => BeekeeperMcpRuntime;
  private readonly skillRegistry: { scan(): SkillRegistrySnapshot };
  private readonly skillSelector: (input: {
    taskGoal: string;
    snapshot: SkillRegistrySnapshot;
  }) => Promise<SkillSelectionResult>;
  private skillSnapshot?: SkillRegistrySnapshot;
  private beekeeperRuntime?: BeekeeperMcpRuntime;
  private beekeeperCapabilityReported = false;
  private credentialMcpRuntime?: CredentialMcpRuntime;
  private connectivityStore?: ConnectivityStore;
  private connectivityRuntimeCleanupComplete = false;
  private taskExecutorSandboxes = new Map<string, DockerTaskSandbox>();
  private networkFinalizations = new Map<string, Promise<void>>();
  private agents?: SecurityAgentRuntime;
  private supervisorInFlight = new Map<string, Promise<SupervisorVerdict>>();
  private supervisorAbortByEpoch = new Map<string, AbortController>();
  private activeSupervisorSessions = new Set<SecurityAgentSession>();
  private activePlannerSessions = new Set<SecurityAgentSession>();
  private activePlannerDelivery = new Map<SecurityAgentSession, ActivePlannerDeliveryState>();
  private plannerControlRevision = 0;
  private ownedPlannerSession?: SecurityAgentSession;
  private ownedPlannerLogging?: ReturnType<typeof attachExecutionLogging>;
  private lastPlannerDecisionView?: PlannerDecisionView;
  private lastPlannerDeliverySeq?: number;
  private pendingSupervisorRequests = new Map<string, {
    request: SupervisorCheckRequest;
    resolve: (signal: SupervisorVerdict) => void;
    reject: (error: unknown) => void;
  }>();
  private latestSupervisorThroughSeqByEpoch = new Map<string, number>();
  private activeProjectionJobCount = 0;
  private projectionRequestsClosed = false;
  private projectionCancellationRequested = false;
  private graphStoreClosed = false;
  private closePromise?: Promise<void>;
  private activeProjectorSessions = new Set<SecurityAgentSession>();
  private activeProjectorByTask = new Map<string, SecurityAgentSession>();
  private projectionContextByTask = new Map<string, ProjectionRequestContext>();
  private lastProjectionByTask = new Map<string, ObserverProjection>();
  private readonly projectorCoordinator: ProjectorCoordinator;
  private activeEpochs = new Map<string, ActiveTaskState>();
  private activeEpochIdByTask = new Map<string, string>();
  private activeTaskRuns = new Map<string, ActiveTaskRun>();
  private taskCompletionQueue: TaskCompletion[] = [];
  private taskCompletionWaiters = new Set<() => void>();
  private taskReconcileChain: Promise<void> = Promise.resolve();
  private awaitingPlannerTaskIds = new Set<string>();
  private taskSupervisionStates = new Map<string, TaskSupervisionState>();
  private readonly invocationAbortController = new AbortController();
  private readonly projectorInvocationAbortController = new AbortController();
  private stopRequestedReason?: string;
  private isolatedSessionsEnabled = false;
  private structuredInvocationsEnabled = false;
  private activeRun?: ActiveRunRecord;
  private currentUserGoal?: string;
  private reportingContext: ReportingContext = { taskType: "pentest" };

  constructor(input: {
    cwd: string;
    runtimeDir?: string;
    environment?: NodeJS.ProcessEnv;
    executorSandboxMode?: ExecutorSandboxRequestedMode;
    fofaRuntimeFactory?: (input: FofaMcpRuntimeOptions) => FofaMcpRuntime;
    beekeeperRuntimeFactory?: (input: BeekeeperMcpRuntimeOptions) => BeekeeperMcpRuntime;
    skillRegistry?: { scan(): SkillRegistrySnapshot };
    skillSelector?: (input: { taskGoal: string; snapshot: SkillRegistrySnapshot }) => Promise<SkillSelectionResult>;
  }) {
    this.cwd = input.cwd;
    this.runtimeDir = input.runtimeDir ?? join(input.cwd, ".agent-runtime");
    this.environment = input.environment;
    this.executorSandboxMode = input.executorSandboxMode;
    this.fofaRuntimeFactory = input.fofaRuntimeFactory ?? ((options) => new FofaMcpRuntime(options));
    this.beekeeperRuntimeFactory = input.beekeeperRuntimeFactory
      ?? ((options) => new BeekeeperMcpRuntime(options));
    this.skillRegistry = input.skillRegistry ?? new SkillRegistry(join(input.cwd, ".agents", "skills"));
    this.skillSelector = input.skillSelector ?? ((selectionInput) => selectSkillsForTask({
      ...selectionInput,
      cwd: this.cwd,
      llmRuntime: this.llmRuntime,
      providerAdmission: this.providerAdmission("planner")
    }));
    let fofaConfig: FofaConfig | undefined;
    let fofaConfigInvalid = false;
    try {
      fofaConfig = loadFofaConfig(input.environment ?? process.env);
    } catch {
      fofaConfigInvalid = true;
    }
    this.fofaConfig = fofaConfig;
    this.fofaConfigInvalid = fofaConfigInvalid;
    let beekeeperConfig: BeekeeperConfig | undefined;
    let beekeeperConfigInvalid = false;
    try {
      beekeeperConfig = loadBeekeeperConfig(input.environment ?? process.env, input.cwd);
    } catch {
      beekeeperConfigInvalid = true;
    }
    this.beekeeperConfig = beekeeperConfig;
    this.beekeeperConfigInvalid = beekeeperConfigInvalid;
    this.graphStore = new SQLiteGraphStore(
      join(this.runtimeDir, "state.sqlite"),
      join(this.runtimeDir, "graph-deltas.jsonl")
    );
    const databasePath = join(this.runtimeDir, "state.sqlite");
    this.executionLog = new ExecutionLog(join(this.runtimeDir, "execution.jsonl"), databasePath);
    this.artifactStore = new ArtifactStore(join(this.runtimeDir, "artifacts"), databasePath);
    this.runtimeStore = new RuntimeStore(databasePath);
    this.runId = this.runtimeStore.getOrCreateRunRef();
    this.llmRuntime = createLlmRuntime();
    this.projectorCoordinator = new ProjectorCoordinator({
      store: {
        raiseDesired: ({ taskId, desiredSeq, priority, terminalTargetSeq }) => this.runtimeStore.raiseProjectionDesired(
          taskId,
          desiredSeq,
          priority,
          terminalTargetSeq
        ),
        getState: (taskId) => this.runtimeStore.getProjectionState(taskId),
        listPending: () => this.runtimeStore.listPendingProjectionTasks(),
        clearTerminalTarget: ({ taskId, terminalTargetSeq }) => {
          this.runtimeStore.clearProjectionTerminalTarget(taskId, terminalTargetSeq);
        }
      },
      countObservations: (range) => this.countProjectionObservations(range),
      run: (work, signal) => this.runCoordinatedProjection(work, signal),
      onError: (error, work) => this.logProjectionCoordinatorError(error, work),
      globalConcurrency: MAX_ACTIVE_PROJECTION_JOBS,
      liveObservationThreshold: PROJECTOR_TOOL_WINDOW_SIZE,
      liveMaxAgeMs: positiveIntegerEnv("PROJECTOR_CATCHUP_DELAY_MS", DEFAULT_PROJECTOR_CATCHUP_DELAY_MS),
      normalBatchSize: PROJECTOR_MAX_OBSERVATIONS_PER_JOB,
      backlogThreshold: 32,
      backlogBatchSize: PROJECTOR_CATCHUP_MAX_OBSERVATIONS_PER_JOB,
      retryDelayMs: 2_000,
      closeDrainTimeoutMs: PROJECTION_DRAIN_TIMEOUT_MS
    });
  }

  async initialize(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true });
    try {
      this.skillSnapshot = this.skillRegistry.scan();
      await this.executionLog.append({
        role: "runtime",
        eventType: "skill_registry_scanned",
        summary: `Discovered ${this.skillSnapshot.skills.length} project skill(s)`,
        payload: {
          skills: this.skillSnapshot.skills.map((skill) => ({ name: skill.name, enabled: skill.enabled, valid: skill.valid })),
          diagnostics: this.skillSnapshot.diagnostics
        }
      });
    } catch (error) {
      this.skillSnapshot = { scannedAt: new Date().toISOString(), skills: [], diagnostics: [] };
      await this.executionLog.append({
        role: "runtime",
        eventType: "skill_registry_failed",
        summary: error instanceof Error ? error.message : String(error),
        payload: {}
      });
    }
    if (this.executorSandboxMode === "docker") {
      const persistedTaskIds = this.graphStore.query("task", [], 1_000_000).nodes
        .filter((node) => node.type === "Task")
        .map((node) => node.id)
        .sort();
      this.connectivityStore = new ConnectivityStore(join(this.runtimeDir, "state.sqlite"));
      this.connectivityRuntime = new ConnectivityRuntime({
        runtimeDir: this.runtimeDir,
        runRef: this.runId,
        artifactStore: this.artifactStore,
        executionLog: this.executionLog,
        connectivityStore: this.connectivityStore,
        knownTaskIds: persistedTaskIds
      });
      await this.connectivityRuntime.start();
      await this.executionLog.append({
        role: "runtime",
        eventType: "executor_sandbox_ready",
        summary: "docker task sandbox backend ready",
        payload: {
          runId: this.runId,
          mode: "docker",
          workspace: "/workspace",
          transparentGateway: true
        }
      });
    } else {
      this.executorSandbox = await createExecutorSandbox({
        runtimeDir: this.runtimeDir,
        runId: this.runId,
        mode: this.executorSandboxMode,
        environment: this.environment,
        additionalReadRoots: projectSkillsDirs(this.cwd)
      });
      await this.executionLog.append({
        role: "runtime",
        eventType: "executor_sandbox_ready",
        summary: `${this.executorSandbox.mode} sandbox ready`,
        payload: {
          runId: this.runId,
          mode: this.executorSandbox.mode,
          backendPath: this.executorSandbox.backendPath,
          root: this.executorSandbox.root,
          allowedReadRoots: this.executorSandbox.allowedReadRoots
        }
      });
    }
    this.isolatedSessionsEnabled = true;
    this.structuredInvocationsEnabled = true;
    await this.restorePlannerHandoffs();
    if (this.runtimeStore.recoveredProjectionClaims > 0) {
      await this.executionLog.append({
        role: "runtime",
        eventType: "projection_recovered",
        summary: `Recovered ${this.runtimeStore.recoveredProjectionClaims} interrupted projection claim(s)`,
        payload: { recoveredProjectionClaims: this.runtimeStore.recoveredProjectionClaims }
      });
    }
    for (const projectionState of this.runtimeStore.listPendingProjectionTasks()) {
      const taskEnvelope = this.graphStore.getTaskEnvelope(projectionState.taskId);
      if (!taskEnvelope) {
        await this.executionLog.append({
          taskId: projectionState.taskId,
          role: "runtime",
          eventType: "projection_request_discarded",
          summary: "Recovered projection has no task envelope",
          payload: { projectionState }
        });
        continue;
      }
      this.rememberProjectionContext({
        reason: "projection_recovered",
        taskEnvelope,
        desiredSeq: projectionState.desiredSeq,
        terminal: true,
        queueId: `projection:${randomUUID()}`,
        queuedAt: Date.now()
      });
      await this.projectorCoordinator.request({
        taskId: projectionState.taskId,
        desiredSeq: projectionState.desiredSeq,
        priority: Math.max(10, projectionState.priority),
        terminal: true
      });
    }
    this.projectorCoordinator.start();
    this.credentialMcpRuntime = new CredentialMcpRuntime({
      artifactStoreRoot: this.artifactStore.rootDir,
      artifactStoreDb: this.artifactStore.databasePath,
      executionLog: this.executionLog
    });
    await this.credentialMcpRuntime.configure();
    await this.executionLog.append({
      role: "runtime",
      eventType: "credential_mcp_ready",
      summary: "Credential MCP Runtime ready",
      payload: { enabled: true }
    });
  }

  hasConnectivityRuntime(): boolean {
    return Boolean(this.connectivityRuntime);
  }

  async inferScopeFromGoal(userGoal: string): Promise<string> {
    const resolver = await createScopeResolverAgentSession({
      cwd: this.cwd,
      llmRuntime: this.llmRuntime,
      providerAdmission: this.providerAdmission("planner")
    });
    const logging = attachExecutionLogging({
      session: resolver.session,
      executionLog: this.executionLog,
      artifactStore: this.artifactStore,
      role: "planner"
    });
    try {
      const resolution = await invokeStructured<ScopeResolution>(
        resolver.session,
        `<user_goal>\n${userGoal}\n</user_goal>\n提取明确出现的 IPv4 地址和 CIDR。`,
        {
          toolName: "scope_submit",
          idleTimeoutMs: 60_000,
          hardTimeoutMs: 120_000,
          terminateOnToolError: true,
          validate: (value) => {
            if (!value || typeof value !== "object" || !Array.isArray((value as { cidrs?: unknown }).cidrs)) {
              throw new Error("scope_submit must contain cidrs");
            }
            return { cidrs: (value as { cidrs: unknown[] }).cidrs.map(String) };
          },
          admission: this.providerAdmission("planner")
        }
      );
      const scopeSummary = normalizeInferredScopeCidrs(userGoal, resolution.cidrs);
      await this.executionLog.append({
        role: "runtime",
        eventType: "scope_inferred",
        summary: scopeSummary,
        payload: { source: "goal", scopeSummary }
      });
      return scopeSummary;
    } finally {
      logging();
      await logging.drain();
      disposeSession(resolver.session);
    }
  }

  routeStatus(routeRef?: string): Promise<RouteStatus[]> {
    return this.requireConnectivityRuntime().routeStatus(routeRef);
  }

  async configureTransparentProxy(
    proxy: TransparentSocks5ProxyConfig,
    scopeSummary: string
  ): Promise<RouteStatus> {
    const runtime = this.requireConnectivityRuntime();
    await runtime.configureAuthorizedScope(scopeSummary);
    const authorizedScope = parseAuthorizedScope(scopeSummary);
    const credential = await this.artifactStore.writeCredential({
      data: proxy.password,
      scopeRef: this.runId,
      kind: "password",
      label: "transparent_proxy_password",
      source: "auto_output"
    });
    const route = await runtime.replaceTransparentProxy({
      connector: "socks5",
      pivotHostRef: proxy.host,
      dialAddress: proxy.host,
      targetCidrs: authorizedScope.domains.length > 0 ? ["0.0.0.0/0"] : authorizedScope.cidrs,
      credentialRef: credential.artifactRef,
      options: { port: proxy.port, user: proxy.username }
    });
    await this.executionLog.append({
      role: "runtime",
      eventType: "transparent_proxy_configured",
      summary: `transparent SOCKS5 proxy ${transparentProxyEndpoint(proxy)} enabled`,
      payload: {
        routeRef: route.routeRef,
        proxyEndpoint: transparentProxyEndpoint(proxy),
        targetCidrs: route.targetCidrs,
        status: route.status
      }
    });
    return route;
  }

  routeStop(routeRef: string): Promise<RouteStatus> {
    return this.requireConnectivityRuntime().stopRoute(routeRef);
  }

  routeReconnect(routeRef: string): Promise<RouteStatus> {
    return this.requireConnectivityRuntime().reconnectRoute(routeRef);
  }

  routeForget(routeRef: string): Promise<RouteStatus> {
    return this.requireConnectivityRuntime().forgetRoute(routeRef);
  }

  replayTraffic(client: MitmFlowClient, input: GatewayReplayInput): Promise<TrafficReplayResult> {
    return this.requireConnectivityRuntime().replayTraffic(client, input);
  }

  async runOnce(input: { userGoal: string; scopeSummary: string; maxParallelTasks?: number }): Promise<{
    plannerDecision: PlannerDecision;
    taskEnvelope?: TaskEnvelope;
    taskEnvelopes?: TaskEnvelope[];
    taskResult?: TaskResult;
    taskResults?: TaskResult[];
    graphDelta?: GraphDelta;
    controlSignal?: ControlSignal;
    quiescent: boolean;
  }> {
    await this.ensureRootGraph(input);
    const plannerVisibleWaitingTaskIds = new Set(this.awaitingPlannerTaskIds);
    let plannerDecision!: PlannerDecision;
    let taskEnvelopes: TaskEnvelope[] = [];
    let releasedTaskIds: string[] = [];
    let repairFeedback: string | undefined;
    for (let decisionAttempt = 1; decisionAttempt <= PLANNER_DECISION_REPAIR_ATTEMPTS; decisionAttempt += 1) {
      try {
        const credentialSummary = await this.buildCredentialSummary(input.scopeSummary);
        const enrichedScopeSummary = input.scopeSummary + credentialSummary;
        const invocation = await this.invokePlannerCycle({
          userGoal: this.reportingGoal(input.userGoal),
          scopeSummary: enrichedScopeSummary,
          repairFeedback
        });
        plannerDecision = invocation.plannerDecision;
        await this.executionLog.append({
          role: "runtime",
          eventType: "planner_prompt_completed",
          summary: "commands",
          payload: {
            plannerPromptId: invocation.plannerPromptId,
            decisionAttempt,
            reason: plannerDecision.reason
          }
        });
        const plannerEvent = await this.executionLog.append({
          role: "planner",
          eventType: "planner_apply_commands",
          summary: plannerDecision.reason,
          payload: { plannerDecision, decisionAttempt }
        });
        taskEnvelopes = await this.applyPlannerCommands(
          plannerDecision,
          input.scopeSummary,
          plannerEvent.id,
          invocation.versionSnapshot
        );
        releasedTaskIds = await this.releasePlannerWaitingTasks(plannerDecision, plannerVisibleWaitingTaskIds);
        this.assertPlannerIdleDecisionCanContinue(plannerDecision, releasedTaskIds);
        break;
      } catch (error) {
        if (!(error instanceof GraphValidationError)) {
          throw error;
        }
        const repairAttemptsExhausted = decisionAttempt >= PLANNER_DECISION_REPAIR_ATTEMPTS;
        repairFeedback = error instanceof IncompletePlannerTerminalDecisionError
          ? "上一版 Planner 决策留下了不明确终态：Root Goal 仍为 open，commands 为空，并且当前没有 active、pending 或 runnable Task。请明确选择一种结果：用 set_node_status 将 goal:root 设置为 completed 或 blocked；或者创建、恢复能继续推进 Root Goal 的 Task。不得只在 reason 中声明目标已经完成。"
          : error instanceof PlannerDecisionConflict
          ? `上一版 Planner 决策因任务版本冲突被拒绝：${error.message}。请基于刷新后的任务状态重新规划。`
          : `上一版 Planner 决策未修改任务图，因图语义校验失败被拒绝：${error.message}。请修正命令；若新证据来自当前 Task 的后继 Task，不要反转依赖，应创建同时依赖相关前驱的新后继 Task。`;
        await this.executionLog.append({
          role: "runtime",
          eventType: error instanceof PlannerDecisionConflict
            ? "planner_decision_conflict"
            : "planner_decision_rejected",
          summary: error.message,
          payload: {
            decisionAttempt,
            ...(error instanceof PlannerDecisionConflict ? { conflicts: error.conflicts } : {}),
            ...(error instanceof ActiveTaskMutationError ? { activeTaskIds: error.taskIds } : {}),
            repairAttemptsExhausted,
            repairFeedback
          }
        });
        if (repairAttemptsExhausted) {
          throw new PlannerDecisionRepairExhaustedError(error);
        }
      }
    }
    if (this.isRootGoalStatus("completed") || this.isRootGoalStatus("blocked")) {
      return {
        plannerDecision,
        taskEnvelope: taskEnvelopes[0],
        taskEnvelopes,
        taskResults: [],
        quiescent: false
      };
    }
    const taskExecutions = await this.runReadyTaskGraph({
      maxParallelTasks: input.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS
    });
    const firstExecution = taskExecutions[0];
    return {
      plannerDecision,
      taskEnvelope: firstExecution?.taskEnvelope ?? taskEnvelopes[0],
      taskEnvelopes,
      taskResult: firstExecution?.taskResult,
      taskResults: taskExecutions.flatMap((execution) => execution.taskResult ? [execution.taskResult] : []),
      graphDelta: firstExecution?.graphDelta,
      controlSignal: firstExecution?.controlSignal,
      quiescent: (plannerDecision.commands?.length ?? 0) === 0
        && releasedTaskIds.length === 0
        && taskExecutions.length === 0
        && this.activeTaskRuns.size === 0
    };
  }

  async runUntilDone(input: {
    userGoal: string;
    scopeSummary: string;
    taskType?: TaskType;
    reportingContext?: ReportingContext;
    maxPlannerCycles?: number;
    maxParallelTasks?: number;
    maxRunTimeMs?: number;
  }): Promise<RunResult> {
    this.reportingContext = input.reportingContext ?? { taskType: input.taskType ?? "pentest" };
    this.reportingContext = { ...this.reportingContext, taskType: input.taskType ?? this.reportingContext.taskType ?? "pentest" };
    await this.connectivityRuntime?.configureAuthorizedScope(input.scopeSummary);
    await this.configureFofaRuntime(input.scopeSummary);
    await this.configureBeekeeperRuntime();
    const maxPlannerCycles = input.maxPlannerCycles ?? 8;
    const maxParallelTasks = normalizeParallelTaskLimit(input.maxParallelTasks);
    const maxRunTimeMs = normalizeRunTimeBudgetMs(input.maxRunTimeMs);
    const cycles: Array<Awaited<ReturnType<SecurityAgentController["runOnce"]>>> = [];
    const invocationId = `run:${randomUUID()}`;
    const startedAt = Date.now();
    const deadlineAt = startedAt + maxRunTimeMs;
    const runStartedEvent = await this.executionLog.append({
      role: "runtime",
      eventType: "run_started",
      summary: input.userGoal,
      payload: {
        invocationId,
        runId: this.runId,
        userGoal: input.userGoal,
        scopeSummary: input.scopeSummary,
        taskType: this.reportingContext.taskType,
        templateDigest: this.reportingContext.templateDigest,
        reportTemplatePath: this.reportingContext.reportTemplatePath,
        scoringTemplatePath: this.reportingContext.scoringTemplatePath,
        maxPlannerCycles,
        maxParallelTasks,
        maxRunTimeMs,
        deadlineAt: new Date(deadlineAt).toISOString(),
        structuredInvocationsEnabled: this.structuredInvocationsEnabled,
        runtimeDir: this.runtimeDir,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        llm: this.llmRuntime.metadata,
        sandbox: this.executorSandbox ? {
          mode: this.executorSandbox.mode,
          backendPath: this.executorSandbox.backendPath,
          root: this.executorSandbox.root
        } : undefined,
        projector: {
          toolWindowSize: PROJECTOR_TOOL_WINDOW_SIZE,
          maxObservationsPerJob: PROJECTOR_MAX_OBSERVATIONS_PER_JOB,
          maxActiveJobs: MAX_ACTIVE_PROJECTION_JOBS,
          idleTimeoutMs: PROJECTOR_IDLE_TIMEOUT_MS,
          hardTimeoutMs: PROJECTOR_HARD_TIMEOUT_MS,
          inputTargetBytes: PROJECTOR_INPUT_TARGET_BYTES
        },
        supervisor: {
          turnWindowSize: SUPERVISOR_TURN_WINDOW_SIZE,
          idleTimeoutMs: SUPERVISOR_IDLE_TIMEOUT_MS,
          hardTimeoutMs: SUPERVISOR_HARD_TIMEOUT_MS
        },
        planner: {
          idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
          hardTimeoutMs: PLANNER_HARD_TIMEOUT_MS,
          freshSessionAttempts: PLANNER_FRESH_SESSION_ATTEMPTS
        },
        defaultTaskBudget: DEFAULT_TASK_BUDGET,
        minTaskBudget: MIN_TASK_BUDGET,
        maxTaskBudget: MAX_TASK_BUDGET
      }
    });
    this.activeRun = {
      invocationId,
      startedAt,
      maxRunTimeMs,
      deadlineAt,
      startSeq: runStartedEvent.seq ?? 0
    };
    await this.ensureRootGraph(input);
    await this.runReadyTaskGraph({ maxParallelTasks });
    const decideRun = async (result: RunResult): Promise<RunResult> => {
      if (this.activeRun?.invocationId === invocationId) {
        this.activeRun.outcome = result;
      }
      await this.executionLog.append({
        role: "runtime",
        eventType: "run_result_decided",
        summary: result.stoppedReason,
        payload: {
          invocationId,
          completed: result.completed,
          stoppedReason: result.stoppedReason,
          plannerCycleCount: result.cycles.length,
          durationMs: Date.now() - startedAt
        }
      });
      return result;
    };
    try {
      let cycleIndex = 0;
      let deferredPlannerFailures = 0;
      let consecutiveNoProgressPlannerCycles = 0;
      while (consecutiveNoProgressPlannerCycles < maxPlannerCycles) {
        if (this.stopRequestedReason) {
          return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
        }
        if (Date.now() >= deadlineAt) {
          return await decideRun({
            cycles,
            completed: false,
            stoppedReason: `Reached global run time budget: ${maxRunTimeMs}ms`
          });
        }
        let cycleResult: Awaited<ReturnType<SecurityAgentController["runOnce"]>>;
        try {
          cycleResult = await this.runOnce({ ...input, maxParallelTasks });
        } catch (error) {
          if (this.stopRequestedReason) {
            return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
          }
          if (Date.now() >= deadlineAt) {
            return await decideRun({
              cycles,
              completed: false,
              stoppedReason: `Reached global run time budget: ${maxRunTimeMs}ms`
            });
          }
          if (!isRetryablePlannerInvocationError(error)) {
            throw error;
          }
          deferredPlannerFailures += 1;
          if (deferredPlannerFailures >= PLANNER_MAX_DEFERRED_FAILURES) {
            return await decideRun({
              cycles,
              completed: false,
              stoppedReason: `Planner unavailable after ${deferredPlannerFailures} consecutive deferred failures: ${errorMessageFromUnknown(error) ?? "unknown error"}`
            });
          }
          const backoffMs = Math.min(
            PLANNER_DEFER_BACKOFF_MAX_MS,
            PLANNER_FRESH_SESSION_BACKOFF_MS * 2 ** Math.min(deferredPlannerFailures - 1, 5)
          );
          await this.executionLog.append({
            role: "runtime",
            eventType: "planner_cycle_deferred",
            summary: errorMessageFromUnknown(error) ?? "Planner temporarily unavailable",
            payload: {
              invocationId,
              cycleIndex,
              deferredPlannerFailures,
              backoffMs,
              plannerCycleCount: cycles.length
            }
          });
          await sleep(backoffMs);
          continue;
        }
        deferredPlannerFailures = 0;
        cycles.push(cycleResult);
        cycleIndex += 1;
        const plannerCycleMadeProgress = (cycleResult.plannerDecision.commands?.length ?? 0) > 0
          || (cycleResult.taskResults?.length ?? 0) > 0;
        consecutiveNoProgressPlannerCycles = plannerCycleMadeProgress
          ? 0
          : consecutiveNoProgressPlannerCycles + 1;
        if (this.stopRequestedReason) {
          return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
        }
        if (this.isRootGoalStatus("completed")) {
          return await decideRun({ cycles, completed: true, stoppedReason: cycleResult.plannerDecision.reason });
        }
        if (this.isRootGoalStatus("blocked")) {
          return await decideRun({ cycles, completed: false, stoppedReason: cycleResult.plannerDecision.reason });
        }
        if (cycleResult.quiescent) {
          return await decideRun({
            cycles,
            completed: false,
            stoppedReason: `Runtime quiescent after Planner decision: ${cycleResult.plannerDecision.reason}`
          });
        }
      }
      const taskGraphDrained = await this.drainReadyTaskGraph({ maxParallelTasks, deadlineAt });
      if (this.stopRequestedReason) {
        return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
      }
      if (!taskGraphDrained || Date.now() >= deadlineAt) {
        return await decideRun({
          cycles,
          completed: false,
          stoppedReason: `Reached global run time budget: ${maxRunTimeMs}ms`
        });
      }
      return await decideRun({
        cycles,
        completed: false,
        stoppedReason: `Reached max consecutive no-progress planner cycles: ${maxPlannerCycles}`
      });
    } catch (error) {
      if (this.stopRequestedReason) {
        return await decideRun({ cycles, completed: false, stoppedReason: this.stopRequestedReason });
      }
      const stoppedReason = error instanceof Error ? error.message : String(error);
      if (this.activeRun?.invocationId === invocationId) {
        this.activeRun.outcome = { completed: false, stoppedReason, failed: true };
      }
      await this.executionLog.append({
        role: "runtime",
        eventType: "run_failed",
        summary: stoppedReason,
        payload: { invocationId, durationMs: Date.now() - startedAt, error: stoppedReason }
      });
      throw error;
    }
  }

  private reportingGoal(userGoal: string): string {
    const context = this.reportingContext;
    const filename = context.taskType === "ctf" ? "writeup.md" : "pentest-report.md";
    const requirements = context.taskType === "ctf"
      ? "完成后必须生成可复现的 writeup.md，包含题目摘要、关键步骤、脚本/命令和最终 Flag。"
      : `完成后必须生成 ${filename}，只使用已验证证据，并遵循评分标准和报告模板；必须包含攻击路径、成果评分、证据、账号密码来源、代码详情和 AI 使用说明。`;
    const template = context.taskType === "pentest"
      ? `评分标准：\n${(context.scoringText ?? "未加载评分标准").slice(0, 12000)}\n报告模板：\n${(context.reportText ?? "未加载报告模板").slice(0, 12000)}`
      : "";
    return `${userGoal}\n\n<reporting_context>\n任务类型：${context.taskType}\n${requirements}\n${template}\n</reporting_context>`;
  }

  async requestStop(reason: string): Promise<void> {
    if (this.stopRequestedReason) {
      return;
    }
    this.stopRequestedReason = reason;
    this.invocationAbortController.abort(reason);
    const fofaStop = this.fofaRuntime?.close(reason);
    const beekeeperStop = this.beekeeperRuntime?.close(reason);
    const credentialStop = this.credentialMcpRuntime?.close(reason);
    this.projectionRequestsClosed = true;
    this.projectionCancellationRequested = true;
    this.projectorInvocationAbortController.abort(reason);
    await this.executionLog.append({
      role: "runtime",
      eventType: "run_interrupted",
      summary: reason,
      payload: {
        invocationId: this.activeRun?.invocationId,
        activeEpochIds: [...this.activeEpochs.keys()],
        activePlannerCount: this.activePlannerSessions.size,
        activeSupervisorCount: this.activeSupervisorSessions.size,
        activeProjectorCount: this.activeProjectorSessions.size
      }
    });
    const executorTerminations: Promise<void>[] = [];
    for (const state of this.activeEpochs.values()) {
      if (state.lifecycleState === "closed") {
        continue;
      }
      state.executorStopRequested = true;
      state.abortContext = { kind: "controller_abort", reason };
      executorTerminations.push(this.terminateExecutorSession(state));
    }
    for (const session of this.activePlannerSessions) {
      void session.abort();
    }
    for (const session of this.activeSupervisorSessions) {
      void session.abort();
    }
    for (const session of this.activeProjectorSessions) {
      void session.abort();
    }
    await Promise.allSettled(executorTerminations);
    await Promise.allSettled([...this.activeTaskRuns.values()].map((run) => run.promise));
    await this.closeExecutorResources();
    await this.projectorCoordinator.close({ drain: false });
    await fofaStop;
    await beekeeperStop;
    await credentialStop;
  }

  private async finalizeRunMetrics(): Promise<void> {
    const activeRun = this.activeRun;
    if (!activeRun) {
      return;
    }
    const eventMetrics = this.executionLog.metrics(activeRun.startSeq);
    await this.executionLog.append({
      role: "runtime",
      eventType: "run_completed",
      summary: activeRun.outcome?.stoppedReason ?? "Controller closed without a run outcome",
      payload: {
        invocationId: activeRun.invocationId,
        runId: this.runId,
        completed: activeRun.outcome?.completed ?? false,
        stoppedReason: activeRun.outcome?.stoppedReason ?? "Controller closed without a run outcome",
        durationMs: Date.now() - activeRun.startedAt,
        costCurrency: this.llmRuntime.metadata.costCurrency,
        eventMetrics,
        runtimeMetrics: this.runtimeStore.stats(),
        graphMetrics: this.graphStore.stats(),
        artifactMetrics: this.artifactStore.stats()
      }
    });
    this.activeRun = undefined;
  }

  private async appendInvocationMetrics(input: {
    session: SecurityAgentSession;
    before?: PiSessionStatsSnapshot;
    invocationId: string;
    invocationKind: "planner" | "executor" | "supervisor" | "projector";
    agentRole: "planner" | "executor" | "observer";
    status: string;
    startedAt: number;
    taskId?: string;
    epochId?: string;
    inputBytes?: number;
    details?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const after = readPiSessionStats(input.session);
      if (!after) {
        return;
      }
      const stats = diffPiSessionStats(input.before, after);
      await this.executionLog.append({
        epochId: input.epochId,
        taskId: input.taskId,
        role: "runtime",
        eventType: "invocation_metrics",
        summary: `${input.invocationKind}:${input.status} tokens=${stats.usage.totalTokens} cost=${stats.usage.cost.total.toFixed(6)} ${this.llmRuntime.metadata.costCurrency}`,
        payload: {
          invocationId: input.invocationId,
          invocationKind: input.invocationKind,
          agentRole: input.agentRole,
          status: input.status,
          durationMs: Date.now() - input.startedAt,
          inputBytes: input.inputBytes,
          model: this.llmRuntime.metadata,
          sessionId: after.sessionId,
          stats,
          contextUsage: after.contextUsage,
          ...input.details
        }
      });
    } catch (error) {
      try {
        await this.executionLog.append({
          epochId: input.epochId,
          taskId: input.taskId,
          role: "runtime",
          eventType: "metrics_collection_failed",
          summary: error instanceof Error ? error.message : String(error),
          payload: {
            invocationId: input.invocationId,
            invocationKind: input.invocationKind,
            status: input.status
          }
        });
      } catch {
      }
    }
  }

  close(input: {
    drainProjectionJobs?: boolean;
    projectionDrainTimeoutMs?: number;
    projectionCancelGraceMs?: number;
  } = {}): Promise<void> {
    if (this.graphStoreClosed) {
      return Promise.resolve();
    }
    this.closePromise ??= this.closeInternal(input).catch((error: unknown) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private async closeInternal(input: {
    drainProjectionJobs?: boolean;
    projectionDrainTimeoutMs?: number;
    projectionCancelGraceMs?: number;
  }): Promise<void> {
    this.invocationAbortController.abort("Controller shutdown");
    const executorTerminations: Array<{ state: ActiveTaskState; promise: Promise<void> }> = [];
    for (const state of [...this.activeEpochs.values()]) {
      if (state.lifecycleState === "closed") {
        continue;
      }
      state.lifecycleState = "closing";
      state.abortContext = { kind: "controller_abort", reason: "Controller shutdown" };
      executorTerminations.push({ state, promise: this.terminateExecutorSession(state) });
    }
    await Promise.allSettled(executorTerminations.map((item) => item.promise));
    await Promise.allSettled([...this.activeTaskRuns.values()].map((run) => run.promise));
    this.projectionRequestsClosed = true;
    for (const state of [...this.activeEpochs.values()]) {
      this.scheduleExecutorNetworkFinalization(state);
      this.finishTaskExecution(state.taskEnvelope.taskId, "shutdown");
    }
    await Promise.allSettled([...(this.networkFinalizations?.values() ?? [])]);
    await this.closeExecutorResources();
    await this.fofaRuntime?.close("Controller shutdown");
    await this.beekeeperRuntime?.close("Controller shutdown");
    await this.credentialMcpRuntime?.close("Controller shutdown");
    for (const pending of [...this.pendingSupervisorRequests.values()]) {
      void this.discardSupervisorCheck(
        pending.request,
        "controller is closing",
        pending.request.sourceEventIds ?? []
      ).then(pending.resolve, pending.reject);
    }
    this.pendingSupervisorRequests.clear();
    for (const session of [...this.activeSupervisorSessions]) {
      void session.abort();
    }
    for (const session of [...this.activePlannerSessions]) {
      void session.abort();
    }
    if (this.supervisorInFlight.size > 0) {
      await raceWithTimeout(
        Promise.allSettled([...this.supervisorInFlight.values()]).then(() => "drained" as const),
        2_000
      );
    }
    const drainProjectionJobs = input.drainProjectionJobs !== false;
    if (!drainProjectionJobs) {
      this.projectionCancellationRequested = true;
      this.projectorInvocationAbortController.abort("Controller shutdown cancelled projection drain");
    }
    const projectionClose = await this.projectorCoordinator.close({
      drain: drainProjectionJobs,
      timeoutMs: input.projectionDrainTimeoutMs ?? PROJECTION_DRAIN_TIMEOUT_MS,
      cancelGraceMs: input.projectionCancelGraceMs ?? PROJECTION_CANCEL_GRACE_MS
    });
    if (!projectionClose.drained) {
      this.projectionCancellationRequested = true;
    }
    this.projectorInvocationAbortController.abort("Controller projection shutdown complete");
    if (!projectionClose.drained) {
      await this.executionLog.append({
        role: "runtime",
        eventType: "projection_jobs_cancelled",
        summary: drainProjectionJobs
          ? `Controller close cancelled projections after drain timeout`
          : `Controller close cancelled projections without drain`,
        payload: {
          pendingTaskIds: projectionClose.pendingTaskIds,
          activeProjectionJobCount: this.activeProjectionJobCount,
          cancelGraceMs: input.projectionCancelGraceMs ?? PROJECTION_CANCEL_GRACE_MS
        }
      });
    }
    const projectorSettled = await this.projectorCoordinator.waitForSettled(0);
    if (!projectorSettled) {
      await this.executionLog.drain();
      throw new Error(
        "Controller close could not settle cancelled projector work; stores remain open and close may be retried"
      );
    }
    if (this.ownedPlannerSession) {
      await this.ownedPlannerLogging?.drain();
      this.ownedPlannerLogging?.();
      disposeSession(this.ownedPlannerSession);
      this.ownedPlannerSession = undefined;
      this.ownedPlannerLogging = undefined;
    }
    await this.finalizeRunMetrics();
    await this.executionLog.drain();
    this.graphStoreClosed = true;
    this.graphStore.close();
    this.runtimeStore.close();
    this.artifactStore.close();
    this.executionLog.close();
  }

  private requireAgents(): SecurityAgentRuntime {
    if (!this.agents) {
      throw new Error("Controller is not initialized");
    }
    return this.agents;
  }

  private isRootGoalStatus(status: string): boolean {
    return this.graphStore
      .query("task", ["goal:root"], 1)
      .nodes
      .some((node) => node.id === "goal:root" && node.properties.status === status);
  }

  private buildPlannerDecisionView(): PlannerDecisionView {
    const view = this.graphStore.plannerDecisionView();
    const taskOutcomes = this.runtimeStore.listTaskOutcomes(Number.MAX_SAFE_INTEGER);
    const statusByTaskId = new Map(view.taskLedger.map((task) => [task.taskId, task.status]));
    const taskLedger = view.taskLedger.map((task) => {
      const projectionState = this.runtimeStore.getProjectionState(task.taskId);
      const readiness = deriveTaskDefinitionReadiness(task.dependsOnTaskRefs, statusByTaskId);
      const running = this.activeTaskRuns.has(task.taskId) || this.activeEpochIdByTask.has(task.taskId);
      const awaitingPlanner = this.awaitingPlannerTaskIds.has(task.taskId);
      const taskEnvelope = this.graphStore.getTaskEnvelope(task.taskId);
      const maxTurns = normalizeTaskBudget(taskEnvelope?.budget).maxTurns;
      const consumedTurns = this.runtimeStore.getTaskConsumedTurns(task.taskId);
      const remainingTaskTurns = Math.max(0, maxTurns - consumedTurns);
      const terminalDefinition = ["completed", "blocked", "failed", "archived"].includes(task.status);
      const includeDecisionDefinition = !["completed", "archived"].includes(task.status);
      return {
        ...task,
        ...(includeDecisionDefinition && taskEnvelope ? {
          goal: taskEnvelope.goal,
          targetRefs: taskEnvelope.targetRefs,
          basisRefs: taskEnvelope.basisRefs,
          scopeRef: taskEnvelope.scopeRef,
          successCriteria: taskEnvelope.successCriteria,
          goalAdditions: taskEnvelope.goalAdditions,
          parentTaskId: taskEnvelope.parentTaskId,
          dependsOnTaskRefs: taskEnvelope.dependsOnTaskRefs
        } : {}),
        ready: task.status === "open"
          && readiness.blockedByTaskRefs.length === 0
          && !running
          && !awaitingPlanner
          && remainingTaskTurns > 0,
        executionState: terminalDefinition
          ? undefined
          : running
          ? "running" as const
          : awaitingPlanner || remainingTaskTurns === 0
            ? "awaiting_planner" as const
            : readiness.blockedByTaskRefs.length > 0
              ? "blocked" as const
              : "queued" as const,
        maxTurns,
        consumedTurns,
        remainingTurns: remainingTaskTurns,
        ...readiness,
        projection: {
          committedSeq: projectionState.committedSeq,
          desiredSeq: projectionState.desiredSeq
        }
      };
    });
    const epochOutcomes = taskLedger.flatMap((task) => (
      this.runtimeStore.listTaskEpochOutcomes(task.taskId, 1)
    ));
    return {
      ...view,
      taskLedger,
      taskOutcomes,
      epochOutcomes,
      projectionDegradations: taskLedger.flatMap((task) => {
        const projectionState = this.runtimeStore.getProjectionState(task.taskId);
        if (projectionState.desiredSeq <= projectionState.committedSeq
          && projectionState.terminalTargetSeq === undefined) {
          return [];
        }
        return [{
          taskRef: task.taskId,
          status: "degraded" as const,
          reason: projectionState.terminalTargetSeq === undefined
            ? "projection_watermark_lag" as const
            : "terminal_projection_incomplete" as const,
          committedSeq: projectionState.committedSeq,
          desiredSeq: projectionState.desiredSeq,
          terminalTargetSeq: projectionState.terminalTargetSeq
        }];
      })
    };
  }

  private async ensureRootGraph(input: { userGoal: string; scopeSummary: string }): Promise<void> {
    this.currentUserGoal = input.userGoal;
    const goalId = "goal:root";
    const scopeId = "scope:root";
    const existingGoal = this.graphStore.query("task", [goalId], 1).nodes.find((node) => node.id === goalId);
    const existingScope = this.graphStore.query("task", [scopeId], 1).nodes.find((node) => node.id === scopeId);
    this.graphStore.upsertDelta({
      sourceEventIds: [],
      nodes: [
        {
          id: goalId,
          graphKind: "task",
          type: "Goal",
          label: input.userGoal,
          properties: { ...(existingGoal?.properties ?? {}), status: existingGoal?.properties.status ?? "open" }
        },
        {
          id: scopeId,
          graphKind: "task",
          type: "Scope",
          label: "Authorized scope",
          properties: { ...(existingScope?.properties ?? {}), summary: input.scopeSummary }
        }
      ],
      edges: [
        { from: goalId, to: scopeId, type: "within_scope" }
      ]
    });
  }

  private taskEnvelopeFromSpec(taskSpec: PlannerTaskSpec, scopeSummary: string): TaskEnvelope {
    const taskId = taskSpec.id;
    const budget = normalizeInitialTaskBudget(taskSpec.budget);
    const constraints = [`授权范围原文：${scopeSummary}`];
    const dependsOnTaskRefs = dedupeStrings(taskSpec.dependsOnTaskRefs ?? []);
    const parentTaskId = taskSpec.parentTaskId ?? "goal:root";
    return {
      taskId,
      goal: taskSpec.goal,
      targetRefs: taskSpec.targetRefs,
      scopeRef: taskSpec.scopeRef,
      constraints,
      successCriteria: taskSpec.successCriteria,
      goalAdditions: [],
      dependsOnTaskRefs,
      continueFromTaskRef: taskSpec.continueFromTaskRef,
      parentTaskId,
      budget
    };
  }

  private normalizePlannerDecisionBoundary(value: unknown): PlannerDecision {
    const plannerDecision = normalizePlannerDecision(value);
    const commands = plannerDecision.commands ?? [];
    const taskCommands = commands.filter((command): command is PlannerTaskCommand =>
      command.kind === "patch_task"
      || command.kind === "replace_dependencies"
      || command.kind === "set_task_status");
    const activeTaskIds = new Set([
      ...this.activeTaskRuns.keys(),
      ...this.activeEpochIdByTask.keys()
    ]);
    const activeTaskMutations = taskCommands
      .filter((command) => activeTaskIds.has(command.taskId));
    if (activeTaskMutations.length > 0) {
      throw new ActiveTaskMutationError(
        dedupeStrings(activeTaskMutations.map((command) => command.taskId))
      );
    }
    return plannerDecision;
  }

  private async applyPlannerCommands(
    plannerDecision: PlannerDecision,
    scopeSummary: string,
    plannerEventId: string,
    versionSnapshot: Record<string, number>
  ): Promise<TaskEnvelope[]> {
    const createdTaskEnvelopes: TaskEnvelope[] = [];
    const commands = plannerDecision.commands ?? [];
    const taskCommands: Array<{ command: PlannerTaskCommand; commandIndex: number }> = [];
    const nodeStatusCommands: Array<{ command: PlannerNodeStatusCommand; commandIndex: number }> = [];
    let rejectedCommand: unknown;
    try {
      const budgetPatchByCommandIndex = this.resolvePlannerBudgetPatches(commands);
      const taskCreateInputs: Array<{
        command: PlannerCreateTasksCommand;
        taskEnvelope: TaskEnvelope;
        priority: number;
      }> = [];
      commands.forEach((command, commandIndex) => {
        if (command.kind === "create_tasks") {
          const basisRefs = dedupeStrings(command.basedOnRefs ?? []);
          const taskEnvelopes = command.tasks.map((taskSpec) => ({
            ...this.taskEnvelopeFromSpec(taskSpec, scopeSummary),
            basisRefs
          }));
          taskEnvelopes.forEach((taskEnvelope, taskIndex) => {
            taskCreateInputs.push({
              command,
              taskEnvelope,
              priority: command.tasks[taskIndex]?.priority ?? 1
            });
          });
          return;
        }
        if (command.kind === "set_node_status") {
          nodeStatusCommands.push({ command, commandIndex });
          return;
        }
        taskCommands.push({ command, commandIndex });
      });
      rejectedCommand = commands;
      this.assertPlannerRuntimeTransitions(commands, budgetPatchByCommandIndex);
      const applied = this.graphStore.applyPlannerDecision({
        createTasks: taskCreateInputs.map(({ taskEnvelope, priority }) => ({
          parentTaskId: taskEnvelope.parentTaskId,
          taskId: taskEnvelope.taskId,
          goal: taskEnvelope.goal,
          targetRefs: taskEnvelope.targetRefs,
          basisRefs: taskEnvelope.basisRefs,
          scopeRef: taskEnvelope.scopeRef,
          constraints: taskEnvelope.constraints,
          successCriteria: taskEnvelope.successCriteria,
          goalAdditions: taskEnvelope.goalAdditions,
          dependsOnTaskRefs: taskEnvelope.dependsOnTaskRefs,
          continueFromTaskRef: taskEnvelope.continueFromTaskRef,
          budget: taskEnvelope.budget,
          priority
        })),
        taskCommands: taskCommands.map(({ command, commandIndex }): PlannerTaskBatchCommand => {
          const commandReason = plannerDecision.reason;
          if (command.kind === "patch_task") {
            const budgetPatch = budgetPatchByCommandIndex.get(commandIndex);
            const { additionalTurns: _additionalTurns, ...patch } = command.patch;
            return {
              commandIndex,
              kind: command.kind,
              taskId: command.taskId,
              patch: {
                ...patch,
                ...(budgetPatch ? { budget: { maxTurns: budgetPatch.newMaxTurns } } : {})
              },
              expectedVersion: versionSnapshot[command.taskId],
              sourceEventIds: [plannerEventId],
              reason: commandReason
            };
          }
          if (command.kind === "replace_dependencies") {
            return {
              commandIndex,
              kind: command.kind,
              taskId: command.taskId,
              dependencyTaskIds: command.dependencyTaskIds,
              expectedVersion: versionSnapshot[command.taskId],
              sourceEventIds: [plannerEventId],
              reason: commandReason
            };
          }
          return {
            commandIndex,
            kind: command.kind,
            taskId: command.taskId,
            status: command.status,
            expectedVersion: versionSnapshot[command.taskId],
            sourceEventIds: [plannerEventId],
            reason: commandReason
          };
        }),
        nodeStatusCommands: nodeStatusCommands.map(({ command, commandIndex }) => ({
          commandIndex,
          nodeId: command.nodeId,
          status: command.status,
          expectedVersion: versionSnapshot[command.nodeId],
          sourceEventIds: [plannerEventId],
          reason: plannerDecision.reason
        })),
        sourceEventIds: [plannerEventId]
      });
      for (const { command, taskEnvelope } of taskCreateInputs) {
        createdTaskEnvelopes.push(taskEnvelope);
        await this.executionLog.append({
          taskId: taskEnvelope.taskId,
          role: "runtime",
          eventType: "task_created",
          summary: taskEnvelope.goal,
          payload: {
            command,
            basedOnRefs: command.basedOnRefs ?? [],
            taskEnvelope
          }
        });
      }
      if (taskCommands.length > 0) {
        const appliedCommandByIndex = new Map(applied.taskCommands.map((result) => [result.commandIndex, result]));
        for (const { command, commandIndex } of taskCommands) {
          const commandReason = plannerDecision.reason;
          const appliedCommand = appliedCommandByIndex.get(commandIndex);
          if (command.kind === "patch_task") {
            const budgetPatch = budgetPatchByCommandIndex.get(commandIndex);
            await this.executionLog.append({
              taskId: command.taskId,
              role: "runtime",
              eventType: "planner_task_patched",
              summary: commandReason,
              payload: {
                command,
                nodeVersion: appliedCommand?.node.properties.version,
                ...(budgetPatch ? {
                  budgetChange: {
                    consumedTurns: budgetPatch.consumedTurns,
                    previousMaxTurns: budgetPatch.previousMaxTurns,
                    additionalTurns: budgetPatch.additionalTurns,
                    newMaxTurns: budgetPatch.newMaxTurns,
                    remainingTurns: Math.max(0, budgetPatch.newMaxTurns - budgetPatch.consumedTurns)
                  }
                } : {})
              }
            });
            continue;
          }
          if (command.kind === "replace_dependencies") {
            await this.executionLog.append({
              taskId: command.taskId,
              role: "runtime",
              eventType: "planner_dependencies_replaced",
              summary: commandReason,
              payload: { command, nodeVersion: appliedCommand?.node.properties.version }
            });
            continue;
          }
          await this.executionLog.append({
            taskId: command.taskId,
            role: "runtime",
            eventType: "planner_status_applied",
            summary: commandReason,
            payload: { command, status: command.status, nodeVersion: appliedCommand?.node.properties.version }
          });
          if (["completed", "blocked", "failed", "archived"].includes(command.status)) {
            this.invalidateFofaTaskIfTerminal(command.taskId, command.status);
            const transfersContext = taskCreateInputs.some(({ taskEnvelope }) =>
              taskEnvelope.continueFromTaskRef === command.taskId);
            if (!transfersContext) {
              this.runtimeStore.deleteExecutorSession(command.taskId);
              const continuedFromTaskRef = this.graphStore.getTaskEnvelope(command.taskId)?.continueFromTaskRef;
              if (continuedFromTaskRef) {
                this.runtimeStore.deleteExecutorSession(continuedFromTaskRef);
              }
            }
            await this.disposeTaskExecutorResources(command.taskId);
          }
        }
      }
      const appliedNodeByIndex = new Map(applied.nodeStatusCommands.map((result) => [result.commandIndex, result.node]));
      for (const { command, commandIndex } of nodeStatusCommands) {
        const commandReason = plannerDecision.reason;
        const node = appliedNodeByIndex.get(commandIndex);
        await this.executionLog.append({
          role: "runtime",
          eventType: "planner_status_applied",
          summary: commandReason,
          payload: { command, status: node?.properties.status, nodeId: node?.id, nodeVersion: node?.properties.version }
        });
      }
    } catch (error) {
      await this.executionLog.append({
        role: "runtime",
        eventType: "planner_command_rejected",
        summary: error instanceof Error ? error.message : String(error),
        payload: {
          command: rejectedCommand,
          errorName: error instanceof Error ? error.name : undefined,
          graphValidationError: error instanceof GraphValidationError
        }
      });
      throw error;
    }
    return createdTaskEnvelopes;
  }

  private resolvePlannerBudgetPatches(commands: PlannerCommand[]): Map<number, {
    taskId: string;
    consumedTurns: number;
    previousMaxTurns: number;
    additionalTurns: number;
    newMaxTurns: number;
  }> {
    const resolutions = new Map<number, {
      taskId: string;
      consumedTurns: number;
      previousMaxTurns: number;
      additionalTurns: number;
      newMaxTurns: number;
    }>();
    const currentMaxTurnsByTaskId = new Map<string, number>();
    for (const [commandIndex, command] of commands.entries()) {
      if (command.kind !== "patch_task") {
        continue;
      }
      const taskEnvelope = this.graphStore.getTaskEnvelope(command.taskId);
      if (!taskEnvelope) {
        continue;
      }
      const previousMaxTurns = currentMaxTurnsByTaskId.get(command.taskId)
        ?? normalizeTaskBudget(taskEnvelope.budget).maxTurns;
      let newMaxTurns = previousMaxTurns;
      let additionalTurns = 0;
      if (command.patch.additionalTurns !== undefined) {
        additionalTurns = command.patch.additionalTurns;
        newMaxTurns = previousMaxTurns + additionalTurns;
        if (!Number.isSafeInteger(newMaxTurns)) {
          throw new GraphValidationError(
            `Task ${command.taskId} budget extension exceeds the safe cumulative allocation: `
            + `previousMaxTurns=${previousMaxTurns}, additionalTurns=${additionalTurns}.`
          );
        }
      } else if (command.patch.budget) {
        // Historical decisions used an absolute cumulative maxTurns patch.
        newMaxTurns = normalizeTaskBudget(command.patch.budget).maxTurns;
        additionalTurns = newMaxTurns - previousMaxTurns;
      } else {
        continue;
      }
      currentMaxTurnsByTaskId.set(command.taskId, newMaxTurns);
      resolutions.set(commandIndex, {
        taskId: command.taskId,
        consumedTurns: this.runtimeStore.getTaskConsumedTurns(command.taskId),
        previousMaxTurns,
        additionalTurns,
        newMaxTurns
      });
    }
    return resolutions;
  }

  private assertPlannerRuntimeTransitions(
    commands: PlannerCommand[],
    budgetPatchByCommandIndex = this.resolvePlannerBudgetPatches(commands)
  ): void {
    this.assertExecutorContextTransfers(commands);
    for (const command of commands) {
      if (command.kind !== "set_task_status" || command.status !== "completed") continue;
      const outcome = this.runtimeStore.getTaskOutcome(command.taskId);
      if (!this.taskOutcomeCompletesCurrentObjectives(command.taskId, outcome, commands)) {
        throw new GraphValidationError(
          `Task ${command.taskId} requires a completed TaskOutcome for its current objective definition `
          + "before Planner can set completed"
        );
      }
    }
    const maxTurnsByTaskId = new Map<string, number>();
    for (const resolution of budgetPatchByCommandIndex.values()) {
      maxTurnsByTaskId.set(resolution.taskId, resolution.newMaxTurns);
    }
    for (const command of commands) {
      if (command.kind !== "set_task_status" || command.status !== "open") {
        continue;
      }
      const taskEnvelope = this.graphStore.getTaskEnvelope(command.taskId);
      if (!taskEnvelope) {
        continue;
      }
      const maxTurns = maxTurnsByTaskId.get(command.taskId)
        ?? normalizeTaskBudget(taskEnvelope.budget).maxTurns;
      const consumedTurns = this.runtimeStore.getTaskConsumedTurns(command.taskId);
      if (consumedTurns < maxTurns) {
        continue;
      }
      throw new GraphValidationError(
        `Task ${command.taskId} cannot reopen with exhausted budget: consumedTurns=${consumedTurns}, maxTurns=${maxTurns}. `
        + `In the same decision, add an execution allocation with patch_task.patch.additionalTurns, `
        + "or archive this Task and create a genuinely distinct successor."
      );
    }
  }

  private assertExecutorContextTransfers(commands: PlannerCommand[]): void {
    const createdTaskIds = new Set(commands.flatMap((command) =>
      command.kind === "create_tasks" ? command.tasks.map((task) => task.id) : []));
    const completedTaskIds = new Set(commands.flatMap((command) =>
      command.kind === "set_task_status" && command.status === "completed" ? [command.taskId] : []));
    const claimedSourceTaskIds = new Set<string>();
    for (const command of commands) {
      if (command.kind !== "create_tasks") continue;
      for (const task of command.tasks) {
        const sourceTaskId = task.continueFromTaskRef;
        if (!sourceTaskId) continue;
        if (!(task.dependsOnTaskRefs ?? []).includes(sourceTaskId)) {
          throw new GraphValidationError(
            `Task ${task.id} can continue Executor context only from a direct dependency: ${sourceTaskId}`
          );
        }
        if (createdTaskIds.has(sourceTaskId)) {
          throw new GraphValidationError(`Task ${task.id} cannot continue from newly created Task ${sourceTaskId}`);
        }
        if (claimedSourceTaskIds.has(sourceTaskId)) {
          throw new GraphValidationError(`Executor context for ${sourceTaskId} can have only one successor`);
        }
        const reservedSuccessor = this.graphStore.listOpenTasks(5_000)
          .find((candidate) => candidate.continueFromTaskRef === sourceTaskId);
        if (reservedSuccessor) {
          throw new GraphValidationError(
            `Executor context for ${sourceTaskId} is already reserved by ${reservedSuccessor.taskId}`
          );
        }
        if (this.activeTaskRuns.has(sourceTaskId) || this.activeEpochIdByTask.has(sourceTaskId)) {
          throw new GraphValidationError(`Cannot transfer active Executor context from ${sourceTaskId}`);
        }
        const sourceNode = this.graphStore.getTaskNode(sourceTaskId);
        if (!sourceNode) {
          throw new GraphValidationError(`Executor context source Task ${sourceTaskId} does not exist`);
        }
        if (sourceNode.properties.status !== "completed" && !completedTaskIds.has(sourceTaskId)) {
          throw new GraphValidationError(
            `Executor context source ${sourceTaskId} must be completed before its successor starts`
          );
        }
        const sourceOutcome = this.runtimeStore.getTaskOutcome(sourceTaskId);
        if (!this.taskOutcomeCompletesCurrentObjectives(sourceTaskId, sourceOutcome, commands)) {
          throw new GraphValidationError(
            `Executor context source ${sourceTaskId} requires a completed TaskOutcome for its current objective definition`
          );
        }
        if (!this.runtimeStore.getExecutorSession(sourceTaskId)) {
          throw new GraphValidationError(`Executor context source ${sourceTaskId} has no persisted Executor session`);
        }
        if (this.runtimeStore.getExecutorSession(task.id)) {
          throw new GraphValidationError(`Executor context target ${task.id} already owns an Executor session`);
        }
        claimedSourceTaskIds.add(sourceTaskId);
      }
    }
  }

  private taskOutcomeCompletesCurrentObjectives(
    taskId: string,
    outcome: TaskOutcome | undefined,
    pendingCommands: PlannerCommand[] = []
  ): boolean {
    if (outcome?.status !== "completed") {
      return false;
    }
    const task = this.graphStore.getTaskNode(taskId);
    if (!task) {
      return false;
    }
    const appendsObjectives = pendingCommands.some((command) => command.kind === "patch_task"
      && command.taskId === taskId
      && (command.patch.appendObjectives?.length ?? 0) > 0);
    if (appendsObjectives) {
      return false;
    }
    const revision = task.properties.objectiveRevision;
    const currentRevision = typeof revision === "number" && Number.isFinite(revision) && revision >= 1
      ? Math.floor(revision)
      : 1;
    if (outcome.objectiveRevision !== undefined) {
      return outcome.objectiveRevision === currentRevision;
    }
    return currentRevision === 1 && (task.properties.goalAdditions === undefined
      || (Array.isArray(task.properties.goalAdditions) && task.properties.goalAdditions.length === 0));
  }

  private async runReadyTaskGraph(input: { maxParallelTasks: number }): Promise<TaskExecution[]> {
    await this.reconcileReadyTasks(input.maxParallelTasks);
    if (this.taskCompletionQueue.length === 0 && this.activeTaskRuns.size === 0) {
      return [];
    }
    if (this.taskCompletionQueue.length === 0) {
      await new Promise<void>((resolve) => this.taskCompletionWaiters.add(resolve));
    }
    const completed = this.taskCompletionQueue.splice(0);
    await this.reconcileReadyTasks(input.maxParallelTasks);
    const failure = completed.find((item) => item.error !== undefined);
    if (failure) {
      throw failure.error;
    }
    const executions = completed.flatMap((item) => item.execution ? [item.execution] : []);
    if (executions.length > 0) {
      await this.executionLog.append({
        role: "runtime",
        eventType: "task_wave_completed",
        summary: `Completed ${executions.length} task(s); independent tasks continue`,
        payload: {
          results: executions.map((execution) => ({
            taskId: execution.taskEnvelope.taskId,
            status: execution.taskResult?.status ?? execution.epochOutcome.status,
            outcomeLayer: execution.taskResult ? "task" : "epoch",
            controlSignal: execution.controlSignal.decision,
            terminalSeq: execution.terminalSeq
          })),
          activeTaskIds: [...this.activeTaskRuns.keys()]
        }
      });
    }
    return executions;
  }

  private assertPlannerIdleDecisionCanContinue(
    plannerDecision: PlannerDecision,
    releasedTaskIds: string[]
  ): void {
    if (!this.isRootGoalStatus("open")
      || (plannerDecision.commands?.length ?? 0) > 0
      || releasedTaskIds.length > 0
      || this.activeTaskRuns.size > 0
      || this.taskCompletionQueue.length > 0
      || this.listRunnableTaskCandidates().length > 0) {
      return;
    }
    throw new IncompletePlannerTerminalDecisionError();
  }

  private listRunnableTaskCandidates(): TaskEnvelope[] {
    const statusByTaskId = new Map(
      this.graphStore.plannerDecisionView().taskLedger
        .map((task) => [task.taskId, task.status])
    );
    return this.graphStore
      .listOpenTasks(Number.MAX_SAFE_INTEGER)
      .filter((task) => deriveTaskDefinitionReadiness(
        task.dependsOnTaskRefs,
        statusByTaskId
      ).blockedByTaskRefs.length === 0)
      .filter((task) => this.runtimeStore.getTaskConsumedTurns(task.taskId)
        < normalizeTaskBudget(task.budget).maxTurns)
      .filter((task) => !this.activeTaskRuns.has(task.taskId))
      .filter((task) => !this.awaitingPlannerTaskIds.has(task.taskId));
  }

  private async drainReadyTaskGraph(input: {
    maxParallelTasks: number;
    deadlineAt: number;
  }): Promise<boolean> {
    while (!this.stopRequestedReason) {
      await this.reconcileReadyTasks(input.maxParallelTasks);
      if (this.taskCompletionQueue.length > 0) {
        await this.runReadyTaskGraph({ maxParallelTasks: input.maxParallelTasks });
        continue;
      }
      if (this.activeTaskRuns.size === 0) {
        return true;
      }
      if (!await this.waitForTaskCompletionUntil(input.deadlineAt)) {
        return false;
      }
    }
    return false;
  }

  private waitForTaskCompletionUntil(deadlineAt: number): Promise<boolean> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (completed: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.taskCompletionWaiters.delete(onCompletion);
        resolve(completed);
      };
      const onCompletion = (): void => finish(true);
      const timer = setTimeout(() => finish(false), remainingMs);
      this.taskCompletionWaiters.add(onCompletion);
      if (this.taskCompletionQueue.length > 0 || this.activeTaskRuns.size === 0) {
        finish(true);
      }
    });
  }

  private reconcileReadyTasks(maxParallelTasks: number): Promise<void> {
    const reconcile = this.taskReconcileChain.then(async () => {
      const capacity = Math.max(0, maxParallelTasks - this.activeTaskRuns.size);
      if (capacity === 0 || this.stopRequestedReason || this.invocationAbortController.signal.aborted) {
        return;
      }
      const candidates = this.listRunnableTaskCandidates();
      const occupiedSessionRefs = new Set(
        [...this.activeTaskRuns.values()].flatMap((run) => run.taskEnvelope.availableSessionRefs ?? [])
      );
      const readyTasks = admitReadyTasks(candidates, capacity, occupiedSessionRefs);
      if (readyTasks.length === 0) {
        return;
      }
      await this.executionLog.append({
        role: "runtime",
        eventType: "task_wave_started",
        summary: `Scheduled ${readyTasks.length} ready task(s)`,
        payload: {
          candidateTaskIds: candidates.map((task) => task.taskId),
          taskIds: readyTasks.map((task) => task.taskId),
          activeTaskIds: [...this.activeTaskRuns.keys()],
          maxParallelTasks
        }
      });
      const useDynamicExecutor = this.isolatedSessionsEnabled
        || this.activeTaskRuns.size > 0
        || readyTasks.length > 1;
      for (const taskEnvelope of readyTasks) {
        const promise = this.runExecutorTask(taskEnvelope, {
          useDynamicExecutor
        });
        const run = { taskEnvelope, promise };
        this.activeTaskRuns.set(taskEnvelope.taskId, run);
        void promise.then(
          (execution) => this.recordTaskCompletion(run, { taskId: taskEnvelope.taskId, execution }, maxParallelTasks),
          (error) => this.recordTaskCompletion(run, { taskId: taskEnvelope.taskId, error }, maxParallelTasks)
        );
      }
    });
    this.taskReconcileChain = reconcile.catch(() => undefined);
    return reconcile;
  }

  private recordTaskCompletion(run: ActiveTaskRun, completion: TaskCompletion, maxParallelTasks: number): void {
    if (this.activeTaskRuns.get(completion.taskId) !== run) {
      return;
    }
    this.activeTaskRuns.delete(completion.taskId);
    this.awaitingPlannerTaskIds.add(completion.taskId);
    this.taskCompletionQueue.push(completion);
    for (const resolve of this.taskCompletionWaiters) {
      resolve();
    }
    this.taskCompletionWaiters.clear();
    void this.reconcileReadyTasks(maxParallelTasks).catch(async (error) => {
      await this.executionLog.append({
        role: "runtime",
        eventType: "task_reconcile_failed",
        summary: error instanceof Error ? error.message : String(error),
        payload: { completedTaskId: completion.taskId }
      });
    });
  }

  private async releasePlannerWaitingTasks(
    plannerDecision: PlannerDecision,
    plannerVisibleWaitingTaskIds: Set<string>
  ): Promise<string[]> {
    const releasedTaskIds: string[] = [];
    const explicitlyReopenedTaskIds = new Set((plannerDecision.commands ?? []).flatMap((command) => (
      command.kind === "set_task_status" && command.status === "open" ? [command.taskId] : []
    )));
    for (const taskId of plannerVisibleWaitingTaskIds) {
      if (explicitlyReopenedTaskIds.has(taskId)) {
        this.awaitingPlannerTaskIds.delete(taskId);
        releasedTaskIds.push(taskId);
        continue;
      }
      const status = this.graphStore.getTaskNode(taskId)?.properties.status;
      if (["completed", "blocked", "failed", "archived"].includes(String(status))) {
        this.awaitingPlannerTaskIds.delete(taskId);
        releasedTaskIds.push(taskId);
        continue;
      }
      if (status !== "open") {
        continue;
      }
      const taskEnvelope = this.graphStore.getTaskEnvelope(taskId);
      const maxTurns = normalizeTaskBudget(taskEnvelope?.budget).maxTurns;
      const consumedTurns = this.runtimeStore.getTaskConsumedTurns(taskId);
      const taskOutcome = this.runtimeStore.getTaskOutcome(taskId);
      const epochOutcome = this.runtimeStore.listTaskEpochOutcomes(taskId, 1)[0];
      const resumablePartial = taskOutcome?.status === "partial"
        && epochOutcome?.epochRef === taskOutcome.epochRef
        && epochOutcome.taskOutcomeRef === taskOutcome.taskRef;
      const resumableEpoch = epochOutcome?.retryable
        && epochOutcome.taskOutcomeRef === undefined
        && epochOutcome.terminalSeq > (taskOutcome?.terminalSeq ?? 0);
      const resumableOpenOutcome = taskOutcome?.status === "blocked" || taskOutcome?.status === "failed";
      const resumableCompletedRevision = taskOutcome?.status === "completed"
        && typeof taskOutcome.objectiveRevision === "number"
        && taskOutcome.objectiveRevision < taskObjectiveRevision(this.graphStore.getTaskNode(taskId));
      if (consumedTurns < maxTurns
        && (resumablePartial || resumableEpoch || resumableOpenOutcome || resumableCompletedRevision)) {
        const resolution = resumablePartial
          ? "resume_partial"
          : resumableEpoch
            ? "resume_retryable_epoch"
            : "resume_open_task";
        await this.executionLog.append({
          taskId,
          role: "runtime",
          eventType: "planner_handoff_resolved",
          summary: plannerDecision.reason,
          payload: {
            resolution,
            taskOutcomeRef: taskOutcome?.taskRef,
            epochOutcomeRef: epochOutcome?.epochRef,
            remainingTurns: maxTurns - consumedTurns
          }
        });
        this.awaitingPlannerTaskIds.delete(taskId);
        releasedTaskIds.push(taskId);
      }
    }
    return releasedTaskIds;
  }

  private async restorePlannerHandoffs(): Promise<void> {
    for (const task of this.graphStore.listOpenTasks(Number.MAX_SAFE_INTEGER)) {
      if (this.runtimeStore.getTaskConsumedTurns(task.taskId) >= normalizeTaskBudget(task.budget).maxTurns) {
        this.awaitingPlannerTaskIds.add(task.taskId);
        continue;
      }
      const outcome = this.runtimeStore.getTaskOutcome(task.taskId);
      const epochOutcome = this.runtimeStore.listTaskEpochOutcomes(task.taskId, 1)[0];
      const terminalSeq = Math.max(outcome?.terminalSeq ?? 0, epochOutcome?.terminalSeq ?? 0);
      if (terminalSeq === 0) {
        continue;
      }
      const laterPlannerStatuses = await this.executionLog.range({
        taskId: task.taskId,
        afterSeq: terminalSeq,
        toSeq: this.executionLog.latestSeq(task.taskId),
        roles: ["runtime"],
        eventTypes: ["planner_status_applied", "planner_handoff_resolved"]
      });
      if (laterPlannerStatuses.length === 0) {
        this.awaitingPlannerTaskIds.add(task.taskId);
      }
    }
  }

  private async runExecutorTask(
    taskEnvelope: TaskEnvelope,
    options: { useDynamicExecutor: boolean }
  ): Promise<TaskExecution> {
    for (let providerAttempt = 1; providerAttempt <= EXECUTOR_PROVIDER_RETRY_ATTEMPTS + 1; providerAttempt += 1) {
      const state = this.beginTaskExecution(taskEnvelope);
      const maxTurns = taskEnvelope.budget?.maxTurns ?? DEFAULT_TASK_BUDGET.maxTurns;
      if (state.taskTurnCount >= maxTurns) {
        const persisted = await this.persistEpochOutcome(state, {
          status: "checkpointed",
          reason: `Task budget already exhausted: maxTurns=${maxTurns}, usedTurns=${state.taskTurnCount}`,
          retryable: true
        });
        this.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
        return {
          taskEnvelope,
          epochOutcome: persisted.outcome,
          terminalSeq: persisted.outcome.terminalSeq,
          controlSignal: controlSignalForEpochOutcome(persisted.outcome, [persisted.eventId])
        };
      }
      let executorSession: ExecutorSessionLease;
      try {
        const executorContext = await this.claimExecutorContextForTask(taskEnvelope);
        await this.prepareExecutorSandboxForEpoch(state, executorContext.workspaceKey);
        executorSession = await this.createExecutorSessionForTask(taskEnvelope, options.useDynamicExecutor);
      } catch (error) {
        await this.endExecutorNetworkEpoch(state);
        await this.persistEpochOutcome(state, {
          status: "failed",
          reason: errorMessageFromUnknown(error) ?? "Executor sandbox initialization failed",
          retryable: false
        });
        this.finishTaskExecution(taskEnvelope.taskId, "provider_error");
        throw error;
      }
      const executorInvocationId = `executor:${state.epochId}:provider:${providerAttempt}`;
      const executorInvocationStartedAt = Date.now();
      const executorStatsBefore = readPiSessionStats(executorSession.session);
      state.executorSession = executorSession.session;
      state.dynamicExecutor = executorSession.dynamicExecutor;
      let executorLogging: ReturnType<typeof attachExecutionLogging> | undefined;
      if (executorSession.dynamicExecutor) {
        executorLogging = attachExecutionLogging({
          session: executorSession.session,
          executionLog: this.executionLog,
          artifactStore: this.artifactStore,
          role: "executor",
          getTaskId: () => taskEnvelope.taskId,
          getEpochId: () => state.epochId,
          getAbortContext: () => state.abortContext,
          onPersistedEvent: (event) => this.handleExecutorEventPersisted(event)
        });
      }
      this.armEpochTimeSlice(taskEnvelope);
      const taskStartedEvent = await this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "epoch_transition",
        summary: `${state.epochId} running`,
        payload: { state: "running", attempt: state.attempt, taskEnvelope }
      });
      state.lastEventId = taskStartedEvent.id;

      let executorOutput = "";
      let taskResult: TaskResult | undefined;
      let providerFailure: RetryableProviderFailure | undefined;
      let executorError: unknown;
      let executorInputBytes = 0;
      let executorInvocationStatus = "submitted";
      let networkFinalizationDeferred = false;
      try {
        const taskStatus = this.getTaskStatusSnapshot(taskEnvelope.taskId);
        const rootGoal = this.currentUserGoal ?? this.getRootGoalText() ?? taskEnvelope.goal;
        const runtimeBudgetStatus = formatExecutorBudgetStatus(
          taskEnvelope,
          state,
          executorSession.resumed
            ? `task_resume:${executorSession.resumeCount}`
            : providerAttempt === 1 ? "task_start" : `provider_retry:${providerAttempt}`
        );
        const executorInput = executorSession.resumed
          ? await this.renderResumeExecutorInput({
            rootGoal,
            taskEnvelope,
            taskStatus,
            runtimeBudgetStatus,
            continuedFromTaskRef: executorSession.continuedFromTaskRef
          })
          : await this.renderInitialExecutorInput({
            rootGoal,
            taskEnvelope,
            taskStatus,
            runtimeBudgetStatus
          });
        executorInputBytes = Buffer.byteLength(executorInput);
        if (this.structuredInvocationsEnabled) {
          taskResult = await invokeStructured(executorSession.session, executorInput, {
            toolName: "task_result_submit",
            validate: (value) => normalizeTaskResult(value as Partial<TaskResult>, taskEnvelope),
            admission: this.providerAdmission("executor", state.invocationAbortController.signal)
          });
        } else {
          executorOutput = await promptAndCollect(executorSession.session, executorInput, {
            admission: this.providerAdmission("executor", state.invocationAbortController.signal)
          });
          taskResult = normalizeTaskResult(extractJsonObject<Partial<TaskResult>>(executorOutput), taskEnvelope);
        }
      } catch (error) {
        executorError = error;
        providerFailure = state.executorStopRequested
          ? undefined
          : classifyExecutorProviderFailure(error, error, executorOutput);
        executorInvocationStatus = state.executorStopRequested
          ? isCheckpointControlSignal(state.controlSignal) ? "checkpointed" : "stopped"
          : providerFailure?.retryable ? "provider_error" : "failed";
      } finally {
        let invocationFinalizationError: unknown;
        try {
          await state.terminationPromise;
          await executorLogging?.drain();
          await this.appendInvocationMetrics({
            session: executorSession.session,
            before: executorStatsBefore,
            invocationId: executorInvocationId,
            invocationKind: "executor",
            agentRole: "executor",
            status: executorInvocationStatus,
            startedAt: executorInvocationStartedAt,
            taskId: taskEnvelope.taskId,
            epochId: state.epochId,
            inputBytes: executorInputBytes,
            details: {
              providerAttempt,
              dynamicSession: executorSession.dynamicExecutor,
              resumedSession: executorSession.resumed,
              resumeCount: executorSession.resumeCount,
              budget: taskEnvelope.budget,
              toolExecutionEndCount: state.toolExecutionEndCount,
              epochTurnCount: state.epochTurnCount,
              taskTurnCount: state.taskTurnCount
            }
          });
        } catch (error) {
          invocationFinalizationError = error;
        } finally {
          this.clearEpochTimeSlice(taskEnvelope);
          networkFinalizationDeferred = !taskResult && state.abortContext?.kind === "budget_abort";
          if (!networkFinalizationDeferred) {
            this.scheduleExecutorNetworkFinalization(state);
          }
        }
        if (invocationFinalizationError !== undefined) {
          if (networkFinalizationDeferred) {
            this.scheduleExecutorNetworkFinalization(state);
          }
          throw invocationFinalizationError;
        }
      }

      if (taskResult && state.executorStopRequested) {
        await this.executionLog.append({
          epochId: state.epochId,
          taskId: taskEnvelope.taskId,
          role: "runtime",
          eventType: "executor_checkpoint_submitted",
          summary: taskResult.summary,
          payload: {
            controlSignal: state.controlSignal,
            taskResultStatus: taskResult.status
          }
        });
      }

      if (
        !taskResult
        && providerFailure?.retryable
        && state.toolExecutionEndCount === 0
        && providerAttempt <= EXECUTOR_PROVIDER_RETRY_ATTEMPTS
        && !state.executorStopRequested
      ) {
        await this.networkFinalizations.get(state.epochId);
        await this.executionLog.append({
          epochId: state.epochId,
          taskId: taskEnvelope.taskId,
          role: "runtime",
          eventType: "executor_provider_retry_scheduled",
          summary: `${providerFailure.errorKind}: retry ${providerAttempt}/${EXECUTOR_PROVIDER_RETRY_ATTEMPTS}`,
          payload: {
            providerAttempt,
            maxRetryAttempts: EXECUTOR_PROVIDER_RETRY_ATTEMPTS,
            backoffMs: EXECUTOR_PROVIDER_RETRY_BACKOFF_MS,
            providerFailure
          }
        });
        await this.persistEpochOutcome(state, {
          status: "provider_error",
          reason: providerFailure.message,
          retryable: true
        });
        this.finishTaskExecution(taskEnvelope.taskId, "provider_error");
        executorLogging?.();
        if (executorSession.dynamicExecutor) {
          disposeSession(executorSession.session);
        }
        await sleep(EXECUTOR_PROVIDER_RETRY_BACKOFF_MS);
        continue;
      }

      if (!taskResult) {
        try {
          taskResult = await this.collectBudgetCheckpointTaskResult({
            taskEnvelope,
            state,
            executorSession,
            logging: executorLogging
          });
          await executorLogging?.drain();
        } finally {
          if (networkFinalizationDeferred) {
            this.scheduleExecutorNetworkFinalization(state);
          }
        }
      }

      if (!taskResult) {
        const reason = providerFailure?.message
          ?? state.abortContext?.reason
          ?? errorMessageFromUnknown(executorError)
          ?? "Executor did not return a valid TaskResult";
        const epochStatus: EpochOutcome["status"] = state.abortContext?.kind === "controller_abort"
          ? "aborted"
          : state.abortContext?.kind === "budget_abort" || state.abortContext?.kind === "observer_abort"
            ? "checkpointed"
            : providerFailure
              ? "provider_error"
              : "failed";
        const retryable = epochStatus === "checkpointed" || epochStatus === "provider_error";
        const persisted = await this.persistEpochOutcome(state, {
          status: epochStatus,
          reason,
          retryable
        });
        void this.enqueueProjectionJob({
          reason: "task_end",
          taskEnvelope,
          sourceEventIds: [persisted.eventId]
        });
        const controlSignal = state.controlSignal ?? controlSignalForEpochOutcome(persisted.outcome, [persisted.eventId]);
        const terminationReason = terminationReasonForEpochOutcome(persisted.outcome, state);
        executorLogging?.();
        this.finishTaskExecution(taskEnvelope.taskId, terminationReason);
        if (executorSession.dynamicExecutor) {
          disposeSession(executorSession.session);
        }
        return {
          taskEnvelope,
          epochOutcome: persisted.outcome,
          terminalSeq: persisted.outcome.terminalSeq,
          controlSignal
        };
      }
      if (providerFailure?.retryable) {
        taskResult = {
          ...taskResult,
          retryable: true,
          checkpointReason: providerFailure.message
        };
      }
      taskResult = await this.enrichTaskResultLifecycle(taskResult, taskEnvelope, state);

      const taskCompletedEvent = await this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "executor",
        eventType: `task_${taskResult.status}`,
        summary: taskResult.summary,
        payload: { taskResult },
        artifactRefs: taskResult.artifactRefs
      });
      state.lastEventId = taskCompletedEvent.id;
      const terminalSeq = taskCompletedEvent.seq ?? this.executionLog.latestSeq(taskEnvelope.taskId);
      const taskOutcome = createTaskOutcome({
        taskResult,
        epochRef: state.epochId,
        objectiveRevision: taskObjectiveRevision(this.graphStore.getTaskNode(taskEnvelope.taskId)),
        terminalSeq
      });
      const epochOutcome = (await this.persistEpochOutcome(state, {
        status: "submitted",
        reason: taskResult.summary,
        retryable: taskResult.retryable === true,
        taskOutcomeRef: taskResult.taskId,
        taskOutcome
      })).outcome;
      const taskStatusDelta = this.graphStore.updateTaskResult({
        taskEnvelope,
        taskResult,
        sourceEventIds: [taskCompletedEvent.id]
      });
      const projectionRequested = !(providerFailure?.retryable && state.toolExecutionEndCount === 0);
      if (!projectionRequested) {
        await this.executionLog.append({
          epochId: state.epochId,
          taskId: taskEnvelope.taskId,
          role: "runtime",
          eventType: "projection_job_skipped",
          summary: `task_end skipped: pure retryable provider error ${providerFailure?.errorKind ?? "unknown"}`,
          payload: { reason: "task_end", providerFailure, sourceEventIds: [taskCompletedEvent.id] }
        });
      } else {
        void this.enqueueProjectionJob({
          reason: "task_end",
          taskEnvelope,
          taskResult,
          sourceEventIds: [taskCompletedEvent.id]
        });
      }
      const controlSignal = state.controlSignal ?? controlSignalForTaskResult(taskResult, [taskCompletedEvent.id]);
      const terminationReason = taskResult.status === "completed"
        ? "executor_submitted"
        : terminationReasonForTaskResult(taskResult, state);
      executorLogging?.();
      this.finishTaskExecution(taskEnvelope.taskId, terminationReason);
      if (executorSession.dynamicExecutor) {
        disposeSession(executorSession.session);
      }
      if (taskResult.status === "completed"
        || taskResult.status === "blocked"
        || (taskResult.status === "failed" && taskResult.retryable !== true)) {
        this.invalidateFofaTaskIfTerminal(
          taskEnvelope.taskId,
          taskResult.status,
          taskResult.retryable === true
        );
        const finalization = this.networkFinalizations.get(state.epochId) ?? Promise.resolve();
        void finalization.then(() => this.disposeTaskExecutorResources(taskEnvelope.taskId)).catch(() => undefined);
      }
      return {
        taskEnvelope,
        taskResult,
        epochOutcome,
        terminalSeq,
        graphDelta: taskStatusDelta,
        controlSignal
      };
    }
    throw new Error(`Executor retry loop exhausted without result for ${taskEnvelope.taskId}`);
  }

  private async claimExecutorContextForTask(
    taskEnvelope: TaskEnvelope
  ): Promise<{ workspaceKey: string }> {
    const owned = this.runtimeStore.getExecutorSession(taskEnvelope.taskId);
    if (owned) {
      return { workspaceKey: owned.workspaceKey };
    }
    const sourceTaskId = taskEnvelope.continueFromTaskRef;
    if (!sourceTaskId) {
      return { workspaceKey: taskEnvelope.taskId };
    }
    const transferred = this.runtimeStore.transferExecutorSession(sourceTaskId, taskEnvelope.taskId);
    await this.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "runtime",
      eventType: "executor_context_transferred",
      summary: `Transferred Executor context ${sourceTaskId} -> ${taskEnvelope.taskId}`,
      payload: {
        sourceTaskId,
        targetTaskId: taskEnvelope.taskId,
        sessionFile: transferred.sessionFile,
        workspaceKey: transferred.workspaceKey
      }
    });
    return { workspaceKey: transferred.workspaceKey };
  }

  private async prepareExecutorSandboxForEpoch(
    state: ActiveTaskState,
    workspaceKey = state.taskEnvelope.taskId
  ): Promise<void> {
    if (!this.connectivityRuntime) {
      return;
    }
    const taskId = state.taskEnvelope.taskId;
    const gateway = await this.connectivityRuntime.beginTaskEpoch({ taskId, epochId: state.epochId });
    let sandbox = this.taskExecutorSandboxes.get(taskId);
    try {
      if (!sandbox) {
        sandbox = await createDockerTaskSandbox({
          runtimeDir: this.runtimeDir,
          runRef: this.runId,
          taskId,
          workspaceKey,
          environment: this.environment,
          network: {
            networkName: gateway.networkName,
            gatewayAddress: gateway.gatewayAddress,
            dnsAddress: gateway.dnsAddress
          },
          transparentCaPath: this.connectivityRuntime.network.gatewayCaPath(),
          additionalReadRoots: projectSkillsDirs(this.cwd)
        });
      }
      await sandbox.start();
      this.taskExecutorSandboxes.set(taskId, sandbox);
    } catch (error) {
      this.taskExecutorSandboxes.delete(taskId);
      await sandbox?.dispose().catch(() => undefined);
      await this.connectivityRuntime.disposeTask(taskId).catch(() => undefined);
      throw error;
    }
    await this.executionLog.append({
      epochId: state.epochId,
      taskId,
      role: "runtime",
      eventType: "executor_task_sandbox_ready",
      summary: `docker sandbox ready for ${taskId}`,
      payload: {
        mode: "docker",
        workspace: sandbox.root,
        flowFile: gateway.flowFile,
        netFile: gateway.netFile,
        network: {
          task: { name: gateway.networkName, address: gateway.gatewayAddress },
          control: { name: gateway.controlNetworkName, address: gateway.controlAddress },
          dnsAddress: gateway.dnsAddress,
          imageId: gateway.imageId,
          firewall: "private-task-network-protocol-aware-capture"
        }
      }
    });
  }

  private scheduleExecutorNetworkFinalization(state: ActiveTaskState): Promise<void> {
    const existing = this.networkFinalizations.get(state.epochId);
    if (existing) return existing;
    const finalization = this.endExecutorNetworkEpoch(state).finally(() => {
      if (this.networkFinalizations.get(state.epochId) === finalization) {
        this.networkFinalizations.delete(state.epochId);
      }
    });
    this.networkFinalizations.set(state.epochId, finalization);
    return finalization;
  }

  private async endExecutorNetworkEpoch(state: ActiveTaskState): Promise<void> {
    if (!this.connectivityRuntime) return;
    const taskId = state.taskEnvelope.taskId;
    const sandbox = this.taskExecutorSandboxes.get(taskId);
    let quiesceFailure: string | undefined;
    try {
      await sandbox?.quiesce?.();
    } catch (error) {
      quiesceFailure = error instanceof Error ? error.message : String(error);
    }
    try {
      const drain = await this.connectivityRuntime.endTaskEpoch({
        taskId,
        epochId: state.epochId
      });
      if (quiesceFailure) throw new Error(`executor quiesce failed: ${quiesceFailure}`);
      await this.executionLog.append({
        epochId: state.epochId,
        taskId,
        role: "runtime",
        eventType: "network_capture_finalized",
        summary: `${state.epochId} network evidence finalized`,
        payload: drain
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.executionLog.append({
        epochId: state.epochId,
        taskId,
        role: "runtime",
        eventType: "network_capture_degraded",
        summary: message,
        payload: {
          epochId: state.epochId,
          quiesceFailure,
          ...captureSequencesFromError(message)
        }
      });
    }
  }

  private requireExecutorSandbox(taskId: string): ExecutorSandbox {
    const sandbox = this.connectivityRuntime
      ? this.taskExecutorSandboxes.get(taskId)
      : this.executorSandbox;
    if (!sandbox) throw new Error(`Executor sandbox is not ready for ${taskId}`);
    return sandbox;
  }

  // Best-effort: facts must never block task start; the tool probe degrades
  // silently on its own, so only sandbox lookups can throw here.
  private async executorEnvironmentFacts(taskId: string): Promise<string | undefined> {
    try {
      const sandbox = this.requireExecutorSandbox(taskId);
      return await getExecutorEnvironmentFacts({
        mode: sandbox.mode,
        sandboxRoot: sandbox.root,
        containerWorkdir: sandbox.mode === "docker" ? "/workspace" : undefined,
        tmpdir: sandbox.mode === "docker" ? "/tmp" : undefined,
        image: sandbox.mode === "docker" ? executorDockerImage() : undefined
      });
    } catch {
      return undefined;
    }
  }

  private requireConnectivityRuntime(): ConnectivityRuntime {
    if (!this.connectivityRuntime) throw new Error("Connectivity runtime is unavailable for this run");
    return this.connectivityRuntime;
  }

  private createTaskConnectivityTools(taskId: string) {
    const runtime = this.connectivityRuntime;
    if (!runtime) return [];
    const executorRuntime: ExecutorConnectivityRuntime = {
      openRoute: (input: RouteOpenInput, ownerTaskId: string) => runtime.openRoute(input, ownerTaskId),
      routeStatus: (routeRef) => runtime.executorRouteStatus(routeRef),
      stopRoute: (routeRef) => runtime.executorStopRoute(routeRef),
      reconnectRoute: (routeRef) => runtime.executorReconnectRoute(routeRef)
    };
    return createExecutorConnectivityTools(executorRuntime, taskId);
  }

  private createTaskRuntimeTools(taskEnvelope: TaskEnvelope) {
    return [
      ...this.createTaskConnectivityTools(taskEnvelope.taskId),
      ...(this.fofaRuntime
        ? createExecutorFofaTools(this.fofaRuntime, this.artifactStore, taskEnvelope.taskId)
        : []),
      ...(this.fofaRuntime ? [createTopologyValidationTool()] : []),
      ...(this.beekeeperRuntime
        ? createExecutorBeekeeperTools(this.beekeeperRuntime, taskEnvelope.taskId)
        : []),
      ...createExecutorCredentialTools(this.credentialMcpRuntime!, taskEnvelope.taskId),
      createEvidenceListTool(this.executionLog),
      createEvidenceReadTool(this.executionLog)
    ];
  }

  private async buildCredentialSummary(scopeSummary: string): Promise<string> {
    if (!this.credentialMcpRuntime) return "";
    try {
      const result = await this.credentialMcpRuntime.call(
        "planner",
        "credential_query",
        { scopeRef: this.runId, includeInvalid: false }
      ) as { records?: Array<{ role?: string; kind: string; hostRef?: string; valid: boolean; lastUsedAt?: string }> };
      const records = result?.records;
      if (!records || records.length === 0) return "";
      const lines = records.map((record) => {
        const roleTag = record.role ? `[${record.role}]` : "[unknown]";
        const hostInfo = record.hostRef ? ` on ${record.hostRef}` : "";
        const validity = record.valid ? "valid" : "invalid";
        const lastUsed = record.lastUsedAt ? `, last used: ${record.lastUsedAt}` : "";
        return `- ${roleTag} ${record.kind}${hostInfo} (${validity}${lastUsed})`;
      });
      return `\n\n<credential_summary scope="${scopeSummary}">\nAvailable credentials:\n${lines.join("\n")}\n</credential_summary>`;
    } catch {
      return "";
    }
  }

  private async configureBeekeeperRuntime(): Promise<void> {
    if (this.beekeeperRuntime) {
      return;
    }
    if (this.beekeeperConfigInvalid) {
      if (!this.beekeeperCapabilityReported) {
        this.beekeeperCapabilityReported = true;
        await this.executionLog.append({
          role: "runtime",
          eventType: "beekeeper_mcp_failed",
          summary: "Beekeeper MCP configuration is invalid",
          payload: { enabled: false }
        });
      }
      return;
    }
    if (!this.beekeeperConfig) {
      if (!this.beekeeperCapabilityReported) {
        this.beekeeperCapabilityReported = true;
        await this.executionLog.append({
          role: "runtime",
          eventType: "beekeeper_mcp_disabled",
          summary: "Beekeeper MCP is not configured",
          payload: { enabled: false }
        });
      }
      return;
    }
    const runtime = this.beekeeperRuntimeFactory({
      config: this.beekeeperConfig,
      executionLog: this.executionLog
    });
    try {
      await runtime.start();
      this.beekeeperRuntime = runtime;
      this.beekeeperCapabilityReported = true;
      await this.executionLog.append({
        role: "runtime",
        eventType: "beekeeper_mcp_ready",
        summary: "Beekeeper MCP is ready for Task Executors",
        payload: { enabled: true }
      });
    } catch {
      await runtime.close("Beekeeper MCP initialization failed").catch(() => undefined);
      this.beekeeperCapabilityReported = true;
      await this.executionLog.append({
        role: "runtime",
        eventType: "beekeeper_mcp_failed",
        summary: "Beekeeper MCP initialization failed",
        payload: { enabled: false }
      });
    }
  }

  private async configureFofaRuntime(scopeSummary: string): Promise<void> {
    if (this.fofaRuntime) {
      const fingerprint = new FofaScopePolicy(parseAuthorizedScope(scopeSummary)).fingerprint();
      if (fingerprint !== this.fofaScopeFingerprint) {
        throw new Error("FOFA Runtime Scope cannot change within one Controller Run");
      }
      return;
    }
    if (this.fofaConfigInvalid) {
      if (!this.fofaCapabilityReported) {
        this.fofaCapabilityReported = true;
        await this.executionLog.append({
          role: "runtime",
          eventType: "fofa_mcp_failed",
          summary: "FOFA MCP configuration is invalid",
          payload: { enabled: false }
        });
      }
      return;
    }
    if (!this.fofaConfig) {
      if (!this.fofaCapabilityReported) {
        this.fofaCapabilityReported = true;
        await this.executionLog.append({
          role: "runtime",
          eventType: "fofa_mcp_disabled",
          summary: "FOFA MCP is not configured",
          payload: { enabled: false }
        });
      }
      return;
    }
    let scope;
    try {
      scope = parseAuthorizedScope(scopeSummary);
    } catch {
      if (!this.fofaCapabilityReported) {
        this.fofaCapabilityReported = true;
        await this.executionLog.append({
          role: "runtime",
          eventType: "fofa_mcp_failed",
          summary: "FOFA MCP requires a machine-readable domain or IPv4 Scope",
          payload: { enabled: false }
        });
      }
      return;
    }
    const policy = new FofaScopePolicy(scope);
    const runtime = this.fofaRuntimeFactory({
      runRef: this.runId,
      scope,
      config: this.fofaConfig,
      runtimeStore: this.runtimeStore,
      executionLog: this.executionLog
    });
    try {
      await runtime.start();
      this.fofaRuntime = runtime;
      this.fofaScopeFingerprint = policy.fingerprint();
      this.fofaCapabilityReported = true;
      await this.executionLog.append({
        role: "runtime",
        eventType: "fofa_mcp_ready",
        summary: "FOFA MCP is ready for Task Executors",
        payload: { enabled: true, scopeFingerprint: this.fofaScopeFingerprint }
      });
    } catch {
      await runtime.close("FOFA MCP initialization failed").catch(() => undefined);
      this.fofaCapabilityReported = true;
      await this.executionLog.append({
        role: "runtime",
        eventType: "fofa_mcp_failed",
        summary: "FOFA MCP initialization failed",
        payload: { enabled: false }
      });
    }
  }

  private invalidateFofaTaskIfTerminal(taskRef: string, status: string, retryable = false): void {
    if (status === "completed" || status === "blocked" || status === "archived"
      || (status === "failed" && !retryable)) {
      this.fofaRuntime?.invalidateTask(taskRef);
    }
  }

  private async disposeTaskExecutorResources(
    taskId: string,
    options: { throwOnFailure?: boolean } = {}
  ): Promise<void> {
    const failures: unknown[] = [];
    const sandbox = this.taskExecutorSandboxes.get(taskId);
    if (sandbox) {
      try {
        await sandbox.dispose();
        if (this.taskExecutorSandboxes.get(taskId) === sandbox) {
          this.taskExecutorSandboxes.delete(taskId);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.connectivityRuntime && !this.connectivityRuntimeCleanupComplete) {
      try {
        await this.connectivityRuntime.disposeTask(taskId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      const failureMessages = failures.map((error) => error instanceof Error ? error.message : String(error));
      await this.executionLog.append({
        taskId,
        role: "runtime",
        eventType: "executor_task_cleanup_failed",
        summary: failureMessages.join("; "),
        payload: { failures: failureMessages }
      }).catch(() => undefined);
      if (options.throwOnFailure) {
        throw new AggregateError(failures, `Executor task cleanup failed for ${taskId}`);
      }
    }
  }

  private async closeExecutorResources(): Promise<void> {
    const failures: unknown[] = [];
    for (const taskId of [...this.taskExecutorSandboxes.keys()]) {
      try {
        await this.disposeTaskExecutorResources(taskId, { throwOnFailure: true });
      } catch (error) {
        failures.push(error);
      }
    }
    const executorSandbox = this.executorSandbox;
    if (executorSandbox) {
      if (executorSandbox.dispose) {
        try {
          await executorSandbox.dispose();
          if (this.executorSandbox === executorSandbox) this.executorSandbox = undefined;
        } catch (error) {
          failures.push(error);
          await this.executionLog.append({
            role: "runtime",
            eventType: "executor_sandbox_cleanup_failed",
            summary: error instanceof Error ? error.message : String(error),
            payload: {}
          }).catch(() => undefined);
        }
      } else if (this.executorSandbox === executorSandbox) {
        this.executorSandbox = undefined;
      }
    }
    if (this.connectivityRuntime && !this.connectivityRuntimeCleanupComplete) {
      try {
        await this.connectivityRuntime.close();
        this.connectivityRuntimeCleanupComplete = true;
      } catch (error) {
        failures.push(error);
        await this.executionLog.append({
          role: "runtime",
          eventType: "connectivity_runtime_cleanup_failed",
          summary: error instanceof Error ? error.message : String(error),
          payload: {}
        }).catch(() => undefined);
      }
    }
    if (failures.length === 0 && this.connectivityStore) {
      try {
        this.connectivityStore.close();
      } catch (error) {
        failures.push(error);
        await this.executionLog.append({
          role: "runtime",
          eventType: "connectivity_store_cleanup_failed",
          summary: error instanceof Error ? error.message : String(error),
          payload: {}
        }).catch(() => undefined);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Controller executor resource cleanup failed");
    }
    this.connectivityStore = undefined;
    this.connectivityRuntime = undefined;
  }

  private async createExecutorSessionForTask(
    taskEnvelope: TaskEnvelope,
    useDynamicExecutor: boolean
  ): Promise<ExecutorSessionLease> {
    if (!this.isolatedSessionsEnabled && !useDynamicExecutor) {
      return { session: this.requireAgents().executor, dynamicExecutor: false, resumed: false, resumeCount: 0 };
    }
    const sandbox = this.requireExecutorSandbox(taskEnvelope.taskId);
    const persisted = this.runtimeStore.getExecutorSession(taskEnvelope.taskId);
    if (persisted) {
      const selectedSkillDirs = await this.selectTaskSkillDirs(taskEnvelope.goal, taskEnvelope.taskId);
      const sessionManager = SessionManager.open(persisted.sessionFile, undefined, sandbox.root);
      const executor = await createExecutorAgentSession({
        cwd: sandbox.root,
        sandbox,
        artifactStore: this.artifactStore,
        llmRuntime: this.llmRuntime,
        sessionManager,
        skillsDirs: selectedSkillDirs,
        additionalTools: this.createTaskRuntimeTools(taskEnvelope),
        providerAdmission: this.providerAdmission("executor")
      });
      const lease: ExecutorSessionLease = {
        session: executor.session,
        dynamicExecutor: true,
        resumed: true,
        resumeCount: persisted.resumeCount + 1,
        continuedFromTaskRef: taskEnvelope.continueFromTaskRef
      };
      this.runtimeStore.upsertExecutorSession({
        taskId: taskEnvelope.taskId,
        sessionFile: persisted.sessionFile,
        workspaceKey: persisted.workspaceKey,
        resumeCount: lease.resumeCount
      });
      await this.executionLog.append({
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "executor_session_resumed",
        summary: `Resumed Executor session for ${taskEnvelope.taskId}`,
        payload: {
          sessionFile: persisted.sessionFile,
          resumeCount: lease.resumeCount
        }
      });
      return lease;
    }
    return this.createNewExecutorSessionForTask(taskEnvelope, useDynamicExecutor);
  }

  private async createNewExecutorSessionForTask(
    taskEnvelope: TaskEnvelope,
    useDynamicExecutor: boolean
  ): Promise<ExecutorSessionLease> {
    if (!this.isolatedSessionsEnabled && !useDynamicExecutor) {
      return { session: this.requireAgents().executor, dynamicExecutor: false, resumed: false, resumeCount: 0 };
    }
    const sandbox = this.requireExecutorSandbox(taskEnvelope.taskId);
    const selectedSkillDirs = await this.selectTaskSkillDirs(taskEnvelope.goal, taskEnvelope.taskId);
    const sessionDir = join(this.runtimeDir, EXECUTOR_SESSION_DIR);
    const sessionManager = SessionManager.create(sandbox.root, sessionDir);
    const executor = await createExecutorAgentSession({
      cwd: sandbox.root,
      sandbox,
      artifactStore: this.artifactStore,
      llmRuntime: this.llmRuntime,
      sessionManager,
      skillsDirs: selectedSkillDirs,
      additionalTools: this.createTaskRuntimeTools(taskEnvelope),
      providerAdmission: this.providerAdmission("executor")
    });
    const sessionFile = executor.session.sessionFile;
    if (!sessionFile) {
      throw new Error(`Executor session for ${taskEnvelope.taskId} was not persisted to a file`);
    }
    this.runtimeStore.upsertExecutorSession({
      taskId: taskEnvelope.taskId,
      sessionFile,
      resumeCount: 0
    });
    return { session: executor.session, dynamicExecutor: true, resumed: false, resumeCount: 0 };
  }

  private async selectTaskSkillDirs(taskGoal: string, taskId: string): Promise<string[]> {
    try {
      const snapshot = this.skillSnapshot ?? this.skillRegistry.scan();
      this.skillSnapshot = snapshot;
      if (snapshot.skills.length === 0) return [];
      const result = await this.skillSelector({ taskGoal, snapshot });
      for (const skill of result.selected) {
        await this.executionLog.append({
          taskId,
          role: "runtime",
          eventType: "skill_selected",
          summary: skill.name,
          payload: { skillName: skill.name, baseDir: skill.baseDir, reason: result.reasons[skill.name] }
        });
      }
      for (const diagnostic of result.diagnostics) {
        await this.executionLog.append({
          taskId,
          role: "runtime",
          eventType: "skill_skipped",
          summary: diagnostic.message,
          payload: { code: diagnostic.code, skillName: diagnostic.skillName }
        });
      }
      return [...new Set(result.selected.map((skill) => skill.baseDir))];
    } catch (error) {
      await this.executionLog.append({
        taskId,
        role: "runtime",
        eventType: "skill_selection_failed",
        summary: error instanceof Error ? error.message : String(error),
        payload: {}
      }).catch(() => undefined);
      return [];
    }
  }

  private async renderInitialExecutorInput(input: {
    rootGoal: string;
    taskEnvelope: TaskEnvelope;
    taskStatus?: Record<string, unknown>;
    runtimeBudgetStatus: string;
  }): Promise<string> {
    const executionGraphContext = this.graphStore.projectionClosure({
      taskId: input.taskEnvelope.taskId,
      scopeRef: input.taskEnvelope.scopeRef,
      dependencyTaskIds: input.taskEnvelope.dependsOnTaskRefs,
      targetRefs: dedupeStrings([
        ...input.taskEnvelope.targetRefs,
        ...(input.taskEnvelope.basisRefs ?? [])
      ]),
      anchors: taskKnowledgeAnchors(input.taskEnvelope),
      nodeLimit: 28,
      edgeLimit: 48
    });
    const operationGraphSlice = compactExecutorGraphClosure(executionGraphContext, "operation", 12);
    return renderExecutorInput({
      rootGoal: this.reportingGoal(input.rootGoal),
      taskEnvelope: input.taskEnvelope,
      operationGraphSlice,
      reasoningGraphSlice: compactExecutorGraphClosure(executionGraphContext, "reasoning", 12),
      sessionRefs: this.withSessionMaterialRefs(
        operationGraphSlice.nodes.filter((node) => ["AgentSession", "ShellSession", "Session", "Credential"].includes(node.type))
      ),
      executionBrief: createExecutionBrief(input.taskEnvelope, (await this.executionLog.window({
        taskId: input.taskEnvelope.taskId,
        limit: 5,
        roles: ["executor", "runtime"]
      })).events, this.runtimeStore.getTaskOutcome(input.taskEnvelope.taskId), input.taskStatus),
      dependencyOutcomes: await this.createDependencyOutcomeBrief(input.taskEnvelope),
      runtimeBudgetStatus: input.runtimeBudgetStatus,
      environmentFacts: await this.executorEnvironmentFacts(input.taskEnvelope.taskId)
    });
  }

  private async renderResumeExecutorInput(input: {
    rootGoal: string;
    taskEnvelope: TaskEnvelope;
    taskStatus?: Record<string, unknown>;
    runtimeBudgetStatus: string;
    continuedFromTaskRef?: string;
  }): Promise<string> {
    const executionGraphContext = this.graphStore.projectionClosure({
      taskId: input.taskEnvelope.taskId,
      scopeRef: input.taskEnvelope.scopeRef,
      dependencyTaskIds: input.taskEnvelope.dependsOnTaskRefs,
      targetRefs: dedupeStrings([
        ...input.taskEnvelope.targetRefs,
        ...(input.taskEnvelope.basisRefs ?? [])
      ]),
      anchors: taskKnowledgeAnchors(input.taskEnvelope),
      nodeLimit: 28,
      edgeLimit: 48
    });
    const operationGraphSlice = compactExecutorGraphClosure(executionGraphContext, "operation", 12);
    return renderExecutorResumeInput({
      rootGoal: this.reportingGoal(input.rootGoal),
      taskEnvelope: input.taskEnvelope,
      operationGraphSlice,
      reasoningGraphSlice: compactExecutorGraphClosure(executionGraphContext, "reasoning", 12),
      sessionRefs: this.withSessionMaterialRefs(
        operationGraphSlice.nodes.filter((node) => ["AgentSession", "ShellSession", "Session", "Credential"].includes(node.type))
      ),
      executionBrief: createExecutionBrief(input.taskEnvelope, (await this.executionLog.window({
        taskId: input.taskEnvelope.taskId,
        limit: 5,
        roles: ["executor", "runtime"]
      })).events, this.runtimeStore.getTaskOutcome(input.taskEnvelope.taskId), input.taskStatus),
      dependencyOutcomes: await this.createDependencyOutcomeBrief(input.taskEnvelope),
      runtimeBudgetStatus: input.runtimeBudgetStatus,
      continuedFromTaskRef: input.continuedFromTaskRef,
      environmentFacts: await this.executorEnvironmentFacts(input.taskEnvelope.taskId)
    });
  }

  private withSessionMaterialRefs<T extends { evidenceRefs?: string[] }>(
    nodes: T[]
  ): Array<T & { materialRefs?: string[] }> {
    const materialsByEvent = this.executionLog.artifactRefsForEvents(
      nodes.flatMap((node) => node.evidenceRefs ?? [])
    );
    if (materialsByEvent.size === 0) {
      return nodes;
    }
    return nodes.map((node) => {
      const materialRefs: string[] = [];
      for (const evidenceRef of node.evidenceRefs ?? []) {
        for (const materialRef of materialsByEvent.get(evidenceRef) ?? []) {
          if (!materialRefs.includes(materialRef)) {
            materialRefs.push(materialRef);
          }
        }
      }
      return materialRefs.length > 0
        ? { ...node, materialRefs: materialRefs.slice(0, 8) }
        : node;
    });
  }

  private getRootGoalText(): string | undefined {
    return this.graphStore
      .query("task", ["goal:root"], 1)
      .nodes
      .find((node) => node.id === "goal:root")
      ?.label;
  }

  private queuePlannerStateUpdate(input: {
    reason: string;
    taskId?: string;
    message?: string;
    invalidateSubmission?: boolean;
  }): boolean {
    const invalidateSubmission = input.invalidateSubmission !== false;
    if (invalidateSubmission) {
      this.plannerControlRevision += 1;
    }
    const revision = this.plannerControlRevision;
    const currentView = this.buildPlannerDecisionView();
    const deliverySeq = this.executionLog.latestSeq();
    let queuedCount = 0;
    for (const plannerSession of this.activePlannerSessions) {
      const steer = (plannerSession as { steer?: (text: string) => Promise<void> }).steer;
      if (typeof steer !== "function") {
        continue;
      }
      const delivery = this.activePlannerDelivery.get(plannerSession);
      const message = input.message ?? (delivery
        ? `RUNTIME_PLANNER_STATE_UPDATE\n${renderPlannerInput({
          userGoal: "",
          scopeSummary: "",
          plannerDecisionView: currentView,
          previousPlannerDecisionView: delivery.queuedView,
          previousDeliverySeq: delivery.queuedSeq,
          deliverySeq
        })}`
        : `RUNTIME_PLANNER_STATE_UPDATE\n${input.reason}`);
      if (delivery) {
        delivery.queuedView = currentView;
        delivery.queuedSeq = deliverySeq;
        if (invalidateSubmission) {
          delivery.requiresControlUpdateConsumption = true;
        }
      }
      queuedCount += 1;
      void steer.call(plannerSession, message).then(() => {
        if (delivery && invalidateSubmission) {
          delivery.queuedRevision = Math.max(delivery.queuedRevision, revision);
        }
      }).catch((error: unknown) => {
        void this.executionLog.append({
          taskId: input.taskId,
          role: "runtime",
          eventType: "planner_state_update_steer_failed",
          summary: `Failed to steer Planner state update: ${error instanceof Error ? error.message : String(error)}`,
          payload: { reason: input.reason, revision, taskId: input.taskId, submissionInvalidated: invalidateSubmission }
        });
      });
    }
    if (queuedCount > 0) {
      void this.executionLog.append({
        taskId: input.taskId,
        role: "runtime",
        eventType: "planner_state_update_queued",
        summary: input.reason,
        payload: {
          revision,
          deliverySeq,
          queuedCount,
          taskId: input.taskId,
          submissionInvalidated: invalidateSubmission
        }
      });
    }
    return queuedCount > 0;
  }

  private plannerSubmissionCanSettle(session: SecurityAgentSession): boolean {
    const delivery = this.activePlannerDelivery.get(session);
    if (!delivery) {
      return true;
    }
    if (delivery.queuedRevision !== this.plannerControlRevision) {
      return false;
    }
    if (!delivery.requiresControlUpdateConsumption) {
      return true;
    }
    const pendingMessageCount = (session as { pendingMessageCount?: unknown }).pendingMessageCount;
    if (typeof pendingMessageCount === "number" && pendingMessageCount > 0) {
      return false;
    }
    delivery.requiresControlUpdateConsumption = false;
    return true;
  }

  private async invokePlannerCycle(input: {
    userGoal: string;
    scopeSummary: string;
    repairFeedback?: string;
  }): Promise<{
    plannerDecision: PlannerDecision;
    plannerPromptId: string;
    versionSnapshot: Record<string, number>;
  }> {
    let lastError: unknown;
    let attemptFeedback = input.repairFeedback;
    for (let attempt = 1; attempt <= PLANNER_FRESH_SESSION_ATTEMPTS; attempt += 1) {
      if (this.stopRequestedReason) {
        throw new Error(this.stopRequestedReason);
      }
      const plannerHardTimeoutMs = this.remainingRunTimeLimit(PLANNER_HARD_TIMEOUT_MS);
      if (plannerHardTimeoutMs <= 0) {
        throw new Error(`Reached global run time budget: ${this.activeRun?.maxRunTimeMs ?? 0}ms`);
      }
      const versionSnapshot = this.graphStore.plannerVersionSnapshot();
      const plannerDecisionView = await this.buildPlannerDecisionView();
      const plannerSessionResult = await this.createPlannerSessionForCycle(attempt > 1, versionSnapshot);
      const deliverySeq = this.executionLog.latestSeq();
      const plannerStateDelivery = plannerSessionResult.isolated || !this.lastPlannerDecisionView
        ? "snapshot"
        : "delta";
      const plannerInput = renderPlannerInput({
        ...input,
        repairFeedback: attemptFeedback,
        plannerDecisionView,
        ...(plannerSessionResult.isolated || !this.lastPlannerDecisionView
          ? {}
          : {
            previousPlannerDecisionView: this.lastPlannerDecisionView,
            previousDeliverySeq: this.lastPlannerDeliverySeq
          }),
        deliverySeq
      });
      const plannerInputBytes = Buffer.byteLength(plannerInput);
      const plannerPromptId = `planner:${randomUUID()}`;
      await this.executionLog.append({
        role: "runtime",
        eventType: "planner_prompt_started",
        summary: `Planner prompt started attempt=${attempt}`,
        payload: {
          plannerPromptId,
          attempt,
          maxAttempts: PLANNER_FRESH_SESSION_ATTEMPTS,
          stateDelivery: plannerStateDelivery,
          previousDeliverySeq: plannerStateDelivery === "delta" ? this.lastPlannerDeliverySeq : undefined,
          deliverySeq,
          idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
          hardTimeoutMs: plannerHardTimeoutMs
        }
      });
      const plannerHeartbeat = this.startRuntimeHeartbeat({
        eventType: "planner_prompt_heartbeat",
        summary: "Planner prompt still running",
        payload: { plannerPromptId, attempt }
      });
      let plannerLogging: ReturnType<typeof attachExecutionLogging> | undefined;
      let plannerStatsBefore: PiSessionStatsSnapshot | undefined;
      let plannerInvocationStatus = "completed";
      let retryDelayMs = 0;
      const plannerInvocationStartedAt = Date.now();
      try {
        const plannerSession = plannerSessionResult.session;
        this.activePlannerSessions.add(plannerSession);
        this.activePlannerDelivery.set(plannerSession, {
          queuedRevision: this.plannerControlRevision,
          queuedView: plannerDecisionView,
          queuedSeq: deliverySeq,
          requiresControlUpdateConsumption: false
        });
        plannerStatsBefore = readPiSessionStats(plannerSession);
        plannerLogging = plannerSessionResult.isolated
          ? attachExecutionLogging({
            session: plannerSession,
            executionLog: this.executionLog,
            artifactStore: this.artifactStore,
            role: "planner"
          })
          : undefined;
        const plannerDecision = this.structuredInvocationsEnabled
          ? await invokeStructured<PlannerDecision>(plannerSession, plannerInput, {
            toolName: "planner_submit",
            idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
            hardTimeoutMs: plannerHardTimeoutMs,
            validate: (value) => this.normalizePlannerDecisionBoundary(value),
            admission: this.providerAdmission("planner")
          })
          : await this.validateTextPlannerSubmission(extractJsonObject<unknown>(await withTimeout(
              promptAndCollect(plannerSession, plannerInput, {
                admission: this.providerAdmission("planner")
              }),
              plannerHardTimeoutMs,
              () => void plannerSession.abort()
            )));
        if (!plannerSessionResult.isolated) {
          const delivered = this.activePlannerDelivery.get(plannerSession);
          this.lastPlannerDecisionView = delivered?.queuedView ?? plannerDecisionView;
          this.lastPlannerDeliverySeq = delivered?.queuedSeq ?? deliverySeq;
        }
        return { plannerDecision, plannerPromptId, versionSnapshot };
      } catch (error) {
        lastError = error;
        if (this.stopRequestedReason) {
          plannerInvocationStatus = "aborted";
          await this.executionLog.append({
            role: "runtime",
            eventType: "planner_prompt_aborted",
            summary: this.stopRequestedReason,
            payload: { plannerPromptId, attempt, maxAttempts: PLANNER_FRESH_SESSION_ATTEMPTS }
          });
          throw error;
        }
        const providerFailure = classifyPlannerProviderFailure(error);
        if (error instanceof StructuredInvocationError && error.code === "missing_submit") {
          attemptFeedback = [attemptFeedback, MISSING_SUBMIT_RETRY_FEEDBACK]
            .filter((value) => value && value.trim().length > 0)
            .join("\n");
        }
        plannerInvocationStatus = providerFailure.retryable ? "provider_error" : "failed";
        await this.executionLog.append({
          role: "runtime",
          eventType: "planner_prompt_failed",
          summary: providerFailure.message,
          payload: {
            plannerPromptId,
            attempt,
            maxAttempts: PLANNER_FRESH_SESSION_ATTEMPTS,
            retryable: providerFailure.retryable,
            errorKind: providerFailure.errorKind
          }
        });
        if (Date.now() >= (this.activeRun?.deadlineAt ?? Number.POSITIVE_INFINITY)
          || !providerFailure.retryable
          || attempt >= PLANNER_FRESH_SESSION_ATTEMPTS) {
          throw error;
        }
        await this.executionLog.append({
          role: "runtime",
          eventType: "planner_prompt_retry_scheduled",
          summary: `Retrying Planner after ${providerFailure.errorKind}`,
          payload: {
            plannerPromptId,
            attempt,
            nextAttempt: attempt + 1,
            backoffMs: PLANNER_FRESH_SESSION_BACKOFF_MS,
            errorKind: providerFailure.errorKind
          }
        });
        retryDelayMs = PLANNER_FRESH_SESSION_BACKOFF_MS * attempt;
      } finally {
        clearInterval(plannerHeartbeat);
        this.activePlannerSessions.delete(plannerSessionResult.session);
        this.activePlannerDelivery.delete(plannerSessionResult.session);
        await plannerLogging?.drain();
        plannerLogging?.();
        await this.appendInvocationMetrics({
          session: plannerSessionResult.session,
          before: plannerStatsBefore,
          invocationId: plannerPromptId,
          invocationKind: "planner",
          agentRole: "planner",
          status: plannerInvocationStatus,
          startedAt: plannerInvocationStartedAt,
          inputBytes: plannerInputBytes,
          details: {
            isolatedSession: plannerSessionResult.isolated,
            plannerStateDelivery,
            attempt,
            maxAttempts: PLANNER_FRESH_SESSION_ATTEMPTS,
            idleTimeoutMs: PLANNER_IDLE_TIMEOUT_MS,
            hardTimeoutMs: plannerHardTimeoutMs
          }
        });
        if (plannerSessionResult.isolated) {
          disposeSession(plannerSessionResult.session);
        }
      }
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
        if (this.stopRequestedReason) {
          throw new Error(this.stopRequestedReason);
        }
      }
    }
    throw lastError ?? new Error("Planner retry loop exhausted without result");
  }

  private remainingRunTimeLimit(configuredLimitMs: number): number {
    if (!this.activeRun) {
      return configuredLimitMs;
    }
    return Math.max(0, Math.min(configuredLimitMs, this.activeRun.deadlineAt - Date.now()));
  }

  private async createPlannerSessionForCycle(
    forceIsolated = false,
    versionSnapshot?: Record<string, number>
  ): Promise<{ session: SecurityAgentSession; isolated: boolean }> {
    if (!forceIsolated) {
      if (this.agents?.planner) {
        return { session: this.agents.planner, isolated: false };
      }
      if (this.ownedPlannerSession) {
        return { session: this.ownedPlannerSession, isolated: false };
      }
    }
    const planner = await createPlannerAgentSession({
      cwd: this.cwd,
      graphStore: this.graphStore,
      artifactStore: this.artifactStore,
      llmRuntime: this.llmRuntime,
      executionLog: this.executionLog,
      plannerReferenceCandidates: (prefix) => this.plannerCapabilityReferenceCandidates(prefix),
      providerAdmission: this.providerAdmission("planner"),
      ...(versionSnapshot
        ? {
          validatePlannerCommands: (decision: PlannerDecision) => {
            this.validatePlannerRuntimeBoundary(decision);
          }
        }
        : {})
    });
    if (forceIsolated) {
      return { session: planner.session, isolated: true };
    }
    this.ownedPlannerSession = planner.session;
    this.ownedPlannerLogging = attachExecutionLogging({
      session: planner.session,
      executionLog: this.executionLog,
      artifactStore: this.artifactStore,
      role: "planner"
    });
    return { session: planner.session, isolated: false };
  }

  private validatePlannerRuntimeBoundary(decision: PlannerDecision): void {
    for (const plannerSession of this.activePlannerSessions) {
      if (!this.plannerSubmissionCanSettle(plannerSession)) {
        throw new Error(
          "Planner state changed while this decision was being produced. " +
          "This planner_submit was rejected and none of its commands were applied. " +
          "Consume the queued RUNTIME_PLANNER_STATE_UPDATE, then submit one complete replacement decision. " +
          "Do not assume that any command from this rejected submission exists."
        );
      }
    }
    this.normalizePlannerDecisionBoundary(decision);
  }

  private async validateTextPlannerSubmission(value: unknown): Promise<PlannerDecision> {
    const normalized = this.normalizePlannerDecisionBoundary(value);
    const resolved = await validatePlannerBasedOnRefs(normalized, {
      listArtifacts: () => this.artifactStore.list(),
      referenceCandidates: (prefix) => this.plannerReferenceCandidates(prefix)
    });
    this.graphStore.validatePlannerDecision(resolved);
    return resolved;
  }

  private plannerReferenceCandidates(prefix: string): string[] {
    return [...new Set([
      ...this.graphStore.nodeIdsWithPrefix(prefix),
      ...this.executionLog.eventIdsWithPrefix(prefix),
      ...this.runtimeStore.epochRefsWithPrefix(prefix),
      ...this.plannerCapabilityReferenceCandidates(prefix)
    ])];
  }

  private plannerCapabilityReferenceCandidates(prefix: string): string[] {
    return dedupeStrings(this.runtimeStore.listTaskOutcomes(Number.MAX_SAFE_INTEGER)
      .flatMap((outcome) => outcome.capabilityRefs)
      .filter((reference) => reference.startsWith(prefix)))
      .slice(0, 4);
  }

  private async createObserverSessionForMode(
    mode: ObserverMode,
    taskId: string,
    projectorGraphRefs?: ProjectorGraphRefRegistry,
    projectorDraftValidation?: Omit<ProjectionDraftValidationOptions, "existingAliases">
  ): Promise<{
    session: SecurityAgentSession;
    dynamicObserver: boolean;
    logging: ReturnType<typeof attachExecutionLogging>;
  }> {
    const observer = await createObserverAgentSession({
      cwd: this.cwd,
      graphStore: this.graphStore,
      executionLog: this.executionLog,
      artifactStore: this.artifactStore,
      llmRuntime: this.llmRuntime,
      mode,
      projectorGraphRefs,
      projectorDraftValidation,
      providerAdmission: this.providerAdmission(mode === "supervise" ? "supervisor" : "projector")
    });
    const logging = attachExecutionLogging({
      session: observer.session,
      executionLog: this.executionLog,
      artifactStore: this.artifactStore,
      role: "observer",
      getTaskId: () => taskId
    });
    return { session: observer.session, dynamicObserver: true, logging };
  }

  private beginTaskExecution(taskEnvelope: TaskEnvelope): ActiveTaskState {
    const epochId = `epoch:${randomUUID()}`;
    const attempt = this.nextTaskAttempt(taskEnvelope.taskId);
    const state: ActiveTaskState = {
      epochId,
      lifecycleState: "created",
      taskEnvelope,
      toolExecutionEndCount: 0,
      epochTurnCount: 0,
      taskTurnCount: this.runtimeStore.getTaskConsumedTurns(taskEnvelope.taskId),
      executorStopRequested: false,
      checkpointFinalizationActive: false,
      dynamicExecutor: false,
      attempt,
      budgetStatusSteerKeys: new Set(),
      invocationAbortController: new AbortController(),
      supervisionState: restoreTaskSupervisionState(
        taskEnvelope,
        this.runtimeStore.getTaskOutcome(taskEnvelope.taskId),
        this.taskSupervisionStates.get(taskEnvelope.taskId)
      )
    };
    this.runtimeStore.createEpoch({
      epochId,
      taskId: taskEnvelope.taskId,
      attempt,
      startSeq: this.executionLog.latestSeq(taskEnvelope.taskId)
    });
    this.runtimeStore.transitionEpoch({ epochId, state: "running" });
    state.lifecycleState = "running";
    this.activeEpochs.set(epochId, state);
    this.activeEpochIdByTask.set(taskEnvelope.taskId, epochId);
    return state;
  }

  private finishTaskExecution(taskId: string, terminationReason: ActiveTaskState["terminationReason"] = "executor_submitted"): void {
    const state = this.getActiveTaskState(taskId);
    if (state) {
      this.taskSupervisionStates.set(taskId, cloneTaskSupervisionState(state.supervisionState));
      state.lifecycleState = "closed";
      state.terminationReason = terminationReason;
      this.runtimeStore.transitionEpoch({
        epochId: state.epochId,
        state: "closed",
        terminationReason,
        endSeq: this.executionLog.latestSeq(taskId)
      });
    }
    state?.epochBudgetClock?.stop();
    if (state) {
      const supervisorAbort = this.supervisorAbortByEpoch.get(state.epochId);
      if (supervisorAbort && !supervisorAbort.signal.aborted) {
        supervisorAbort.abort(`Executor epoch ${state.epochId} closed`);
      }
      this.activeEpochs.delete(state.epochId);
      this.latestSupervisorThroughSeqByEpoch.delete(state.epochId);
    }
    this.activeEpochIdByTask.delete(taskId);
  }

  private async persistEpochOutcome(
    state: ActiveTaskState,
    input: Pick<EpochOutcome, "status" | "reason" | "retryable" | "taskOutcomeRef"> & {
      taskOutcome?: TaskOutcome;
    }
  ): Promise<{ outcome: EpochOutcome; eventId: string }> {
    const event = await this.executionLog.append({
      epochId: state.epochId,
      taskId: state.taskEnvelope.taskId,
      role: "runtime",
      eventType: `epoch_${input.status}`,
      summary: input.reason,
      payload: {
        status: input.status,
        retryable: input.retryable,
        taskOutcomeRef: input.taskOutcomeRef,
        abortKind: state.abortContext?.kind,
        controlSignal: state.controlSignal
      }
    });
    const outcome: EpochOutcome = {
      epochRef: state.epochId,
      taskRef: state.taskEnvelope.taskId,
      status: input.status,
      reason: input.reason,
      terminalSeq: event.seq ?? this.executionLog.latestSeq(state.taskEnvelope.taskId),
      taskOutcomeRef: input.taskOutcomeRef,
      retryable: input.retryable,
      createdAt: event.timestamp
    };
    if (input.taskOutcome) {
      this.runtimeStore.upsertTaskOutcome(input.taskOutcome);
    }
    this.runtimeStore.upsertEpochOutcome(outcome);
    this.queuePlannerStateUpdate({
      taskId: state.taskEnvelope.taskId,
      reason: input.taskOutcome
        ? `TaskOutcome and EpochOutcome persisted for ${state.taskEnvelope.taskId}`
        : `EpochOutcome persisted for ${state.taskEnvelope.taskId}`
    });
    return { outcome, eventId: event.id };
  }

  private getActiveTaskState(taskId: string): ActiveTaskState | undefined {
    const epochId = this.activeEpochIdByTask.get(taskId);
    return epochId ? this.activeEpochs.get(epochId) : undefined;
  }


  private isActiveEpoch(state: ActiveTaskState): boolean {
    return state.lifecycleState === "running"
      && this.activeEpochIdByTask.get(state.taskEnvelope.taskId) === state.epochId
      && this.activeEpochs.get(state.epochId) === state;
  }

  private async loadProjectorArtifactIndex(input: {
    taskEnvelope: TaskEnvelope;
    taskResult?: TaskResult;
    observations: ProjectionObservation[];
  }): Promise<{ text: string; itemCount: number; omittedCount: number }> {
    const directRefs = dedupeStrings(input.observations.flatMap((observation) => observation.artifactRefs));
    const includeTaskResultArtifacts = input.observations.some((observation) => observation.kind === "task_outcome");
    const taskResultRefs = includeTaskResultArtifacts ? input.taskResult?.artifactRefs ?? [] : [];
    const candidateRefs = dedupeStrings([...directRefs, ...taskResultRefs]);
    const relevantSnippets = await this.artifactStore.searchWithin({
      artifactRefs: candidateRefs,
      query: [
        ...input.observations.flatMap((observation) => observation.anchors),
        ...input.observations
          .filter((observation) => observation.kind === "task_outcome")
          .map((observation) => observation.outcomeDigest),
        ...input.observations.flatMap((observation) => [
          compactUtf8HeadTail(observation.executorCommentary ?? "", 260),
          compactUtf8HeadTail(observation.inputDigest ?? "", 600),
          compactUtf8HeadTail(observation.outcomeDigest, 900)
        ]),
        input.taskEnvelope.goal,
        ...input.taskEnvelope.successCriteria
      ].join(" "),
      limit: 6
    });
    const selected: string[] = [];
    for (const artifactRef of candidateRefs) {
      if (selected.length >= PROJECTOR_ARTIFACT_MANIFEST_LIMIT) {
        break;
      }
      const record = artifactRef.startsWith("artifact:") ? await this.artifactStore.get(artifactRef) : undefined;
      if (record && isRuntimeContextArtifact(record.preview)) {
        continue;
      }
      const snippet = relevantSnippets.find((candidate) => candidate.artifactRef === artifactRef);
      selected.push([
        `${artifactRef} kind=${record?.kind ?? "unknown"} bytes=${record?.byteLength ?? "unknown"}`,
        snippet ? `  match: ${truncateText(snippet.snippet.replace(/\s+/g, " "), 480)}` : undefined
      ].filter((line): line is string => Boolean(line)).join("\n"));
    }
    return {
      text: selected.length > 0 ? selected.join("\n") : "无相关 artifact。",
      itemCount: selected.length,
      omittedCount: Math.max(0, candidateRefs.length - selected.length)
    };
  }

  private async handleExecutorEventPersisted(event: ExecutionEvent): Promise<void> {
    if (!event.taskId) {
      return;
    }
    let state = this.getActiveTaskState(event.taskId);
    if (event.epochId && state && event.epochId !== state.epochId) {
      await this.executionLog.append({
        epochId: event.epochId,
        taskId: event.taskId,
        role: "runtime",
        eventType: "stale_callback_discarded",
        summary: `Ignored event from stale epoch ${event.epochId}`,
        payload: { sourceEventId: event.id, activeEpochId: state.epochId }
      });
      return;
    }
    const taskEnvelope = state?.taskEnvelope;
    if (!state || !taskEnvelope) {
      return;
    }
    state.lastEventId = event.id;
    updateTaskSupervisionState(state.supervisionState, event);
    if (executorContinuedAfterHandoffAdvice(event, state.supervisionState.lastVerdict)) {
      const supersededVerdict = state.supervisionState.lastVerdict;
      state.supervisionState.lastVerdict = undefined;
      await this.executionLog.append({
        epochId: state.epochId,
        taskId: event.taskId,
        role: "runtime",
        eventType: "supervisor_handoff_superseded",
        summary: `Executor continued after ${supersededVerdict?.decision ?? "handoff"} recommendation`,
        payload: {
          sourceEventId: event.id,
          supersededVerdict
        }
      });
    }
    if (event.eventType === "provider_retry_started") {
      this.pauseExecutorEpochBudget(state, event.eventType);
    }
    if (event.eventType === "provider_error") {
      const llmError = isRecord(event.payload?.llmError) ? event.payload.llmError : undefined;
      if (llmError?.retryable === true) {
        this.pauseExecutorEpochBudget(state, event.eventType);
      }
    }
    if (event.eventType === "provider_retry_completed") {
      await this.resumeExecutorEpochBudget(state, event.eventType);
    }
    if (isCountableExecutorTurn(event)) {
      if (state.checkpointFinalizationActive) {
        return;
      }
      state.epochTurnCount += 1;
      state.taskTurnCount = this.runtimeStore.recordTaskTurn({
        taskId: event.taskId,
        eventId: taskTurnIdentity(event)
      });
      this.publishExecutorBudgetStatusUpdate({
        taskEnvelope,
        state,
        sourceEventId: event.id,
        reason: "turn_usage"
      });
      if (state.taskTurnCount >= (taskEnvelope.budget?.maxTurns ?? DEFAULT_TASK_BUDGET.maxTurns)) {
        this.requestBudgetCheckpoint(taskEnvelope, event, "maxTurns", state);
      } else if (state.epochTurnCount >= DEFAULT_EPOCH_TURN_SLICE) {
        this.requestBudgetCheckpoint(taskEnvelope, event, "epochTurns", state);
      } else if (state.epochTurnCount % SUPERVISOR_TURN_WINDOW_SIZE === 0) {
        void this.enqueueSupervisorCheck({
          reason: `${TURN_WINDOW_REASON_PREFIX}${state.epochTurnCount}`,
          taskEnvelope,
          sourceEventIds: [event.id]
        }).then((controlSignal) => this.applyControlSignal(taskEnvelope, controlSignal, state));
      }
    }
    if (event.eventType === "tool_finished" || event.eventType === "tool_execution_end") {
      state.toolExecutionEndCount += 1;
      if (state.toolExecutionEndCount % PROJECTOR_TOOL_WINDOW_SIZE === 0) {
        void this.requestProjection({
          reason: `${PROJECT_WINDOW_REASON_PREFIX}${state.toolExecutionEndCount}`,
          taskEnvelope,
          sourceEventIds: [event.id]
        });
      }
    }
  }

  private enqueueSupervisorCheck(input: SupervisorCheckRequest): Promise<SupervisorVerdict> {
    const currentState = this.getActiveTaskState(input.taskEnvelope.taskId);
    const queueItem: SupervisorCheckRequest = {
      ...input,
      queueId: `supervisor:${randomUUID()}`,
      queuedAt: Date.now(),
      epochRef: input.epochRef ?? currentState?.epochId,
      throughSeq: input.throughSeq ?? this.executionLog.latestSeq(input.taskEnvelope.taskId)
    };
    const state = currentState;
    if (!state) {
      return this.discardSupervisorCheck(queueItem, "task is no longer active", input.sourceEventIds ?? []);
    }
    const epochId = state.epochId;
    this.latestSupervisorThroughSeqByEpoch.set(
      epochId,
      Math.max(this.latestSupervisorThroughSeqByEpoch.get(epochId) ?? 0, queueItem.throughSeq ?? 0)
    );
    if (this.supervisorInFlight.has(epochId)) {
      const existing = this.pendingSupervisorRequests.get(epochId);
      if (existing) {
        void this.discardSupervisorCheck(
          existing.request,
          `superseded by newer supervisor window ${queueItem.reason}`,
          existing.request.sourceEventIds ?? []
        ).then(existing.resolve, existing.reject);
      }
      const pending = new Promise<SupervisorVerdict>((resolve, reject) => {
        this.pendingSupervisorRequests.set(epochId, { request: queueItem, resolve, reject });
      });
      const activeAbort = this.supervisorAbortByEpoch.get(epochId);
      if (activeAbort && !activeAbort.signal.aborted) {
        activeAbort.abort(`Superseded by supervisor window ${queueItem.reason}`);
      }
      return pending;
    }
    return this.startSupervisorCheck(epochId, queueItem);
  }

  private startSupervisorCheck(epochId: string, input: SupervisorCheckRequest): Promise<SupervisorVerdict> {
    const abortController = new AbortController();
    const promise = this.runSupervisorCheck(input, abortController.signal);
    this.supervisorInFlight.set(epochId, promise);
    this.supervisorAbortByEpoch.set(epochId, abortController);
    void promise.then(() => {
      this.finishSupervisorCheck(epochId, promise, abortController);
    }, () => {
      this.finishSupervisorCheck(epochId, promise, abortController);
    });
    return promise;
  }

  private finishSupervisorCheck(
    epochId: string,
    promise: Promise<SupervisorVerdict>,
    abortController: AbortController
  ): void {
    if (this.supervisorInFlight.get(epochId) === promise) {
      this.supervisorInFlight.delete(epochId);
    }
    if (this.supervisorAbortByEpoch.get(epochId) === abortController) {
      this.supervisorAbortByEpoch.delete(epochId);
    }
    const pending = this.pendingSupervisorRequests.get(epochId);
    if (!pending) {
      return;
    }
    this.pendingSupervisorRequests.delete(epochId);
    this.startSupervisorCheck(epochId, pending.request).then(pending.resolve, pending.reject);
  }

  private async runSupervisorCheck(
    input: SupervisorCheckRequest,
    admissionSignal: AbortSignal = new AbortController().signal
  ): Promise<SupervisorVerdict> {
    const requestedSourceEventIds = input.sourceEventIds ?? [];
    let snapshotSourceEventIds = requestedSourceEventIds;
    let snapshotThroughSeq = input.throughSeq ?? 0;
    const state = this.getActiveTaskState(input.taskEnvelope.taskId);
    const discardReason = this.supervisorCheckDiscardReason(input, state);
    if (discardReason) {
      return this.discardSupervisorCheck(input, discardReason, requestedSourceEventIds);
    }
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "supervisor_check_started",
      summary: `${input.reason} started`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        queuedForMs: input.queuedAt ? Date.now() - input.queuedAt : undefined,
        sourceEventIds: requestedSourceEventIds
      }
    });
    let supervisorOutput = "";
    let supervisorSession: SecurityAgentSession | undefined;
    let supervisorLogging: ReturnType<typeof attachExecutionLogging> | undefined;
    let supervisorStatsBefore: PiSessionStatsSnapshot | undefined;
    let supervisorInputBytes = 0;
    let supervisorInvocationStatus = "failed";
    let abortSession: (() => void) | undefined;
    const supervisorInvocationStartedAt = Date.now();
    try {
      const logWindow = await this.executionLog.window({
        taskId: input.taskEnvelope.taskId,
        limit: 96,
        toSeq: input.throughSeq,
        roles: ["executor", "runtime"],
        eventTypes: [
          "assistant_intent",
          "turn_usage",
          "tool_started",
          "tool_finished",
          "provider_error",
          "message_end",
          "turn_end",
          "tool_execution_start",
          "tool_execution_end",
          "task_completed",
          "task_partial",
          "task_blocked",
          "task_failed",
          "executor_stop_requested"
        ]
      });
      const snapshotEvents = selectRecentExecutorTurnEvents(logWindow.events, SUPERVISOR_TURN_WINDOW_SIZE);
      const snapshotObservations = buildProjectionObservations(snapshotEvents).slice(-8);
      snapshotSourceEventIds = dedupeStrings(snapshotObservations.flatMap((observation) => observation.sourceEventIds));
      if (snapshotSourceEventIds.length === 0) {
        snapshotSourceEventIds = snapshotEvents
          .filter((event) => event.eventType !== "assistant_intent" && event.eventType !== "turn_usage")
          .map((event) => event.id);
      }
      if (input.throughSeq === undefined) {
        snapshotThroughSeq = snapshotEvents.reduce(
          (latest, event) => Math.max(latest, event.seq ?? 0),
          0
        );
      }
      const supervisorTrace = summarizeSupervisorTrace(
        snapshotEvents
      );
      const observerSession = await this.createObserverSessionForMode("supervise", input.taskEnvelope.taskId);
      const activeSupervisorSession = observerSession.session;
      supervisorSession = activeSupervisorSession;
      supervisorStatsBefore = readPiSessionStats(activeSupervisorSession);
      supervisorLogging = observerSession.logging;
      this.activeSupervisorSessions.add(activeSupervisorSession);
      abortSession = () => void activeSupervisorSession.abort();
      admissionSignal.addEventListener("abort", abortSession, { once: true });
      if (admissionSignal.aborted) {
        abortSession();
        supervisorInvocationStatus = "discarded";
        return this.discardSupervisorCheck(
          input,
          String(admissionSignal.reason ?? "superseded supervisor window"),
          snapshotSourceEventIds
        );
      }
      const supervisorInput = renderSupervisorInput({
          taskEnvelope: input.taskEnvelope,
          actionTraceText: supervisorTrace.actionTraceText,
          loopSignalsText: supervisorTrace.loopSignalsText,
          supervisionState: supervisionStateForPrompt(
            state?.supervisionState ?? createInitialTaskSupervisionState(input.taskEnvelope)
          ),
          budgetState: {
            ...budgetStatusSnapshot(input.taskEnvelope, state),
            toolExecutionEndCount: state?.toolExecutionEndCount ?? 0
          },
          taskStatus: this.getTaskStatusSnapshot(input.taskEnvelope.taskId),
          lastControlSignal: state?.supervisionState.lastVerdict ?? state?.controlSignal,
          priorRelevantKnowledge: compactSupervisorRelevantKnowledge(this.graphStore.projectionClosure({
            taskId: input.taskEnvelope.taskId,
            scopeRef: input.taskEnvelope.scopeRef,
            dependencyTaskIds: input.taskEnvelope.dependsOnTaskRefs,
            targetRefs: dedupeStrings([
              ...input.taskEnvelope.targetRefs,
              ...(input.taskEnvelope.basisRefs ?? [])
            ]),
            anchors: taskKnowledgeAnchors(input.taskEnvelope),
            nodeLimit: 20,
            edgeLimit: 32
          }), 8),
          sourceEventIds: snapshotSourceEventIds,
          reason: input.reason
        });
      supervisorInputBytes = Buffer.byteLength(supervisorInput);
      const rawControlSignal = this.structuredInvocationsEnabled
        ? await invokeStructured<unknown>(activeSupervisorSession, supervisorInput, {
          toolName: "control_submit",
          idleTimeoutMs: SUPERVISOR_IDLE_TIMEOUT_MS,
          hardTimeoutMs: SUPERVISOR_HARD_TIMEOUT_MS,
          admission: this.providerAdmission("supervisor", admissionSignal)
        })
        : extractJsonObject<unknown>(await withTimeout(
          promptAndCollect(activeSupervisorSession, supervisorInput, {
            admission: this.providerAdmission("supervisor", admissionSignal)
          }),
          SUPERVISOR_HARD_TIMEOUT_MS,
          () => void supervisorSession?.abort()
        ));
      const normalizedControlSignal = normalizeSupervisorControlSignal(rawControlSignal, snapshotSourceEventIds);
      const allowedEvidenceRefs = new Set(snapshotSourceEventIds);
      const selectedEvidenceRefs = normalizedControlSignal.evidenceRefs.filter((ref) => allowedEvidenceRefs.has(ref));
      const controlSignal: SupervisorVerdict = {
        ...normalizedControlSignal,
        evidenceRefs: selectedEvidenceRefs.length > 0 ? selectedEvidenceRefs : snapshotSourceEventIds,
        epochRef: input.epochRef ?? state?.epochId ?? "unknown",
        throughSeq: snapshotThroughSeq
      };
      const postPromptDiscardReason = this.supervisorCheckDiscardReason(input, state);
      if (postPromptDiscardReason) {
        supervisorInvocationStatus = "discarded";
        return this.discardSupervisorCheck(input, postPromptDiscardReason, snapshotSourceEventIds);
      }
      supervisorInvocationStatus = "completed";
      await this.executionLog.append({
        taskId: input.taskEnvelope.taskId,
        role: "observer",
        eventType: "supervisor_check_succeeded",
        summary: `${input.reason}: signal=${controlSignal.decision}`,
        payload: {
          queueId: input.queueId,
          reason: input.reason,
          controlSignal,
          sourceEventIds: snapshotSourceEventIds,
          outputPreview: supervisorOutput.slice(0, 1000)
        }
      });
      return controlSignal;
    } catch (error) {
      if (admissionSignal.aborted) {
        supervisorInvocationStatus = "discarded";
        return this.discardSupervisorCheck(
          input,
          String(admissionSignal.reason ?? "superseded supervisor window"),
          snapshotSourceEventIds
        );
      }
      supervisorInvocationStatus = "failed";
      const controlSignal: SupervisorVerdict = {
        decision: "continue",
        reason: `Supervisor check failed; continuing hot path: ${error instanceof Error ? error.message : String(error)}`,
        evidenceRefs: snapshotSourceEventIds,
        epochRef: input.epochRef ?? state?.epochId ?? "unknown",
        throughSeq: snapshotThroughSeq
      };
      await this.executionLog.append({
        taskId: input.taskEnvelope.taskId,
        role: "observer",
        eventType: "supervisor_check_failed",
        summary: controlSignal.reason,
        payload: {
          queueId: input.queueId,
          reason: input.reason,
          error: error instanceof Error ? error.message : String(error),
          outputPreview: supervisorOutput.slice(0, 1000),
          controlSignal
        }
      });
      return controlSignal;
    } finally {
      if (abortSession) {
        admissionSignal.removeEventListener("abort", abortSession);
      }
      await supervisorLogging?.drain();
      supervisorLogging?.();
      if (supervisorSession) {
        await this.appendInvocationMetrics({
          session: supervisorSession,
          before: supervisorStatsBefore,
          invocationId: input.queueId ?? `supervisor:${randomUUID()}`,
          invocationKind: "supervisor",
          agentRole: "observer",
          status: supervisorInvocationStatus,
          startedAt: supervisorInvocationStartedAt,
          taskId: input.taskEnvelope.taskId,
          inputBytes: supervisorInputBytes,
          details: { reason: input.reason, sourceEventIds: snapshotSourceEventIds, throughSeq: snapshotThroughSeq }
        });
      }
      if (supervisorSession) {
        this.activeSupervisorSessions.delete(supervisorSession);
      }
      if (supervisorSession) {
        disposeSession(supervisorSession);
      }
    }
  }

  private supervisorCheckDiscardReason(input: SupervisorCheckRequest, state?: ActiveTaskState): string | undefined {
    if (!state) {
      return "task is no longer active";
    }
    if (state.lifecycleState !== "running") {
      return `epoch ${state.epochId} is ${state.lifecycleState}`;
    }
    if (state.executorStopRequested) {
      return "executor already requested stop";
    }
    if (input.epochRef && input.epochRef !== state.epochId) {
      return `stale supervisor epoch: requested ${input.epochRef}, current ${state.epochId}`;
    }
    const latestThroughSeq = this.latestSupervisorThroughSeqByEpoch.get(state.epochId);
    if (
      input.throughSeq !== undefined
      && latestThroughSeq !== undefined
      && input.throughSeq < latestThroughSeq
    ) {
      return `superseded supervisor window: requested throughSeq ${input.throughSeq}, latest ${latestThroughSeq}`;
    }
    const requestedTurnCount = turnWindowCount(input.reason);
    if (
      requestedTurnCount !== undefined
      && state.epochTurnCount - requestedTurnCount >= SUPERVISOR_TURN_WINDOW_SIZE
    ) {
      return `stale supervisor window: requested ${requestedTurnCount}, current ${state.epochTurnCount}`;
    }
    return undefined;
  }

  private async discardSupervisorCheck(
    input: SupervisorCheckRequest,
    discardReason: string,
    evidenceRefs: string[]
  ): Promise<SupervisorVerdict> {
    const controlSignal: SupervisorVerdict = {
      decision: "continue",
      reason: `Supervisor check discarded: ${discardReason}`,
      evidenceRefs,
      epochRef: input.epochRef ?? "unknown",
      throughSeq: input.throughSeq ?? 0
    };
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "supervisor_check_discarded",
      summary: `${input.reason}: ${discardReason}`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        discardReason,
        sourceEventIds: evidenceRefs
      }
    });
    return controlSignal;
  }

  private async enqueueProjectionJob(input: ObserverProjectionRequest): Promise<ObserverProjection> {
    const scheduled = await this.scheduleProjection(input, true);
    if (scheduled.discarded) {
      return scheduled.projection;
    }
    try {
      await scheduled.completion;
    } catch (error) {
      return this.discardProjectionJob(
        input,
        error instanceof Error ? error.message : String(error)
      );
    }
    return this.lastProjectionByTask.get(input.taskEnvelope.taskId) ?? scheduled.projection;
  }

  private async requestProjection(input: ObserverProjectionRequest): Promise<ObserverProjection> {
    const scheduled = await this.scheduleProjection(input, false);
    return scheduled.projection;
  }

  private async scheduleProjection(
    input: ObserverProjectionRequest,
    forceImmediate: boolean
  ): Promise<{
    targetSeq: number;
    projection: ObserverProjection;
    discarded: boolean;
    completion?: Promise<void>;
  }> {
    const fallbackProjection = projectionPlaceholder(input, `${input.reason} scheduled`);
    if (this.projectionRequestsClosed) {
      return {
        targetSeq: this.runtimeStore.getProjectionState(input.taskEnvelope.taskId).committedSeq,
        projection: await this.discardProjectionJob(input, "controller is closing; projection coordinator is closed"),
        discarded: true
      };
    }
    const currentProjectionState = this.runtimeStore.getProjectionState(input.taskEnvelope.taskId);
    const latestSeq = Math.max(
      currentProjectionState.desiredSeq,
      ...((input.sourceEventIds ?? []).map((eventId) => this.executionLog.seqForEvent(eventId) ?? 0))
    );
    const terminal = forceImmediate || input.terminal === true || input.reason === "task_end";
    const queueItem: ProjectionRequestContext = {
      ...input,
      queueId: `projection:${randomUUID()}`,
      queuedAt: Date.now(),
      desiredSeq: latestSeq,
      terminal
    };
    const previousContext = this.projectionContextByTask.get(input.taskEnvelope.taskId);
    this.rememberProjectionContext(queueItem);
    const coordinatorRequest = this.projectorCoordinator.request({
      taskId: input.taskEnvelope.taskId,
      desiredSeq: latestSeq,
      priority: terminal ? 10 : 0,
      terminal
    });
    const completion = forceImmediate
      ? this.projectorCoordinator.waitForCommitted(
        input.taskEnvelope.taskId,
        latestSeq,
        { timeoutMs: PROJECTION_DRAIN_TIMEOUT_MS }
      )
      : undefined;
    void completion?.catch(() => undefined);
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "projection_requested",
      summary: `${input.reason} requested`,
      payload: {
        queueId: queueItem.queueId,
        reason: input.reason,
        sourceEventIds: input.sourceEventIds ?? [],
        desiredSeq: latestSeq,
        terminal,
        activeProjectionJobCount: this.activeProjectionJobCount
      }
    });
    if (previousContext) {
      await this.executionLog.append({
        taskId: input.taskEnvelope.taskId,
        role: "runtime",
        eventType: "projection_request_coalesced",
        summary: `${previousContext.reason} -> ${queueItem.reason}`,
        payload: {
          previousQueueId: previousContext.queueId,
          queueId: queueItem.queueId,
          previousReason: previousContext.reason,
          reason: queueItem.reason,
          previousDesiredSeq: previousContext.desiredSeq,
          desiredSeq: latestSeq,
          activeProjectionJobCount: this.activeProjectionJobCount
        }
      });
    }
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "projection_job_queued",
      summary: `${input.reason} queued`,
      payload: {
        queueId: queueItem.queueId,
        reason: input.reason,
        sourceEventIds: input.sourceEventIds ?? [],
        desiredSeq: latestSeq,
        terminal,
        activeProjectionJobCount: this.activeProjectionJobCount
      }
    });
    await coordinatorRequest;
    return { targetSeq: latestSeq, projection: fallbackProjection, discarded: false, completion };
  }

  private rememberProjectionContext(input: ProjectionRequestContext): void {
    const existing = this.projectionContextByTask.get(input.taskEnvelope.taskId);
    if (
      !existing
      || input.desiredSeq > existing.desiredSeq
      || projectionRequestPriority(input) >= projectionRequestPriority(existing)
    ) {
      this.projectionContextByTask.set(input.taskEnvelope.taskId, {
        ...input,
        taskResult: input.taskResult ?? existing?.taskResult,
        terminal: input.terminal || existing?.terminal
      });
    }
  }

  private async countProjectionObservations(input: {
    taskId: string;
    afterSeq: number;
    toSeq: number;
  }): Promise<number> {
    const events = await this.executionLog.range({
      taskId: input.taskId,
      afterSeq: input.afterSeq,
      toSeq: input.toSeq,
      roles: [...PROJECTOR_OBSERVATION_ROLES],
      eventTypes: [...PROJECTOR_OBSERVATION_EVENT_TYPES]
    });
    return selectProjectionBatch(events, {
      fromSeq: input.afterSeq,
      maxObservations: Number.MAX_SAFE_INTEGER
    }).observations.length;
  }

  private async runCoordinatedProjection(
    work: ProjectorWorkItem,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }
    const remembered = this.projectionContextByTask.get(work.taskId);
    const taskEnvelope = remembered?.taskEnvelope ?? this.graphStore.getTaskEnvelope(work.taskId);
    if (!taskEnvelope) {
      throw new Error(`Projection ${work.taskId} has no persisted task envelope`);
    }
    const taskResult = remembered?.taskResult ?? taskResultFromOutcome(this.runtimeStore.getTaskOutcome(work.taskId));
    const request: ObserverProjectionRequest = {
      reason: remembered?.reason ?? `projection_${work.reason}`,
      taskEnvelope,
      taskResult,
      sourceEventIds: remembered?.sourceEventIds,
      queueId: remembered?.queueId ?? `projection:${randomUUID()}`,
      queuedAt: remembered?.queuedAt ?? Date.now(),
      terminal: work.reason === "terminal",
      maxObservations: work.maxObservations,
      admissionSignal: signal
    };
    const abortListener = (): void => {
      const state = this.runtimeStore.getProjectionState(work.taskId);
      if (state.activeGeneration !== undefined) {
        this.runtimeStore.invalidateProjection(work.taskId);
      }
      void this.activeProjectorByTask.get(work.taskId)?.abort();
    };
    signal.addEventListener("abort", abortListener, { once: true });
    const committedBefore = this.runtimeStore.getProjectionState(work.taskId).committedSeq;
    try {
      const projection = await this.runProjectionJob(request);
      this.lastProjectionByTask.set(work.taskId, projection);
      const state = this.getActiveTaskState(work.taskId);
      if (state) {
        state.lastObserverProjection = projection;
      }
      if (signal.aborted) {
        return;
      }
      const projectedState = this.runtimeStore.getProjectionState(work.taskId);
      if (
        projectedState.desiredSeq > projectedState.committedSeq
        && projectedState.committedSeq <= committedBefore
      ) {
        throw new Error(`Projection ${work.taskId} made no watermark progress`);
      }
      const projectionState = this.runtimeStore.getProjectionState(work.taskId);
      const currentContext = this.projectionContextByTask.get(work.taskId);
      if (currentContext && projectionState.committedSeq >= projectionState.desiredSeq) {
        this.projectionContextByTask.delete(work.taskId);
      }
      return;
    } finally {
      signal.removeEventListener("abort", abortListener);
    }
  }

  private async logProjectionCoordinatorError(error: unknown, work: ProjectorWorkItem): Promise<void> {
    await this.executionLog.append({
      taskId: work.taskId,
      role: "runtime",
      eventType: work.retryScheduled === false ? "projection_retry_exhausted" : "projection_retry_scheduled",
      summary: error instanceof Error ? error.message : String(error),
      payload: {
        reason: work.reason,
        fromSeq: work.fromSeq,
        targetSeq: work.targetSeq,
        terminalTargetSeq: work.terminalTargetSeq,
        pendingObservationCount: work.pendingObservationCount,
        maxObservations: work.maxObservations,
        retryAttempt: work.retryAttempt,
        retryScheduled: work.retryScheduled !== false
      }
    });
  }

  private enqueueObserverProjection(input: ObserverProjectionRequest): Promise<ObserverProjection> {
    return this.enqueueProjectionJob(input);
  }

  private async prepareProjectorInput(input: {
    input: ObserverProjectionRequest;
    claim: ProjectionClaim;
    batch: ProjectionBatch;
    artifactTextLimit?: number;
    graphTextLimit?: number;
    goalTextLimit?: number;
  }) {
    const closure = this.graphStore.projectionClosure({
      taskId: input.input.taskEnvelope.taskId,
      scopeRef: input.input.taskEnvelope.scopeRef,
      dependencyTaskIds: input.input.taskEnvelope.dependsOnTaskRefs,
      targetRefs: dedupeStrings([
        ...input.input.taskEnvelope.targetRefs,
        ...(input.input.taskEnvelope.basisRefs ?? [])
      ]),
      anchors: input.batch.observations.flatMap((observation) => observation.anchors),
      nodeLimit: 64,
      edgeLimit: 96
    });
    const fullGraphContext = aliasProjectionGraphContext(filterProjectorSemanticGraph(closure));
    const artifactIndex = await this.loadProjectorArtifactIndex({
      taskEnvelope: input.input.taskEnvelope,
      taskResult: input.input.taskResult,
      observations: input.batch.observations
    });
    const artifactText = input.artifactTextLimit !== undefined
      ? compactUtf8HeadTail(artifactIndex.text, input.artifactTextLimit)
      : compactUtf8HeadTail(artifactIndex.text, 3_000);
    const observationText = renderProjectionObservations(input.batch.observations);
    const connectivityContext = compactProjectorConnectivityContext(
      this.connectivityRuntime?.routeProjectionSnapshot() ?? [],
      input.batch.observations,
      4_000
    );
    const projectionJob = [
      `task=${compactUtf8HeadTail(input.input.taskEnvelope.taskId, 240)}`,
      `reason=${input.input.reason}`,
      `seq=(${input.claim.fromSeq},${input.batch.toSeq}] desired=${input.claim.toSeq}`,
      input.input.taskResult ? renderProjectorTaskResult(input.input.taskResult) : undefined,
      `goal=${compactUtf8HeadTail(input.input.taskEnvelope.goal, input.goalTextLimit ?? 800)}`
    ].filter((line): line is string => Boolean(line)).join("\n");
    const fixedInput = renderObserverInput({
      projectionJob,
      observations: observationText,
      artifactIndex: artifactText,
      graphContext: "",
      connectivityContext
    });
    const availableGraphBytes = Math.max(
      256,
      PROJECTOR_INPUT_TARGET_BYTES - Buffer.byteLength(fixedInput, "utf8") - 512
    );
    const graphContext = compactProjectionGraphContextForInput(
      fullGraphContext,
      Math.min(input.graphTextLimit ?? availableGraphBytes, availableGraphBytes)
    );
    const graphText = renderProjectionGraphContext(graphContext);
    const projectorInput = renderObserverInput({
      projectionJob,
      observations: observationText,
      artifactIndex: artifactText,
      graphContext: graphText,
      connectivityContext
    });
    return {
      batch: input.batch,
      graphContext,
      artifactCount: artifactIndex.itemCount,
      projectorInput,
      inputBytes: Buffer.byteLength(projectorInput, "utf8")
    };
  }

  private async runProjectionJob(input: ObserverProjectionRequest): Promise<ObserverProjection> {
    const discardReason = this.observerProjectionDiscardReason(input);
    if (discardReason) {
      return this.discardProjectionJob(input, discardReason);
    }
    const claim = this.runtimeStore.claimProjection(input.taskEnvelope.taskId);
    if (!claim) {
      return this.discardProjectionJob(input, "no uncommitted projection range is available");
    }
    let expectedSourceEventIds = input.sourceEventIds ?? [];
    this.activeProjectionJobCount += 1;
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "projection_job_started",
      summary: `${input.reason} started`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        queuedForMs: input.queuedAt ? Date.now() - input.queuedAt : undefined,
        sourceEventIds: expectedSourceEventIds,
        fromSeq: claim.fromSeq,
        toSeq: claim.toSeq,
        generation: claim.generation,
        attemptRef: projectionAttemptRef(input.queueId, claim.generation),
        activeProjectionJobCount: this.activeProjectionJobCount
      }
    });
    const projectionHeartbeat = this.startRuntimeHeartbeat({
      taskId: input.taskEnvelope.taskId,
      eventType: "projection_job_heartbeat",
      summary: `${input.reason} still running`,
      payload: {
        queueId: input.queueId,
        reason: input.reason,
        sourceEventIds: expectedSourceEventIds
      }
    });
    let observerOutput = "";
    let projectorSession: SecurityAgentSession | undefined;
    let projectorLogging: ReturnType<typeof attachExecutionLogging> | undefined;
    let projectorStatsBefore: PiSessionStatsSnapshot | undefined;
    let projectorInputBytes = 0;
    let projectorObservationCount = 0;
    let projectorProjectionToSeq = claim.toSeq;
    let projectorInvocationStatus = "failed";
    const projectorInvocationStartedAt = Date.now();
    let projectionCommitted = false;
    try {
      const cancellationReason = this.projectionWriteBlockedReason();
      if (cancellationReason) {
        return this.discardProjectionJob(input, cancellationReason, claim);
      }
      const availableLogEvents = await this.executionLog.range({
        taskId: input.taskEnvelope.taskId,
        afterSeq: claim.fromSeq,
        toSeq: claim.toSeq,
        roles: [...PROJECTOR_OBSERVATION_ROLES],
        eventTypes: [...PROJECTOR_OBSERVATION_EVENT_TYPES]
      });
      const availableObservationCount = selectProjectionBatch(availableLogEvents, {
        fromSeq: claim.fromSeq,
        maxObservations: Number.MAX_SAFE_INTEGER
      }).observations.length;
      if (availableObservationCount === 0 && availableLogEvents.length > 0) {
        const projection: ObserverProjection = {
          graphDelta: { sourceEventIds: [], nodes: [], edges: [] },
          controlSignal: CONTINUE_CONTROL_SIGNAL
        };
        this.graphStore.commitProjection({
          taskId: input.taskEnvelope.taskId,
          fromSeq: claim.fromSeq,
          toSeq: claim.toSeq,
          generation: claim.generation,
          delta: projection.graphDelta
        });
        projectorProjectionToSeq = claim.toSeq;
        projectionCommitted = true;
        projectorInvocationStatus = "completed_without_llm";
        await this.appendProjectionJobLog({
          taskId: input.taskEnvelope.taskId,
          eventType: "projection_job_succeeded",
          reason: input.reason,
          projection,
          outputPreview: "",
          queueId: input.queueId,
          generation: claim.generation,
          fromSeq: claim.fromSeq,
          toSeq: claim.toSeq,
          desiredSeq: claim.toSeq,
          durationMs: Date.now() - projectorInvocationStartedAt,
          inputBytes: 0,
          observationCount: 0,
          remappedNodeCount: 0,
          mergedNodeCount: 0
        });
        return projection;
      }
      const maxObservations = input.maxObservations ?? PROJECTOR_MAX_OBSERVATIONS_PER_JOB;
      const selectedBatch = attachTaskResultProjectionReferences(selectProjectionBatch(availableLogEvents, {
        fromSeq: claim.fromSeq,
        maxObservations
      }), input.taskResult);
      const initialBatch = selectedBatch.observations.length >= availableObservationCount
        ? { ...selectedBatch, toSeq: claim.toSeq }
        : selectedBatch;
      let prepared = await this.prepareProjectorInput({
        input,
        claim,
        batch: initialBatch
      });
      let requiresObservationPartition = false;
      if (prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES) {
        try {
          const compactedBatch = compactProjectionBatchForInput(initialBatch, {
            maxObservations: Math.min(maxObservations, 24),
            maxBytes: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.55)
          });
          prepared = await this.prepareProjectorInput({
            input,
            claim,
            batch: compactedBatch,
            artifactTextLimit: 1_200,
            graphTextLimit: 7_000
          });
        } catch (error) {
          if (!(error instanceof ProjectionObservationEnvelopeTooLargeError)) {
            throw error;
          }
          requiresObservationPartition = true;
        }
      }
      if (!requiresObservationPartition && prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES) {
        try {
          const compactedBatch = compactProjectionBatchForInput(initialBatch, {
            maxObservations: Math.min(maxObservations, 16),
            maxBytes: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.4)
          });
          prepared = await this.prepareProjectorInput({
            input,
            claim,
            batch: compactedBatch,
            artifactTextLimit: 500,
            graphTextLimit: 4_000,
            goalTextLimit: 240
          });
        } catch (error) {
          if (!(error instanceof ProjectionObservationEnvelopeTooLargeError)) {
            throw error;
          }
          requiresObservationPartition = true;
        }
      }
      if (!requiresObservationPartition && prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES) {
        try {
          let compactedBatch = compactProjectionBatchForInput(initialBatch, {
            maxObservations: Math.min(maxObservations, 12),
            maxBytes: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.3)
          });
          do {
            prepared = await this.prepareProjectorInput({
              input,
              claim,
              batch: compactedBatch,
              artifactTextLimit: 0,
              graphTextLimit: 2_000,
              goalTextLimit: 120
            });
            if (prepared.inputBytes <= PROJECTOR_INPUT_TARGET_BYTES || compactedBatch.observations.length <= 1) {
              break;
            }
            compactedBatch = compactProjectionBatchForInput(initialBatch, {
              maxObservations: compactedBatch.observations.length - 1,
              maxBytes: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.3)
            });
          } while (true);
        } catch (error) {
          if (!(error instanceof ProjectionObservationEnvelopeTooLargeError)) {
            throw error;
          }
          requiresObservationPartition = true;
        }
      }
      let preparedInputs = [prepared];
      if (requiresObservationPartition || prepared.inputBytes > PROJECTOR_INPUT_TARGET_BYTES) {
        const firstObservation = initialBatch.observations[0];
        if (!firstObservation) {
          throw new Error("Projector input exceeds its byte limit without an observation to partition");
        }
        const singleObservationBatch: ProjectionBatch = {
          observations: [firstObservation],
          toSeq: initialBatch.observations.length === 1 ? initialBatch.toSeq : firstObservation.seqEnd,
          sourceEventIds: initialBatch.observations.length === 1
            ? [...initialBatch.sourceEventIds]
            : [...firstObservation.sourceEventIds]
        };
        const fragmentBatches = partitionProjectionBatchForInput(singleObservationBatch, {
          maxObservations: Math.min(maxObservations, 12),
          maxBytes: Math.floor(PROJECTOR_INPUT_TARGET_BYTES * 0.3)
        });
        preparedInputs = [];
        for (const fragmentBatch of fragmentBatches) {
          const fragmentInput = await this.prepareProjectorInput({
            input,
            claim,
            batch: fragmentBatch,
            artifactTextLimit: 0,
            graphTextLimit: 2_000,
            goalTextLimit: 120
          });
          if (fragmentInput.inputBytes > PROJECTOR_INPUT_TARGET_BYTES) {
            throw new Error(
              `Projector fixed input envelope requires ${fragmentInput.inputBytes} UTF-8 bytes; maximum is ${PROJECTOR_INPUT_TARGET_BYTES}`
            );
          }
          preparedInputs.push(fragmentInput);
        }
      }
      if (preparedInputs.some((item) => item.inputBytes > PROJECTOR_INPUT_TARGET_BYTES)) {
        throw new Error(`Projector input exceeds ${PROJECTOR_INPUT_TARGET_BYTES} UTF-8 bytes before model invocation`);
      }
      const projectionToSeq = preparedInputs.at(-1)!.batch.toSeq;
      projectorProjectionToSeq = projectionToSeq;
      projectorInputBytes = Math.max(...preparedInputs.map((item) => item.inputBytes));
      projectorObservationCount = preparedInputs.reduce((total, item) => total + item.batch.observations.length, 0);
      expectedSourceEventIds = dedupeStrings(preparedInputs.flatMap((item) => item.batch.sourceEventIds));
      for (const [fragmentIndex, preparedInput] of preparedInputs.entries()) {
        await this.executionLog.append({
          taskId: input.taskEnvelope.taskId,
          role: "runtime",
          eventType: "projection_input_built",
          summary: `observations=${preparedInput.batch.observations.length} bytes=${preparedInput.inputBytes}`,
          payload: {
            queueId: input.queueId,
            reason: input.reason,
            generation: claim.generation,
            fromSeq: claim.fromSeq,
            toSeq: projectionToSeq,
            desiredSeq: claim.toSeq,
            fragmentIndex: fragmentIndex + 1,
            fragmentCount: preparedInputs.length,
            observationCount: preparedInput.batch.observations.length,
            graphNodeCount: preparedInput.graphContext.nodes.length,
            graphEdgeCount: preparedInput.graphContext.edges.length,
            artifactCount: preparedInput.artifactCount,
            inputBytes: preparedInput.inputBytes,
            targetBytes: PROJECTOR_INPUT_TARGET_BYTES,
            overTarget: false
          }
        });
      }
      prepared = preparedInputs[0]!;
      if (prepared.batch.observations.length === 0) {
        const projection: ObserverProjection = {
          graphDelta: { sourceEventIds: [], nodes: [], edges: [] },
          controlSignal: CONTINUE_CONTROL_SIGNAL
        };
        const commitResult = this.graphStore.commitProjection({
          taskId: input.taskEnvelope.taskId,
          fromSeq: claim.fromSeq,
          toSeq: projectionToSeq,
          generation: claim.generation,
          delta: projection.graphDelta
        });
        projection.graphDelta = commitResult.delta;
        projectionCommitted = true;
        projectorInvocationStatus = "completed_without_llm";
        await this.appendProjectionJobLog({
          taskId: input.taskEnvelope.taskId,
          eventType: "projection_job_succeeded",
          reason: input.reason,
          projection,
          outputPreview: "",
          queueId: input.queueId,
          generation: claim.generation,
          fromSeq: claim.fromSeq,
          toSeq: projectionToSeq,
          desiredSeq: claim.toSeq,
          durationMs: Date.now() - projectorInvocationStartedAt,
          inputBytes: prepared.inputBytes,
          observationCount: prepared.batch.observations.length,
          remappedNodeCount: commitResult.remappedNodeCount,
          mergedNodeCount: commitResult.mergedNodeCount
        });
        return projection;
      }
      const prePromptCancellationReason = this.projectionWriteBlockedReason();
      if (prePromptCancellationReason) {
        return this.discardProjectionJob(input, prePromptCancellationReason, claim);
      }
      const fragmentDeltas: GraphDelta[] = [];
      for (const [fragmentIndex, preparedInput] of preparedInputs.entries()) {
        const projectorGraphRefs = new ProjectorGraphRefRegistry(preparedInput.graphContext);
        const observerSession = await this.createObserverSessionForMode(
          "project",
          input.taskEnvelope.taskId,
          projectorGraphRefs,
          {
            availableEvidenceRefs: new Set([
              ...preparedInput.batch.observations.map((observation) => observation.ref),
              ...preparedInput.batch.sourceEventIds
            ]),
          }
        );
        const activeProjectorSession = observerSession.session;
        const fragmentStartedAt = Date.now();
        const fragmentStatsBefore = readPiSessionStats(activeProjectorSession);
        let fragmentStatus = "failed";
        projectorSession = activeProjectorSession;
        projectorStatsBefore = fragmentStatsBefore;
        projectorLogging = observerSession.logging;
        this.activeProjectorSessions.add(activeProjectorSession);
        this.activeProjectorByTask.set(input.taskEnvelope.taskId, activeProjectorSession);
        try {
          const rawGraphDelta = this.structuredInvocationsEnabled
            ? await invokeStructured<unknown>(activeProjectorSession, preparedInput.projectorInput, {
              toolName: "graph_delta_submit",
              maxRepeatedToolErrors: 2,
              idleTimeoutMs: PROJECTOR_IDLE_TIMEOUT_MS,
              hardTimeoutMs: PROJECTOR_HARD_TIMEOUT_MS,
              admission: this.providerAdmission("projector", input.admissionSignal)
            })
            : extractJsonObject<unknown>(await withTimeout(
              promptAndCollect(activeProjectorSession, preparedInput.projectorInput, {
                admission: this.providerAdmission("projector", input.admissionSignal)
              }),
              PROJECTOR_HARD_TIMEOUT_MS,
              () => void activeProjectorSession.abort()
            ));
          const postPromptCancellationReason = this.projectionWriteBlockedReason();
          if (postPromptCancellationReason) {
            return this.discardProjectionJob(input, postPromptCancellationReason, claim);
          }
          fragmentDeltas.push(expandProjectionDraft({
            value: rawGraphDelta,
            batch: preparedInput.batch,
            graphContext: preparedInput.graphContext,
            references: projectorGraphRefs
          }));
          fragmentStatus = "completed";
        } finally {
          await observerSession.logging?.drain();
          observerSession.logging?.();
          await this.appendInvocationMetrics({
            session: activeProjectorSession,
            before: fragmentStatsBefore,
            invocationId: `${input.queueId ?? `projection:${claim.generation}`}:fragment:${fragmentIndex + 1}`,
            invocationKind: "projector",
            agentRole: "observer",
            status: fragmentStatus,
            startedAt: fragmentStartedAt,
            taskId: input.taskEnvelope.taskId,
            inputBytes: preparedInput.inputBytes,
            details: {
              reason: input.reason,
              generation: claim.generation,
              fromSeq: claim.fromSeq,
              toSeq: projectionToSeq,
              desiredSeq: claim.toSeq,
              fragmentIndex: fragmentIndex + 1,
              fragmentCount: preparedInputs.length,
              observationCount: preparedInput.batch.observations.length,
              projectionCommitPending: true
            }
          });
          this.activeProjectorSessions.delete(activeProjectorSession);
          if (this.activeProjectorByTask.get(input.taskEnvelope.taskId) === activeProjectorSession) {
            this.activeProjectorByTask.delete(input.taskEnvelope.taskId);
          }
          disposeSession(activeProjectorSession);
          if (projectorSession === activeProjectorSession) {
            projectorSession = undefined;
            projectorLogging = undefined;
            projectorStatsBefore = undefined;
          }
        }
      }
      const graphDelta = mergeProjectionFragmentDeltas(fragmentDeltas);
      const projection: ObserverProjection = {
        graphDelta,
        controlSignal: CONTINUE_CONTROL_SIGNAL
      };
      const commitResult = this.graphStore.commitProjection({
        taskId: input.taskEnvelope.taskId,
        fromSeq: claim.fromSeq,
        toSeq: projectionToSeq,
        generation: claim.generation,
        delta: projection.graphDelta
      });
      projection.graphDelta = commitResult.delta;
      projectionCommitted = true;
      projectorInvocationStatus = "completed";
      await this.notifyProjectorGraphCommitted(
        input.taskEnvelope.taskId,
        commitResult.delta,
        projectionToSeq,
        commitResult.nodeStatusChanges
      );
      await this.appendProjectionJobLog({
        taskId: input.taskEnvelope.taskId,
        eventType: "projection_job_succeeded",
        reason: input.reason,
        projection,
        outputPreview: observerOutput.slice(0, 1000),
        queueId: input.queueId,
        generation: claim.generation,
        fromSeq: claim.fromSeq,
        toSeq: projectionToSeq,
        desiredSeq: claim.toSeq,
        durationMs: Date.now() - projectorInvocationStartedAt,
        inputBytes: projectorInputBytes,
        observationCount: projectorObservationCount,
        remappedNodeCount: commitResult.remappedNodeCount,
        mergedNodeCount: commitResult.mergedNodeCount
      });
      return projection;
    } catch (promptError) {
      projectorInvocationStatus = "failed";
      this.runtimeStore.releaseProjection(input.taskEnvelope.taskId, claim.generation);
      const projectionState = this.runtimeStore.getProjectionState(input.taskEnvelope.taskId);
      if (projectionState.generation > claim.generation) {
        return this.discardProjectionJob(input, `projection generation ${claim.generation} was superseded`, claim);
      }
      const cancellationReason = this.projectionWriteBlockedReason();
      if (cancellationReason) {
        return this.discardProjectionJob(input, cancellationReason, claim);
      }
      return this.failProjectionJob(
        input,
        expectedSourceEventIds,
        promptError,
        "project_failed",
        observerOutput,
        {
          generation: claim.generation,
          fromSeq: claim.fromSeq,
          toSeq: projectorProjectionToSeq,
          desiredSeq: claim.toSeq,
          durationMs: Date.now() - projectorInvocationStartedAt,
          inputBytes: projectorInputBytes,
          observationCount: projectorObservationCount
        }
      );
    } finally {
      clearInterval(projectionHeartbeat);
      await projectorLogging?.drain();
      projectorLogging?.();
      if (projectorSession) {
        await this.appendInvocationMetrics({
          session: projectorSession,
          before: projectorStatsBefore,
          invocationId: input.queueId ?? `projection:${randomUUID()}`,
          invocationKind: "projector",
          agentRole: "observer",
          status: projectorInvocationStatus,
          startedAt: projectorInvocationStartedAt,
          taskId: input.taskEnvelope.taskId,
          inputBytes: projectorInputBytes,
          details: {
            reason: input.reason,
            generation: claim.generation,
            fromSeq: claim.fromSeq,
            toSeq: projectorProjectionToSeq,
            desiredSeq: claim.toSeq,
            observationCount: projectorObservationCount,
            projectionCommitted
          }
        });
      }
      if (!projectionCommitted) {
        this.runtimeStore.releaseProjection(input.taskEnvelope.taskId, claim.generation);
      }
      this.activeProjectionJobCount = Math.max(0, this.activeProjectionJobCount - 1);
      if (projectorSession) {
        this.activeProjectorSessions.delete(projectorSession);
        if (this.activeProjectorByTask.get(input.taskEnvelope.taskId) === projectorSession) {
          this.activeProjectorByTask.delete(input.taskEnvelope.taskId);
        }
      }
      if (projectorSession) {
        disposeSession(projectorSession);
      }
    }
  }

  private observerProjectionDiscardReason(input: ObserverProjectionRequest): string | undefined {
    const writeBlockedReason = this.projectionWriteBlockedReason();
    if (writeBlockedReason) {
      return writeBlockedReason;
    }
    return undefined;
  }

  private projectionWriteBlockedReason(): string | undefined {
    if (this.graphStoreClosed) {
      return "graph store is already closed";
    }
    if (this.projectionCancellationRequested) {
      return "controller shutdown cancelled projection before graph write";
    }
    return undefined;
  }

  private async discardProjectionJob(
    input: ObserverProjectionRequest,
    discardReason: string,
    claim?: ProjectionClaim
  ): Promise<ObserverProjection> {
    const sourceEventIds = input.sourceEventIds ?? [];
    await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: claim ? "projection_job_discarded" : "projection_request_discarded",
      summary: `${input.reason}: ${discardReason}`,
      payload: {
        queueId: input.queueId,
        generation: claim?.generation,
        attemptRef: claim ? projectionAttemptRef(input.queueId, claim.generation) : undefined,
        reason: input.reason,
        discardReason,
        sourceEventIds
      }
    });
    const projection: ObserverProjection = {
      graphDelta: { sourceEventIds, nodes: [], edges: [] },
      controlSignal: {
        decision: "continue",
        reason: `Projection job discarded: ${discardReason}`,
        evidenceRefs: sourceEventIds
      }
    };
    return projection;
  }

  private async failProjectionJob(
    input: ObserverProjectionRequest,
    expectedSourceEventIds: string[],
    error: unknown,
    phase: string,
    observerOutput: string,
    metrics: {
      generation: number;
      fromSeq: number;
      toSeq: number;
      desiredSeq: number;
      durationMs: number;
      inputBytes: number;
      observationCount: number;
    }
  ): Promise<ObserverProjection> {
    const parseFailureEvent = await this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "observer",
      eventType: "projection_job_failed",
      summary: error instanceof Error ? error.message : "Projection job failed",
      payload: {
        queueId: input.queueId,
        attemptRef: projectionAttemptRef(input.queueId, metrics.generation),
        reason: input.reason,
        phase,
        error: error instanceof Error ? error.message : String(error),
        outputPreview: observerOutput.slice(0, 2000),
        ...metrics
      }
    });
    const cancellationReason = this.projectionWriteBlockedReason();
    if (cancellationReason) {
      return {
        graphDelta: { sourceEventIds: [...expectedSourceEventIds, parseFailureEvent.id], nodes: [], edges: [] },
        controlSignal: {
          decision: "continue",
          reason: `Projection job failed during ${phase}, but graph write was skipped: ${cancellationReason}`,
          evidenceRefs: [...expectedSourceEventIds, parseFailureEvent.id]
        }
      };
    }
    return {
      graphDelta: { sourceEventIds: expectedSourceEventIds, nodes: [], edges: [] },
      controlSignal: {
        decision: "continue",
        reason: `Projection job failed during ${phase}; committed watermark was not advanced`,
        evidenceRefs: [...expectedSourceEventIds, parseFailureEvent.id]
      }
    };
  }

  private async appendProjectionJobLog(input: {
    taskId: string;
    eventType: "projection_job_succeeded";
    reason: string;
    projection: ObserverProjection;
    outputPreview: string;
    error?: string;
    queueId?: string;
    generation?: number;
    fromSeq?: number;
    toSeq?: number;
    desiredSeq?: number;
    durationMs?: number;
    inputBytes?: number;
    observationCount?: number;
    remappedNodeCount?: number;
    mergedNodeCount?: number;
  }): Promise<void> {
    const nodeCounts = input.projection.graphDelta.nodes.reduce<Record<string, number>>((counts, node) => {
      const key = `${node.graphKind}:${node.type}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    await this.executionLog.append({
      taskId: input.taskId,
      role: "observer",
      eventType: input.eventType,
      summary: `${input.reason}: nodes=${input.projection.graphDelta.nodes.length} edges=${input.projection.graphDelta.edges.length}`,
      payload: {
        reason: input.reason,
        queueId: input.queueId,
        generation: input.generation,
        attemptRef: input.generation === undefined
          ? undefined
          : projectionAttemptRef(input.queueId, input.generation),
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        desiredSeq: input.desiredSeq,
        durationMs: input.durationMs,
        inputBytes: input.inputBytes,
        observationCount: input.observationCount,
        remappedNodeCount: input.remappedNodeCount,
        mergedNodeCount: input.mergedNodeCount,
        nodeCounts,
        edgeCount: input.projection.graphDelta.edges.length,
        sourceEventIds: input.projection.graphDelta.sourceEventIds,
        empty: input.projection.graphDelta.nodes.length === 0 && input.projection.graphDelta.edges.length === 0,
        error: input.error,
        outputPreview: input.outputPreview
      }
    });
  }

  private startRuntimeHeartbeat(input: {
    taskId?: string;
    eventType: string;
    summary: string;
    payload: Record<string, unknown>;
  }): NodeJS.Timeout {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      void this.executionLog.append({
        taskId: input.taskId,
        role: "runtime",
        eventType: input.eventType,
        summary: `${input.summary}; elapsedMs=${elapsedMs}`,
        payload: {
          ...input.payload,
          elapsedMs
        }
      });
    }, RUNTIME_HEARTBEAT_MS);
    timer.unref?.();
    return timer;
  }

  private requestBudgetCheckpoint(
    taskEnvelope: TaskEnvelope,
    event: ExecutionEvent,
    budgetKey: "maxTurns" | "epochTurns",
    state = this.getActiveTaskState(taskEnvelope.taskId)
  ): void {
    if (!state || state.executorStopRequested) {
      return;
    }
    const reason = budgetKey === "epochTurns"
      ? `Epoch turn slice reached: maxTurns=${DEFAULT_EPOCH_TURN_SLICE}`
      : `Task budget reached: maxTurns=${taskEnvelope.budget?.maxTurns ?? DEFAULT_TASK_BUDGET.maxTurns}`;
    const budgetSignal: ControlSignal = {
      decision: "handoff",
      reason,
      evidenceRefs: [event.id]
    };
    void this.requestEpochStop(taskEnvelope, budgetSignal, state, "executor_checkpoint_requested", "budget_abort");
  }

  private async collectBudgetCheckpointTaskResult(input: {
    taskEnvelope: TaskEnvelope;
    state: ActiveTaskState;
    executorSession: ExecutorSessionLease;
    logging?: { drain: () => Promise<void> };
  }): Promise<TaskResult | undefined> {
    if (
      input.state.abortContext?.kind !== "budget_abort"
      || this.stopRequestedReason
      || this.invocationAbortController.signal.aborted
    ) {
      return undefined;
    }
    const sandbox = (() => {
      try {
        return this.requireExecutorSandbox(input.taskEnvelope.taskId);
      } catch {
        return undefined;
      }
    })();
    const workspaceFiles = sandbox?.workspaceDir
      ? await listExecutorWorkspaceFiles(sandbox.workspaceDir)
      : [];
    const durableArtifactRefs = (await this.artifactStore.list({ taskId: input.taskEnvelope.taskId }))
      .map((artifact) => artifact.artifactRef);
    const prompt = [
      "RUNTIME_BUDGET_CHECKPOINT_FINALIZATION",
      input.state.abortContext.reason,
      "探索预算已经耗尽。不得调用 bash、read、搜索、图查询或继续探索。",
      durableArtifactRefs.length > 0
        ? `已持久化 Artifact（直接在 TaskOutcome 中引用，不要重复归档）：\n${durableArtifactRefs.map((ref) => `- ${JSON.stringify(ref)}`).join("\n")}`
        : "当前 Task 尚无已持久化 Artifact。",
      workspaceFiles.length > 0
        ? `workspace 中可选择提升的现有文件（artifact_write.path 只能从下列 JSON 字符串选择）：\n${workspaceFiles.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
        : "workspace 中没有可归档文件；直接调用 task_result_submit，不要调用或提及 artifact_write。",
      ...(workspaceFiles.length > 0 ? [
        "先形成本次 TaskOutcome 的 summary 和 evidenceRefs。若提交 partial 且同一 Task 仍可继续，workspace 已跨 epoch 持久，不得仅因 checkpoint 提升文件。",
        "只有 Task 将结束或真实跨 Task 交接，并且结果仍依赖无法由持久 evidenceRefs 重建、必须保持原文、精确字节或可执行状态的现有文件时，才用 artifact_write 提升缺失的最小材料。不要逐项归档普通响应；不得创建、修改、检查或搜索文件。"
      ] : []),
      "TaskOutcome 本身就是结构化结论，不要为结论临时虚构或创建总结文件；但若当前 Task successCriteria 明确要求报告交付物，必须引用已经存在并以 kind=report 持久化的报告 Artifact。已有材料归档完成后调用一次 task_result_submit，并根据任务成功条件如实选择 completed、partial、blocked 或 failed。",
      "summary 写明本次已经验证的能力、最新失效条件和仍未解决的问题；",
      "evidenceRefs 和 artifactRefs 只填写本会话中真实存在的引用；",
      "不要继续探索，也不要输出自由文本 JSON。"
    ].join("\n");
    const session = input.executorSession.session;
    const invocationId = `executor:${input.state.epochId}:checkpoint-finalization`;
    const remainingGlobalRunMs = this.activeRun
      ? Math.max(0, this.activeRun.deadlineAt - Date.now())
      : DEFAULT_RUN_TIME_BUDGET_MS;
    if (remainingGlobalRunMs === 0) {
      return undefined;
    }
    const globalDeadlineTimer = setTimeout(() => {
      void session.abort().catch(() => undefined);
    }, remainingGlobalRunMs);
    globalDeadlineTimer.unref?.();
    const startedAt = Date.now();
    const statsBefore = readPiSessionStats(session);
    const inputBytes = Buffer.byteLength(prompt);
    let invocationStatus = "failed";
    let originalToolNames: string[] | undefined;
    try {
      originalToolNames = session.getActiveToolNames();
      const finalizationToolNames = [
        ...(workspaceFiles.length > 0 ? ["artifact_write"] : []),
        "task_result_submit"
      ]
        .filter((toolName) => originalToolNames?.includes(toolName));
      session.setActiveToolsByName(finalizationToolNames);
      const activeFinalizationToolNames = session.getActiveToolNames();
      if (
        !activeFinalizationToolNames.includes("task_result_submit")
        || activeFinalizationToolNames.some((toolName) => toolName !== "artifact_write" && toolName !== "task_result_submit")
      ) {
        throw new Error("Executor checkpoint finalization must expose task_result_submit and may expose artifact_write only");
      }
      input.state.checkpointFinalizationActive = true;
      const taskResult = await invokeStructured(session, prompt, {
        toolName: "task_result_submit",
        maxTruncationSteers: 0,
        validate: (value) => {
          const normalized = normalizeTaskResult(value as Partial<TaskResult>, input.taskEnvelope);
          return normalized.status === "partial"
            ? {
                ...normalized,
                checkpointReason: input.state.abortContext?.reason,
                retryable: true
              }
            : normalized;
        },
        admission: this.providerAdmission("executor")
      });
      await input.logging?.drain();
      invocationStatus = "submitted";
      await this.executionLog.append({
        epochId: input.state.epochId,
        taskId: input.taskEnvelope.taskId,
        role: "runtime",
        eventType: "executor_checkpoint_submitted",
        summary: taskResult.summary,
        payload: {
          invocationId,
          controlSignal: input.state.controlSignal,
          taskResultStatus: taskResult.status
        }
      });
      return taskResult;
    } catch (error) {
      await this.executionLog.append({
        epochId: input.state.epochId,
        taskId: input.taskEnvelope.taskId,
        role: "runtime",
        eventType: "executor_checkpoint_finalization_failed",
        summary: errorMessageFromUnknown(error) ?? "Executor checkpoint finalization failed",
        payload: {
          error: errorMessageFromUnknown(error) ?? String(error)
        }
      });
      return undefined;
    } finally {
      clearTimeout(globalDeadlineTimer);
      input.state.checkpointFinalizationActive = false;
      if (originalToolNames) {
        session.setActiveToolsByName(originalToolNames);
      }
      await this.appendInvocationMetrics({
        session,
        before: statsBefore,
        invocationId,
        invocationKind: "executor",
        agentRole: "executor",
        status: invocationStatus,
        startedAt,
        taskId: input.taskEnvelope.taskId,
        epochId: input.state.epochId,
        inputBytes,
        details: {
          phase: "checkpoint_finalization",
          taskResultTurnExcludedFromBudget: true,
          semanticTimeout: "none",
          remainingGlobalRunMs
        }
      });
    }
  }

  private publishExecutorBudgetStatusUpdate(input: {
    taskEnvelope: TaskEnvelope;
    state: ActiveTaskState;
    sourceEventId?: string;
    reason: string;
    force?: boolean;
  }): void {
    if (input.state.executorStopRequested) {
      return;
    }
    const status = budgetStatusSnapshot(input.taskEnvelope, input.state);
    const steerKey = budgetStatusSteerKey(input, status);
    if (!steerKey || input.state.budgetStatusSteerKeys.has(steerKey)) {
      return;
    }
    input.state.budgetStatusSteerKeys.add(steerKey);
    const message = formatExecutorBudgetStatus(input.taskEnvelope, input.state, input.reason, true);
    const steeringQueued = this.queueExecutorSteer(input.state, message, input.taskEnvelope.taskId, input.reason);
    void this.executionLog.append({
      taskId: input.taskEnvelope.taskId,
      role: "runtime",
      eventType: "budget_status_updated",
      summary: `remainingTurns=${status.remainingTurns}`,
      payload: {
        reason: input.reason,
        sourceEventId: input.sourceEventId,
        budgetStatus: status,
        delivery: steeringQueued ? "steer" : "none",
        messagePreview: message.slice(0, 500)
      }
    });
  }

  private async notifyProjectorGraphCommitted(
    taskId: string,
    delta: GraphDelta,
    graphVersion?: number,
    committedStatusChanges: ProjectionNodeStatusChange[] = []
  ): Promise<void> {
    graphVersion ??= this.graphStore.plannerVersionSnapshot()[taskId] ?? 0;
    const nodeCount = delta.nodes.length;
    const edgeCount = delta.edges.length;
    if (nodeCount === 0 && edgeCount === 0) {
      return;
    }
    const candidateTaskIds = new Set(this.activeEpochIdByTask.keys());
    candidateTaskIds.add(taskId);
    const nodeRefs = dedupeStrings(delta.nodes.map((node) => node.id));
    const edgeRefs = dedupeStrings(delta.edges.map((edge) => (
      edge.id ?? `${edge.from}:${edge.type}:${edge.to}`
    )));
    const evidenceRefs = dedupeStrings([
      ...delta.sourceEventIds,
      ...delta.nodes.flatMap((node) => node.evidenceRefs ?? []),
      ...delta.edges.flatMap((edge) => edge.evidenceRefs ?? [])
    ]);
    const artifactRefs = dedupeStrings(delta.nodes.flatMap((node) => {
      const single = typeof node.properties.artifactRef === "string" ? [node.properties.artifactRef] : [];
      const many = Array.isArray(node.properties.artifactRefs)
        ? node.properties.artifactRefs.filter((ref): ref is string => typeof ref === "string")
        : [];
      return [...single, ...many];
    }));
    const updateManifest = JSON.stringify({
      sourceTaskRef: taskId,
      graphVersion,
      nodeRefs,
      edgeRefs,
      nodes: delta.nodes.map((node) => ({
        ref: node.id,
        type: node.type,
        label: node.label,
        status: typeof node.properties.status === "string" ? node.properties.status : undefined,
        conclusion: typeof node.properties.conclusion === "string"
          ? node.properties.conclusion
          : typeof node.properties.observedResult === "string"
            ? node.properties.observedResult
            : typeof node.properties.negativeConclusion === "string"
              ? node.properties.negativeConclusion
              : undefined,
        evidenceRefs: node.evidenceRefs ?? []
      })),
      relations: delta.edges.map((edge) => ({
        ref: edge.id ?? `${edge.from}:${edge.type}:${edge.to}`,
        from: edge.from,
        type: edge.type,
        to: edge.to,
        evidenceRefs: edge.evidenceRefs ?? []
      })),
      evidenceRefs,
      artifactRefs
    });
    const notifiedTaskIds: string[] = [];
    for (const candidateTaskId of candidateTaskIds) {
      const state = this.getActiveTaskState(candidateTaskId);
      if (!state || !this.isActiveEpoch(state) || state.executorStopRequested) {
        continue;
      }
      const message = `作战图已提交增量，不改变当前任务边界。请自主判断是否需要查询：${updateManifest}`;
      const delivered = this.queueExecutorSteer(state, message, candidateTaskId, "projector_graph_committed");
      if (!delivered) {
        continue;
      }
      notifiedTaskIds.push(candidateTaskId);
    }
    const plannerUpdateQueued = this.queuePlannerStateUpdate({
      taskId,
      reason: `Projector graph commit persisted for ${taskId}`,
      message: `作战图已提交增量。提交 planner_submit 前请自主判断是否需要查询：${updateManifest}`,
      invalidateSubmission: false
    });
    await this.executionLog.append({
      taskId,
      role: "runtime",
      eventType: "graph_update_notified",
      summary: `Projector commit notified ${notifiedTaskIds.length} active executor(s)`,
      payload: {
        taskId,
        graphVersion,
        notifiedTaskIds,
        plannerUpdateQueued,
        nodeCount,
        edgeCount,
        evidenceRefs,
        artifactRefs,
        nodeRefs,
        edgeRefs,
        statusChanges: committedStatusChanges
      }
    });
  }

  private queueExecutorSteer(
    state: ActiveTaskState,
    message: string,
    taskId: string,
    reason: string,
    allowWhenStopping = false
  ): boolean {
    if (state.executorStopRequested && !allowWhenStopping) {
      return false;
    }
    const executorSession = state.executorSession;
    const steer = (executorSession as { steer?: (text: string) => Promise<void> } | undefined)?.steer;
    if (typeof steer !== "function" || !executorSession) {
      return false;
    }
    void steer.call(executorSession, message).catch((error: unknown) => {
      void this.executionLog.append({
        taskId,
        role: "runtime",
        eventType: reason === "projector_graph_committed" ? "graph_update_steer_failed" : "budget_status_steer_failed",
        summary: `Failed to steer ${reason}: ${error instanceof Error ? error.message : String(error)}`,
        payload: {
          reason,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    });
    return true;
  }

  private applyControlSignal(
    taskEnvelope: TaskEnvelope,
    controlSignal: ControlSignal,
    state = this.getActiveTaskState(taskEnvelope.taskId)
  ): void {
    if (!state || !this.isActiveEpoch(state)) {
      void this.executionLog.append({
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "stale_callback_discarded",
        summary: `Ignored control signal for inactive epoch ${state?.epochId ?? "unknown"}`,
        payload: { controlSignal, epochId: state?.epochId, lifecycleState: state?.lifecycleState }
      });
      return;
    }
    const supervisorVerdict = controlSignal as Partial<SupervisorVerdict>;
    if (supervisorVerdict.epochRef && supervisorVerdict.epochRef !== state.epochId) {
      void this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "stale_callback_discarded",
        summary: `Ignored control signal for stale epoch ${supervisorVerdict.epochRef}`,
        payload: { controlSignal, activeEpochId: state.epochId }
      });
      return;
    }
    const latestSupervisorThroughSeq = this.latestSupervisorThroughSeqByEpoch.get(state.epochId);
    if (
      supervisorVerdict.throughSeq !== undefined
      && latestSupervisorThroughSeq !== undefined
      && supervisorVerdict.throughSeq < latestSupervisorThroughSeq
    ) {
      void this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "supervisor_check_discarded",
        summary: `Ignored superseded control signal throughSeq ${supervisorVerdict.throughSeq}`,
        payload: { controlSignal, latestThroughSeq: latestSupervisorThroughSeq }
      });
      return;
    }
    if (supervisorVerdict.epochRef !== undefined && supervisorVerdict.throughSeq !== undefined) {
      state.supervisionState.lastVerdict = {
        decision: controlSignal.decision,
        reason: controlSignal.reason,
        ...(controlSignal.guidance ? { guidance: controlSignal.guidance } : {})
      };
    }
    if (controlSignal.decision === "redirect") {
      const guidance = controlSignal.guidance?.trim() || controlSignal.reason;
      const delivered = this.queueExecutorSteer(
        state,
        `SUPERVISOR_REDIRECT:\n${guidance}`,
        taskEnvelope.taskId,
        controlSignal.reason
      );
      void this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "supervisor_redirect_applied",
        summary: controlSignal.reason,
        payload: { controlSignal, delivery: delivered ? "steer" : "none" }
      });
      return;
    }
    if (isSupervisorHandoffAdvice(controlSignal)) {
      const message = formatSupervisorHandoffAdvice(controlSignal);
      const delivered = this.queueExecutorSteer(
        state,
        message,
        taskEnvelope.taskId,
        controlSignal.reason
      );
      void this.executionLog.append({
        epochId: state.epochId,
        taskId: taskEnvelope.taskId,
        role: "runtime",
        eventType: "supervisor_handoff_recommended",
        summary: controlSignal.reason,
        payload: { controlSignal, delivery: delivered ? "steer" : "none" }
      });
      return;
    }
    if (!shouldStopExecutorForControlSignal(controlSignal)) {
      return;
    }
    if (state?.executorStopRequested) {
      return;
    }
    void this.requestEpochStop(taskEnvelope, controlSignal, state, "executor_stop_requested");
  }

  private requestEpochStop(
    taskEnvelope: TaskEnvelope,
    controlSignal: ControlSignal,
    state: ActiveTaskState,
    eventType: "executor_checkpoint_requested" | "executor_stop_requested",
    abortKind?: RuntimeAbortContext["kind"]
  ): Promise<void> {
    if (state.terminationPromise) {
      return state.terminationPromise;
    }
    state.lifecycleState = "closing";
    state.executorStopRequested = true;
    state.abortContext = createRuntimeAbortContext(controlSignal, abortKind);
    state.controlSignal = controlSignal;
    state.invocationAbortController.abort(controlSignal.reason);
    state.terminationPromise = this.terminateExecutorSession(state);
    try {
      this.runtimeStore.transitionEpoch({ epochId: state.epochId, state: "closing" });
    } catch {
    }
    void Promise.resolve().then(() => this.executionLog.append({
      epochId: state.epochId,
      taskId: taskEnvelope.taskId,
      role: "runtime",
      eventType,
      summary: controlSignal.reason,
      payload: { controlSignal, abortContext: state.abortContext, epochId: state.epochId, delivery: "abort" }
    })).catch(() => undefined);
    return state.terminationPromise;
  }

  private terminateExecutorSession(state: ActiveTaskState): Promise<void> {
    state.invocationAbortController.abort(state.abortContext?.reason ?? "Executor epoch terminated");
    if (!state.terminationPromise) {
      state.terminationPromise = this.abortExecutorSession(state).catch(async (error: unknown) => {
        state.terminationFailure = errorMessageFromUnknown(error) ?? "Executor termination failed";
        await this.executionLog.append({
          epochId: state.epochId,
          taskId: state.taskEnvelope.taskId,
          role: "runtime",
          eventType: "executor_termination_failed",
          summary: `Executor epoch ${state.epochId} termination command failed`,
          payload: {
            epochId: state.epochId,
            errorType: error instanceof Error ? error.name : "UnknownError",
            error: state.terminationFailure
          }
        }).catch(() => undefined);
      });
    }
    return state.terminationPromise;
  }

  private async abortExecutorSession(state: ActiveTaskState): Promise<void> {
    let clearQueueError: unknown;
    try {
      state.executorSession?.clearQueue?.();
    } catch (error) {
      clearQueueError = error;
    }
    let abortError: unknown;
    try {
      await state.executorSession?.abort();
    } catch (error) {
      abortError = error;
    }
    if (clearQueueError !== undefined || abortError !== undefined) {
      throw new AggregateError(
        [clearQueueError, abortError].filter((error) => error !== undefined),
        `Failed to terminate executor epoch ${state.epochId}`
      );
    }
  }

  private providerAdmission(role: LlmAgentRole, signal?: AbortSignal) {
    const globalSignal = role === "projector"
      ? this.projectorInvocationAbortController.signal
      : this.invocationAbortController.signal;
    return {
      key: providerAdmissionKey(this.llmRuntime, role),
      maxConcurrent: LLM_PROVIDER_MAX_CONCURRENT,
      signal: signal ? AbortSignal.any([globalSignal, signal]) : globalSignal
    };
  }

  private getActiveAbortContext(taskId?: string): RuntimeAbortContext | undefined {
    if (!taskId) {
      return undefined;
    }
    return this.getActiveTaskState(taskId)?.abortContext;
  }

  private armEpochTimeSlice(taskEnvelope: TaskEnvelope): void {
    this.clearEpochTimeSlice(taskEnvelope);
    const state = this.getActiveTaskState(taskEnvelope.taskId);
    const activeRun = this.activeRun;
    if (!state || !activeRun) {
      return;
    }
    const now = Date.now();
    const remainingRunMs = Math.max(0, activeRun.deadlineAt - now);
    const epochTimeLimitMs = Math.max(1, Math.min(
      Math.floor(activeRun.maxRunTimeMs * TASK_EPOCH_RUN_TIME_SHARE),
      remainingRunMs
    ));
    state.runDeadlineAt = activeRun.deadlineAt;
    state.epochBudgetClock = new EpochBudgetClock({
      epochId: state.epochId,
      timeLimitMs: epochTimeLimitMs,
      persist: (snapshot) => this.runtimeStore.upsertEpochBudget(snapshot),
      onExpire: () => {
        if (!this.isActiveEpoch(state)) return;
        const signal: ControlSignal = {
          decision: "handoff",
          reason: `Epoch time slice reached: ${epochTimeLimitMs}ms of ${this.activeRun?.maxRunTimeMs ?? "unknown"}ms global run budget`,
          evidenceRefs: []
        };
        void this.requestEpochStop(taskEnvelope, signal, state, "executor_checkpoint_requested", "budget_abort");
      }
    });
  }

  private pauseExecutorEpochBudget(state: ActiveTaskState, reason: string): void {
    const clock = state.epochBudgetClock;
    if (!clock || !this.isActiveEpoch(state) || !clock.pause()) return;
    const snapshot = clock.snapshot();
    void this.executionLog.append({
      epochId: state.epochId,
      taskId: state.taskEnvelope.taskId,
      role: "runtime",
      eventType: "epoch_budget_paused",
      summary: `Executor epoch budget paused for provider wait (${reason})`,
      payload: { reason, pausedAt: snapshot.pausedAt, epochRemainingMs: snapshot.remainingMs }
    }).catch(() => undefined);
  }

  private async resumeExecutorEpochBudget(state: ActiveTaskState, reason: string): Promise<void> {
    const clock = state.epochBudgetClock;
    if (!clock) return;
    const outageMs = clock.resume();
    if (!this.isActiveEpoch(state)) {
      clock.stop();
      return;
    }
    if (outageMs <= 0) return;
    const snapshot = clock.snapshot();
    await this.executionLog.append({
      epochId: state.epochId,
      taskId: state.taskEnvelope.taskId,
      role: "runtime",
      eventType: "epoch_budget_resumed",
      summary: `Executor epoch budget resumed after ${outageMs}ms provider wait (${reason})`,
      payload: {
        reason,
        outageMs,
        providerDowntimeMs: snapshot.accumulatedPauseMs,
        epochDeadlineAt: snapshot.deadlineAt,
        epochRemainingMs: snapshot.remainingMs
      }
    });
  }

  private clearEpochTimeSlice(taskEnvelope?: TaskEnvelope): void {
    const states = taskEnvelope
      ? [this.getActiveTaskState(taskEnvelope.taskId)].filter((state): state is ActiveTaskState => Boolean(state))
      : [...this.activeEpochs.values()];
    for (const state of states) {
      state.epochBudgetClock?.stop();
      state.epochBudgetClock = undefined;
    }
  }

  private async enrichTaskResultLifecycle(
    taskResult: TaskResult,
    taskEnvelope: TaskEnvelope,
    state = this.getActiveTaskState(taskEnvelope.taskId)
  ): Promise<TaskResult> {
    const checkpointReason = taskResult.checkpointReason
      ?? state?.controlSignal?.reason
      ?? (taskResult.status === "partial" ? "Executor returned a partial epoch result" : undefined);
    const retryable = typeof taskResult.retryable === "boolean"
      ? taskResult.retryable
      : taskResult.status === "partial";
    const lastEventId = state?.lastEventId;
    const submittedEvidenceRefs = taskResult.evidenceRefs.filter((ref) => {
      const event = this.executionLog.eventById(ref);
      if (event) {
        return event.eventType !== "assistant_intent";
      }
      return this.graphStore.trace({ nodeId: ref }).nodes.some((node) => node.id === ref);
    });
    const submittedArtifactRefs: string[] = [];
    for (const artifactRef of taskResult.artifactRefs) {
      if (await this.artifactStore.get(artifactRef)) {
        submittedArtifactRefs.push(artifactRef);
      }
    }
    const epochEvents = state
      ? (await this.executionLog.window({
        epochId: state.epochId,
        limit: 256,
        roles: ["executor", "runtime"],
        eventTypes: ["assistant_intent", "tool_started", "tool_finished", "provider_error"]
      })).events
      : [];
    const epochObservations = buildProjectionObservations(epochEvents);
    const evidenceRefs = dedupeStrings([
      ...submittedEvidenceRefs,
      ...epochObservations.flatMap((observation) => observation.sourceEventIds)
    ]);
    const capabilityRefs = dedupeStrings([
      ...(taskResult.capabilityRefs ?? []),
      ...(this.connectivityRuntime?.capabilityRefsForTask(taskEnvelope.taskId) ?? [])
    ]);
    return {
      ...taskResult,
      evidenceRefs,
      artifactRefs: dedupeStrings(submittedArtifactRefs),
      capabilityRefs,
      checkpointReason,
      retryable,
      attempt: state?.attempt ?? this.nextTaskAttempt(taskEnvelope.taskId),
      resumeCursor: lastEventId,
      lastEventId
    };
  }

  private nextTaskAttempt(taskId: string): number {
    return this.runtimeStore.countTaskEpochs(taskId) + 1;
  }

  private getTaskStatusSnapshot(taskId: string): Record<string, unknown> | undefined {
    const taskNode = this.graphStore
      .query("task", [taskId], 1)
      .nodes
      .find((node) => node.id === taskId);
    return taskNode?.properties;
  }

  private async createDependencyOutcomeBrief(taskEnvelope: TaskEnvelope): Promise<string> {
    const dependencyTaskIds = taskEnvelope.dependsOnTaskRefs ?? [];
    if (dependencyTaskIds.length === 0) {
      return "无直接依赖任务结果。";
    }
    const briefs = dependencyTaskIds.map((dependencyTaskId) => {
      const taskNode = this.graphStore.getTaskNode(dependencyTaskId);
      if (!taskNode) {
        return `${dependencyTaskId}: 图中不存在。`;
      }
      const outcome = this.runtimeStore.getTaskOutcome(dependencyTaskId);
      return JSON.stringify({
        taskRef: dependencyTaskId,
        graphStatus: String(taskNode.properties.status ?? "unknown"),
        outcome: outcome ?? null
      });
    });
    return briefs.join("\n");
  }

}

function deriveTaskDefinitionReadiness(
  dependencyTaskIds: string[] | undefined,
  statusByTaskId: Map<string, string>
): {
  blockedByTaskRefs: string[];
  dependencyStatuses: Record<string, string>;
} {
  const dependencyStatuses = Object.fromEntries(
    dedupeStrings(dependencyTaskIds ?? []).sort()
      .map((taskId) => [taskId, statusByTaskId.get(taskId) ?? "missing"])
  );
  return {
    blockedByTaskRefs: Object.entries(dependencyStatuses)
      .filter(([, status]) => status !== "completed")
      .map(([taskId]) => taskId),
    dependencyStatuses
  };
}

function admitReadyTasks(
  candidates: TaskEnvelope[],
  maxParallelTasks: number,
  occupiedSessionRefs: Set<string> = new Set()
): TaskEnvelope[] {
  const admitted: TaskEnvelope[] = [];
  const occupiedSessions = new Set(occupiedSessionRefs);
  for (const candidate of candidates) {
    const sessionRefs = candidate.availableSessionRefs ?? [];
    const conflicts = sessionRefs.some((sessionRef) => occupiedSessions.has(sessionRef));
    if (conflicts) {
      continue;
    }
    admitted.push(candidate);
    sessionRefs.forEach((sessionRef) => occupiedSessions.add(sessionRef));
    if (admitted.length >= maxParallelTasks) {
      break;
    }
  }
  return admitted;
}

function terminationReasonForTaskResult(
  taskResult: TaskResult,
  state: ActiveTaskState
): ActiveTaskState["terminationReason"] {
  if (state.abortContext?.kind === "budget_abort") {
    return state.abortContext.reason.startsWith("Epoch time slice reached:")
      ? "time_slice_exhausted"
      : "budget_exhausted";
  }
  if (state.abortContext?.kind === "observer_abort") {
    return "supervisor_checkpoint";
  }
  if (taskResult.retryable && /provider|concurrency|rate limit|timeout/i.test(taskResult.checkpointReason ?? taskResult.summary)) {
    return "provider_error";
  }
  return "executor_submitted";
}

function terminationReasonForEpochOutcome(
  outcome: EpochOutcome,
  state: ActiveTaskState
): ActiveTaskState["terminationReason"] {
  if (state.abortContext?.kind === "budget_abort") {
    return state.abortContext.reason.startsWith("Epoch time slice reached:")
      ? "time_slice_exhausted"
      : "budget_exhausted";
  }
  if (state.abortContext?.kind === "observer_abort") {
    return "supervisor_checkpoint";
  }
  if (outcome.status === "provider_error") {
    return "provider_error";
  }
  if (outcome.status === "aborted") {
    return "shutdown";
  }
  return "timeout";
}

function normalizeParallelTaskLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_PARALLEL_TASKS;
  }
  return Math.max(1, Math.min(Math.floor(value), 8));
}

function normalizeRunTimeBudgetMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_RUN_TIME_BUDGET_MS;
  }
  return Math.max(60_000, Math.floor(value));
}

function normalizeGraphDelta(delta: Partial<GraphDelta>): GraphDelta {
  return {
    sourceEventIds: Array.isArray(delta.sourceEventIds) ? delta.sourceEventIds : [],
    nodes: Array.isArray(delta.nodes)
      ? delta.nodes.map((node) => ({
        ...node,
        properties: node.properties ?? {}
      }))
      : [],
    edges: Array.isArray(delta.edges) ? delta.edges : []
  };
}

function mergeProjectionFragmentDeltas(deltas: GraphDelta[]): GraphDelta {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const delta of deltas) {
    for (const node of delta.nodes) {
      const previous = nodes.get(node.id);
      nodes.set(node.id, previous ? {
        ...previous,
        ...node,
        properties: { ...(previous.properties ?? {}), ...(node.properties ?? {}) },
        evidenceRefs: dedupeStrings([...(previous.evidenceRefs ?? []), ...(node.evidenceRefs ?? [])])
      } : node);
    }
    for (const edge of delta.edges) {
      const key = edge.id ?? JSON.stringify([
        edge.from,
        edge.type,
        edge.to,
        edge.properties ?? {}
      ]);
      const previous = edges.get(key);
      edges.set(key, previous ? {
        ...previous,
        ...edge,
        properties: { ...(previous.properties ?? {}), ...(edge.properties ?? {}) },
        evidenceRefs: dedupeStrings([...(previous.evidenceRefs ?? []), ...(edge.evidenceRefs ?? [])])
      } : edge);
    }
  }
  return {
    sourceEventIds: dedupeStrings(deltas.flatMap((delta) => delta.sourceEventIds)),
    nodes: [...nodes.values()],
    edges: [...edges.values()]
  };
}

export function normalizeObserverProjection(value: unknown, defaultSourceEventIds: string[] = []): ObserverProjection {
  const record = isRecord(value) ? value : {};
  const rawGraphDelta = isRecord(record.graphDelta) ? record.graphDelta : record;
  const graphDelta = withDefaultSourceEventIds(
    normalizeGraphDelta(rawGraphDelta as Partial<GraphDelta>),
    defaultSourceEventIds
  );
  const rawControlSignal = isRecord(record.controlSignal) ? record.controlSignal : undefined;
  return {
    graphDelta,
    controlSignal: normalizeControlSignal(rawControlSignal, graphDelta.sourceEventIds)
  };
}

export function normalizeSupervisorControlSignal(value: unknown, defaultEvidenceRefs: string[] = []): ControlSignal {
  const record = isRecord(value) ? value : {};
  const rawControlSignal = isRecord(record.controlSignal) ? record.controlSignal : record;
  return normalizeControlSignal(rawControlSignal, defaultEvidenceRefs);
}

export function normalizeProjectorGraphDelta(value: unknown, defaultSourceEventIds: string[] = []): GraphDelta {
  return normalizeObserverProjection(value, defaultSourceEventIds).graphDelta;
}

function normalizeControlSignal(signal: Record<string, unknown> | undefined, fallbackEvidenceRefs: string[]): ControlSignal {
  const rawDecision = typeof signal?.decision === "string" && isControlSignalDecision(signal.decision)
    ? signal.decision
    : "continue";
  const decision = rawDecision === "checkpoint" || rawDecision === "need_planner" ? "handoff" : rawDecision;
  return {
    decision,
    reason: typeof signal?.reason === "string" && signal.reason.trim().length > 0
      ? signal.reason
      : CONTINUE_CONTROL_SIGNAL.reason,
    evidenceRefs: Array.isArray(signal?.evidenceRefs)
      ? signal.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
      : fallbackEvidenceRefs,
    guidance: typeof signal?.guidance === "string" && signal.guidance.trim().length > 0
      ? signal.guidance.trim()
      : undefined
  };
}

export function normalizeTaskBudget(input?: TaskBudget): Required<TaskBudget> {
  return {
    maxTurns: normalizeBudgetNumber(
      input?.maxTurns,
      DEFAULT_TASK_BUDGET.maxTurns,
      Number.MAX_SAFE_INTEGER,
      MIN_TASK_BUDGET.maxTurns
    )
  };
}

function normalizeInitialTaskBudget(input?: TaskBudget): Required<TaskBudget> {
  return {
    maxTurns: normalizeBudgetNumber(
      input?.maxTurns,
      DEFAULT_TASK_BUDGET.maxTurns,
      MAX_TASK_BUDGET.maxTurns,
      MIN_TASK_BUDGET.maxTurns
    )
  };
}

function normalizeBudgetNumber(value: unknown, defaultValue: number, maxValue: number, minValue = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return Math.max(minValue, Math.min(Math.floor(value), maxValue));
}

export function shouldStopExecutorForControlSignal(controlSignal: ControlSignal): boolean {
  return controlSignal.decision === "stop_executor";
}

function isCheckpointControlSignal(controlSignal?: ControlSignal): boolean {
  return controlSignal?.decision === "handoff"
    || controlSignal?.decision === "checkpoint"
    || controlSignal?.decision === "need_planner";
}

function isSupervisorHandoffAdvice(controlSignal: ControlSignal): boolean {
  return controlSignal.decision === "handoff"
    || controlSignal.decision === "checkpoint"
    || controlSignal.decision === "need_planner";
}

function formatSupervisorHandoffAdvice(controlSignal: ControlSignal): string {
  const supervisorVerdict = controlSignal as Partial<SupervisorVerdict>;
  return [
    "SUPERVISOR_HANDOFF_RECOMMENDATION:",
    JSON.stringify({
      decision: controlSignal.decision,
      reason: controlSignal.reason,
      evidenceRefs: controlSignal.evidenceRefs,
      guidance: controlSignal.guidance,
      epochRef: supervisorVerdict.epochRef,
      throughSeq: supervisorVerdict.throughSeq
    }, undefined, 2),
    "这是 Observer 的交回建议，不是强制终止。若接受，请调用 task_result_submit 正常交回；若判断当前路径仍能产生有效进展，可继续自主执行，继续行动后本建议失效。"
  ].join("\n");
}

function executorContinuedAfterHandoffAdvice(
  event: ExecutionEvent,
  verdict?: Pick<ControlSignal, "decision" | "reason" | "guidance">
): boolean {
  if (!verdict || !["handoff", "checkpoint", "need_planner"].includes(verdict.decision)) {
    return false;
  }
  if (event.eventType === "tool_started") {
    return stringProperty(event.payload?.toolName) !== "task_result_submit";
  }
  if (event.eventType !== "assistant_intent") {
    return false;
  }
  const toolCalls = Array.isArray(event.payload?.toolCalls) ? event.payload.toolCalls : [];
  return !toolCalls.some((toolCall) => isRecord(toolCall) && toolCall.name === "task_result_submit");
}

export function classifyPlannerProviderFailure(error: unknown): RetryableProviderFailure {
  const message = errorMessageFromUnknown(error) ?? "Planner invocation failed";
  if (error instanceof StructuredInvocationError) {
    if (error.code === "timeout") {
      return { errorKind: "provider_timeout", message, retryable: true };
    }
    if (error.code === "provider_error") {
      return { errorKind: classifyLlmErrorKind(message), message, retryable: true };
    }
    if (error.code === "invalid_submit") {
      return { errorKind: "llm_error", message, retryable: true };
    }
    if (error.code === "missing_submit") {
      // The model exhausted its completion budget (typically on reasoning)
      // before emitting the terminating tool call. Retrying with a fresh
      // session and an explicit submit-first nudge usually recovers; a single
      // silent Planner turn must never be run-fatal.
      return { errorKind: "missing_submit", message, retryable: true };
    }
    return { errorKind: "llm_error", message, retryable: false };
  }
  if (error instanceof PromptRuntimeError) {
    return {
      errorKind: error.errorKind,
      message,
      retryable: isRetryableLlmErrorKind(error.errorKind)
    };
  }
  const errorKind = classifyLlmErrorKind(message);
  return { errorKind, message, retryable: isRetryableLlmErrorKind(errorKind) };
}

function isRetryablePlannerInvocationError(error: unknown): boolean {
  if (error instanceof PlannerDecisionRepairExhaustedError) {
    return !(error.cause instanceof IncompletePlannerTerminalDecisionError);
  }
  return classifyPlannerProviderFailure(error).retryable;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createRuntimeAbortContext(
  controlSignal: ControlSignal,
  kind = runtimeAbortKindForControlSignal(controlSignal)
): RuntimeAbortContext {
  return {
    kind,
    reason: controlSignal.reason,
    controlSignal
  };
}

function runtimeAbortKindForControlSignal(controlSignal: ControlSignal): RuntimeAbortContext["kind"] {
  if (controlSignal.reason.startsWith("Task budget reached:") || controlSignal.reason.startsWith("Epoch time slice reached:")) {
    return "budget_abort";
  }
  if (controlSignal.decision === "stop_executor") {
    return "controller_abort";
  }
  return "observer_abort";
}

function normalizeTaskResult(result: Partial<TaskResult>, taskEnvelope: TaskEnvelope): TaskResult {
  const submittedStatus = isTaskResultStatus(result.status) ? result.status : "partial";
  const blockerReason = typeof result.blockerReason === "string" && result.blockerReason.trim().length > 0
    ? result.blockerReason
    : undefined;
  const checkpointReason = typeof result.checkpointReason === "string" && result.checkpointReason.trim().length > 0
    ? result.checkpointReason
    : undefined;
  const retryable = typeof result.retryable === "boolean" ? result.retryable : undefined;
  const status = submittedStatus === "completed"
    && (blockerReason !== undefined || checkpointReason !== undefined || retryable === true)
    ? "partial"
    : submittedStatus;
  return {
    taskId: taskEnvelope.taskId,
    status,
    summary: typeof result.summary === "string" && result.summary.trim().length > 0
      ? result.summary
      : "Executor returned a TaskResult without summary",
    evidenceRefs: Array.isArray(result.evidenceRefs) ? result.evidenceRefs.filter((ref): ref is string => typeof ref === "string") : [],
    artifactRefs: Array.isArray(result.artifactRefs) ? result.artifactRefs.filter((ref): ref is string => typeof ref === "string") : [],
    capabilityRefs: Array.isArray(result.capabilityRefs) ? result.capabilityRefs.filter((ref): ref is string => typeof ref === "string") : [],
    blockerReason,
    suggestedNextGoal: typeof result.suggestedNextGoal === "string" ? result.suggestedNextGoal : undefined,
    checkpointReason,
    retryable,
    attempt: typeof result.attempt === "number" && Number.isFinite(result.attempt) ? Math.floor(result.attempt) : undefined,
    resumeCursor: typeof result.resumeCursor === "string" ? result.resumeCursor : undefined,
    lastEventId: typeof result.lastEventId === "string" ? result.lastEventId : undefined
  };
}

function createTaskOutcome(input: {
  taskResult: TaskResult;
  epochRef: string;
  objectiveRevision: number;
  terminalSeq: number;
}): TaskOutcome {
  return {
    taskRef: input.taskResult.taskId,
    epochRef: input.epochRef,
    objectiveRevision: input.objectiveRevision,
    status: input.taskResult.status,
    summary: input.taskResult.summary,
    evidenceRefs: [...input.taskResult.evidenceRefs],
    artifactRefs: [...input.taskResult.artifactRefs],
    capabilityRefs: [...(input.taskResult.capabilityRefs ?? [])],
    blockerReason: input.taskResult.blockerReason,
    suggestedNextGoal: input.taskResult.suggestedNextGoal,
    checkpoint: input.taskResult.checkpointReason || input.taskResult.retryable || input.taskResult.resumeCursor
      ? {
        reason: input.taskResult.checkpointReason,
        retryable: input.taskResult.retryable,
        resumeCursor: input.taskResult.resumeCursor
      }
      : undefined,
    terminalSeq: input.terminalSeq,
    createdAt: new Date().toISOString()
  };
}

function taskObjectiveRevision(task: GraphNode | undefined): number {
  const revision = task?.properties.objectiveRevision;
  return typeof revision === "number" && Number.isFinite(revision) && revision >= 1
    ? Math.floor(revision)
    : 1;
}

function taskResultFromOutcome(outcome: TaskOutcome | undefined): TaskResult | undefined {
  if (!outcome) {
    return undefined;
  }
  return {
    taskId: outcome.taskRef,
    status: outcome.status,
    summary: outcome.summary,
    evidenceRefs: [...outcome.evidenceRefs],
    artifactRefs: [...outcome.artifactRefs],
    capabilityRefs: [...outcome.capabilityRefs],
    blockerReason: outcome.blockerReason,
    suggestedNextGoal: outcome.suggestedNextGoal,
    checkpointReason: outcome.checkpoint?.reason,
    retryable: outcome.checkpoint?.retryable,
    resumeCursor: outcome.checkpoint?.resumeCursor
  };
}

function projectionPlaceholder(input: ObserverProjectionRequest, reason: string): ObserverProjection {
  return {
    graphDelta: {
      sourceEventIds: input.sourceEventIds ?? [],
      nodes: [],
      edges: []
    },
    controlSignal: {
      decision: "continue",
      reason,
      evidenceRefs: input.sourceEventIds ?? []
    }
  };
}

function controlSignalForTaskResult(taskResult: TaskResult, evidenceRefs: string[]): ControlSignal {
  if (taskResult.status === "partial") {
    return {
      decision: "handoff",
      reason: taskResult.checkpointReason ?? taskResult.summary,
      evidenceRefs
    };
  }
  return {
    decision: "continue",
    reason: taskResult.summary,
    evidenceRefs
  };
}

function controlSignalForEpochOutcome(outcome: EpochOutcome, evidenceRefs: string[]): ControlSignal {
  return {
    decision: "handoff",
    reason: outcome.reason,
    evidenceRefs
  };
}

function classifyExecutorProviderFailure(
  executorError: unknown,
  parseError: unknown,
  executorOutput: string
): RetryableProviderFailure | undefined {
  const message = errorMessageFromUnknown(executorError)
    ?? providerMessageFromOutput(executorOutput)
    ?? errorMessageFromUnknown(parseError);
  if (!message) {
    return undefined;
  }
  const errorKind = executorError instanceof PromptRuntimeError
    ? executorError.errorKind
    : classifyLlmErrorKind(message);
  return {
    errorKind,
    message,
    retryable: isRetryableLlmErrorKind(errorKind)
  };
}

function providerMessageFromOutput(output: string): string | undefined {
  if (!/concurrency limit|rate limit|too many requests|\b429\b|\b5\d\d\b|bad gateway|service unavailable|timed out|timeout/i.test(output)) {
    return undefined;
  }
  return output.slice(0, 500);
}

function errorMessageFromUnknown(error: unknown): string | undefined {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : typeof error === "string" && error.trim().length > 0
      ? error
      : undefined;
}

function projectionRequestPriority(input: ObserverProjectionRequest): number {
  if (input.reason === "task_end") {
    return 100;
  }
  if (input.taskResult) {
    return 90;
  }
  if (input.reason.startsWith(PROJECT_WINDOW_REASON_PREFIX)) {
    return 10;
  }
  return 1;
}

function turnWindowCount(reason: string): number | undefined {
  if (!reason.startsWith(TURN_WINDOW_REASON_PREFIX)) {
    return undefined;
  }
  const count = Number.parseInt(reason.slice(TURN_WINDOW_REASON_PREFIX.length), 10);
  return Number.isFinite(count) ? count : undefined;
}

function selectRecentExecutorTurnEvents(events: ExecutionEvent[], maxTurns: number): ExecutionEvent[] {
  const ordered = [...events].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  let turnsSeen = 0;
  let startIndex = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (["turn_usage", "turn_end"].includes(ordered[index]?.eventType ?? "")) {
      turnsSeen += 1;
      if (turnsSeen > maxTurns) {
        startIndex = index + 1;
        break;
      }
    }
  }
  return ordered.slice(startIndex).filter((event) => event.eventType !== "turn_usage");
}

function createInitialTaskSupervisionState(taskEnvelope: TaskEnvelope): TaskSupervisionState {
  return {
    taskId: taskEnvelope.taskId,
    phase: inferTaskPhase(taskEnvelope.goal),
    progressDigest: "尚无监督摘要；等待 Executor 产生执行事件。",
    repeatedPatterns: [],
    negativeFindings: [],
    recentFingerprints: [],
    openQuestions: taskEnvelope.successCriteria.length > 0
      ? [`成功条件：${taskEnvelope.successCriteria.join("；")}`]
      : ["成功条件未显式提供。"]
  };
}

function restoreTaskSupervisionState(
  taskEnvelope: TaskEnvelope,
  taskOutcome: TaskOutcome | undefined,
  previous: TaskSupervisionState | undefined
): TaskSupervisionState {
  if (previous) {
    return {
      ...cloneTaskSupervisionState(previous),
      taskId: taskEnvelope.taskId,
      phase: inferTaskPhase(taskEnvelope.goal),
      openQuestions: taskEnvelope.successCriteria.length > 0
        ? [`成功条件：${taskEnvelope.successCriteria.join("；")}`]
        : previous.openQuestions
    };
  }
  const initial = createInitialTaskSupervisionState(taskEnvelope);
  const resultSummary = taskOutcome?.summary;
  const checkpointReason = taskOutcome?.checkpoint?.reason;
  const blockerReason = taskOutcome?.status === "blocked" || taskOutcome?.status === "failed"
    ? taskOutcome.summary
    : undefined;
  if (resultSummary) {
    initial.progressDigest = `上一阶段结果：${truncateText(resultSummary, 240)}`;
  }
  for (const negativeFinding of [checkpointReason, blockerReason]) {
    if (negativeFinding) {
      appendLimitedUnique(initial.negativeFindings, truncateText(negativeFinding, 160), 6);
    }
  }
  return initial;
}

function cloneTaskSupervisionState(state: TaskSupervisionState): TaskSupervisionState {
  return {
    ...state,
    ...(state.lastVerdict ? { lastVerdict: { ...state.lastVerdict } } : {}),
    repeatedPatterns: [...state.repeatedPatterns],
    negativeFindings: [...state.negativeFindings],
    recentFingerprints: [...state.recentFingerprints],
    openQuestions: [...state.openQuestions]
  };
}

function updateTaskSupervisionState(
  supervisionState: TaskSupervisionState,
  event: ExecutionEvent
): void {
  if (event.eventType === "tool_finished" || event.eventType === "tool_execution_end") {
    const toolName = stringProperty((event.payload as { toolName?: unknown } | undefined)?.toolName);
    const resultText = eventText(event).slice(0, 240);
    const fingerprint = toolResultFingerprint(event);
    const repeated = Boolean(fingerprint && supervisionState.recentFingerprints.includes(fingerprint));
    supervisionState.progressDigest = [
      `最近工具完成：${toolName ?? "unknown"}`,
      resultText ? `结果摘要：${resultText}` : undefined,
      fingerprint ? `工具输出指纹：${repeated ? "重复出现" : "此前未见"}；指纹变化不代表语义进展` : undefined
    ].filter(Boolean).join("；");
    if (fingerprint) {
      if (repeated) {
        appendLimitedUnique(supervisionState.repeatedPatterns, fingerprint, 6);
      }
      supervisionState.recentFingerprints.push(fingerprint);
      while (supervisionState.recentFingerprints.length > 12) {
        supervisionState.recentFingerprints.shift();
      }
    }
    if ((event.payload as { isError?: unknown }).isError === true) {
      appendLimitedUnique(supervisionState.negativeFindings, resultText.slice(0, 160) || `${toolName}:error`, 6);
    }
    return;
  }
  if (["turn_usage", "assistant_intent", "turn_end", "message_end"].includes(event.eventType)) {
    const text = eventText(event).slice(0, 240);
    if (text) {
      supervisionState.progressDigest = `最近思考/消息：${text}`;
    }
    return;
  }
  if (["task_partial", "task_blocked", "task_failed", "task_completed"].includes(event.eventType)) {
    const summary = event.summary ?? eventText(event).slice(0, 240);
    supervisionState.progressDigest = `任务阶段结果：${summary}`;
    if (event.eventType === "task_blocked" || event.eventType === "task_failed") {
      appendLimitedUnique(supervisionState.negativeFindings, summary, 6);
    }
  }
}

function inferTaskPhase(goal: string): TaskSupervisionState["phase"] {
  const normalized = goal.toLowerCase();
  if (/recon|enumerat|discover|侦察|枚举|探测/.test(normalized)) {
    return "recon";
  }
  if (/exploit|bypass|ssrf|sqli|rce|利用|绕过|注入/.test(normalized)) {
    return "exploit";
  }
  if (/verify|validate|confirm|验证|确认/.test(normalized)) {
    return "verify";
  }
  if (/flag|extract|read|读取|提取/.test(normalized)) {
    return "extract";
  }
  return "unknown";
}

function toolResultFingerprint(event: ExecutionEvent): string | undefined {
  const payload = event.payload as { toolName?: unknown; result?: unknown; isError?: unknown } | undefined;
  const toolName = stringProperty(payload?.toolName) ?? "tool";
  const text = eventText(event);
  if (!text) {
    return `${toolName}:empty:${payload?.isError === true ? "error" : "ok"}`;
  }
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${toolName}:${payload?.isError === true ? "error" : "ok"}:${text.length}:${digest}`;
}

function eventText(event: ExecutionEvent): string {
  const texts: string[] = [];
  collectTextFragments(event.payload, texts, 6);
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

function collectTextFragments(value: unknown, output: string[], limit: number): void {
  if (output.length >= limit || value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    if (value.trim().length > 0) {
      output.push(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      collectTextFragments(item, output, limit);
      if (output.length >= limit) {
        return;
      }
    }
    return;
  }
  if (isRecord(value)) {
    for (const key of ["summary", "text", "command", "error", "stdout", "stderr", "content", "result", "partialResult", "message"]) {
      if (key in value) {
        collectTextFragments(value[key], output, limit);
        if (output.length >= limit) {
          return;
        }
      }
    }
  }
}

function supervisionStateForPrompt(
  state: TaskSupervisionState
): Omit<TaskSupervisionState, "recentFingerprints" | "lastVerdict"> {
  const {
    recentFingerprints: _recentFingerprints,
    lastVerdict: _lastVerdict,
    ...promptState
  } = state;
  return promptState;
}

function appendLimitedUnique(values: string[], value: string, limit: number): void {
  const normalized = value.trim();
  if (!normalized || values.includes(normalized)) {
    return;
  }
  values.push(normalized);
  while (values.length > limit) {
    values.shift();
  }
}

function truncateText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 24))}...[truncated:${normalized.length}]`;
}

function attachTaskResultProjectionReferences(
  batch: ProjectionBatch,
  taskResult: TaskResult | undefined
): ProjectionBatch {
  if (!taskResult || batch.observations.length === 0) {
    return batch;
  }
  const taskOutcomeIndex = batch.observations.findLastIndex((observation) => observation.kind === "task_outcome");
  const targetIndex = taskOutcomeIndex >= 0 ? taskOutcomeIndex : batch.observations.length - 1;
  const observations = batch.observations.map((observation, index) => index === targetIndex ? {
    ...observation,
    artifactRefs: dedupeStrings([...observation.artifactRefs, ...taskResult.artifactRefs]),
    capabilityRefs: dedupeStrings([
      ...(observation.capabilityRefs ?? []),
      ...(taskResult.capabilityRefs ?? [])
    ]),
    sourceEventIds: dedupeStrings([...observation.sourceEventIds, ...taskResult.evidenceRefs])
  } : observation);
  return {
    ...batch,
    observations,
    sourceEventIds: dedupeStrings([...batch.sourceEventIds, ...taskResult.evidenceRefs])
  };
}

function compactProjectorConnectivityContext(
  routes: RouteProjectionContext[],
  observations: ProjectionObservation[],
  maxBytes: number
): Record<string, unknown> {
  const anchors = dedupeStrings(observations.flatMap((observation) => observation.anchors));
  const ordered = routes
    .map((route, index) => ({ route, index, relevant: routeMatchesProjectionAnchors(route, anchors) }))
    .sort((left, right) => Number(right.relevant) - Number(left.relevant) || left.index - right.index);
  const compactedRoutes: Array<Record<string, unknown>> = [];
  const routeDigest = createHash("sha256").update(JSON.stringify(routes)).digest("hex");
  for (const { route } of ordered) {
    const targetCidrs = dedupeStrings(route.targetCidrs);
    const compactedRoute = {
      routeRef: compactUtf8HeadTail(route.routeRef, 240),
      connector: route.connector,
      pivotHostRef: compactUtf8HeadTail(route.pivotHostRef, 240),
      dialAddress: route.dialAddress ? compactUtf8HeadTail(route.dialAddress, 240) : undefined,
      targetCidrs: targetCidrs.slice(0, 12).map((cidr) => compactUtf8HeadTail(cidr, 160)),
      targetCidrCount: targetCidrs.length,
      targetCidrsSha256: createHash("sha256").update(targetCidrs.join("\u0000")).digest("hex"),
      status: route.status,
      lastHeartbeat: compactUtf8HeadTail(route.lastHeartbeat, 80),
      connectionRef: route.connectionRef ? compactUtf8HeadTail(route.connectionRef, 240) : undefined
    };
    const candidate = {
      source: "ConnectivityStore route definitions",
      routeCount: routes.length,
      routeSnapshotSha256: routeDigest,
      routes: [...compactedRoutes, compactedRoute],
      omittedRouteCount: Math.max(0, routes.length - compactedRoutes.length - 1)
    };
    if (Buffer.byteLength(JSON.stringify(candidate, null, 2), "utf8") > Math.max(512, maxBytes)) {
      break;
    }
    compactedRoutes.push(compactedRoute);
  }
  return {
    source: "ConnectivityStore route definitions",
    routeCount: routes.length,
    routeSnapshotSha256: routeDigest,
    routes: compactedRoutes,
    omittedRouteCount: Math.max(0, routes.length - compactedRoutes.length)
  };
}

function routeMatchesProjectionAnchors(route: RouteProjectionContext, anchors: string[]): boolean {
  const routeText = [
    route.routeRef,
    route.pivotHostRef,
    route.dialAddress ?? "",
    route.connectionRef ?? "",
    ...route.targetCidrs
  ].join(" ").toLowerCase();
  for (const anchor of anchors) {
    const normalized = anchor.toLowerCase();
    if (normalized && (routeText.includes(normalized) || normalized.includes(route.routeRef.toLowerCase()))) {
      return true;
    }
    const addresses = anchor.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
    if (addresses.some((address) => route.targetCidrs.some((cidr) => ipv4AddressInCidr(address, cidr)))) {
      return true;
    }
  }
  return false;
}

function ipv4AddressInCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/", 2);
  const prefix = Number(prefixText);
  const addressValue = ipv4AddressValue(address);
  const networkValue = ipv4AddressValue(network ?? "");
  if (addressValue === undefined || networkValue === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressValue & mask) === (networkValue & mask);
}

function ipv4AddressValue(value: string): number | undefined {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return octets.reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
}

function renderProjectorTaskResult(taskResult: TaskResult): string {
  return `taskOutcome=${JSON.stringify({
    taskRef: compactUtf8HeadTail(taskResult.taskId, 240),
    status: taskResult.status,
    summary: compactUtf8HeadTail(taskResult.summary, 1_200),
    refManifest: {
      transport: "exact refs are carried by projection observation aliases",
      evidenceRefCount: taskResult.evidenceRefs.length,
      artifactRefCount: taskResult.artifactRefs.length,
      capabilityRefCount: taskResult.capabilityRefs?.length ?? 0
    },
    checkpoint: taskResult.checkpointReason || taskResult.retryable || taskResult.resumeCursor
      ? {
        reason: taskResult.checkpointReason
          ? compactUtf8HeadTail(taskResult.checkpointReason, 480)
          : undefined,
        retryable: taskResult.retryable,
        resumeCursor: taskResult.resumeCursor
          ? compactUtf8HeadTail(taskResult.resumeCursor, 480)
          : undefined
      }
      : undefined
  })}`;
}

function truncateOneLine(value: string, limit: number): string {
  return truncateText(value, limit);
}

function isRuntimeContextArtifact(preview: string): boolean {
  const normalized = preview.trim();
  return normalized.startsWith("OBSERVATION_SEED:")
    || normalized.startsWith("TASK_ENVELOPE:")
    || normalized.startsWith("USER_GOAL:")
    || normalized.startsWith("你正在监督当前 Executor")
    || (normalized.startsWith("---") && /\nname:\s*(ctf-|solve-challenge|skill)/i.test(normalized))
    || /allowed-tools:|# CTF Web Exploitation|# AGENTS\.md/i.test(normalized)
    || (normalized.startsWith("{") && normalized.includes("\"events\"") && normalized.includes("\"eventType\""));
}

function stringArrayProperty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isControlSignalDecision(value: string): value is ControlSignal["decision"] {
  return ["continue", "redirect", "handoff", "checkpoint", "stop_executor", "need_planner"].includes(value);
}

function isTaskResultStatus(value: unknown): value is TaskResultStatus {
  return ["completed", "partial", "blocked", "failed"].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDefaultSourceEventIds(delta: GraphDelta, defaultSourceEventIds: string[]): GraphDelta {
  if (delta.sourceEventIds.length > 0 || defaultSourceEventIds.length === 0) {
    return delta;
  }
  return {
    ...delta,
    sourceEventIds: defaultSourceEventIds
  };
}

export function compactExecutorGraphClosure(
  closure: ReturnType<SQLiteGraphStore["projectionClosure"]>,
  graphKind: "operation" | "reasoning",
  limit: number
) {
  const nodes = closure.nodes
    .filter((node) => node.graphKind === graphKind)
    .slice(0, limit)
    .map((node) => ({
    id: node.id,
    type: node.type,
    label: truncateText(node.label, 220),
    properties: compactNodeProperties(node.type, node.properties),
    evidenceRefs: (node.evidenceRefs ?? []).slice(0, 6)
    }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: closure.edges
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .slice(0, 20)
      .map((edge) => ({ from: edge.from, to: edge.to, type: edge.type }))
  };
}

export function compactSupervisorRelevantKnowledge(
  closure: ReturnType<SQLiteGraphStore["projectionClosure"]>,
  fillLimit: number
) {
  const nodes = closure.nodes
    .filter((node) => node.graphKind === "reasoning")
    .slice(0, fillLimit)
    .map((node) => ({
    id: node.id,
    type: node.type,
    label: truncateText(node.label, 220),
    properties: compactNodeProperties(node.type, node.properties),
    evidenceRefs: (node.evidenceRefs ?? []).slice(0, 6)
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: closure.edges
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .slice(0, 20)
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        type: edge.type,
        evidenceRefs: (edge.evidenceRefs ?? []).slice(0, 6)
      }))
  };
}

function compactNodeProperties(type: string, properties: Record<string, unknown>): Record<string, unknown> {
  const commonKeys = [
    "status",
    "host",
    "port",
    "protocol",
    "service",
    "url",
    "path",
    "method",
    "name",
    "username",
    "role",
    "valid",
    "confidence",
    "resultSummary",
    "checkpointReason",
    "blockerReason"
  ];
  const keysByType: Record<string, string[]> = {
    Host: ["address", "ip", "hostname"],
    Port: ["port", "protocol", "state"],
    Service: ["scheme", "server", "technology", "baseUrl"],
    WebEndpoint: ["path", "url", "method", "status", "requires_auth", "role_observed"],
    Parameter: ["name", "location", "examples", "flag_path_probe_result"],
    Credential: ["username", "password", "role", "source", "valid"],
    Session: ["username", "role", "principal", "cookieName", "cookie_name", "authenticated", "valid"],
    File: ["path", "size", "hash", "mediaType"],
    Process: ["pid", "command", "user"],
    Evidence: [
      "target", "endpoint", "parameter", "method", "accessMethod", "precondition", "result",
      "preconditions", "observedResult", "oracle", "conclusionScope", "statusCode",
      "negativeConclusion", "negativeFindings", "negative_flag_findings", "interesting_paths"
    ],
    Hypothesis: [
      "basis", "target", "method", "accessMethod", "endpointLocated", "preconditions",
      "observedResult", "oracle", "negativeConclusion", "reopenConditions"
    ],
    Vulnerability: ["affectedEndpoint", "affectedParameter", "authenticatedRole", "preconditions", "impact"],
    Exploit: ["sessionRole", "preconditions", "effect", "readFiles", "createdSession", "nonDestructive"]
  };
  const allowedKeys = dedupeStrings([...commonKeys, ...(keysByType[type] ?? [])]);
  return Object.fromEntries(
    allowedKeys
      .filter((key) => properties[key] !== undefined)
      .map((key) => [key, compactExecutorProperty(properties[key])])
  );
}

function taskKnowledgeAnchors(taskEnvelope: TaskEnvelope): string[] {
  return dedupeStrings([
    ...taskEnvelope.targetRefs,
    ...(taskEnvelope.basisRefs ?? []),
    taskEnvelope.goal,
    ...taskEnvelope.successCriteria,
    ...taskEnvelope.constraints
  ]);
}

function compactExecutorProperty(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateText(value, 300);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => typeof item === "string" ? truncateText(item, 180) : item);
  }
  return value;
}

function createExecutionBrief(
  taskEnvelope: TaskEnvelope,
  events: ExecutionEvent[],
  outcome?: TaskOutcome,
  taskStatus?: Record<string, unknown>
): string {
  return JSON.stringify({
    taskRef: taskEnvelope.taskId,
    graphStatus: String(taskStatus?.status ?? "open"),
    outcome: outcome ?? null,
    recentObservationRefs: events.map((event) => ({
      ref: event.id,
      seq: event.seq,
      eventType: event.eventType
    })),
    remainingSuccessCriteria: taskEnvelope.successCriteria
  });
}

export function createFallbackObserverDelta(
  _taskEnvelope: TaskEnvelope,
  _taskResult: TaskResult | undefined,
  sourceEventIds: string[],
  _reason = "observer_projection_failed"
): GraphDelta {
  return {
    sourceEventIds,
    nodes: [],
    edges: []
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function projectionAttemptRef(queueId: string | undefined, generation: number): string {
  return `${queueId ?? "projection"}:generation:${generation}`;
}

function ensureTaskBudget(taskEnvelope: TaskEnvelope): Required<TaskBudget> {
  const budget = normalizeTaskBudget(taskEnvelope.budget);
  taskEnvelope.budget = budget;
  return budget;
}

export function isCountableExecutorTurn(event: Pick<ExecutionEvent, "eventType" | "payload">): boolean {
  if (event.eventType !== "turn_usage" && event.eventType !== "turn_end") {
    return false;
  }
  const stopReason = stringProperty(event.payload.stopReason);
  if (stopReason && !["toolUse", "stop"].includes(stopReason)) {
    return false;
  }
  const usage = isRecord(event.payload.usage) ? event.payload.usage : undefined;
  const outputTokens = typeof usage?.output === "number" ? usage.output : undefined;
  return outputTokens === undefined || outputTokens > 0;
}

function taskTurnIdentity(event: ExecutionEvent): string {
  const responseId = stringProperty(event.payload.responseId);
  return responseId ? `${event.taskId ?? "task"}:${responseId}` : event.id;
}

function budgetStatusSnapshot(taskEnvelope: TaskEnvelope, state?: ActiveTaskState): Record<string, unknown> {
  const budget = normalizeTaskBudget(taskEnvelope.budget);
  const taskUsedTurns = state?.taskTurnCount ?? 0;
  const taskRemainingTurns = Math.max(0, budget.maxTurns - taskUsedTurns);
  const epochUsedTurns = state?.epochTurnCount ?? 0;
  const epochMaxTurns = Math.min(DEFAULT_EPOCH_TURN_SLICE, taskRemainingTurns + epochUsedTurns);
  const epochRemainingTurns = Math.max(0, epochMaxTurns - epochUsedTurns);
  const epochBudget = state?.epochBudgetClock?.snapshot();
  return {
    taskId: taskEnvelope.taskId,
    budget: { maxTurns: budget.maxTurns },
    usedTurns: taskUsedTurns,
    remainingTurns: taskRemainingTurns,
    epochUsedTurns,
    epochMaxTurns,
    epochRemainingTurns,
    nearTurnLimit: Math.min(taskRemainingTurns, epochRemainingTurns) <= BUDGET_PRESSURE_TURNS,
    stopRequested: state?.executorStopRequested ?? false,
    abortReason: state?.abortContext?.reason,
    globalRemainingMs: state?.runDeadlineAt === undefined
      ? undefined
      : Math.max(0, state.runDeadlineAt - Date.now()),
    epochRemainingMs: epochBudget?.remainingMs,
    epochTimeLimitMs: epochBudget?.timeLimitMs,
    providerDowntimeMs: epochBudget?.accumulatedPauseMs,
    lastControlSignal: state?.controlSignal,
    lastEventId: state?.lastEventId
  };
}

function remainingTurns(taskEnvelope: TaskEnvelope, state: ActiveTaskState): number {
  const budget = normalizeTaskBudget(taskEnvelope.budget);
  return Math.max(0, budget.maxTurns - state.taskTurnCount);
}

function budgetStatusSteerKey(
  input: {
    reason: string;
    force?: boolean;
  },
  status: Record<string, unknown>
): string | undefined {
  const taskRemaining = typeof status.remainingTurns === "number" ? status.remainingTurns : undefined;
  const epochRemaining = typeof status.epochRemainingTurns === "number" ? status.epochRemainingTurns : undefined;
  const remaining = taskRemaining === undefined
    ? epochRemaining
    : epochRemaining === undefined ? taskRemaining : Math.min(taskRemaining, epochRemaining);
  if (input.force) {
    const budget = status.budget as { maxTurns?: number } | undefined;
    return `force:${input.reason}:maxTurns=${budget?.maxTurns ?? "unknown"}`;
  }
  if (remaining !== undefined && remaining > 0 && remaining <= BUDGET_PRESSURE_TURNS) {
    return `remainingTurns:${remaining}`;
  }
  const epochRemainingMs = typeof status.epochRemainingMs === "number" ? status.epochRemainingMs : undefined;
  if (epochRemainingMs !== undefined && epochRemainingMs > 0 && epochRemainingMs <= 120_000) {
    return `epochRemainingBucket:${Math.ceil(epochRemainingMs / 30_000)}`;
  }
  const globalRemainingMs = typeof status.globalRemainingMs === "number" ? status.globalRemainingMs : undefined;
  if (globalRemainingMs !== undefined && globalRemainingMs > 0 && globalRemainingMs <= 120_000) {
    return `globalRemainingBucket:${Math.ceil(globalRemainingMs / 30_000)}`;
  }
  const usedTurns = typeof status.usedTurns === "number" ? status.usedTurns : 0;
  const turnBucket = Math.floor(usedTurns / BUDGET_STEER_TURN_INTERVAL);
  if (turnBucket >= 1) {
    return `turnBucket:${turnBucket}`;
  }
  return undefined;
}

function formatExecutorBudgetStatus(
  taskEnvelope: TaskEnvelope,
  state: ActiveTaskState,
  reason: string,
  update = false
): string {
  const status = budgetStatusSnapshot(taskEnvelope, state);
  const budget = status.budget as { maxTurns?: number };
  const yesNo = (value: unknown): string => value === true ? "yes" : "no";
  return [
    update ? "RUNTIME_BUDGET_STATUS_UPDATE" : "RUNTIME_BUDGET_STATUS",
    `reason: ${reason}`,
    `taskAllocation: ${status.usedTurns}/${budget.maxTurns ?? "unknown"}; remaining: ${status.remainingTurns}`,
    `epochSlice: ${status.epochUsedTurns}/${status.epochMaxTurns}; remaining: ${status.epochRemainingTurns}`,
    `globalRemainingMs: ${status.globalRemainingMs ?? "unbounded"}`,
    `epochRemainingMs: ${status.epochRemainingMs ?? "unbounded"}; epochTimeLimitMs: ${status.epochTimeLimitMs ?? "unbounded"}; providerDowntimeMs: ${status.providerDowntimeMs ?? 0}`,
    `nearTurnLimit: ${yesNo(status.nearTurnLimit)}`,
    `stopRequested: ${yesNo(status.stopRequested)}${status.abortReason ? `; abortReason: ${status.abortReason}` : ""}`,
    `constraints: ${taskEnvelope.constraints.join("；") || "none"}`,
    "Rule: if stopRequested=yes, task allocation remaining<=0, epoch slice remaining<=0, or epochRemainingMs is near zero, immediately return a phase TaskResult; otherwise continue within scope."
  ].join("\n");
}

function readPiSessionStats(session: SecurityAgentSession): PiSessionStatsSnapshot | undefined {
  const candidate = session as unknown as { getSessionStats?: () => PiSessionStatsSnapshot };
  if (typeof candidate.getSessionStats !== "function") {
    return undefined;
  }
  try {
    return candidate.getSessionStats();
  } catch {
    return undefined;
  }
}

function diffPiSessionStats(
  before: PiSessionStatsSnapshot | undefined,
  after: PiSessionStatsSnapshot
): Record<string, unknown> & {
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { total: number };
  };
} {
  const delta = (current: number, previous = 0): number => Math.max(0, current - previous);
  const input = delta(after.tokens.input, before?.tokens.input);
  const output = delta(after.tokens.output, before?.tokens.output);
  const cacheRead = delta(after.tokens.cacheRead, before?.tokens.cacheRead);
  const cacheWrite = delta(after.tokens.cacheWrite, before?.tokens.cacheWrite);
  return {
    userMessages: delta(after.userMessages, before?.userMessages),
    assistantMessages: delta(after.assistantMessages, before?.assistantMessages),
    toolCalls: delta(after.toolCalls, before?.toolCalls),
    toolResults: delta(after.toolResults, before?.toolResults),
    totalMessages: delta(after.totalMessages, before?.totalMessages),
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { total: delta(after.cost, before?.cost) }
    }
  };
}

function captureSequencesFromError(message: string): {
  persistedFlowSequence?: number;
  persistedNetworkSequence?: number;
} {
  const flow = /flow_seq=(\d+)/.exec(message)?.[1];
  const network = /net_seq=(\d+)/.exec(message)?.[1];
  return {
    ...(flow ? { persistedFlowSequence: Number(flow) } : {}),
    ...(network ? { persistedNetworkSequence: Number(network) } : {})
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function disposeSession(session: SecurityAgentSession): void {
  const candidate = session as unknown as { dispose?: () => void; abort?: () => Promise<void> };
  if (typeof candidate.dispose === "function") {
    candidate.dispose();
    return;
  }
  void candidate.abort?.();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
