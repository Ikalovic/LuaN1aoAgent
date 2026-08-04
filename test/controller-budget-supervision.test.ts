import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_TASK_BUDGET,
  DEFAULT_EPOCH_TURN_SLICE,
  MAX_TASK_BUDGET,
  MIN_TASK_BUDGET,
  normalizeObserverProjection,
  normalizeTaskBudget,
  SecurityAgentController,
  compactExecutorGraphClosure,
  compactSupervisorRelevantKnowledge,
  isCountableExecutorTurn,
  normalizeSupervisorControlSignal,
  shouldStopExecutorForControlSignal
} from "../src/controller.js";
import { PromptRuntimeError } from "../src/pi-runner.js";
import type { EpochBudgetClock } from "../src/epoch-budget-clock.js";
import { renderPlannerInput } from "../src/prompts.js";
import type { ProjectorGraphRefRegistry } from "../src/projection.js";
import type { ControlSignal, EpochOutcome, ExecutionEvent, GraphDelta, GraphNode, ObserverProjection, PlannerDecision, PlannerDecisionView, PlannerTaskSpec, SupervisorVerdict, TaskEnvelope, TaskOutcome, TaskResult } from "../src/types.js";

type ControllerHarness = {
  executorSandbox?: { workspaceDir?: string };
  agents: {
    planner: unknown;
    executor: { abort: () => Promise<void>; clearQueue?: () => unknown; steer?: (text: string) => Promise<void> };
    observer: unknown;
  };
  activeEpochs?: Map<string, unknown>;
  activeEpochIdByTask?: Map<string, string>;
  activeRun?: {
    invocationId: string;
    startedAt: number;
    maxRunTimeMs: number;
    deadlineAt: number;
    startSeq: number;
  };
  enqueueProjectionJob: (input: unknown) => Promise<ObserverProjection>;
  enqueueSupervisorCheck: (input: unknown) => Promise<SupervisorVerdict>;
  runProjectionJob: (input: unknown) => Promise<ObserverProjection>;
  runSupervisorCheck: (input: unknown) => Promise<SupervisorVerdict>;
  applyControlSignal: (taskEnvelope: TaskEnvelope, controlSignal: ControlSignal, state?: TestActiveState) => void;
  requestEpochStop: (
    taskEnvelope: TaskEnvelope,
    controlSignal: ControlSignal,
    state: TestActiveState,
    eventType: "executor_checkpoint_requested" | "executor_stop_requested"
  ) => Promise<void>;
  handleExecutorEventPersisted: (event: ExecutionEvent) => Promise<void>;
  armEpochTimeSlice: (taskEnvelope: TaskEnvelope) => void;
  clearEpochTimeSlice: () => void;
  createExecutorSessionForTask: (
    taskEnvelope: TaskEnvelope,
    useDynamicExecutor: boolean
  ) => Promise<{
    session: ReturnType<typeof createAbortableMockTextSession>;
    dynamicExecutor: boolean;
    resumed: boolean;
    resumeCount: number;
  }>;
  createNewExecutorSessionForTask: (
    useDynamicExecutor: boolean
  ) => Promise<{
    session: ReturnType<typeof createAbortableMockTextSession>;
    dynamicExecutor: boolean;
    resumed: boolean;
    resumeCount: number;
  }>;
  createObserverSessionForMode: (
    mode: "supervise" | "project",
    taskId: string,
    projectorGraphRefs?: ProjectorGraphRefRegistry
  ) => Promise<{ session: ReturnType<typeof createAbortableMockTextSession>; dynamicObserver: boolean }>;
  persistEpochOutcome: (
    state: TestActiveState,
    input: Pick<EpochOutcome, "status" | "reason" | "retryable" | "taskOutcomeRef"> & {
      taskOutcome?: TaskOutcome;
    }
  ) => Promise<{ outcome: EpochOutcome; eventId: string }>;
  releasePlannerWaitingTasks: (
    plannerDecision: PlannerDecision,
    plannerVisibleWaitingTaskIds: Set<string>
  ) => Promise<string[]>;
  createDependencyOutcomeBrief: (taskEnvelope: TaskEnvelope) => Promise<string>;
  withSessionMaterialRefs: <T extends { evidenceRefs?: string[] }>(
    nodes: T[]
  ) => Array<T & { materialRefs?: string[] }>;
  structuredInvocationsEnabled: boolean;
  isolatedSessionsEnabled: boolean;
  createPlannerSessionForCycle: (forceIsolated?: boolean) => Promise<{
    session: ReturnType<typeof createAbortableMockTextSession>;
    isolated: boolean;
  }>;
  invokePlannerCycle: (input: {
    userGoal: string;
    scopeSummary: string;
    repairFeedback?: string;
  }) => Promise<{
    plannerDecision: PlannerDecision;
    plannerPromptId: string;
    versionSnapshot: Record<string, number>;
  }>;
  beginTaskExecution: (taskEnvelope: TaskEnvelope) => TestActiveState;
  finishTaskExecution: (taskId: string, reason?: string) => void;
  closeExecutorResources: () => Promise<void>;
  ensureRootGraph: (input: { userGoal: string; scopeSummary: string }) => Promise<void>;
  buildPlannerDecisionView: () => Promise<PlannerDecisionView>;
  notifyProjectorGraphCommitted: (taskId: string, delta: GraphDelta) => Promise<void>;
  activePlannerSessions: Set<{ steer?: (text: string) => Promise<void>; abort?: () => Promise<void> }>;
  validatePlannerRuntimeBoundary: (plannerDecision: PlannerDecision) => void;
  normalizePlannerDecisionBoundary: (plannerDecision: PlannerDecision) => PlannerDecision;
  plannerReferenceCandidates: (prefix: string) => string[];
  taskEnvelopeFromSpec: (taskSpec: PlannerTaskSpec, scopeSummary: string) => TaskEnvelope;
  assertPlannerRuntimeTransitions: (commands: NonNullable<PlannerDecision["commands"]>) => void;
  projectorCoordinator: {
    waitForCommitted: (taskId: string, targetSeq: number, options?: { timeoutMs?: number }) => Promise<void>;
    waitForSettled: (timeoutMs?: number) => Promise<boolean>;
  };
  enrichTaskResultLifecycle: (
    taskResult: TaskResult,
    taskEnvelope: TaskEnvelope,
    state?: TestActiveState
  ) => Promise<TaskResult>;
  collectBudgetCheckpointTaskResult: (input: {
    taskEnvelope: TaskEnvelope;
    state: TestActiveState;
    executorSession: {
      session: ReturnType<typeof createCheckpointSubmissionSession>;
      dynamicExecutor: boolean;
      resumed: boolean;
      resumeCount: number;
    };
    logging?: { drain: () => Promise<void> };
  }) => Promise<TaskResult | undefined>;
  scheduleExecutorNetworkFinalization: (state: TestActiveState) => Promise<void>;
  disposeTaskExecutorResources: (taskId: string) => Promise<void>;
};

type TestActiveState = {
  epochId: string;
  taskEnvelope: TaskEnvelope;
  lifecycleState: "created" | "running" | "closing" | "closed";
  executorSession?: { abort: () => Promise<void>; clearQueue?: () => unknown; steer?: (text: string) => Promise<void> };
  executorStopRequested: boolean;
  checkpointFinalizationActive: boolean;
  controlSignal?: ControlSignal;
  terminationPromise?: Promise<void>;
  terminationFailure?: string;
  epochBudgetClock?: EpochBudgetClock;
  runDeadlineAt?: number;
  lastGraphUpdateSteerAt?: number;
  abortContext?: {
    kind: "budget_abort" | "observer_abort" | "controller_abort";
    reason: string;
    controlSignal?: ControlSignal;
  };
  supervisionState: {
    progressDigest: string;
    lastVerdict?: Pick<ControlSignal, "decision" | "reason" | "guidance">;
    repeatedPatterns: string[];
    negativeFindings: string[];
    recentFingerprints: string[];
    openQuestions: string[];
  };
};

test("normalizes missing planner budget to controller defaults", () => {
  assert.deepEqual(normalizeTaskBudget(), DEFAULT_TASK_BUDGET);
});

test("only completed semantic model turns consume the cumulative task budget", () => {
  const turn = (id: string, stopReason: string, output: number): ExecutionEvent => ({
    id,
    seq: Number(id.split(":").at(-1) ?? 0),
    timestamp: "2026-07-31T00:00:00.000Z",
    epochId: "epoch:test",
    taskId: "task:test",
    role: "executor",
    eventType: "turn_usage",
    payload: { responseId: id, stopReason, usage: { input: 1, output } }
  });

  assert.equal(isCountableExecutorTurn(turn("response:1", "toolUse", 20)), true);
  assert.equal(isCountableExecutorTurn(turn("response:2", "stop", 20)), true);
  assert.equal(isCountableExecutorTurn(turn("response:3", "error", 0)), false);
  assert.equal(isCountableExecutorTurn(turn("response:4", "length", 1)), false);
  assert.equal(isCountableExecutorTurn(turn("response:5", "aborted", 0)), false);
});

test("an exhausted task budget closes a resumed epoch before sandbox or model startup", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ budget: { maxTurns: 8 } });
  for (let index = 1; index <= 8; index += 1) {
    harness.controller.runtimeStore.recordTaskTurn({
      taskId: taskEnvelope.taskId,
      eventId: `response:${index}`
    });
  }

  const result = await (harness.controllerHarness as unknown as {
    runExecutorTask: (
      envelope: TaskEnvelope,
      options: { useDynamicExecutor: boolean }
    ) => Promise<{ taskResult?: TaskResult; epochOutcome: EpochOutcome }>;
  }).runExecutorTask(taskEnvelope, { useDynamicExecutor: false });

  assert.equal(result.taskResult, undefined);
  assert.equal(result.epochOutcome.status, "checkpointed");
  assert.match(result.epochOutcome.reason, /maxTurns=8, usedTurns=8/);
  assert.equal(harness.controller.runtimeStore.getTaskOutcome(taskEnvelope.taskId), undefined);
  await harness.controller.close({ drainProjectionJobs: false });
});

test("Planner cannot reopen an exhausted Task without increasing its cumulative budget", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ taskId: "task:exhausted", budget: { maxTurns: 10 } });
  harness.controller.graphStore.createTask({
    taskId: taskEnvelope.taskId,
    goal: taskEnvelope.goal,
    targetRefs: taskEnvelope.targetRefs,
    scopeRef: taskEnvelope.scopeRef,
    constraints: taskEnvelope.constraints,
    successCriteria: taskEnvelope.successCriteria,
    budget: taskEnvelope.budget,
    priority: 1
  });
  for (let index = 1; index <= 10; index += 1) {
    harness.controller.runtimeStore.recordTaskTurn({
      taskId: taskEnvelope.taskId,
      eventId: `event:consumed:${index}`
    });
  }

  assert.throws(() => harness.controllerHarness.assertPlannerRuntimeTransitions([{
    kind: "set_task_status",
    taskId: taskEnvelope.taskId,
    status: "open",
    basedOnRefs: []
  }]), /cannot reopen with exhausted budget: consumedTurns=10, maxTurns=10/);

  assert.doesNotThrow(() => harness.controllerHarness.assertPlannerRuntimeTransitions([{
    kind: "patch_task",
    taskId: taskEnvelope.taskId,
    patch: { additionalTurns: 10 },
    basedOnRefs: []
  }, {
    kind: "set_task_status",
    taskId: taskEnvelope.taskId,
    status: "open",
    basedOnRefs: []
  }]));
  assert.doesNotThrow(() => harness.controllerHarness.assertPlannerRuntimeTransitions([{
    kind: "patch_task",
    taskId: taskEnvelope.taskId,
    patch: { additionalTurns: 31 },
    basedOnRefs: []
  }]));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("Runtime exclusively derives task constraints from the root Scope", () => {
  const harness = createControllerHarness();
  const envelope = harness.controllerHarness.taskEnvelopeFromSpec({
    id: "task:scope-owned",
    goal: "Resolve one observable uncertainty",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    successCriteria: ["An observable result is persisted"],
    priority: 1
  }, "仅允许测试 10.0.0.8；禁止破坏性操作");

  assert.deepEqual(envelope.constraints, ["授权范围原文：仅允许测试 10.0.0.8；禁止破坏性操作"]);
  harness.controller.close();
});

test("executor graph compaction preserves capability-defining properties by node type", () => {
  const compact = compactExecutorGraphClosure({
    nodes: [
      {
        id: "vuln:file-read",
        graphKind: "reasoning",
        type: "Vulnerability",
        label: "Authenticated arbitrary file read",
        properties: {
          status: "validated",
          affectedEndpoint: "/download.php",
          affectedParameter: "id",
          authenticatedRole: "employee",
          impact: "local file read"
        },
        evidenceRefs: ["event:1"]
      },
      {
        id: "exploit:file-read",
        graphKind: "reasoning",
        type: "Exploit",
        label: "Read system files through traversal",
        properties: {
          sessionRole: "employee",
          readFiles: ["/etc/passwd", "/var/www/html/includes/config.php"],
          nonDestructive: true
        },
        evidenceRefs: ["event:2"]
      }
    ],
    edges: [{ from: "vuln:file-read", to: "exploit:file-read", type: "exploited_by" }]
  }, "reasoning", 12);

  assert.deepEqual(compact.nodes[0]?.properties, {
    status: "validated",
    affectedEndpoint: "/download.php",
    affectedParameter: "id",
    authenticatedRole: "employee",
    impact: "local file read"
  });
  assert.deepEqual(compact.nodes[1]?.properties, {
    sessionRole: "employee",
    readFiles: ["/etc/passwd", "/var/www/html/includes/config.php"],
    nonDestructive: true
  });
});

test("executor graph compaction preserves graph traversal order", () => {
  const compact = compactExecutorGraphClosure({
    nodes: [
      {
        id: "hypothesis:open",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Open branch",
        properties: { status: "open", target: "/include" }
      },
      {
        id: "hypothesis:refuted",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Session-file inclusion",
        properties: {
          status: "refuted",
          target: "/include",
          method: "session file path candidates",
          preconditions: ["unauthenticated", "known include parameter"],
          observedResult: "all controlled probes matched the negative baseline",
          negativeConclusion: "tested session-file candidates do not resolve",
          reopenConditions: "a valid session identifier or changed filesystem mapping is observed"
        },
        evidenceRefs: ["event:negative"]
      }
    ],
    edges: []
  }, "reasoning", 1);

  assert.equal(compact.nodes[0]?.id, "hypothesis:open");
});

test("Supervisor knowledge compaction does not reorder graph semantics", () => {
  const compact = compactSupervisorRelevantKnowledge({
    nodes: [
      ...Array.from({ length: 6 }, (_, index): GraphNode => ({
        id: `vulnerability:${index}`,
        graphKind: "reasoning",
        type: "Vulnerability",
        label: `Confirmed branch ${index}`,
        properties: { status: "confirmed" }
      })),
      {
        id: "evidence:negative-control",
        graphKind: "reasoning",
        type: "Evidence",
        label: "Equivalent negative control",
        properties: {
          target: "/include",
          method: "raw traversal",
          preconditions: ["unauthenticated"],
          observedResult: "candidate and random control returned the same fingerprint",
          oracle: "status, length, and body hash"
        },
        evidenceRefs: ["event:control"]
      },
      {
        id: "hypothesis:raw-traversal",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "Raw traversal reaches the include sink",
        properties: {
          status: "refuted",
          target: "/include",
          method: "raw traversal",
          preconditions: ["unauthenticated"],
          negativeConclusion: "the raw form is not distinguished from the negative control",
          reopenConditions: "a different server-visible transform is observed"
        },
        evidenceRefs: ["event:control"]
      }
    ],
    edges: [{
      from: "evidence:negative-control",
      to: "hypothesis:raw-traversal",
      type: "contradicts",
      evidenceRefs: ["event:control"]
    }]
  }, 1);

  assert.deepEqual(compact.nodes.map((node) => node.id), ["vulnerability:0"]);
  assert.deepEqual(compact.edges, []);
});

test("clamps undersized planner maxTurns to controller minimum", () => {
  assert.equal(normalizeTaskBudget({ maxTurns: 6 }).maxTurns, MIN_TASK_BUDGET.maxTurns);
});

test("preserves cumulative Task allocation above a single allocation chunk", () => {
  assert.deepEqual(normalizeTaskBudget({
    maxTurns: 999
  }), { maxTurns: 999 });
});

test("clamps a newly created Task to one bounded initial allocation chunk", () => {
  const harness = createControllerHarness();
  const envelope = harness.controllerHarness.taskEnvelopeFromSpec({
    id: "task:bounded-initial-allocation",
    goal: "Resolve one observable uncertainty",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    successCriteria: ["An observable result is persisted"],
    priority: 1,
    budget: { maxTurns: 999 }
  }, "仅允许测试 10.0.0.8");

  assert.deepEqual(envelope.budget, MAX_TASK_BUDGET);
  harness.controller.close();
});

test("ignores invalid planner budget values", () => {
  assert.deepEqual(normalizeTaskBudget({
    maxTurns: -1
  }), DEFAULT_TASK_BUDGET);
});

test("wraps legacy pure GraphDelta observer output as continue signal", () => {
  const projection = normalizeObserverProjection({
    sourceEventIds: ["event:1"],
    nodes: [],
    edges: []
  });

  assert.deepEqual(projection.graphDelta.sourceEventIds, ["event:1"]);
  assert.equal(projection.controlSignal.decision, "continue");
  assert.equal(shouldStopExecutorForControlSignal(projection.controlSignal), false);
});

test("normalizes historical checkpoint observer signals to one handoff decision", () => {
  const projection = normalizeObserverProjection({
    graphDelta: {
      sourceEventIds: ["event:2"],
      nodes: [],
      edges: []
    },
    controlSignal: {
      decision: "checkpoint",
      reason: "success criteria reached",
      evidenceRefs: ["event:2"],
      confidence: "high"
    }
  });

  assert.equal(projection.controlSignal.decision, "handoff");
  assert.equal(shouldStopExecutorForControlSignal(projection.controlSignal), false);
});

test("normalizes pure Supervisor ControlSignal output", () => {
  const signal = normalizeSupervisorControlSignal({
    decision: "redirect",
    reason: "change the current strategy",
    evidenceRefs: ["event:5"],
    confidence: "high",
    guidance: "stop repeating the same probe and test the remaining hypothesis"
  }, ["event:fallback"]);

  assert.equal(signal.decision, "redirect");
  assert.deepEqual(signal.evidenceRefs, ["event:5"]);
  assert.equal(signal.guidance, "stop repeating the same probe and test the remaining hypothesis");
  assert.equal(shouldStopExecutorForControlSignal(signal), false);
});

test("continues executor when observer signal is continue", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "continue",
    reason: "no intervention",
    evidenceRefs: []
  });

  await waitForSettled();
  assert.equal(harness.abortCount(), 0);
  harness.controller.close();
});

test("Supervisor handoff advice preserves the full verdict without stopping the Executor", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = harness.controllerHarness.agents.executor;

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "checkpoint",
    reason: "handoff to planner",
    evidenceRefs: ["event:checkpoint"],
    guidance: "preserve the confirmed capability",
    confidence: "high",
    epochRef: state.epochId,
    throughSeq: 42
  } as ControlSignal, state);

  await waitFor(() => harness.steers().some((message) => message.includes("SUPERVISOR_HANDOFF_RECOMMENDATION")));
  const steer = harness.steers()[0] ?? "";
  assert.match(steer, /"decision": "checkpoint"/);
  assert.match(steer, /"reason": "handoff to planner"/);
  assert.match(steer, /"evidenceRefs": \[/);
  assert.match(steer, /"guidance": "preserve the confirmed capability"/);
  assert.doesNotMatch(steer, /"confidence"/);
  assert.match(steer, new RegExp(state.epochId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(steer, /"throughSeq": 42/);
  assert.equal(harness.abortCount(), 0);
  assert.equal(state.lifecycleState, "running");
  assert.equal(state.executorStopRequested, false);
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "supervisor_handoff_recommended" && event.payload.delivery === "steer"
  ));
  harness.controller.close();
});

test("Executor action supersedes Supervisor handoff advice without terminating the epoch", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = harness.controllerHarness.agents.executor;

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "need_planner",
    reason: "handoff to planner",
    evidenceRefs: ["event:checkpoint"],
    confidence: "high",
    epochRef: state.epochId,
    throughSeq: 10
  } as ControlSignal, state);
  await waitFor(() => harness.steers().length === 1);

  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "assistant_intent",
    { text: "Continue the current causal experiment", toolCalls: [{ name: "bash" }] },
    "event:continued"
  ));

  assert.equal(harness.abortCount(), 0);
  assert.equal(state.lifecycleState, "running");
  assert.equal(state.executorStopRequested, false);
  assert.equal(state.supervisionState.lastVerdict, undefined);
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "supervisor_handoff_superseded"
  ));
  harness.controller.close();
});

test("task_result_submit accepts Supervisor handoff advice without forced termination", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = harness.controllerHarness.agents.executor;

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "need_planner",
    reason: "return the evidence to Planner",
    evidenceRefs: ["event:checkpoint"],
    confidence: "high",
    epochRef: state.epochId,
    throughSeq: 10
  } as ControlSignal, state);
  await waitFor(() => harness.steers().length === 1);

  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "assistant_intent",
    { toolCalls: [{ name: "task_result_submit" }] },
    "event:submit"
  ));

  assert.equal(harness.abortCount(), 0);
  assert.equal(state.lifecycleState, "running");
  assert.equal(state.executorStopRequested, false);
  assert.equal((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "supervisor_handoff_superseded"
  ), false);
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "executor_submitted");
  assert.equal(state.lifecycleState, "closed");
  harness.controller.close();
});

test("late control signal from a closed epoch cannot abort the next epoch", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  let oldAbortCount = 0;
  let newAbortCount = 0;
  const oldState = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  oldState.executorSession = { async abort() { oldAbortCount += 1; } };
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
  const newState = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  newState.executorSession = { async abort() { newAbortCount += 1; } };

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "checkpoint",
    reason: "late old epoch signal",
    evidenceRefs: ["event:old"]
  }, oldState);

  await waitForSettled();
  assert.equal(oldAbortCount, 0);
  assert.equal(newAbortCount, 0);
  assert.equal(newState.lifecycleState, "running");
  assert.ok((await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "stale_callback_discarded"));
  harness.controller.close();
});

test("same task rebuilds Supervisor state across resumed epochs", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({
    successCriteria: ["confirm authenticated access"]
  });
  const firstState = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  firstState.supervisionState.progressDigest = "Authenticated session confirmed";
  firstState.supervisionState.repeatedPatterns.push("GET /login -> 302");
  firstState.supervisionState.negativeFindings.push("Default credentials rejected");
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");

  const resumedState = harness.controllerHarness.beginTaskExecution(taskEnvelope);

  assert.equal(resumedState.supervisionState.progressDigest, "Authenticated session confirmed");
  assert.deepEqual(resumedState.supervisionState.repeatedPatterns, ["GET /login -> 302"]);
  assert.deepEqual(resumedState.supervisionState.negativeFindings, ["Default credentials rejected"]);
  assert.deepEqual(resumedState.supervisionState.openQuestions, ["成功条件：confirm authenticated access"]);
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "executor_submitted");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("Supervisor state is reconstructed from the persisted Task outcome", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ taskId: "task:persisted-resume" });
  harness.controller.graphStore.createTask({
    ...taskEnvelope,
    priority: 1
  });
  harness.controller.graphStore.markTaskStatus({
    taskId: taskEnvelope.taskId,
    status: "open"
  });
  harness.controller.runtimeStore.upsertTaskOutcome({
    taskRef: taskEnvelope.taskId,
    epochRef: "epoch:persisted-resume",
    status: "partial",
    summary: "Confirmed reusable authenticated session",
    evidenceRefs: [],
    artifactRefs: [],
    capabilityRefs: [],
    checkpoint: { reason: "Planner should choose the next goal-level step" },
    terminalSeq: 1,
    createdAt: new Date(0).toISOString()
  });

  const resumedState = harness.controllerHarness.beginTaskExecution(taskEnvelope);

  assert.match(resumedState.supervisionState.progressDigest, /Confirmed reusable authenticated session/);
  assert.deepEqual(resumedState.supervisionState.negativeFindings, [
    "Planner should choose the next goal-level step"
  ]);
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "executor_submitted");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("requestStop aborts active epoch and records an interrupt before shutdown", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  let abortCount = 0;
  state.executorSession = { async abort() { abortCount += 1; } };

  await harness.controller.requestStop("Received SIGTERM");
  await waitForSettled();

  assert.equal(abortCount, 1);
  assert.equal(state.executorStopRequested, true);
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "run_interrupted" && event.summary === "Received SIGTERM"
  ));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("requestStop clears queued steers before aborting the executor", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  const calls: string[] = [];
  state.executorSession = {
    clearQueue() { calls.push("clearQueue"); },
    async abort() { calls.push("abort"); }
  };

  await harness.controller.requestStop("Received SIGTERM");
  await waitForSettled();

  assert.deepEqual(calls, ["clearQueue", "abort"]);
  await harness.controller.close({ drainProjectionJobs: false });
});

test("requestStop remains a hard boundary after advisory checkpoint", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  const calls: string[] = [];
  state.executorSession = {
    async steer() { calls.push("steer"); },
    clearQueue() { calls.push("clearQueue"); },
    async abort() { calls.push("abort"); }
  };

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "checkpoint",
    reason: "handoff to planner",
    evidenceRefs: ["event:checkpoint"]
  }, state);
  await waitFor(() => calls.includes("steer"));

  await harness.controller.requestStop("Received SIGTERM");

  assert.deepEqual(calls, ["steer", "clearQueue", "abort"]);
  assert.equal(state.executorStopRequested, true);
  await harness.controller.close({ drainProjectionJobs: false });
});

test("requestStop immediately aborts active Projector work", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    nodes: [],
    edges: []
  }));
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);
  const projectorRelease = createDeferred<void>();
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    await projectorRelease.promise;
    return JSON.stringify({
      nodes: [],
      edges: []
    });
  });
  projectorSession.abort = async () => {
    projectorRelease.resolve();
  };
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });
  const sourceEvent = await persistExecutorEvent(
    harness.controller,
    taskEnvelope.taskId,
    "task_partial",
    "task end"
  );

  void harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id]
  });
  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "projection_job_started"));

  await harness.controller.requestStop("Received SIGTERM");
  const projectionEvents = (await harness.controller.executionLog.readAll()).filter((event) =>
    event.eventType.startsWith("projection_job_"));
  assert.ok(projectionEvents.some((event) =>
    event.eventType === "projection_job_discarded"
    || event.eventType === "projection_job_failed"
    || event.eventType === "projection_job_succeeded"
  ));
  const startedAttemptRef = projectionEvents.find((event) => event.eventType === "projection_job_started")
    ?.payload.attemptRef;
  const terminalAttempts = projectionEvents.filter((event) => [
    "projection_job_discarded",
    "projection_job_failed",
    "projection_job_succeeded"
  ].includes(event.eventType));
  assert.ok(terminalAttempts.length >= 1);
  const terminalCountByAttempt = new Map<string, number>();
  for (const terminal of terminalAttempts) {
    const attemptRef = String(terminal.payload.attemptRef ?? "");
    assert.ok(attemptRef.length > 0);
    terminalCountByAttempt.set(attemptRef, (terminalCountByAttempt.get(attemptRef) ?? 0) + 1);
  }
  assert.equal(terminalCountByAttempt.get(String(startedAttemptRef)), 1);
  assert.ok([...terminalCountByAttempt.values()].every((count) => count === 1));

  let closeResolved = false;
  const closePromise = harness.controller.close({ projectionDrainTimeoutMs: 1_000 })
    .then(() => {
      closeResolved = true;
    });
  await waitFor(() => closeResolved);
  assert.equal(closeResolved, true);

  await closePromise;
  assert.equal(closeResolved, true);
});

test("stop_executor control signal clears queued steers before aborting the executor", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  const calls: string[] = [];
  state.executorSession = {
    clearQueue() { calls.push("clearQueue"); },
    async abort() { calls.push("abort"); }
  };

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "stop_executor",
    reason: "supervisor stop",
    evidenceRefs: ["event:stop"]
  }, state);
  await waitForSettled();

  assert.deepEqual(calls, ["clearQueue", "abort"]);
  await harness.controller.close({ drainProjectionJobs: false });
});

test("stop_executor terminates even when the audit append fails", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  const calls: string[] = [];
  state.executorSession = {
    clearQueue() { calls.push("clearQueue"); },
    async abort() { calls.push("abort"); }
  };
  const executionLogHarness = harness.controller.executionLog as unknown as {
    append: typeof harness.controller.executionLog.append;
  };
  const originalAppend = executionLogHarness.append;
  let appendAttempted = false;
  executionLogHarness.append = async () => {
    appendAttempted = true;
    throw new Error("audit unavailable");
  };

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "stop_executor",
    reason: "supervisor stop",
    evidenceRefs: ["event:stop"]
  }, state);

  assert.deepEqual(calls, ["clearQueue", "abort"]);
  assert.ok(state.terminationPromise);
  await state.terminationPromise;
  await waitFor(() => appendAttempted);
  assert.equal(state.executorStopRequested, true);

  executionLogHarness.append = originalAppend;
  await harness.controller.close({ drainProjectionJobs: false });
});

test("executor termination command failures are persisted and block later steers", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  let steerCount = 0;
  state.executorSession = {
    clearQueue() { throw new Error("clear failed"); },
    async abort() { throw new Error("abort failed"); },
    async steer() { steerCount += 1; }
  };

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "stop_executor",
    reason: "supervisor stop",
    evidenceRefs: ["event:stop"]
  }, state);
  await state.terminationPromise;

  assert.equal(state.lifecycleState, "closing");
  assert.equal(state.executorStopRequested, true);
  assert.match(state.terminationFailure ?? "", /Failed to terminate executor epoch/);
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "executor_termination_failed"
      && event.epochId === state.epochId
      && event.payload.errorType === "AggregateError"
  ));

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "redirect",
    reason: "late redirect",
    guidance: "continue probing",
    evidenceRefs: ["event:late"]
  }, state);
  await waitForSettled();
  assert.equal(steerCount, 0);

  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "supervisor_checkpoint");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("checkpoint without steer support remains advisory and does not terminate", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  const calls: string[] = [];
  state.executorSession = {
    clearQueue() { calls.push("clearQueue"); },
    async abort() { calls.push("abort"); }
  };

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "checkpoint",
    reason: "budget exhausted",
    evidenceRefs: ["event:budget"]
  }, state);
  await waitForSettled();

  assert.deepEqual(calls, []);
  assert.equal(state.lifecycleState, "running");
  assert.equal(state.executorStopRequested, false);
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "supervisor_handoff_recommended" && event.payload.delivery === "none"
  ));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("budget checkpoint finalization accepts completed and restores the Executor tool set", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorStopRequested = true;
  const checkpointSignal: ControlSignal = { decision: "handoff", reason: "budget reached", evidenceRefs: [] };
  state.abortContext = {
    kind: "budget_abort",
    reason: checkpointSignal.reason,
    controlSignal: checkpointSignal
  };
  const finalizerSession = createCheckpointSubmissionSession({
    taskId: taskEnvelope.taskId,
    status: "completed",
    summary: "The Executor verified every task success criterion before the budget boundary.",
    evidenceRefs: [],
    artifactRefs: []
  });
  const semanticResult = await harness.controllerHarness.collectBudgetCheckpointTaskResult({
    taskEnvelope,
    state,
    executorSession: {
      session: finalizerSession,
      dynamicExecutor: true,
      resumed: false,
      resumeCount: 0
    }
  });

  assert.equal(semanticResult?.status, "completed");
  assert.equal(semanticResult?.retryable, undefined);
  assert.equal(semanticResult?.checkpointReason, undefined);
  assert.deepEqual(finalizerSession.getActiveToolNames(), ["bash", "read", "artifact_write", "task_result_submit"]);
  assert.deepEqual(finalizerSession.activeToolHistory(), [
    ["task_result_submit"],
    ["bash", "read", "artifact_write", "task_result_submit"]
  ]);
  assert.match(finalizerSession.prompts()[0] ?? "", /artifact_write/);
  assert.match(finalizerSession.prompts()[0] ?? "", /不得调用 bash/);
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "executor_checkpoint_submitted"
      && event.payload.taskResultStatus === "completed"
  ));
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("completed checkpoint result with unresolved lifecycle fields is normalized to partial", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorStopRequested = true;
  state.abortContext = {
    kind: "budget_abort",
    reason: "Task budget reached: maxTurns=12",
    controlSignal: { decision: "handoff", reason: "Task budget reached: maxTurns=12", evidenceRefs: [] }
  };
  const finalizerSession = createCheckpointSubmissionSession({
    taskId: taskEnvelope.taskId,
    status: "completed",
    summary: "The result still reports an unresolved boundary.",
    evidenceRefs: [],
    artifactRefs: [],
    blockerReason: "The final target condition remains unverified.",
    checkpointReason: "Continue from the saved state.",
    retryable: true
  });

  const semanticResult = await harness.controllerHarness.collectBudgetCheckpointTaskResult({
    taskEnvelope,
    state,
    executorSession: {
      session: finalizerSession,
      dynamicExecutor: true,
      resumed: false,
      resumeCount: 0
    }
  });

  assert.equal(semanticResult?.status, "partial");
  assert.equal(semanticResult?.blockerReason, "The final target condition remains unverified.");
  assert.equal(semanticResult?.checkpointReason, "Task budget reached: maxTurns=12");
  assert.equal(semanticResult?.retryable, true);
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("checkpoint finalization keeps artifact_write available for multiple existing files", async () => {
  const harness = createControllerHarness();
  const workspaceDir = mkdtempSync(join(tmpdir(), "luanniao-checkpoint-workspace-"));
  writeFileSync(join(workspaceDir, "poc.py"), "print('verified')\n");
  writeFileSync(join(workspaceDir, "evidence.json"), "{}\n");
  harness.controllerHarness.executorSandbox = { workspaceDir };
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorStopRequested = true;
  state.abortContext = {
    kind: "budget_abort",
    reason: "Task budget reached: maxTurns=12",
    controlSignal: { decision: "handoff", reason: "Task budget reached: maxTurns=12", evidenceRefs: [] }
  };
  const finalizerSession = createCheckpointArtifactThenResultSession({
    taskId: taskEnvelope.taskId,
    status: "partial",
    summary: "Archived the reusable result and submitted the semantic checkpoint.",
    evidenceRefs: [],
    artifactRefs: ["artifact:checkpoint"]
  });

  const semanticResult = await harness.controllerHarness.collectBudgetCheckpointTaskResult({
    taskEnvelope,
    state,
    executorSession: {
      session: finalizerSession,
      dynamicExecutor: true,
      resumed: false,
      resumeCount: 0
    }
  });

  assert.equal(semanticResult?.status, "partial");
  assert.deepEqual(finalizerSession.activeToolHistory(), [
    ["artifact_write", "task_result_submit"],
    ["bash", "read", "artifact_write", "task_result_submit"]
  ]);
  assert.match(finalizerSession.prompts()[0] ?? "", /可连续归档多个文件/);
  assert.match(finalizerSession.prompts()[0] ?? "", /poc\.py/);
  assert.match(finalizerSession.prompts()[0] ?? "", /evidence\.json/);
  assert.match(finalizerSession.prompts()[0] ?? "", /不要为结论临时虚构或创建总结文件/);
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("partial checkpoint gets runtime metadata while only its finalization turn is excluded", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ budget: { maxTurns: 10 } });
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorStopRequested = true;
  state.abortContext = {
    kind: "budget_abort",
    reason: "Task budget reached: maxTurns=10",
    controlSignal: { decision: "handoff", reason: "Task budget reached: maxTurns=10", evidenceRefs: [] }
  };
  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "turn_usage",
    { responseId: "response:late-exploration", stopReason: "stop", usage: { input: 1, output: 1 } },
    "event:late-exploration"
  ));
  const finalizerSession = createCheckpointSubmissionSession({
    taskId: taskEnvelope.taskId,
    status: "partial",
    summary: "A verified intermediate capability remains reusable.",
    evidenceRefs: [],
    artifactRefs: [],
    checkpointReason: "model supplied reason must not become the runtime boundary",
    retryable: false
  }, async () => {
    await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
      taskEnvelope.taskId,
      "turn_usage",
      { responseId: "response:finalization", stopReason: "toolUse", usage: { input: 1, output: 1 } },
      "event:finalization"
    ));
  });

  const semanticResult = await harness.controllerHarness.collectBudgetCheckpointTaskResult({
    taskEnvelope,
    state,
    executorSession: {
      session: finalizerSession,
      dynamicExecutor: true,
      resumed: false,
      resumeCount: 0
    }
  });

  assert.equal(semanticResult?.status, "partial");
  assert.equal(semanticResult?.retryable, true);
  assert.equal(semanticResult?.checkpointReason, "Task budget reached: maxTurns=10");
  assert.equal(harness.controller.runtimeStore.getTaskConsumedTurns(taskEnvelope.taskId), 1);
  assert.equal(state.checkpointFinalizationActive, false);
  assert.deepEqual(finalizerSession.getActiveToolNames(), ["bash", "read", "artifact_write", "task_result_submit"]);
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("checkpoint finalization provider failure leaves only the mechanical EpochOutcome", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorStopRequested = true;
  state.abortContext = {
    kind: "budget_abort",
    reason: "Task budget reached: maxTurns=12",
    controlSignal: { decision: "handoff", reason: "Task budget reached: maxTurns=12", evidenceRefs: [] }
  };
  const finalizerSession = createCheckpointSubmissionSession({
    taskId: taskEnvelope.taskId,
    status: "partial",
    summary: "This result is never submitted because the provider fails first.",
    evidenceRefs: [],
    artifactRefs: []
  }, () => {
    throw new Error("provider unavailable during checkpoint finalization");
  });

  const semanticResult = await harness.controllerHarness.collectBudgetCheckpointTaskResult({
    taskEnvelope,
    state,
    executorSession: {
      session: finalizerSession,
      dynamicExecutor: true,
      resumed: false,
      resumeCount: 0
    }
  });
  const { outcome } = await harness.controllerHarness.persistEpochOutcome(state, {
    status: "checkpointed",
    reason: state.abortContext.reason,
    retryable: true,
    taskOutcomeRef: undefined
  });

  assert.equal(semanticResult, undefined);
  assert.equal(outcome.status, "checkpointed");
  assert.equal(harness.controller.runtimeStore.getTaskOutcome(taskEnvelope.taskId), undefined);
  assert.deepEqual(finalizerSession.getActiveToolNames(), ["bash", "read", "artifact_write", "task_result_submit"]);
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "executor_checkpoint_finalization_failed"
      && String(event.summary).includes("provider unavailable")
  ));
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("checkpoint finalization uses the remaining global run deadline instead of a fixed semantic timeout", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorStopRequested = true;
  state.abortContext = {
    kind: "budget_abort",
    reason: "Task budget reached: maxTurns=12",
    controlSignal: { decision: "handoff", reason: "Task budget reached: maxTurns=12", evidenceRefs: [] }
  };
  harness.controllerHarness.activeRun = {
    invocationId: "run:checkpoint-deadline",
    startedAt: Date.now(),
    maxRunTimeMs: 30,
    deadlineAt: Date.now() + 30,
    startSeq: 0
  };
  const pendingPrompt = createDeferred<void>();
  const finalizerSession = createCheckpointSubmissionSession({
    taskId: taskEnvelope.taskId,
    status: "partial",
    summary: "The global deadline prevents this result from being submitted.",
    evidenceRefs: [],
    artifactRefs: []
  }, () => pendingPrompt.promise);
  let abortCount = 0;
  finalizerSession.abort = async () => {
    abortCount += 1;
    pendingPrompt.reject(new Error("global run deadline reached"));
  };

  const semanticResult = await harness.controllerHarness.collectBudgetCheckpointTaskResult({
    taskEnvelope,
    state,
    executorSession: {
      session: finalizerSession,
      dynamicExecutor: true,
      resumed: false,
      resumeCount: 0
    }
  });

  assert.equal(semanticResult, undefined);
  assert.ok(abortCount >= 1);
  assert.equal(harness.controller.runtimeStore.getTaskOutcome(taskEnvelope.taskId), undefined);
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "global_deadline");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("Supervisor handoff advice is not persisted as either result layer", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.controlSignal = {
    decision: "handoff",
    reason: "success conditions are not met",
    evidenceRefs: ["event:stale"]
  };

  assert.equal(harness.controller.runtimeStore.getTaskOutcome(taskEnvelope.taskId), undefined);
  assert.equal(harness.controller.runtimeStore.getEpochOutcome(state.epochId), undefined);
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "supervisor_handoff");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("runtime grounds evidence but keeps incidental observation artifacts out of TaskOutcome", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  const artifact = await harness.controller.artifactStore.write({
    taskId: taskEnvelope.taskId,
    kind: "http_body",
    mediaType: "text/plain",
    data: "confirmed sensitive response"
  });
  const intent = await harness.controller.executionLog.append({
    epochId: state.epochId,
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "Validate the confirmed file-read capability",
    payload: { text: "Validate the confirmed file-read capability" }
  });
  const started = await harness.controller.executionLog.append({
    epochId: state.epochId,
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_started",
    summary: "tool_started:bash",
    payload: { toolCallId: "call:read", toolName: "bash", args: { command: "read candidate" } }
  });
  const finished = await harness.controller.executionLog.append({
    epochId: state.epochId,
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "tool_finished:bash:ok",
    payload: {
      toolCallId: "call:read",
      toolName: "bash",
      result: { content: [{ type: "text", text: "confirmed sensitive response" }] }
    },
    artifactRefs: [artifact.artifactRef]
  });
  (harness.controller as unknown as { connectivityRuntime?: { capabilityRefsForTask(taskId: string): string[] } }).connectivityRuntime = {
    capabilityRefsForTask: (taskId) => taskId === taskEnvelope.taskId
      ? ["route:task-route", "connection:task-connection"]
      : []
  };

  const enriched = await harness.controllerHarness.enrichTaskResultLifecycle({
    taskId: taskEnvelope.taskId,
    status: "partial",
    summary: "Checkpoint",
    evidenceRefs: [intent.id],
    artifactRefs: [],
    retryable: true
  }, taskEnvelope, state);

  assert.ok(!enriched.evidenceRefs.includes(intent.id));
  assert.ok(enriched.evidenceRefs.includes(started.id));
  assert.ok(enriched.evidenceRefs.includes(finished.id));
  assert.deepEqual(enriched.artifactRefs, []);
  assert.deepEqual(enriched.capabilityRefs, ["route:task-route", "connection:task-connection"]);
  delete (harness.controller as unknown as { connectivityRuntime?: unknown }).connectivityRuntime;
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "executor_submitted");
  harness.controller.close();
});

test("does not let Supervisor extend the runtime-owned turn budget", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    decision: "continue",
    reason: "recent execution is still making high-value progress",
    evidenceRefs: ["event:turn_end"],
    confidence: "high",
    budgetExtension: {
      maxTurnsDelta: 4,
      reason: "finish the current promising epoch instead of checkpointing"
    }
  }));
  const taskEnvelope = makeTaskEnvelope({ budget: { maxTurns: MIN_TASK_BUDGET.maxTurns } });
  activateTask(harness.controllerHarness, taskEnvelope);

  for (let index = 0; index < MIN_TASK_BUDGET.maxTurns; index += 1) {
    harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
      taskEnvelope.taskId,
      "turn_end",
      {},
      `event:turn:${index}`
    ));
  }

  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "executor_checkpoint_requested"));
  assert.equal(taskEnvelope.budget?.maxTurns, MIN_TASK_BUDGET.maxTurns);
  assert.equal((await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "budget_extension_granted"), false);
  harness.controller.close();
});

test("forces checkpoint when maxTurns budget is reached", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ budget: { maxTurns: MIN_TASK_BUDGET.maxTurns } });
  activateTask(harness.controllerHarness, taskEnvelope);

  for (let index = 0; index < MIN_TASK_BUDGET.maxTurns; index += 1) {
    harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
      taskEnvelope.taskId,
      "turn_end",
      {},
      `event:turn:${index}`
    ));
  }

  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "executor_checkpoint_requested"));
  await waitFor(() => harness.abortCount() === 1);
  assert.equal(harness.abortCount(), 1);
  assert.equal(harness.observerPromptCount(), 1);
  assert.equal(harness.steers().some((message) => message.includes(
    `Task budget reached: maxTurns=${MIN_TASK_BUDGET.maxTurns}`
  )), false);
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "executor_checkpoint_requested"
      && event.summary === `Task budget reached: maxTurns=${MIN_TASK_BUDGET.maxTurns}`
      && event.payload.delivery === "abort"
  ));
  harness.controller.close();
});

test("steers runtime budget status near turn limit", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: MIN_TASK_BUDGET.maxTurns } });
  activateTask(harness.controllerHarness, taskEnvelope);

  for (let index = 0; index < MIN_TASK_BUDGET.maxTurns - 1; index += 1) {
    harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
      taskEnvelope.taskId,
      "turn_end",
      {},
      `event:turn:${index}`
    ));
  }

  await waitFor(async () => harness.steers().length >= 2);
  const lastSteer = harness.steers().at(-1) ?? "";
  assert.match(lastSteer, /RUNTIME_BUDGET_STATUS_UPDATE/);
  assert.match(lastSteer, /remaining: 1/);
  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "budget_status_updated" && event.payload.delivery === "steer"));
  const statusEvent = (await harness.controller.executionLog.readAll())
    .find((event) => event.eventType === "budget_status_updated" && event.payload.delivery === "steer");
  assert.equal(statusEvent?.payload.delivery, "steer");
  harness.controller.close();
});

test("epoch turn slice checkpoints before a larger cumulative Task allocation is exhausted", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({
    budget: { maxTurns: MAX_TASK_BUDGET.maxTurns },
    constraints: ["授权范围原文：仅允许测试 10.0.0.8", "禁止 JWT kid 遍历", "禁止爆破内网服务"]
  });
  const state = activateTask(harness.controllerHarness, taskEnvelope);
  for (let index = 0; index < DEFAULT_EPOCH_TURN_SLICE; index += 1) {
      harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
        taskEnvelope.taskId,
        "turn_end",
        {},
        `event:turn:${index}`
      ));
  }
  const budgetSteers = () => harness.steers().filter((message) => message.includes("RUNTIME_BUDGET_STATUS_UPDATE"));
  await waitFor(() => harness.abortCount() === 1);
  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "executor_checkpoint_requested"));
  const events = await harness.controller.executionLog.readAll();
  assert.equal(harness.controller.runtimeStore.getTaskConsumedTurns(taskEnvelope.taskId), DEFAULT_EPOCH_TURN_SLICE);
  assert.ok(events.some((event) => event.eventType === "executor_checkpoint_requested"
    && event.summary === `Epoch turn slice reached: maxTurns=${DEFAULT_EPOCH_TURN_SLICE}`));
  assert.equal(state.abortContext?.kind, "budget_abort");
  assert.ok(DEFAULT_EPOCH_TURN_SLICE < MAX_TASK_BUDGET.maxTurns);
  const steer = budgetSteers().at(-1) ?? "";
  assert.ok(steer.includes("禁止 JWT kid 遍历"), "steer carries planner bans verbatim");
  assert.ok(steer.includes("禁止爆破内网服务"));
  assert.ok(steer.includes("授权范围原文：仅允许测试 10.0.0.8"), "scope statement stays first");
  harness.controller.close();
});

test("does not steer budget status after executor stop is requested", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: MIN_TASK_BUDGET.maxTurns } });
  activateTask(harness.controllerHarness, taskEnvelope);

  harness.controllerHarness.applyControlSignal(taskEnvelope, {
    decision: "stop_executor",
    reason: "handoff to planner",
    evidenceRefs: ["event:checkpoint"],
    confidence: "high"
  });
  await waitFor(async () => harness.abortCount() === 1);

  for (let index = 0; index < 5; index += 1) {
    harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
      taskEnvelope.taskId,
      "turn_end",
      {},
      `event:post-stop-turn:${index}`
    ));
  }

  await waitForSettled();
  assert.equal(harness.steers().length, 0);
  assert.equal((await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "budget_status_updated" && event.payload.delivery === "steer"), false);
  harness.controller.close();
});

test("epoch run-time slice remains a hard checkpoint boundary", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET } });
  activateTask(harness.controllerHarness, taskEnvelope);
  harness.controllerHarness.activeRun = {
    invocationId: "run:test",
    startedAt: Date.now(),
    maxRunTimeMs: 2,
    deadlineAt: Date.now() + 2,
    startSeq: 0
  };

  harness.controllerHarness.armEpochTimeSlice(taskEnvelope);

  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "executor_checkpoint_requested"));
  await waitFor(() => harness.abortCount() === 1);
  harness.controllerHarness.clearEpochTimeSlice();
  harness.controller.close();
});

test("supervisor checkpoint signal recommends handoff from turn window", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    decision: "checkpoint",
    reason: "stable progress should return to planner",
    evidenceRefs: ["event:tool_execution_end"],
    confidence: "high"
  }));
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET } });
  activateTask(harness.controllerHarness, taskEnvelope);

  for (let index = 0; index < 8; index += 1) {
    harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
      taskEnvelope.taskId,
      "turn_usage",
      {},
      `event:turn:${index}`
    ));
  }

  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "supervisor_handoff_recommended"));
  const eventTypes = (await harness.controller.executionLog.readAll()).map((event) => event.eventType);
  assert.ok(eventTypes.includes("supervisor_check_started"));
  assert.ok(eventTypes.includes("supervisor_check_succeeded"));
  assert.ok((await harness.controller.executionLog.readAll()).some((event) =>
    event.eventType === "supervisor_handoff_recommended" && event.payload.delivery === "steer"
  ));
  harness.controller.close();
});

test("supervisor prompt uses natural-language execution state", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    decision: "continue",
    reason: "no intervention",
    evidenceRefs: [],
    confidence: "low"
  }));
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET } });
  activateTask(harness.controllerHarness, taskEnvelope);
  await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "assistant tool call",
    payload: {
      text: "基线为有效开发者会话；只改变 kid；以身份变化作为判定信号。",
      toolCalls: [{
        type: "toolCall",
        name: "bash",
        arguments: { command: "ls .agent-runtime" }
      }]
    }
  });
  await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_started",
    summary: "bash:start",
    payload: {
      toolCallId: "call:kid",
      toolName: "bash",
      args: { command: "ls .agent-runtime" }
    }
  });
  await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "bash:ok",
    payload: {
      toolCallId: "call:kid",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "artifactRef=artifact:large-output preview=..." }]
      }
    }
  });
  await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "interpret result",
    payload: { text: "该调用只确认本地工作区访问，未形成目标侧安全结论。" }
  });

  await harness.controllerHarness.runSupervisorCheck({
    reason: "turn_window:8",
    taskEnvelope,
    sourceEventIds: ["event:source"]
  });

  const prompt = harness.observerPrompts()[0];
  assert.match(prompt, /SUPERVISION_STATE:/);
  assert.match(prompt, /时间预算：全局剩余/);
  assert.match(prompt, /当前 Epoch 剩余/);
  assert.match(prompt, /最近执行轨迹：/);
  assert.match(prompt, /"toolName":"bash"/);
  assert.match(prompt, /基线为有效开发者会话/);
  assert.match(prompt, /本地工作区漂移：是/);
  assert.doesNotMatch(prompt, /RECENT_COMPACT_EVENTS|TASK_ENVELOPE|BUDGET_STATE|TASK_STATUS|ARTIFACT_MANIFEST|CURRENT_GRAPH_SLICE/);
  assert.doesNotMatch(prompt, /\.\.\.\[truncated:/);
  harness.controller.close();
});

test("supervisor does not treat distinct script output as semantic progress", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    decision: "checkpoint",
    reason: "the current input-binding experiments have no trustworthy dynamic oracle",
    evidenceRefs: [],
    confidence: "high"
  }));
  const taskEnvelope = makeTaskEnvelope({
    goal: "Determine whether a special form field reaches the evaluation branch",
    successCriteria: ["prove branch reachability", "prove input binding"]
  });
  activateTask(harness.controllerHarness, taskEnvelope);

  const firstIntent = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "test dotted field",
    payload: {
      text: "输入绑定层探索；只改字段名，以页面出现‘拦截’作为信号。"
    }
  });
  await harness.controllerHarness.handleExecutorEventPersisted(firstIntent);
  const firstStarted = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_started",
    summary: "bash:start",
    payload: { toolCallId: "call:dot", toolName: "bash", args: { command: "probe dot" } }
  });
  await harness.controllerHarness.handleExecutorEventPersisted(firstStarted);
  const firstResult = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "bash:ok",
    payload: {
      toolCallId: "call:dot",
      toolName: "bash",
      result: { content: [{ type: "text", text: "case=dot hash=abc output=placeholder static=拦截" }] }
    }
  });
  await harness.controllerHarness.handleExecutorEventPersisted(firstResult);
  const secondIntent = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "test underscore field",
    payload: { text: "点号字段与基线无动态差异，改测下划线字段。" }
  });
  await harness.controllerHarness.handleExecutorEventPersisted(secondIntent);
  const secondStarted = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_started",
    summary: "bash:start",
    payload: { toolCallId: "call:underscore", toolName: "bash", args: { command: "probe underscore" } }
  });
  await harness.controllerHarness.handleExecutorEventPersisted(secondStarted);
  const secondResult = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "bash:ok",
    payload: {
      toolCallId: "call:underscore",
      toolName: "bash",
      result: { content: [{ type: "text", text: "case=underscore hash=abc output=placeholder static=拦截" }] }
    }
  });
  await harness.controllerHarness.handleExecutorEventPersisted(secondResult);
  const finalInterpretation = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "inconclusive oracle",
    payload: { text: "两种字段的动态区域和响应哈希相同，当前判定信号不可信。" }
  });
  await harness.controllerHarness.handleExecutorEventPersisted(finalInterpretation);

  const signal = await harness.controllerHarness.runSupervisorCheck({
    reason: "turn_window:8",
    taskEnvelope,
    sourceEventIds: [secondResult.id]
  });

  const prompt = harness.observerPrompts()[0] ?? "";
  assert.equal(signal.decision, "handoff");
  assert.match(prompt, /hash=abc output=placeholder static=拦截/);
  assert.match(prompt, /"executorCommentary":"两种字段的动态区域和响应哈希相同，当前判定信号不可信/);
  assert.doesNotMatch(prompt, /lastProgressReason|new_result:/);
  harness.controller.close();
});

test("supervisor context contains only the latest eight executor turns", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    decision: "continue",
    reason: "no intervention",
    evidenceRefs: [],
    confidence: "low"
  }));
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: 20 } });
  activateTask(harness.controllerHarness, taskEnvelope);
  for (let index = 0; index < 10; index += 1) {
    await harness.controller.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "executor",
      eventType: "assistant_intent",
      summary: `turn-${index}-intent`,
      payload: { text: `turn-${index}-intent` }
    });
    await harness.controller.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "executor",
      eventType: "tool_started",
      summary: "tool_started:bash",
      payload: {
        toolCallId: `call:turn:${index}`,
        toolName: "bash",
        args: { command: `turn-${index}-command` }
      }
    });
    await harness.controller.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "executor",
      eventType: "tool_finished",
      summary: "tool_finished:bash:ok",
      payload: {
        toolCallId: `call:turn:${index}`,
        toolName: "bash",
        result: { content: [{ type: "text", text: `turn-${index}-result` }] }
      }
    });
    await harness.controller.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "executor",
      eventType: "turn_usage",
      summary: "turn_usage",
      payload: {}
    });
  }

  await harness.controllerHarness.runSupervisorCheck({
    reason: "turn_window:8",
    taskEnvelope,
    sourceEventIds: ["event:source"]
  });

  const prompt = harness.observerPrompts()[0] ?? "";
  assert.doesNotMatch(prompt, /turn-0-|turn-1-/);
  assert.match(prompt, /turn-2-intent/);
  assert.match(prompt, /turn-9-result/);
  assert.doesNotMatch(prompt, /\.\.\.\[truncated:/);
  harness.controller.close();
});

test("supervisor reads one immutable event snapshot and returns only refs from that snapshot", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    decision: "redirect",
    reason: "inspect the distinguishing result",
    guidance: "confirm the successful branch",
    evidenceRefs: ["event:outside-snapshot"]
  }));
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);
  await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "compare traversal depth",
    payload: {
      text: "compare traversal depth",
      toolCalls: [{ name: "bash", arguments: { command: "probe traversal variants" } }]
    }
  });
  const started = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_started",
    summary: "tool_started:bash",
    payload: {
      toolCallId: "call:traversal",
      toolName: "bash",
      args: { command: "probe traversal variants" }
    }
  });
  const result = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "tool_finished:bash:ok",
    payload: {
      toolCallId: "call:traversal",
      toolName: "bash",
      result: { content: [{ type: "text", text: "depth=1 rejected\ndepth=4 size=2422 msg=''" }] }
    }
  });
  const future = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "future event outside snapshot",
    payload: {
      toolCallId: "call:future",
      toolName: "bash",
      result: { content: [{ type: "text", text: "future-marker" }] }
    }
  });

  const verdict = await harness.controllerHarness.runSupervisorCheck({
    reason: "manual:immutable-snapshot",
    taskEnvelope,
    sourceEventIds: [result.id],
    throughSeq: result.seq
  });

  const prompt = harness.observerPrompts()[0] ?? "";
  assert.match(prompt, /depth=4 size=2422 msg=''/);
  assert.doesNotMatch(prompt, new RegExp(`future-marker|${future.id}`));
  assert.equal(verdict.throughSeq, result.seq);
  assert.ok(verdict.evidenceRefs.includes(started.id));
  assert.ok(verdict.evidenceRefs.includes(result.id));
  assert.ok(!verdict.evidenceRefs.includes("event:outside-snapshot"));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("supervisor checks use fresh sessions without previous prompt history", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const sessions: Array<ReturnType<typeof createAbortableMockTextSession>> = [];
  controllerHarness.agents = {
    planner: createMockTextSession("{}"),
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession("{}")
  };
  controllerHarness.createObserverSessionForMode = async (mode) => {
    assert.equal(mode, "supervise");
    const session = createAbortableMockTextSession(JSON.stringify({
      decision: "continue",
      reason: sessions.length === 0 ? "first-check-marker" : "second-check-marker",
      evidenceRefs: [],
      confidence: "low"
    }));
    sessions.push(session);
    return { session, dynamicObserver: true };
  };
  const taskEnvelope = makeTaskEnvelope();
  const state = controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = controllerHarness.agents.executor;

  const firstVerdict = await controllerHarness.runSupervisorCheck({
    reason: "manual:first",
    taskEnvelope,
    sourceEventIds: ["event:first"]
  });
  controllerHarness.applyControlSignal(taskEnvelope, firstVerdict, state);
  await controllerHarness.runSupervisorCheck({
    reason: "manual:second",
    taskEnvelope,
    sourceEventIds: ["event:second"]
  });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].promptCount(), 1);
  assert.equal(sessions[1].promptCount(), 1);
  assert.match(sessions[1].prompts()[0] ?? "", /最近监督信号：[\s\S]*first-check-marker/);
  assert.doesNotMatch(sessions[1].prompts()[0] ?? "", /manual:first|event:first/);
  controller.close();
});

test("superseded in-flight Supervisor verdict cannot redirect while the latest verdict applies", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const firstRelease = createDeferred<void>();
  const executorSession = createAbortableMockTextSession("{}");
  const delayedFirstSession = createDelayedAbortableMockTextSession(async () => {
    await firstRelease.promise;
    return JSON.stringify({
      decision: "redirect",
      reason: "old verdict",
      guidance: "follow the old path",
      evidenceRefs: [],
      confidence: "high"
    });
  });
  let firstAbortCount = 0;
  const firstSession = {
    ...delayedFirstSession,
    async abort(): Promise<void> {
      firstAbortCount += 1;
    },
    dispose(): void {}
  };
  const latestSession = createAbortableMockTextSession(JSON.stringify({
    decision: "redirect",
    reason: "latest verdict",
    guidance: "follow the latest path",
    evidenceRefs: [],
    confidence: "high"
  }));
  let sessionIndex = 0;
  controllerHarness.agents = {
    planner: createMockTextSession("{}"),
    executor: executorSession,
    observer: latestSession
  };
  controllerHarness.createObserverSessionForMode = async () => ({
    session: sessionIndex++ === 0 ? firstSession : latestSession,
    dynamicObserver: true
  });
  const taskEnvelope = makeTaskEnvelope();
  const state = controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = executorSession;

  const firstVerdictPromise = controllerHarness.enqueueSupervisorCheck({
    reason: "manual:first",
    taskEnvelope,
    sourceEventIds: ["event:first"],
    epochRef: state.epochId,
    throughSeq: 10
  });
  await waitFor(() => firstSession.promptCount() === 1);
  const latestVerdictPromise = controllerHarness.enqueueSupervisorCheck({
    reason: "manual:latest",
    taskEnvelope,
    sourceEventIds: ["event:latest"],
    epochRef: state.epochId,
    throughSeq: 20
  });
  await waitFor(() => firstAbortCount === 1);
  firstRelease.resolve();

  const [firstVerdict, latestVerdict] = await Promise.all([firstVerdictPromise, latestVerdictPromise]);
  controllerHarness.applyControlSignal(taskEnvelope, firstVerdict, state);
  controllerHarness.applyControlSignal(taskEnvelope, latestVerdict, state);
  await waitForSettled();

  assert.equal(firstVerdict.decision, "continue");
  assert.match(firstVerdict.reason, /superseded supervisor window/);
  assert.equal(firstAbortCount, 1);
  assert.equal(latestVerdict.decision, "redirect");
  assert.deepEqual(executorSession.steers(), ["SUPERVISOR_REDIRECT:\nfollow the latest path"]);
  const events = await controller.executionLog.readAll();
  assert.ok(events.some((event) => event.eventType === "supervisor_check_discarded"
    && String(event.summary).includes("superseded supervisor window")));
  await controller.close({ drainProjectionJobs: false });
});

test("control application rejects a Supervisor verdict older than the latest requested sequence", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const latestRelease = createDeferred<void>();
  const executorSession = createAbortableMockTextSession("{}");
  const firstSession = createAbortableMockTextSession(JSON.stringify({
    decision: "redirect",
    reason: "first verdict",
    guidance: "follow the first path",
    evidenceRefs: [],
    confidence: "high"
  }));
  const latestSession = createDelayedAbortableMockTextSession(async () => {
    await latestRelease.promise;
    return JSON.stringify({
      decision: "redirect",
      reason: "latest verdict",
      guidance: "follow the latest path",
      evidenceRefs: [],
      confidence: "high"
    });
  });
  let sessionIndex = 0;
  controllerHarness.agents = {
    planner: createMockTextSession("{}"),
    executor: executorSession,
    observer: latestSession
  };
  controllerHarness.createObserverSessionForMode = async () => ({
    session: sessionIndex++ === 0 ? firstSession : latestSession,
    dynamicObserver: true
  });
  const taskEnvelope = makeTaskEnvelope();
  const state = controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = executorSession;

  const firstVerdict = await controllerHarness.enqueueSupervisorCheck({
    reason: "manual:first",
    taskEnvelope,
    sourceEventIds: ["event:first"],
    epochRef: state.epochId,
    throughSeq: 10
  });
  const latestVerdictPromise = controllerHarness.enqueueSupervisorCheck({
    reason: "manual:latest",
    taskEnvelope,
    sourceEventIds: ["event:latest"],
    epochRef: state.epochId,
    throughSeq: 20
  });
  await waitFor(() => latestSession.promptCount() === 1);
  controllerHarness.applyControlSignal(taskEnvelope, firstVerdict, state);
  await waitForSettled();
  assert.deepEqual(executorSession.steers(), []);

  latestRelease.resolve();
  const latestVerdict = await latestVerdictPromise;
  controllerHarness.applyControlSignal(taskEnvelope, latestVerdict, state);
  await waitForSettled();

  assert.deepEqual(executorSession.steers(), ["SUPERVISOR_REDIRECT:\nfollow the latest path"]);
  assert.ok((await controller.executionLog.readAll()).some((event) => event.eventType === "supervisor_check_discarded"
    && String(event.summary).includes("Ignored superseded control signal")));
  await controller.close({ drainProjectionJobs: false });
});

test("supervisor check is discarded after executor stop without LLM call", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  let observerSessionCount = 0;
  controllerHarness.agents = {
    planner: createMockTextSession("{}"),
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession("{}")
  };
  controllerHarness.createObserverSessionForMode = async () => {
    observerSessionCount += 1;
    return {
      session: createAbortableMockTextSession(JSON.stringify({
        decision: "checkpoint",
        reason: "should not run",
        evidenceRefs: [],
        confidence: "high"
      })),
      dynamicObserver: true
    };
  };
  const taskEnvelope = makeTaskEnvelope();
  activateTask(controllerHarness, taskEnvelope, { executorStopRequested: true });

  const signal = await controllerHarness.runSupervisorCheck({
    reason: "turn_window:8",
    taskEnvelope,
    sourceEventIds: ["event:source"]
  });

  assert.equal(signal.decision, "continue");
  assert.match(signal.reason, /discarded/);
  assert.equal(observerSessionCount, 0);
  const eventTypes = (await controller.executionLog.readAll()).map((event) => event.eventType);
  assert.ok(eventTypes.includes("supervisor_check_discarded"));
  assert.equal(eventTypes.includes("supervisor_check_started"), false);
  controller.close();
});

test("projection job logs queued, started and succeeded runtime events", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);
  const sourceEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "event source");

  const projection = await harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:manual",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id]
  });

  assert.equal(projection.controlSignal.decision, "continue");
  assert.equal(harness.observerPromptCount(), 1);
  const eventTypes = (await harness.controller.executionLog.readAll()).map((event) => event.eventType);
  assert.ok(eventTypes.includes("projection_job_queued"));
  assert.ok(eventTypes.includes("projection_job_started"));
  assert.ok(eventTypes.includes("projection_job_succeeded"));
  harness.controller.close();
});

test("projector input uses compact artifact index and graph context", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope({ targetRefs: ["host:identity-index-target"] });
  activateTask(harness.controllerHarness, taskEnvelope);
  const artifactRefs: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    const record = await harness.controller.artifactStore.write({
      taskId: taskEnvelope.taskId,
      kind: "text",
      mediaType: "text/plain",
      data: index < 4
        ? `OBSERVATION_SEED:\\nruntime prompt artifact ${index}`
        : index === 10
          ? `${"x".repeat(600)} middle-breakthrough-marker ${"y".repeat(600)}`
          : `executor evidence artifact ${index} ${"x".repeat(300)}`
    });
    artifactRefs.push(record.artifactRef);
  }
  harness.controller.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: taskEnvelope.taskId,
      graphKind: "task",
      type: "Task",
      label: taskEnvelope.goal,
      properties: {
        status: "partial",
        artifactRefs: ["artifact:graph-noise-1", "artifact:graph-noise-2"],
        targetRefs: taskEnvelope.targetRefs,
        scopeRef: taskEnvelope.scopeRef,
        constraints: taskEnvelope.constraints,
        successCriteria: taskEnvelope.successCriteria
      }
    }],
    edges: []
  });
  harness.controller.graphStore.upsertDelta({
    sourceEventIds: ["event:operation-index"],
    nodes: [{
      id: "host:identity-index-target",
      graphKind: "operation",
      type: "Host",
      label: "10.0.0.9",
      properties: { host: "10.0.0.9" },
      evidenceRefs: ["event:operation-index"]
    }],
    edges: []
  });
  const sourceEvent = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "bash:ok",
    payload: {
      toolName: "bash",
      result: { content: [{ type: "text", text: `important output in ${artifactRefs[10]}` }] }
    },
    artifactRefs: [artifactRefs[10]]
  });
  const outcomeEvent = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "task_partial",
    summary: "confirmed middle breakthrough",
    payload: {
      taskResult: {
        summary: "确认 middle-breakthrough-marker 对应内部读取能力，阶段性收束。"
      }
    }
  });

  await harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [outcomeEvent.id],
    taskResult: {
      taskId: taskEnvelope.taskId,
      status: "partial",
      summary: "checkpoint with many artifacts",
      evidenceRefs: [sourceEvent.id],
      artifactRefs
    }
  });

  const prompt = harness.observerPrompts()[0];
  assert.match(prompt, /<projection_job>/);
  assert.match(prompt, /<observations>/);
  assert.match(prompt, /<artifact_evidence>/);
  assert.match(prompt, /<graph_context>/);
  assert.match(prompt, /相关图节点/);
  assert.match(prompt, /10\.0\.0\.9/);
  assert.doesNotMatch(prompt, /executor_commentary_non_evidence:/);
  assert.match(prompt, /middle-breakthrough-marker/);
  assert.match(prompt, /taskOutcome=.*"status":"partial"/);
  assert.ok(prompt.includes(artifactRefs.at(-1)!));
  const projectorGraphContext = prompt.match(/<graph_context>\n([\s\S]*?)\n<\/graph_context>/)?.[1] ?? "";
  assert.doesNotMatch(projectorGraphContext, /existing:\d+ task\/(?:Task|Scope|Goal|Milestone|Blocker)/);
  assert.doesNotMatch(projectorGraphContext, /task:|scope:|goal:/);
  assert.doesNotMatch(prompt, /  head:|  tail:/);
  assert.doesNotMatch(prompt, /ARTIFACT_MANIFEST:|CURRENT_GRAPH_SLICE:/);
  assert.doesNotMatch(prompt, /artifact:graph-noise/);
  assert.doesNotMatch(prompt, /runtime prompt artifact/);
  assert.ok(prompt.length < 10_000, `Projector prompt too large: ${prompt.length}`);
  assert.ok((prompt.match(/artifact:/g) ?? []).length < 50);
  const inputEvent = (await harness.controller.executionLog.readAll())
    .find((event) => event.eventType === "projection_input_built");
  assert.equal(inputEvent?.payload.observationCount, 2);
  assert.ok(Number(inputEvent?.payload.inputBytes) < 10_000);
  harness.controller.close();
});

test("projector artifact index exposes unmatched artifacts as references without fixed previews", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  const artifact = await harness.controller.artifactStore.write({
    taskId: taskEnvelope.taskId,
    kind: "text",
    mediaType: "text/plain",
    data: `private-prefix-${"x".repeat(600)}-private-suffix`
  });
  const controllerHarness = harness.controller as unknown as {
    loadProjectorArtifactIndex(input: {
      taskEnvelope: TaskEnvelope;
      observations: Array<{
        ref: string;
        kind: "action";
        seqStart: number;
        seqEnd: number;
        action: string;
        outcomeDigest: string;
        status: "ok";
        artifactRefs: string[];
        anchors: string[];
        sourceEventIds: string[];
      }>;
    }): Promise<{ text: string }>;
  };

  const index = await controllerHarness.loadProjectorArtifactIndex({
    taskEnvelope,
    observations: [{
      ref: "o1",
      kind: "action",
      seqStart: 1,
      seqEnd: 1,
      action: "bash",
      outcomeDigest: "unrelated observation",
      status: "ok",
      artifactRefs: [artifact.artifactRef],
      anchors: ["unrelated-anchor"],
      sourceEventIds: ["event:1"]
    }]
  });

  assert.match(index.text, new RegExp(artifact.artifactRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(index.text, /private-prefix|private-suffix|  head:|  tail:/);
  harness.controller.close();
});

test("projection job remains independent after executor stop", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope, { executorStopRequested: true });

  const sourceEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "post-stop source");
  const projection = await harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:manual",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id]
  });

  assert.equal(projection.controlSignal.decision, "continue");
  assert.equal(harness.observerPromptCount(), 1);
  const eventTypes = (await harness.controller.executionLog.readAll()).map((event) => event.eventType);
  assert.ok(eventTypes.includes("projection_job_queued"));
  assert.ok(eventTypes.includes("projection_job_started"));
  assert.ok(eventTypes.includes("projection_job_succeeded"));
  harness.controller.close();
});

test("projector consumes typed connectivity facts without skipping their watermark", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  const connectivityEvent = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "runtime",
    eventType: "connectivity_observation",
    summary: "SSH route became active",
    payload: {
      observationKind: "route",
      transition: "route_opened",
      status: "active",
      routeRef: "route:ssh-1",
      connectionRef: "connection:ssh-1",
      pivotHostRef: "host:dmz",
      dialAddress: "10.0.0.8",
      targetCidrs: ["172.31.0.0/24"]
    }
  });

  await harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [connectivityEvent.id]
  });

  const prompt = harness.observerPrompts()[0] ?? "";
  assert.match(prompt, /route_opened/);
  assert.match(prompt, /route:ssh-1/);
  assert.match(prompt, /172\.31\.0\.0\/24/);
  const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(state.committedSeq, connectivityEvent.seq);
  assert.equal(state.desiredSeq, connectivityEvent.seq);
  await harness.controller.close();
});

test("typed live command connection projects one stable ShellSession on the real pivot host", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    nodes: [{
      id: "new:1",
      type: "Host",
      label: "10.0.0.8",
      properties: { ip: "10.0.0.8" },
      evidenceRefs: ["o1"]
    }, {
      id: "new:2",
      type: "ShellSession",
      label: "SSH on 10.0.0.8",
      properties: { sessionId: "connection:ssh-1", status: "live", transport: "ssh" },
      evidenceRefs: ["o1"]
    }],
    edges: [{
      from: "new:2",
      to: "new:1",
      type: "session_on",
      evidenceRefs: ["o1"]
    }]
  }));
  const taskEnvelope = makeTaskEnvelope();
  const connectivityEvent = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "runtime",
    eventType: "connectivity_observation",
    summary: "ssh connection connection:ssh-1 is live",
    payload: {
      observationKind: "session",
      transition: "opened",
      connectionRef: "connection:ssh-1",
      sessionType: "shell",
      hostRef: "host:dmz",
      transport: "ssh",
      status: "live",
      dialAddress: "10.0.0.8"
    }
  });

  await harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:connectivity",
    taskEnvelope,
    sourceEventIds: [connectivityEvent.id]
  });

  const operation = harness.controller.graphStore.query("operation", [], 20);
  const session = operation.nodes.find((node) => node.type === "ShellSession");
  const host = operation.nodes.find((node) => node.type === "Host");
  assert.equal(session?.properties.sessionId, "connection:ssh-1");
  assert.equal(host?.properties.ip, "10.0.0.8");
  assert.ok(operation.edges.some((edge) => edge.type === "session_on" && edge.from === session?.id && edge.to === host?.id));
  await harness.controller.close();
});

test("projector receives active route references when an internal host is discovered later", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  const connectivityRuntime = {
    routeProjectionSnapshot: () => [{
      routeRef: "route:ssh-existing",
      connector: "ssh" as const,
      pivotHostRef: "host:dmz",
      dialAddress: "10.0.0.8",
      targetCidrs: ["172.31.0.0/24"],
      status: "live" as const,
      lastHeartbeat: "2026-07-26T00:00:00.000Z",
      connectionRef: "connection:ssh-existing"
    }]
  };
  (harness.controller as unknown as { connectivityRuntime?: typeof connectivityRuntime }).connectivityRuntime = connectivityRuntime;
  const hostDiscoveryEvent = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "HTTP 200 from newly discovered internal host 172.31.0.20",
    payload: {
      toolCallId: "call:internal-host",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "HTTP 200 from http://172.31.0.20/" }]
      }
    }
  });

  await harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:host_discovery",
    taskEnvelope,
    sourceEventIds: [hostDiscoveryEvent.id]
  });

  const prompt = harness.observerPrompts()[0] ?? "";
  const observations = prompt.match(/<observations>\n([\s\S]*?)\n<\/observations>/)?.[1] ?? "";
  const connectivityContext = prompt.match(/<connectivity_context format="json">\n([\s\S]*?)\n<\/connectivity_context>/)?.[1] ?? "";
  assert.match(observations, /172\.31\.0\.20/);
  assert.doesNotMatch(observations, /route:ssh-existing/);
  assert.match(connectivityContext, /route:ssh-existing/);
  assert.match(connectivityContext, /host:dmz/);
  assert.match(connectivityContext, /172\.31\.0\.0\/24/);
  assert.match(prompt, /不能独立证明 Host、Session、Evidence 或关系/);
  assert.equal(harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId).committedSeq, hostDiscoveryEvent.seq);
  delete (harness.controller as unknown as { connectivityRuntime?: unknown }).connectivityRuntime;
  await harness.controller.close();
});

test("tool windows queue asynchronous projector every sixteen tool results without invoking supervisor", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET } });
  activateTask(harness.controllerHarness, taskEnvelope);

  for (let index = 0; index < 15; index += 1) {
    const event = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", `tool ${index}`);
    await harness.controllerHarness.handleExecutorEventPersisted(event);
  }
  assert.equal(harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId).desiredSeq, 0);

  const windowEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "tool 15");
  await harness.controllerHarness.handleExecutorEventPersisted(windowEvent);

  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "projection_job_succeeded"));
  const events = await harness.controller.executionLog.readAll();
  assert.ok(events.some((event) => event.eventType === "projection_job_queued" && event.summary?.startsWith("project_window:16")));
  const inputEvent = events.find((event) => event.eventType === "projection_input_built");
  assert.ok(Number(inputEvent?.payload.observationCount) > 1);
  assert.equal(events.some((event) => event.eventType === "supervisor_check_started"), false);
  harness.controller.close();
});

test("active projector does not chase events below the next tool window", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: 20 } });
  activateTask(harness.controllerHarness, taskEnvelope);
  const releaseProjection = createDeferred<void>();
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    await releaseProjection.promise;
    return observerProjectionJson();
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });

  let windowSeq = 0;
  for (let index = 0; index < 16; index += 1) {
    const event = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", `tool ${index}`);
    windowSeq = event.seq ?? windowSeq;
    await harness.controllerHarness.handleExecutorEventPersisted(event);
  }
  await waitFor(async () => projectorSession.promptCount() === 1);

  for (let index = 16; index < 21; index += 1) {
    const event = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", `tool ${index}`);
    await harness.controllerHarness.handleExecutorEventPersisted(event);
  }
  assert.equal(harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId).desiredSeq, windowSeq);

  releaseProjection.resolve();
  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "projection_job_succeeded"));
  const events = await harness.controller.executionLog.readAll();
  assert.equal(events.some((event) => event.eventType === "projection_catchup_started"), false);
  harness.controller.close();
});

test("projector max-age scheduling projects an accumulated live tail", async (t) => {
  process.env.PROJECTOR_CATCHUP_DELAY_MS = "20";
  process.env.PROJECTOR_CATCHUP_MIN_OBSERVATIONS = "1";
  t.after(() => {
    delete process.env.PROJECTOR_CATCHUP_DELAY_MS;
    delete process.env.PROJECTOR_CATCHUP_MIN_OBSERVATIONS;
  });
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: 20 } });
  activateTask(harness.controllerHarness, taskEnvelope);
  const releaseProjection = createDeferred<void>();
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    await releaseProjection.promise;
    return observerProjectionJson();
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });

  for (let index = 0; index < 16; index += 1) {
    const event = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", `tool ${index}`);
    await harness.controllerHarness.handleExecutorEventPersisted(event);
  }
  await waitFor(async () => projectorSession.promptCount() === 1);

  let tailSeq = 0;
  for (let index = 16; index < 20; index += 1) {
    const event = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", `tail ${index}`);
    tailSeq = event.seq ?? tailSeq;
  }
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, tailSeq, 0);

  releaseProjection.resolve();
  await waitFor(async () => projectorSession.promptCount() === 2);
  await waitFor(() => harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId).committedSeq === tailSeq);
  const events = await harness.controller.executionLog.readAll();
  assert.equal(events.filter((event) => event.eventType === "projection_job_started").length, 2);
  harness.controller.close();
});

test("projector max-age scheduling eventually projects a tiny live tail", async (t) => {
  process.env.PROJECTOR_CATCHUP_DELAY_MS = "20";
  t.after(() => {
    delete process.env.PROJECTOR_CATCHUP_DELAY_MS;
  });
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: 20 } });
  activateTask(harness.controllerHarness, taskEnvelope);
  const releaseProjection = createDeferred<void>();
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    await releaseProjection.promise;
    return observerProjectionJson();
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });

  for (let index = 0; index < 16; index += 1) {
    const event = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", `tool ${index}`);
    await harness.controllerHarness.handleExecutorEventPersisted(event);
  }
  await waitFor(async () => projectorSession.promptCount() === 1);

  const tailEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "single tail event");
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, tailEvent.seq ?? 0, 0);

  releaseProjection.resolve();
  await waitFor(async () => projectorSession.promptCount() === 2);
  await waitFor(() => harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId).committedSeq === tailEvent.seq);
  const events = await harness.controller.executionLog.readAll();
  assert.equal(events.filter((event) => event.eventType === "projection_job_started").length, 2);
  harness.controller.close();
});

test("terminal projection continuously drains its remaining tail", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: 20 } });
  let lastSeq = 0;
  for (let index = 0; index < 17; index += 1) {
    const event = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", `terminal ${index}`);
    lastSeq = event.seq ?? lastSeq;
  }
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, lastSeq, 0);

  await harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    taskResult: {
      taskId: taskEnvelope.taskId,
      status: "partial",
      summary: "terminal projection drain",
      evidenceRefs: [],
      artifactRefs: []
    }
  });

  const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(state.committedSeq, state.desiredSeq);
  const events = await harness.controller.executionLog.readAll();
  assert.ok(events.filter((event) => event.eventType === "projection_job_started").length >= 1);
  assert.equal(state.terminalTargetSeq, undefined);
  await harness.controller.close();
});

test("terminal projection compacts an oversized tail without input-limit failure", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: 40 } });
  let lastSeq = 0;
  for (let index = 0; index < 80; index += 1) {
    const event = await persistExecutorEvent(
      harness.controller,
      taskEnvelope.taskId,
      "tool_finished",
      `terminal-${index} ${"dense-result ".repeat(120)}`
    );
    lastSeq = event.seq ?? lastSeq;
  }
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, lastSeq, 0);

  await harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    taskResult: {
      taskId: taskEnvelope.taskId,
      status: "partial",
      summary: `dense terminal result ${"summary ".repeat(2_000)}`,
      evidenceRefs: [],
      artifactRefs: []
    }
  });

  const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(state.committedSeq, state.desiredSeq);
  assert.ok(harness.observerPromptCount() >= 2);
  const events = await harness.controller.executionLog.readAll();
  assert.equal(events.some((event) => event.eventType === "projection_job_failed"), false);
  const inputs = events.filter((event) => event.eventType === "projection_input_built");
  assert.ok(inputs.every((input) => Number(input.payload.inputBytes) <= Number(input.payload.targetBytes)));
  assert.ok(inputs.every((input) => Number(input.payload.observationCount) <= 32));
  const prompts = harness.observerPrompts().join("\n");
  for (let index = 0; index < 80; index += 1) {
    assert.match(prompts, new RegExp(`terminal-${index}\\b`));
  }
  assert.equal(Number(inputs[0]?.payload.fromSeq), 0);
  for (let index = 1; index < inputs.length; index += 1) {
    assert.equal(
      Number(inputs[index]?.payload.fromSeq),
      Number(inputs[index - 1]?.payload.toSeq)
    );
  }
  assert.equal(Number(inputs.at(-1)?.payload.toSeq), state.desiredSeq);
  await harness.controller.close();
});

test("projector partitions one huge parallel action group and commits its cursor only after every fragment", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  const fragmentSession = createPromptAwareMockTextSession((_prompt, fragmentIndex) => {
    assert.equal(harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId).committedSeq, 0);
    return JSON.stringify({
      nodes: Array.from({ length: 20 }, (_, nodeIndex) => ({
        id: `new:${nodeIndex + 1}`,
        type: "Evidence",
        label: `fragment ${fragmentIndex + 1} evidence ${nodeIndex + 1}`,
        properties: { fragmentIndex: fragmentIndex + 1, nodeIndex: nodeIndex + 1 },
        evidenceRefs: ["o1"]
      })),
      edges: Array.from({ length: 30 }, (_, edgeIndex) => ({
        from: `new:${(edgeIndex % 20) + 1}`,
        to: `new:${((edgeIndex + 1 + Math.floor(edgeIndex / 20)) % 20) + 1}`,
        type: "supports",
        properties: { fragmentIndex: fragmentIndex + 1, edgeIndex: edgeIndex + 1 },
        evidenceRefs: ["o1"]
      }))
    });
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: fragmentSession,
    dynamicObserver: true
  });
  let seq = 0;
  await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "parallel target validation",
    payload: {
      text: "并行验证全部候选，再统一解释结果。",
      toolCalls: Array.from({ length: 60 }, (_, index) => ({
        id: `call:${index}`,
        name: "bash",
        arguments: {}
      }))
    }
  });
  seq += 1;
  for (let index = 0; index < 60; index += 1) {
    await harness.controller.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "executor",
      eventType: "tool_started",
      summary: `started ${index}`,
      payload: {
        toolCallId: `call:${index}`,
        toolName: "bash",
        args: { command: `curl http://10.0.0.${index + 1}/candidate/${index}` }
      }
    });
    seq += 1;
  }
  const artifactRefs: string[] = [];
  let lastFinishedEventId = "";
  for (let index = 0; index < 60; index += 1) {
    const artifactRef = `artifact:${index}:${"evidence".repeat(36)}`;
    artifactRefs.push(artifactRef);
    const finished = await harness.controller.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "executor",
      eventType: "tool_finished",
      summary: `finished ${index}`,
      payload: {
        toolCallId: `call:${index}`,
        toolName: "bash",
        result: { content: [{ type: "text", text: `HTTP 200 from 10.0.0.${index + 1}` }] }
      },
      artifactRefs: [artifactRef]
    });
    lastFinishedEventId = finished.id;
    seq += 1;
  }
  const interpretation = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "assistant_intent",
    summary: "all candidates interpreted",
    payload: { text: "全部候选已经验证，分别保留成功目标和对应证据。" }
  });
  seq += 1;
  assert.equal(interpretation.seq, seq);
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, seq, 0);

  await harness.controllerHarness.runProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [interpretation.id],
    taskResult: {
      taskId: taskEnvelope.taskId,
      status: "partial",
      summary: "parallel group reached a bounded checkpoint",
      evidenceRefs: [lastFinishedEventId],
      artifactRefs: []
    },
    maxObservations: 16
  });

  const prompts = fragmentSession.prompts();
  assert.ok(prompts.length > 1);
  assert.ok(prompts.every((prompt) => Buffer.byteLength(prompt, "utf8") <= 32_000));
  assert.ok(prompts.every((prompt) => /taskOutcome=.*"status":"partial"/.test(prompt)));
  const combinedPrompts = prompts.join("\n");
  for (const artifactRef of artifactRefs) {
    assert.match(combinedPrompts, new RegExp(artifactRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(state.committedSeq, seq);
  assert.equal(state.desiredSeq, seq);
  const events = await harness.controller.executionLog.readAll();
  const inputs = events.filter((event) => event.eventType === "projection_input_built");
  assert.equal(inputs.length, prompts.length);
  assert.ok(inputs.every((event) => Number(event.payload.inputBytes) <= 32_000));
  assert.ok(inputs.every((event) => Number(event.payload.fragmentCount) === prompts.length));
  const succeeded = events.findLast((event) => event.eventType === "projection_job_succeeded");
  assert.equal(Number((succeeded?.payload.nodeCounts as Record<string, number> | undefined)?.["reasoning:Evidence"]), prompts.length * 20);
  assert.equal(Number(succeeded?.payload.edgeCount), prompts.length * 30);
  assert.ok(Number((succeeded?.payload.nodeCounts as Record<string, number> | undefined)?.["reasoning:Evidence"]) > 24);
  assert.ok(Number(succeeded?.payload.edgeCount) > 40);
  const projectedSourceIds = new Set((succeeded?.payload.sourceEventIds ?? []) as string[]);
  const actionEvents = events.filter((event) => event.role === "executor" && [
    "tool_started", "tool_finished"
  ].includes(event.eventType));
  assert.ok(actionEvents.every((event) => projectedSourceIds.has(event.id)));
  assert.ok(events
    .filter((event) => event.eventType === "assistant_intent")
    .every((event) => !projectedSourceIds.has(event.id)));
  await harness.controller.close();
});

test("projector carries an oversized TaskOutcome manifest through bounded observation fragments", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  const sourceEvent = await persistExecutorEvent(
    harness.controller,
    taskEnvelope.taskId,
    "tool_finished",
    "bounded observation"
  );
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, sourceEvent.seq ?? 0, 0);
  const oversizedEvidenceRefs = Array.from(
    { length: 240 },
    (_, index) => `event:fixed-envelope:${index}:${"x".repeat(160)}`
  );
  const oversizedArtifactRefs = Array.from(
    { length: 80 },
    (_, index) => `artifact:fixed-envelope:${index}:${"a".repeat(120)}`
  );
  const oversizedCapabilityRefs = Array.from(
    { length: 80 },
    (_, index) => `route:fixed-envelope:${index}:${"c".repeat(120)}`
  );

  await harness.controllerHarness.runProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id],
    taskResult: {
      taskId: taskEnvelope.taskId,
      status: "partial",
      summary: "fixed envelope must remain complete",
      evidenceRefs: oversizedEvidenceRefs,
      artifactRefs: oversizedArtifactRefs,
      capabilityRefs: oversizedCapabilityRefs
    }
  });

  assert.ok(harness.observerPromptCount() > 0);
  assert.ok(harness.observerPrompts().every((prompt) => Buffer.byteLength(prompt, "utf8") <= 32_000));
  const combinedPrompts = harness.observerPrompts().join("\n");
  for (const ref of [...oversizedArtifactRefs, ...oversizedCapabilityRefs]) {
    assert.match(combinedPrompts, new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(state.committedSeq, sourceEvent.seq);
  assert.equal(state.desiredSeq, sourceEvent.seq);
  assert.equal(state.activeGeneration, undefined);
  const events = await harness.controller.executionLog.readAll();
  assert.equal(events.some((event) => event.eventType === "projection_job_failed"), false);
  const succeeded = events.findLast((event) => event.eventType === "projection_job_succeeded");
  assert.deepEqual(
    new Set((succeeded?.payload.sourceEventIds ?? []) as string[]),
    new Set([sourceEvent.id, ...oversizedEvidenceRefs])
  );
  await harness.controller.close();
});

test("projector advances committed watermark without losing prior windows", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET, maxTurns: 20 } });
  activateTask(harness.controllerHarness, taskEnvelope);

  for (let index = 0; index < 16; index += 1) {
    const event = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", `tool ${index}`);
    await harness.controllerHarness.handleExecutorEventPersisted(event);
  }

  await waitFor(() => {
    const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
    return state.committedSeq === state.desiredSeq && state.committedSeq > 0;
  });
  const started = (await harness.controller.executionLog.readAll())
    .filter((event) => event.eventType === "projection_job_started");
  assert.ok(started.length >= 1);
  assert.equal(started[0]?.payload.fromSeq, 0);
  const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(state.committedSeq, state.desiredSeq);
  harness.controller.close();
});

test("projector consumes legacy non-semantic runtime tail without empty catch-up loop", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);
  const runtimeTailEvent = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "runtime",
    eventType: "projection_job_heartbeat",
    summary: "legacy projector heartbeat",
    payload: { elapsedMs: 10_000 }
  });

  await harness.controllerHarness.enqueueProjectionJob({
    reason: "projection_recovered",
    taskEnvelope,
    sourceEventIds: [runtimeTailEvent.id]
  });

  const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(state.committedSeq, runtimeTailEvent.seq);
  assert.equal(state.desiredSeq, runtimeTailEvent.seq);
  assert.equal(harness.observerPromptCount(), 0);
  harness.controller.close();
});

test("projector coalesces same-task windows behind one in-flight job", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);
  const firstRelease = createDeferred<void>();
  const secondRelease = createDeferred<void>();
  let promptIndex = 0;
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    promptIndex += 1;
    if (promptIndex === 1) {
      await firstRelease.promise;
      return projectionDeltaJson("evidence:old-window", "event:old-window");
    }
    await secondRelease.promise;
    return projectionDeltaJson("evidence:latest-window", "event:latest-window");
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });

  const oldEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "old window");

  const firstWindow = harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:3",
    taskEnvelope,
    sourceEventIds: [oldEvent.id]
  });
  await waitFor(async () => projectorSession.promptCount() === 1);
  const supersededEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "superseded window");
  const supersededWindow = harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:6",
    taskEnvelope,
    sourceEventIds: [supersededEvent.id]
  });
  const latestEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "latest window");
  const latestWindow = harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:9",
    taskEnvelope,
    sourceEventIds: [latestEvent.id]
  });

  firstRelease.resolve();
  await waitFor(async () => projectorSession.promptCount() === 2);
  secondRelease.resolve();
  await Promise.all([firstWindow, supersededWindow, latestWindow]);

  const events = await harness.controller.executionLog.readAll();
  const startedReasons = events
    .filter((event) => event.eventType === "projection_job_started")
    .map((event) => event.summary ?? "");
  assert.ok(startedReasons.some((summary) => summary.startsWith("project_window:3")));
  assert.ok(startedReasons.some((summary) => summary.startsWith("project_window:9")));
  assert.equal(startedReasons.some((summary) => summary.startsWith("project_window:6")), false);
  assert.ok(events.some((event) => event.eventType === "projection_request_coalesced"));
  assert.equal(events.some((event) => event.eventType === "projection_request_superseded"), false);
  const reasoningLabels = harness.controller.graphStore.query("reasoning").nodes.map((node) => node.label);
  assert.ok(reasoningLabels.includes("evidence:old-window"));
  assert.ok(reasoningLabels.includes("evidence:latest-window"));
  const projectionState = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(projectionState.committedSeq, projectionState.desiredSeq);
  harness.controller.close();
});

test("task_end raises the terminal target without preempting active projection", async () => {
  const harness = createObserverControllerHarness(observerProjectionJson());
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);
  const firstRelease = createDeferred<void>();
  const finalRelease = createDeferred<void>();
  let promptIndex = 0;
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    promptIndex += 1;
    if (promptIndex === 1) {
      await firstRelease.promise;
      return projectionDeltaJson("evidence:window-before-end", "event:window-before-end");
    }
    await finalRelease.promise;
    return projectionDeltaJson("evidence:task-end", "event:task-end");
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });

  const windowEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "window before end");

  const activeWindow = harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:3",
    taskEnvelope,
    sourceEventIds: [windowEvent.id]
  });
  await waitFor(async () => projectorSession.promptCount() === 1);
  const pendingEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "tool_finished", "pending window");
  const pendingWindow = harness.controllerHarness.enqueueProjectionJob({
    reason: "project_window:6",
    taskEnvelope,
    sourceEventIds: [pendingEvent.id]
  });
  const taskEndEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "task_partial", "task end");
  const finalProjection = harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [taskEndEvent.id],
    taskResult: {
      taskId: taskEnvelope.taskId,
      status: "partial",
      summary: "checkpoint before planner",
      evidenceRefs: ["event:task-end"],
      artifactRefs: []
    }
  });

  firstRelease.resolve();
  await waitFor(async () => projectorSession.promptCount() === 2);
  finalRelease.resolve();
  await Promise.all([activeWindow, pendingWindow, finalProjection]);

  const events = await harness.controller.executionLog.readAll();
  const startedReasons = events
    .filter((event) => event.eventType === "projection_job_started")
    .map((event) => event.summary ?? "");
  assert.ok(startedReasons.some((summary) => summary.startsWith("project_window:3")));
  assert.ok(startedReasons.some((summary) => summary.startsWith("task_end")));
  assert.equal(startedReasons.some((summary) => summary.startsWith("project_window:6")), false);
  assert.ok(events.some((event) => event.eventType === "projection_request_coalesced"));
  assert.equal(events.some((event) => event.eventType === "projection_job_preempted"), false);
  const reasoningLabels = harness.controller.graphStore.query("reasoning").nodes.map((node) => node.label);
  assert.ok(reasoningLabels.includes("evidence:window-before-end"));
  assert.ok(reasoningLabels.includes("evidence:task-end"));
  harness.controller.close();
});

test("completed task hands off to the next planner cycle without waiting for terminal projection", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const projectorRelease = createDeferred<void>();
  let projectorPromptStarted = false;
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    projectorPromptStarted = true;
    await projectorRelease.promise;
    return JSON.stringify({
      nodes: [],
      edges: []
    });
  });
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "create_tasks",
          tasks: [{
            id: "task:first",
            goal: "Run an executor epoch",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["epoch done"],
            budget: { maxTurns: 8 },
            priority: 1
          }],
          reason: "Start first epoch.",
          basedOnRefs: ["goal:root"]
        }],
        reason: "Start first epoch.",
        basedOnRefs: ["goal:root"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "set_node_status",
          nodeId: "goal:root",
          status: "achieved",
          reason: "Planner regained control after epoch.",
          basedOnRefs: ["task:first"]
        }],
        reason: "Planner regained control after epoch.",
        basedOnRefs: ["task:first"]
      })
    ]),
    executor: createAbortableMockTextSession(JSON.stringify({
      taskId: "task:first",
      status: "completed",
      summary: "Epoch completed",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createAbortableMockTextSession(JSON.stringify({
      decision: "continue",
      reason: "no intervention",
      evidenceRefs: [],
      confidence: "low"
    }))
  };
  controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });

  const runPromise = controller.runUntilDone({
    userGoal: "Wait for completed-task knowledge",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 2
  });

  await waitFor(() => projectorPromptStarted);
  // The Planner is not fenced by the in-flight terminal projection: the second
  // cycle completes while the projector is still blocked, carrying the task
  // outcome and the projection degradation instead of waiting for the graph.
  await waitFor(async () => (await controller.executionLog.readAll())
    .filter((event) => event.eventType === "planner_prompt_completed").length === 2);
  const result = await withTestTimeout(runPromise, 500);

  assert.equal(result.cycles.length, 2);
  assert.equal(result.cycles[1].plannerDecision.decision, undefined);
  assert.equal(result.completed, true);
  const plannerPrompts = (controllerHarness.agents.planner as ReturnType<typeof createMockTextSessionSequence>).prompts();
  assert.match(plannerPrompts[1] ?? "", /"projectionDegradations":\{"remove":\[\],"upsert":\[/);
  assert.match(plannerPrompts[1] ?? "", /task:first/);
  assert.match(plannerPrompts[1] ?? "", /Epoch completed/);
  projectorRelease.resolve();
  await waitFor(async () => (await controller.executionLog.readAll())
    .some((event) => event.eventType === "projection_job_succeeded"));
  await controller.close();
});

test("planner prompt uses compact decision state without retrieval hints", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const plannerSession = createMockTextSession(JSON.stringify({
    decision: "apply_commands",
    commands: [{
      kind: "set_node_status",
      nodeId: "goal:root",
      status: "achieved",
      reason: "Goal achieved",
      basedOnRefs: ["goal:root"]
    }],
    reason: "Mark the goal achieved",
    basedOnRefs: ["goal:root"]
  }));
  const controllerHarness = controller as unknown as ControllerHarness;
  controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession(observerProjectionJson())
  };

  await controller.runOnce({
    userGoal: "Get the flag",
    scopeSummary: "Authorized target only"
  });

  const prompt = plannerSession.prompts()[0] ?? "";
  assert.match(prompt, /<planner_state format="compact-json">/);
  assert.match(prompt, /"taskLedger"/);
  assert.match(prompt, /"reasoningDigest"/);
  assert.match(prompt, /"operationDigest"/);
  assert.doesNotMatch(prompt, /retrievalHints|graph_query|graph_trace/);
  assert.doesNotMatch(prompt, /PLANNER_GRAPH_SNAPSHOT:|OPEN_TASKS:|AVAILABLE_SESSIONS:/);
  assert.ok(prompt.length < 8_000, `Planner prompt too large: ${prompt.length}`);
  controller.close();
});

test("retries a retryable Planner provider failure with a fresh session", async () => {
  const harness = createControllerHarness();
  await harness.controllerHarness.ensureRootGraph({ userGoal: "Get the flag", scopeSummary: "Authorized target only" });
  const sessions = [
    createProviderErrorSession("503 Service unavailable"),
    createStructuredToolSession("planner_submit", {
      decision: "apply_commands",
      commands: [{
        kind: "set_node_status",
        nodeId: "goal:root",
        status: "achieved",
        reason: "Goal achieved",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Mark the goal achieved",
      basedOnRefs: ["goal:root"]
    })
  ];
  let sessionIndex = 0;
  let viewVersion = 0;
  harness.controllerHarness.structuredInvocationsEnabled = true;
  harness.controllerHarness.buildPlannerDecisionView = async () => ({
    view: "planner_decision",
    rootRefs: { goalRef: "goal:root", scopeRef: "scope:root" },
    taskLedger: [],
    reasoningDigest: [],
    operationDigest: [],
    blockers: [],
    graphSummary: { nodeCount: viewVersion += 1 }
  });
  harness.controllerHarness.createPlannerSessionForCycle = async () => ({
    session: sessions[Math.min(sessionIndex++, sessions.length - 1)]!,
    isolated: true
  });

  const result = await harness.controllerHarness.invokePlannerCycle({
    userGoal: "Get the flag",
    scopeSummary: "Authorized target only"
  });

  assert.equal(sessionIndex, 2);
  assert.equal(viewVersion, 2);
  assert.match(sessions[0]?.prompts()[0] ?? "", /"nodeCount":1/);
  assert.match(sessions[1]?.prompts()[0] ?? "", /"nodeCount":2/);
  assert.equal(result.plannerDecision.decision, undefined);
  assert.ok((await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "planner_prompt_retry_scheduled"));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("keeps the primary Planner session across cycles even when task sessions are isolated", async () => {
  const harness = createControllerHarness();
  const plannerSession = createAbortableMockTextSession("{}");
  harness.controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession("{}")
  };
  harness.controllerHarness.isolatedSessionsEnabled = true;

  const first = await harness.controllerHarness.createPlannerSessionForCycle(false);
  const second = await harness.controllerHarness.createPlannerSessionForCycle(false);

  assert.equal(first.isolated, false);
  assert.equal(second.isolated, false);
  assert.equal(first.session, plannerSession);
  assert.equal(second.session, plannerSession);
  await harness.controller.close({ drainProjectionJobs: false });
});

test("repairs an invalid planner submit in the same session and executes the created task", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const plannerSession = createRecoveringStructuredToolSession("planner_submit", {
    decision: "apply_commands",
    commands: [{
      kind: "create_tasks",
      tasks: [{
        id: "task:deep-dive",
        goal: "Reuse the confirmed operator session to inspect the protected API",
        targetRefs: ["capability:operator-session"],
        scopeRef: "scope:root",
        constraints: ["authorized target only"],
        successCriteria: ["protected API evidence collected"],
        budget: { maxTurns: 10 },
        priority: 1
      }],
      reason: "Continue from the confirmed capability",
      basedOnRefs: ["capability:operator-session"]
    }],
    reason: "Repair the rejected submission and continue the attack chain",
    basedOnRefs: ["capability:operator-session"]
  });
  controllerHarness.structuredInvocationsEnabled = true;
  controllerHarness.createPlannerSessionForCycle = async () => ({
    session: plannerSession,
    isolated: true
  });
  controllerHarness.agents = {
    planner: createStructuredToolSession("planner_submit", {
      decision: "apply_commands",
      commands: [],
      reason: "unused fallback planner",
      basedOnRefs: ["goal:root"]
    }),
    executor: createStructuredToolSession("task_result_submit", {
      taskId: "task:deep-dive",
      status: "completed",
      summary: "Protected API evidence collected with the confirmed operator session.",
      evidenceRefs: [],
      artifactRefs: []
    }),
    observer: createStructuredToolSession("graph_delta_submit", { nodes: [], edges: [] })
  };

  const result = await controller.runOnce({
    userGoal: "Complete the authorized assessment",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });
  const events = await controller.executionLog.readAll();

  assert.equal(plannerSession.promptCount(), 1);
  assert.match(plannerSession.prompts()[0] ?? "", /Complete the authorized assessment/);
  assert.match(plannerSession.prompts()[0] ?? "", /<planner_state format="compact-json">/);
  assert.equal(result.plannerDecision.reason, "Repair the rejected submission and continue the attack chain");
  assert.equal(controller.graphStore.getTaskNode("task:deep-dive")?.properties.status, "open");
  assert.equal(controller.runtimeStore.getTaskOutcome("task:deep-dive")?.status, "completed");
  assert.deepEqual(controller.graphStore.getTaskEnvelope("task:deep-dive")?.basisRefs,
    ["capability:operator-session"]);
  assert.ok(events.some((event) => event.eventType === "runtime_control"
    && event.summary === "runtime_control:planner_submit:error"));
  assert.ok(events.some((event) => event.eventType === "task_created" && event.taskId === "task:deep-dive"));
  assert.ok(events.some((event) => event.eventType === "task_completed" && event.taskId === "task:deep-dive"));
  assert.equal(events.some((event) => event.eventType === "planner_prompt_failed"), false);
  assert.equal(events.some((event) => event.eventType === "run_failed"), false);
  await controller.close({ drainProjectionJobs: false });
});

test("retries an unrepaired invalid Planner submit with a fresh session", async () => {
  const harness = createControllerHarness();
  await harness.controllerHarness.ensureRootGraph({ userGoal: "Get the flag", scopeSummary: "Authorized target only" });
  const sessions = [
    createStructuredToolErrorSession("planner_submit", "Validation failed: reason is required"),
    createStructuredToolSession("planner_submit", {
      decision: "apply_commands",
      commands: [{
        kind: "set_node_status",
        nodeId: "goal:root",
        status: "achieved",
        reason: "Goal achieved",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Mark the goal achieved",
      basedOnRefs: ["goal:root"]
    })
  ];
  let sessionIndex = 0;
  harness.controllerHarness.structuredInvocationsEnabled = true;
  harness.controllerHarness.createPlannerSessionForCycle = async () => ({
    session: sessions[Math.min(sessionIndex++, sessions.length - 1)]!,
    isolated: true
  });

  const result = await harness.controllerHarness.invokePlannerCycle({
    userGoal: "Get the flag",
    scopeSummary: "Authorized target only"
  });
  const events = await harness.controller.executionLog.readAll();

  assert.equal(sessionIndex, 2);
  assert.equal(result.plannerDecision.decision, undefined);
  assert.ok(events.some((event) => event.eventType === "planner_prompt_failed"
    && event.summary === "Validation failed: reason is required"
    && event.payload.retryable === true));
  assert.ok(events.some((event) => event.eventType === "planner_prompt_retry_scheduled"));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("defers a retryable Planner outage without failing the run", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  let attempts = 0;
  const controllerHarness = controller as unknown as {
    runOnce: SecurityAgentController["runOnce"];
  };
  controllerHarness.runOnce = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new PromptRuntimeError("503 Service unavailable", "provider_unavailable");
    }
    return {
      plannerDecision: {
        decision: "apply_commands",
        commands: [],
        reason: "Recovered after the outage",
        basedOnRefs: []
      },
      quiescent: false
    };
  };

  const result = await controller.runUntilDone({
    userGoal: "Get the flag",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 1
  });

  assert.equal(attempts, 2);
  assert.equal(result.completed, false);
  assert.equal(result.stoppedReason, "Reached max consecutive no-progress planner cycles: 1");
  const events = await controller.executionLog.readAll();
  assert.ok(events.some((event) => event.eventType === "planner_cycle_deferred"));
  assert.equal(events.some((event) => event.eventType === "run_failed"), false);
  await controller.close({ drainProjectionJobs: false });
});

test("Planner stop abort does not create a fresh retry session", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const plannerSession = createAbortSensitivePlannerSession();
  let sessionCreateCount = 0;
  controllerHarness.createPlannerSessionForCycle = async () => {
    sessionCreateCount += 1;
    return { session: plannerSession as never, isolated: true };
  };

  const invocation = controllerHarness.invokePlannerCycle({
    userGoal: "Stop the active Planner cleanly",
    scopeSummary: "Local test only"
  });
  await waitFor(async () => plannerSession.promptCount() === 1);
  await controller.requestStop("Received SIGTERM");

  await assert.rejects(invocation);
  const events = await controller.executionLog.readAll();
  assert.equal(sessionCreateCount, 1);
  assert.ok(events.some((event) => event.eventType === "planner_prompt_aborted"));
  assert.equal(events.some((event) => event.eventType === "planner_prompt_retry_scheduled"), false);
  await controller.close({ drainProjectionJobs: false });
});

test("executor dependency handoff does not infer facts from graph or recent events", async () => {
  const harness = createControllerHarness();
  harness.controller.graphStore.upsertDelta({
    sourceEventIds: ["event:dependency"],
    nodes: [
      {
        id: "task:recon",
        graphKind: "task",
        type: "Task",
        label: "Recon target",
        properties: {
          status: "partial",
          resultSummary: "API key accepted by POST /api/upload.php",
          evidenceRefs: ["event:dependency"],
          artifactRefs: ["artifact:dependency"]
        }
      },
      {
        id: "endpoint:upload",
        graphKind: "operation",
        type: "WebEndpoint",
        label: "POST /api/upload.php",
        properties: { method: "POST", path: "/api/upload.php" }
      },
      {
        id: "session:admin",
        graphKind: "operation",
        type: "Session",
        label: "Valid admin session",
        properties: { status: "valid", role: "admin" }
      },
      {
        id: "exploit:upload-key",
        graphKind: "reasoning",
        type: "Exploit",
        label: "API key enables authenticated upload",
        properties: { status: "succeeded" },
        evidenceRefs: ["event:dependency"]
      }
    ],
    edges: [
      { from: "task:recon", to: "endpoint:upload", type: "requires_evidence" },
      { from: "task:recon", to: "session:admin", type: "creates_session", evidenceRefs: ["event:dependency"] },
      { from: "exploit:upload-key", to: "endpoint:upload", type: "affects", evidenceRefs: ["event:dependency"] }
    ]
  });
  await harness.controller.executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "assistant_intent",
    summary: "Reuse the accepted API key to upload a controlled file",
    payload: { text: "Reuse the accepted API key to upload a controlled file" }
  });
  await harness.controller.executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "tool_started",
    summary: "tool_started:bash",
    payload: {
      toolCallId: "call:upload",
      toolName: "bash",
      args: { command: "curl -H 'X-Api-Key: accepted-key' -F file=@poc.php /api/upload.php" }
    }
  });
  await harness.controller.executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "tool_finished",
    summary: "tool_finished:bash:ok",
    payload: {
      toolCallId: "call:upload",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Upload accepted at /files/poc.php" }] }
    }
  });

  const brief = await harness.controllerHarness.createDependencyOutcomeBrief(makeTaskEnvelope({
    taskId: "task:exploit",
    dependsOnTaskRefs: ["task:recon"]
  }));

  assert.match(brief, /"taskRef":"task:recon"/);
  assert.match(brief, /"graphStatus":"partial"/);
  assert.match(brief, /"outcome":null/);
  assert.doesNotMatch(brief, /X-Api-Key: accepted-key|Upload accepted|exploit:upload-key/);
  harness.controller.close();
});

test("executor dependency handoff uses the canonical TaskOutcome without event inference", async () => {
  const harness = createControllerHarness();
  harness.controller.graphStore.upsertDelta({
    sourceEventIds: ["event:dependency"],
    nodes: [{
      id: "task:recon",
      graphKind: "task",
      type: "Task",
      label: "Recon target",
      properties: { status: "completed" }
    }],
    edges: []
  });
  await harness.controller.executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "tool_started",
    summary: "tool_started:bash",
    payload: {
      toolCallId: "call:upload",
      toolName: "bash",
      args: { command: "curl -H 'X-Api-Key: accepted-key' -F file=@poc.php /api/upload.php" }
    }
  });
  await harness.controller.executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "tool_finished",
    summary: "tool_finished:bash:ok",
    payload: {
      toolCallId: "call:upload",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Upload accepted at /files/poc.php" }] }
    }
  });
  harness.controller.runtimeStore.upsertTaskOutcome({
    taskRef: "task:recon",
    epochRef: "epoch:recon-1",
    status: "completed",
    summary: "API key accepted by POST /api/upload.php",
    evidenceRefs: [],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 2,
    createdAt: new Date().toISOString()
  });

  const brief = await harness.controllerHarness.createDependencyOutcomeBrief(makeTaskEnvelope({
    taskId: "task:exploit",
    dependsOnTaskRefs: ["task:recon"]
  }));

  assert.match(brief, /"status":"completed"/);
  assert.match(brief, /API key accepted by POST \/api\/upload\.php/);
  assert.match(brief, /"capabilityRefs":\[\]/);
  assert.doesNotMatch(brief, /X-Api-Key: accepted-key/);
  harness.controller.close();
});

test("executor dependency handoff preserves Executor-selected Artifact order", async () => {
  const harness = createControllerHarness();
  harness.controller.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "task:material-source",
      graphKind: "task",
      type: "Task",
      label: "Build a stable capability invocation",
      properties: {
        status: "completed",
        goal: "Build a stable capability invocation",
        targetRefs: ["goal:root"],
        scopeRef: "scope:root",
        constraints: [],
        successCriteria: []
      }
    }],
    edges: []
  });
  const responseArtifact = await harness.controller.artifactStore.write({
    taskId: "task:material-source",
    kind: "http_body",
    mediaType: "text/plain",
    data: "accepted response oracle"
  });
  const scriptArtifact = await harness.controller.artifactStore.write({
    taskId: "task:material-source",
    kind: "poc",
    mediaType: "text/x-shellscript",
    data: "#!/bin/sh\ncurl --fail-with-body \"$TARGET/api/action\""
  });
  await harness.controller.executionLog.append({
    taskId: "task:material-source",
    role: "executor",
    eventType: "tool_finished",
    summary: "Archived the verified invocation script",
    payload: { toolName: "artifact_write" },
    artifactRefs: [scriptArtifact.artifactRef]
  });
  harness.controller.runtimeStore.upsertTaskOutcome({
    taskRef: "task:material-source",
    epochRef: "epoch:material-source",
    status: "completed",
    summary: "The archived invocation reproduces the accepted capability",
    evidenceRefs: [],
    artifactRefs: [responseArtifact.artifactRef, scriptArtifact.artifactRef],
    capabilityRefs: ["session:verified"],
    terminalSeq: 1,
    createdAt: new Date().toISOString()
  });

  const brief = await harness.controllerHarness.createDependencyOutcomeBrief(makeTaskEnvelope({
    taskId: "task:material-consumer",
    dependsOnTaskRefs: ["task:material-source"]
  }));

  assert.ok(brief.indexOf(responseArtifact.artifactRef) < brief.indexOf(scriptArtifact.artifactRef));
  assert.doesNotMatch(brief, /ordered by direct reuse value|curl --fail-with-body|Archived the verified/);
  assert.match(brief, /session:verified/);
  harness.controller.close();
});

test("executor session refs surface evidence-backed artifact refs", async () => {
  const harness = createControllerHarness();
  const materialEvent = await harness.controller.executionLog.append({
    taskId: "task:recon",
    role: "executor",
    eventType: "tool_finished",
    payload: { toolName: "artifact_write" },
    artifactRefs: ["artifact:cookie-jar"]
  });

  const enriched = harness.controllerHarness.withSessionMaterialRefs([
    { id: "projected:credential", type: "Credential", evidenceRefs: [materialEvent.id] },
    { id: "projected:session", type: "Session", evidenceRefs: ["event:missing"] }
  ]);

  assert.deepEqual(enriched[0]?.materialRefs, ["artifact:cookie-jar"]);
  assert.equal(enriched[1]?.materialRefs, undefined);
  harness.controller.close();
});

test("root graph initialization preserves an existing completed goal", async () => {
  const harness = createControllerHarness();
  harness.controller.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "goal:root",
      graphKind: "task",
      type: "Goal",
      label: "Get flag",
      properties: { status: "completed" }
    }],
    edges: []
  });

  await harness.controllerHarness.ensureRootGraph({
    userGoal: "Get flag",
    scopeSummary: "Authorized target only"
  });

  assert.equal(
    harness.controller.graphStore.query("task", ["goal:root"], 1).nodes[0]?.properties.status,
    "completed"
  );
  assert.deepEqual((await harness.controllerHarness.buildPlannerDecisionView()).rootRefs, {
    goalRef: "goal:root",
    scopeRef: "scope:root"
  });
  harness.controller.close();
});

test("planner decision view includes the canonical TaskOutcome before projection catches up", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ taskId: "task:runtime-tail" });
  harness.controller.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: taskEnvelope.taskId,
      graphKind: "task",
      type: "Task",
      label: taskEnvelope.goal,
      properties: {
        status: "partial",
        targetRefs: taskEnvelope.targetRefs,
        scopeRef: taskEnvelope.scopeRef,
        constraints: taskEnvelope.constraints,
        successCriteria: taskEnvelope.successCriteria
      }
    }],
    edges: []
  });
  await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "runtime",
    eventType: "task_created",
    summary: "Old task lifecycle event that must not outrank the latest result",
    payload: { goal: taskEnvelope.goal }
  });
  await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_started",
    summary: "tool_started:bash",
    payload: { toolCallId: "call:tail", toolName: "bash", args: { command: "read flag" } }
  });
  const finished = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "tool_finished:bash:ok",
    payload: {
      toolCallId: "call:tail",
      toolName: "bash",
      result: { content: [{ type: "text", text: "flag{visible_before_projection}" }] }
    }
  });
  const taskResultSummary = `${"Earlier exploration detail. ".repeat(10)}admin_token=internal_admin_token_2024`;
  const partial = await harness.controller.executionLog.append({
    taskId: taskEnvelope.taskId,
    role: "executor",
    eventType: "task_partial",
    summary: taskResultSummary,
    payload: { taskResult: { summary: taskResultSummary } }
  });
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, partial.seq ?? finished.seq ?? 0);
  harness.controller.runtimeStore.upsertTaskOutcome({
    taskRef: taskEnvelope.taskId,
    epochRef: "epoch:tail",
    status: "partial",
    summary: taskResultSummary,
    evidenceRefs: [partial.id],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: partial.seq ?? 0,
    createdAt: new Date().toISOString()
  });

  const view = await harness.controllerHarness.buildPlannerDecisionView();
  const prompt = renderPlannerInput({
    userGoal: "Recover the authorized target artifact",
    scopeSummary: "Authorized target only",
    plannerDecisionView: view
  });

  assert.match(view.taskOutcomes?.find((item) => item.taskRef === taskEnvelope.taskId)?.summary ?? "",
    /admin_token=internal_admin_token_2024/);
  assert.match(prompt, /admin_token=internal_admin_token_2024/);
  harness.controller.close();
});

test("planner uses the canonical task ledger and marks terminal projection degradation separately", async () => {
  const harness = createControllerHarness();
  const degradedTaskId = "task:degraded-terminal";
  harness.controller.graphStore.createTask({
    taskId: degradedTaskId,
    goal: "Continue through the verified route",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["route reused"],
    priority: 1
  });
  const taskEnvelope = harness.controller.graphStore.getTaskEnvelope(degradedTaskId)!;
  harness.controller.graphStore.updateTaskResult({
    taskEnvelope,
    taskResult: {
      taskId: degradedTaskId,
      status: "partial",
      summary: "Confirmed reusable internal route",
      evidenceRefs: ["event:route-confirmed"],
      artifactRefs: ["artifact:route-transcript"],
      capabilityRefs: ["route:internal"],
      checkpointReason: "projection timed out after task completion",
      retryable: true,
      resumeCursor: "resume from verified route"
    },
    sourceEventIds: ["event:route-confirmed"]
  });
  harness.controller.runtimeStore.raiseProjectionDesired(degradedTaskId, 21, 10, 21);
  harness.controller.runtimeStore.upsertTaskOutcome({
    taskRef: degradedTaskId,
    epochRef: "epoch:degraded",
    status: "partial",
    summary: "Confirmed reusable internal route",
    evidenceRefs: ["event:route-confirmed"],
    artifactRefs: ["artifact:route-transcript"],
    capabilityRefs: ["route:internal"],
    checkpoint: {
      reason: "projection timed out after task completion",
      retryable: true,
      resumeCursor: "resume from verified route"
    },
    terminalSeq: 21,
    createdAt: new Date().toISOString()
  });

  const view = await harness.controllerHarness.buildPlannerDecisionView();
  const prompt = renderPlannerInput({
    userGoal: "Continue from durable executor knowledge",
    scopeSummary: "Authorized target only",
    plannerDecisionView: view
  });

  assert.equal(view.taskOutcomes?.length, 1);
  assert.equal(view.taskLedger.find((task) => task.taskId === degradedTaskId)?.status, "open");
  assert.equal(view.taskOutcomes?.find((outcome) => outcome.taskRef === degradedTaskId)?.summary,
    "Confirmed reusable internal route");
  assert.deepEqual(view.projectionDegradations, [{
    taskRef: degradedTaskId,
    status: "degraded",
    reason: "terminal_projection_incomplete",
    committedSeq: 0,
    desiredSeq: 21,
    terminalTargetSeq: 21
  }]);
  assert.match(prompt, /"projectionDegradations":\[/);
  assert.match(prompt, /"status":"degraded"/);
  assert.match(prompt, /artifact:route-transcript/);
  assert.match(prompt, /route:internal/);
  assert.match(prompt, /resume from verified route/);
  await harness.controller.close({ drainProjectionJobs: false });
});

test("planner decision view reports projection lag without synthesizing event semantics", async () => {
  const harness = createControllerHarness();
  for (let index = 0; index < 5; index += 1) {
    const taskEnvelope = makeTaskEnvelope({
      taskId: `task:runtime-tail-${index}`,
      successCriteria: [`Persist projection result ${index}`]
    });
    harness.controller.graphStore.upsertDelta({
      sourceEventIds: [],
      nodes: [{
        id: taskEnvelope.taskId,
        graphKind: "task",
        type: "Task",
        label: taskEnvelope.goal,
        properties: {
          status: "partial",
          priority: 1,
          targetRefs: taskEnvelope.targetRefs,
          scopeRef: taskEnvelope.scopeRef,
          constraints: taskEnvelope.constraints,
          successCriteria: taskEnvelope.successCriteria
        }
      }],
      edges: []
    });
  }
  const pendingTaskId = "task:runtime-tail-4";
  await harness.controller.executionLog.append({
    taskId: pendingTaskId,
    role: "executor",
    eventType: "tool_started",
    summary: "tool_started:bash",
    payload: { toolCallId: "call:late-tail", toolName: "bash", args: { command: "verify capability" } }
  });
  const finished = await harness.controller.executionLog.append({
    taskId: pendingTaskId,
    role: "executor",
    eventType: "tool_finished",
    summary: "tool_finished:bash:ok",
    payload: {
      toolCallId: "call:late-tail",
      toolName: "bash",
      result: { content: [{ type: "text", text: "late ledger capability" }] }
    }
  });
  harness.controller.runtimeStore.raiseProjectionDesired(pendingTaskId, finished.seq ?? 0);

  const view = await harness.controllerHarness.buildPlannerDecisionView();

  assert.ok(view.projectionDegradations?.some((item) => item.taskRef === pendingTaskId));
  const pendingTask = view.taskLedger.find((task) => task.taskId === pendingTaskId);
  assert.deepEqual(pendingTask?.successCriteria, ["Persist projection result 4"]);
  assert.equal(pendingTask?.scopeRef, "scope:root");
  harness.controller.close();
});

test("dependency readiness uses Planner-owned Task status instead of Executor TaskOutcome", async () => {
  const harness = createControllerHarness();
  harness.controller.graphStore.createTasks([
    {
      taskId: "task:probe",
      goal: "Probe the target",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["probe complete"],
      priority: 1
    },
    {
      taskId: "task:exploit",
      goal: "Use the completed probe",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["exploit complete"],
      dependsOnTaskRefs: ["task:probe"],
      priority: 2
    }
  ]);
  harness.controller.graphStore.markTaskStatus({
    taskId: "task:probe",
    status: "archived",
    properties: { resultSummary: "Useful stage result exists" }
  });
  harness.controller.runtimeStore.upsertTaskOutcome({
    taskRef: "task:probe",
    epochRef: "epoch:probe-partial",
    status: "partial",
    summary: "Useful but incomplete probe",
    evidenceRefs: ["event:probe-partial"],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 4,
    createdAt: "2026-07-30T00:00:00.000Z"
  });

  const partialView = await harness.controllerHarness.buildPlannerDecisionView();
  const partialChild = partialView.taskLedger.find((task) => task.taskId === "task:exploit");
  assert.equal(partialChild?.ready, false);
  assert.deepEqual(partialChild?.blockedByTaskRefs, ["task:probe"]);
  assert.deepEqual(partialChild?.dependencyStatuses, { "task:probe": "archived" });

  harness.controller.runtimeStore.upsertTaskOutcome({
    taskRef: "task:probe",
    epochRef: "epoch:probe-completed",
    status: "completed",
    summary: "Probe success criteria satisfied",
    evidenceRefs: ["event:probe-completed"],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 8,
    createdAt: "2026-07-30T00:01:00.000Z"
  });

  const beforePlannerAcceptance = await harness.controllerHarness.buildPlannerDecisionView();
  assert.equal(beforePlannerAcceptance.taskLedger.find((task) => task.taskId === "task:exploit")?.ready, false);

  harness.controller.graphStore.setTaskStatus({
    taskId: "task:probe",
    status: "completed",
    reason: "Planner accepted the completed TaskOutcome"
  });
  const completedView = await harness.controllerHarness.buildPlannerDecisionView();
  const completedChild = completedView.taskLedger.find((task) => task.taskId === "task:exploit");
  assert.equal(completedChild?.ready, true);
  assert.deepEqual(completedChild?.blockedByTaskRefs, []);
  assert.deepEqual(completedChild?.dependencyStatuses, { "task:probe": "completed" });
  harness.controller.close();
});

test("retries executor when provider returns a retryable concurrency error", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const executorSession = createProviderErrorThenSuccessSession(
    "Concurrency limit exceeded for user, please retry later",
    JSON.stringify({
      taskId: "task:retry-provider",
      status: "completed",
      summary: "Recovered after provider retry",
      evidenceRefs: [],
      artifactRefs: []
    })
  );
  const observerSession = createAbortableMockTextSession(JSON.stringify({
    nodes: [],
    edges: []
  }));
  controllerHarness.agents = {
    planner: createMockTextSession(JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [{
          id: "task:retry-provider",
          goal: "Run executor despite transient provider errors",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: [],
          successCriteria: ["executor returns a result"],
          budget: { maxTurns: 1 },
          priority: 1
        }],
        reason: "Start retry task",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Start retry task",
      basedOnRefs: ["goal:root"]
    })),
    executor: executorSession,
    observer: observerSession
  };
  controllerHarness.createObserverSessionForMode = async () => ({
    session: observerSession,
    dynamicObserver: true
  });

  const result = await controller.runOnce({
    userGoal: "Retry provider errors",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });

  assert.equal(result.taskResult?.status, "completed");
  assert.equal(result.taskResult?.summary, "Recovered after provider retry");
  assert.equal(executorSession.promptCount(), 2);
  assert.equal(controller.runtimeStore.countTaskEpochs("task:retry-provider"), 2);
  const events = await controller.executionLog.readAll();
  assert.ok(events.some((event) => event.eventType === "executor_provider_retry_scheduled"));
  controller.close();
});

test("pure provider failure records an EpochOutcome without fabricating TaskOutcome", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const executorSession = createProviderErrorSession("Concurrency limit exceeded for user, please retry later");
  const observerSession = createAbortableMockTextSession(observerProjectionJson());
  controllerHarness.agents = {
    planner: createMockTextSession(JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [{
          id: "task:pure-provider-failure",
          goal: "Run executor against transient provider error",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: [],
          successCriteria: ["executor returns a result"],
          budget: { maxTurns: 1 },
          priority: 1
        }],
        reason: "Start provider failure task",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Start provider failure task",
      basedOnRefs: ["goal:root"]
    })),
    executor: executorSession,
    observer: observerSession
  };

  const result = await controller.runOnce({
    userGoal: "Handle provider errors",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });

  assert.equal(result.taskResult, undefined);
  assert.ok(executorSession.promptCount() >= 3);
  const events = await controller.executionLog.readAll();
  assert.ok(events.some((event) => event.eventType === "epoch_provider_error"));
  assert.equal(controller.graphStore.getTaskNode("task:pure-provider-failure")?.properties.status, "open");
  assert.equal(controller.runtimeStore.getTaskOutcome("task:pure-provider-failure"), undefined);
  const epochOutcomes = controller.runtimeStore.listTaskEpochOutcomes("task:pure-provider-failure");
  assert.equal(epochOutcomes.at(-1)?.status, "provider_error");
  assert.equal(epochOutcomes.at(-1)?.retryable, true);
  assert.match(epochOutcomes.at(-1)?.reason ?? "", /Concurrency limit exceeded/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(executorSession.promptCount(), 3);
  const schedulerState = controller as unknown as {
    activeTaskRuns: Map<string, unknown>;
    awaitingPlannerTaskIds: Set<string>;
  };
  assert.equal(schedulerState.activeTaskRuns.has("task:pure-provider-failure"), false);
  assert.equal(schedulerState.awaitingPlannerTaskIds.has("task:pure-provider-failure"), true);
  await controller.close();
  const reopened = createControllerWithTestLlmEnv(runtimeDir);
  await reopened.initialize();
  assert.equal(reopened.graphStore.getTaskNode("task:pure-provider-failure")?.properties.status, "open");
  assert.equal(reopened.graphStore.listOpenTasks().some((task) => task.taskId === "task:pure-provider-failure"), true);
  assert.equal((reopened as unknown as { awaitingPlannerTaskIds: Set<string> })
    .awaitingPlannerTaskIds.has("task:pure-provider-failure"), true);
  await reopened.close();
});

test("Planner reference validation can resolve persisted EpochOutcome refs", async () => {
  const harness = createControllerHarness();
  harness.controller.runtimeStore.upsertEpochOutcome({
    epochRef: "epoch:bf9d37a1-verified",
    taskRef: "task:recon",
    status: "provider_error",
    reason: "retryable provider response",
    terminalSeq: 12,
    retryable: true,
    createdAt: "2026-08-03T00:00:00.000Z"
  });

  assert.deepEqual(
    harness.controllerHarness.plannerReferenceCandidates("epoch:bf9d"),
    ["epoch:bf9d37a1-verified"]
  );
  await harness.controller.close({ drainProjectionJobs: false });
});

test("retryable checkpoint EpochOutcome resumes an open Task with remaining allocation", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({
    taskId: "task:checkpoint-resume",
    budget: { maxTurns: 30 }
  });
  harness.controller.graphStore.createTask({ ...taskEnvelope, priority: 1 });
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  for (let turn = 1; turn <= DEFAULT_EPOCH_TURN_SLICE; turn += 1) {
    harness.controller.runtimeStore.recordTaskTurn({
      taskId: taskEnvelope.taskId,
      eventId: `event:checkpoint-resume:${turn}`
    });
  }
  const persisted = await harness.controllerHarness.persistEpochOutcome(state, {
    status: "checkpointed",
    reason: `Epoch turn slice reached: maxTurns=${DEFAULT_EPOCH_TURN_SLICE}`,
    retryable: true
  });
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
  const schedulerState = harness.controller as unknown as { awaitingPlannerTaskIds: Set<string> };
  schedulerState.awaitingPlannerTaskIds.add(taskEnvelope.taskId);

  const released = await harness.controllerHarness.releasePlannerWaitingTasks({
    commands: [],
    reason: "Continue the same Task after its retryable Epoch checkpoint"
  }, new Set([taskEnvelope.taskId]));
  const events = await harness.controller.executionLog.readAll();

  assert.deepEqual(released, [taskEnvelope.taskId]);
  assert.equal(schedulerState.awaitingPlannerTaskIds.has(taskEnvelope.taskId), false);
  assert.equal(persisted.outcome.taskOutcomeRef, undefined);
  assert.equal(harness.controller.runtimeStore.getTaskConsumedTurns(taskEnvelope.taskId), DEFAULT_EPOCH_TURN_SLICE);
  assert.ok(events.some((event) => event.eventType === "planner_handoff_resolved"
    && event.taskId === taskEnvelope.taskId
    && event.payload.resolution === "resume_retryable_epoch"
    && event.payload.remainingTurns === 30 - DEFAULT_EPOCH_TURN_SLICE));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("Planner empty decision resumes an open Task after a blocked outcome", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({
    taskId: "task:blocked-resume",
    budget: { maxTurns: 60 }
  });
  harness.controller.graphStore.createTask({ ...taskEnvelope, priority: 1 });
  harness.controller.graphStore.markTaskStatus({
    taskId: taskEnvelope.taskId,
    status: "open"
  });
  for (let turn = 1; turn <= 36; turn += 1) {
    harness.controller.runtimeStore.recordTaskTurn({
      taskId: taskEnvelope.taskId,
      eventId: `event:blocked-resume:${turn}`
    });
  }
  harness.controller.runtimeStore.upsertTaskOutcome({
    taskRef: taskEnvelope.taskId,
    epochRef: "epoch:blocked-resume",
    status: "blocked",
    summary: "The previous epoch reached a temporary external blocker",
    evidenceRefs: [],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 40,
    createdAt: new Date().toISOString()
  });
  harness.controller.runtimeStore.upsertEpochOutcome({
    epochRef: "epoch:blocked-resume",
    taskRef: taskEnvelope.taskId,
    status: "submitted",
    reason: "Executor reported a blocked outcome",
    taskOutcomeRef: taskEnvelope.taskId,
    terminalSeq: 40,
    retryable: false,
    createdAt: new Date().toISOString()
  });
  const schedulerState = harness.controller as unknown as { awaitingPlannerTaskIds: Set<string> };
  schedulerState.awaitingPlannerTaskIds.add(taskEnvelope.taskId);

  const released = await harness.controllerHarness.releasePlannerWaitingTasks({
    commands: [],
    reason: "Keep the open Task and continue with its remaining allocation"
  }, new Set([taskEnvelope.taskId]));
  const events = await harness.controller.executionLog.readAll();

  assert.deepEqual(released, [taskEnvelope.taskId]);
  assert.equal(schedulerState.awaitingPlannerTaskIds.has(taskEnvelope.taskId), false);
  assert.ok(events.some((event) => event.eventType === "planner_handoff_resolved"
    && event.taskId === taskEnvelope.taskId
    && event.payload.resolution === "resume_open_task"
    && event.payload.taskOutcomeRef === taskEnvelope.taskId
    && event.payload.remainingTurns === 24));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("initialize preserves a persisted partial handoff resolution", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const first = createControllerWithTestLlmEnv(runtimeDir);
  first.graphStore.createTasks([{
    taskId: "task:resolved-partial",
    goal: "Continue a reviewed partial task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["complete the remaining work"],
    budget: { maxTurns: 10 },
    priority: 1
  }]);
  const partial = await first.executionLog.append({
    taskId: "task:resolved-partial",
    role: "executor",
    eventType: "task_partial",
    summary: "A reusable capability exists and the remaining work is known",
    payload: {}
  });
  first.runtimeStore.upsertTaskOutcome({
    taskRef: "task:resolved-partial",
    epochRef: "epoch:resolved-partial",
    status: "partial",
    summary: "A reusable capability exists and the remaining work is known",
    evidenceRefs: [partial.id],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: partial.seq ?? 0,
    createdAt: new Date().toISOString()
  });
  await first.executionLog.append({
    taskId: "task:resolved-partial",
    role: "runtime",
    eventType: "planner_handoff_resolved",
    summary: "Continue the reviewed partial task",
    payload: { resolution: "resume_partial", taskOutcomeRef: "task:resolved-partial", remainingTurns: 10 }
  });
  await first.close({ drainProjectionJobs: false });

  const reopened = createControllerWithTestLlmEnv(runtimeDir);
  await reopened.initialize();
  assert.equal((reopened as unknown as { awaitingPlannerTaskIds: Set<string> })
    .awaitingPlannerTaskIds.has("task:resolved-partial"), false);
  assert.equal((await (reopened as unknown as ControllerHarness).buildPlannerDecisionView())
    .taskLedger.find((task) => task.taskId === "task:resolved-partial")?.executionState, "queued");
  await reopened.close({ drainProjectionJobs: false });
});

test("pure provider failure does not create a Planner projection fence", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness & {
    runExecutorTask: (taskEnvelope: TaskEnvelope) => Promise<{
      taskEnvelope: TaskEnvelope;
      taskResult: TaskResult;
      terminalSeq: number;
      controlSignal: ControlSignal;
    }>;
  };
  const plannerSession = createMockTextSessionSequence([
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [{
          id: "task:pure-provider-failure-fence",
          goal: "Exercise a provider failure without projection input",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: [],
          successCriteria: ["failure handed back"],
          priority: 1
        }],
        reason: "Start the provider-failure task",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Start the provider-failure task",
      basedOnRefs: ["goal:root"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_node_status",
        nodeId: "goal:root",
        status: "achieved",
        reason: "The provider failure was handed back without a projection dependency"
      }],
      reason: "Finish after receiving the persisted task outcome",
      basedOnRefs: ["task:pure-provider-failure-fence"]
    })
  ]);
  controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession(observerProjectionJson())
  };
  controllerHarness.runExecutorTask = async (taskEnvelope) => {
    const taskResult: TaskResult = {
      taskId: taskEnvelope.taskId,
      status: "failed",
      summary: "Provider rejected the invocation before any execution evidence",
      evidenceRefs: [],
      artifactRefs: [],
      retryable: true,
      checkpointReason: "provider concurrency"
    };
    controller.graphStore.markTaskStatus({
      taskId: taskEnvelope.taskId,
      status: "open",
      properties: { resultSummary: taskResult.summary, retryable: true }
    });
    return {
      taskEnvelope,
      taskResult,
      terminalSeq: 99,
      controlSignal: {
        decision: "need_planner",
        reason: taskResult.summary,
        evidenceRefs: []
      }
    };
  };

  const stopTimer = setTimeout(() => {
    void controller.requestStop("projection fence regression timeout");
  }, 500);
  const result = await controller.runUntilDone({
    userGoal: "Verify provider failure handoff",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 2,
    maxParallelTasks: 1
  });
  clearTimeout(stopTimer);

  assert.equal(result.completed, true);
  assert.equal(plannerSession.promptCount(), 2);
  assert.equal(
    (await controller.executionLog.readAll()).some((event) => event.eventType === "planner_projection_degraded"),
    false
  );
  await controller.close({ drainProjectionJobs: false });
});

test("planner cycle is not blocked by lagging projection watermarks", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  controller.graphStore.createTask({
    taskId: "task:lagging",
    goal: "Use the confirmed internal panel access",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["panel used"],
    priority: 1
  });
  controller.runtimeStore.upsertTaskOutcome({
    taskRef: "task:lagging",
    epochRef: "epoch:lagging",
    status: "completed",
    summary: "Confirmed access to the internal panel",
    evidenceRefs: [],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 9,
    createdAt: new Date().toISOString()
  });
  controller.runtimeStore.raiseProjectionDesired("task:lagging", 9, 10, 9);
  let waitForCommittedCalls = 0;
  controllerHarness.projectorCoordinator.waitForCommitted = async () => {
    waitForCommittedCalls += 1;
    throw new Error("waitForCommitted must not gate the Planner");
  };
  const plannerSession = createMockTextSession(JSON.stringify({
    decision: "apply_commands",
    commands: [{
      kind: "set_node_status",
      nodeId: "goal:root",
      status: "achieved",
      reason: "Close the run without waiting for projection"
    }],
    reason: "Close the run without waiting for projection",
    basedOnRefs: ["goal:root"]
  }));
  controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession(observerProjectionJson())
  };

  const result = await controller.runOnce({
    userGoal: "Do not stall on projection watermarks",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });

  assert.equal(result.plannerDecision.decision, undefined);
  assert.equal(plannerSession.promptCount(), 1);
  assert.equal(waitForCommittedCalls, 0);
  assert.match(plannerSession.prompts()[0] ?? "", /"projectionDegradations":\[/);
  assert.match(plannerSession.prompts()[0] ?? "", /task:lagging/);
  await controller.close({ drainProjectionJobs: false });
});

test("active Planner consumes a persisted TaskOutcome before its terminal decision settles", async () => {
  const harness = createControllerHarness();
  harness.controllerHarness.structuredInvocationsEnabled = true;
  await harness.controllerHarness.ensureRootGraph({
    userGoal: "Recover the target evidence",
    scopeSummary: "Authorized target only"
  });
  harness.controller.graphStore.createTask({
    taskId: "task:concurrent-outcome",
    goal: "Produce a durable result",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["result persisted"],
    priority: 1
  });
  const taskEnvelope = harness.controller.graphStore.getTaskEnvelope("task:concurrent-outcome")!;
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  const listeners: Array<(event: unknown) => void> = [];
  const releaseFirstSubmit = createDeferred<void>();
  const steers: string[] = [];
  let pendingMessageCount = 0;
  const replacementDecision: PlannerDecision = {
    commands: [{
      kind: "create_tasks",
      tasks: [{
        id: "task:follow-up-after-outcome",
        goal: "Use the newly persisted outcome",
        targetRefs: ["goal:root"],
        scopeRef: "scope:root",
        successCriteria: ["follow-up completed"],
        priority: 1
      }],
      reason: "Continue from the canonical outcome",
      basedOnRefs: ["goal:root"]
    }],
    reason: "decision after canonical outcome delivery"
  };
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const plannerSession = {
    async prompt(): Promise<void> {
      await releaseFirstSubmit.promise;
      let staleSubmitError: unknown;
      try {
        harness.controllerHarness.validatePlannerRuntimeBoundary(replacementDecision);
      } catch (error) {
        staleSubmitError = error;
      }
      assert.ok(staleSubmitError instanceof Error);
      assert.match(staleSubmitError.message, /rejected and none of its commands were applied/);
      emit({
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: true,
        result: { content: [{ type: "text", text: staleSubmitError.message }] }
      });
      pendingMessageCount = 0;
      emit({
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: steers.at(-1) ?? "" }] }
      });
      harness.controllerHarness.validatePlannerRuntimeBoundary(replacementDecision);
      emit({
        type: "tool_execution_end",
        toolName: "planner_submit",
        isError: false,
        result: { details: replacementDecision }
      });
    },
    async steer(text: string): Promise<void> {
      steers.push(text);
      pendingMessageCount += 1;
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    get pendingMessageCount(): number {
      return pendingMessageCount;
    },
    clearQueue(): void {
      pendingMessageCount = 0;
    },
    async abort(): Promise<void> {}
  };
  harness.controllerHarness.createPlannerSessionForCycle = async () => ({
    session: plannerSession as unknown as ReturnType<typeof createAbortableMockTextSession>,
    isolated: false
  });

  const invocation = harness.controllerHarness.invokePlannerCycle({
    userGoal: "Recover the target evidence",
    scopeSummary: "Authorized target only"
  });
  await waitFor(() => harness.controllerHarness.activePlannerSessions.size === 1);
  await harness.controllerHarness.persistEpochOutcome(state, {
    status: "submitted",
    reason: "Executor submitted a partial result",
    retryable: true,
    taskOutcomeRef: taskEnvelope.taskId,
    taskOutcome: {
      taskRef: taskEnvelope.taskId,
      epochRef: state.epochId,
      status: "partial",
      summary: "Canonical result discovered while Planner was running",
      evidenceRefs: ["event:outcome"],
      artifactRefs: [],
      capabilityRefs: [],
      terminalSeq: 10,
      createdAt: new Date(0).toISOString()
    }
  });
  assert.equal(steers.length, 1);
  assert.match(steers[0] ?? "", /Canonical result discovered while Planner was running/);
  assert.match(steers[0] ?? "", /"epochOutcomes"/);
  releaseFirstSubmit.resolve();

  const result = await invocation;
  assert.equal(result.plannerDecision.reason, "decision after canonical outcome delivery");
  assert.equal(result.plannerDecision.commands?.[0]?.kind, "create_tasks");
  assert.equal(
    result.plannerDecision.commands?.[0]?.kind === "create_tasks"
      ? result.plannerDecision.commands[0].tasks[0]?.id
      : undefined,
    "task:follow-up-after-outcome"
  );
  assert.equal(harness.controller.runtimeStore.getTaskOutcome(taskEnvelope.taskId)?.status, "partial");
  assert.equal(harness.controller.runtimeStore.listTaskEpochOutcomes(taskEnvelope.taskId).length, 1);
  const events = await harness.controller.executionLog.readAll();
  assert.ok(events.some((event) => event.eventType === "planner_state_update_queued"
    && event.payload.queuedCount === 1
    && event.payload.submissionInvalidated === true));
  harness.controllerHarness.finishTaskExecution(taskEnvelope.taskId);
  await harness.controller.close({ drainProjectionJobs: false });
});

test("Projector knowledge steer does not invalidate an active Planner submission", async () => {
  const harness = createControllerHarness();
  harness.controllerHarness.structuredInvocationsEnabled = true;
  await harness.controllerHarness.ensureRootGraph({
    userGoal: "Use current persisted knowledge",
    scopeSummary: "Authorized target only"
  });
  const releaseSubmit = createDeferred<void>();
  const listeners: Array<(event: unknown) => void> = [];
  const steers: string[] = [];
  let pendingMessageCount = 0;
  const decision: PlannerDecision = {
    commands: [],
    reason: "No scheduling change is required"
  };
  const plannerSession = {
    async prompt(): Promise<void> {
      await releaseSubmit.promise;
      harness.controllerHarness.validatePlannerRuntimeBoundary(decision);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName: "planner_submit",
          isError: false,
          result: { details: decision }
        });
      }
    },
    async steer(text: string): Promise<void> {
      steers.push(text);
      pendingMessageCount += 1;
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    get pendingMessageCount(): number {
      return pendingMessageCount;
    },
    clearQueue(): void {
      pendingMessageCount = 0;
    },
    async abort(): Promise<void> {}
  };
  harness.controllerHarness.createPlannerSessionForCycle = async () => ({
    session: plannerSession as unknown as ReturnType<typeof createAbortableMockTextSession>,
    isolated: false
  });

  const invocation = harness.controllerHarness.invokePlannerCycle({
    userGoal: "Use current persisted knowledge",
    scopeSummary: "Authorized target only"
  });
  await waitFor(() => harness.controllerHarness.activePlannerSessions.size === 1);
  await harness.controllerHarness.notifyProjectorGraphCommitted("task:projected", {
    sourceEventIds: ["event:projected"],
    nodes: [{
      id: "hypothesis:projected",
      graphKind: "reasoning",
      type: "Hypothesis",
      label: "New persisted knowledge",
      properties: { status: "open" },
      evidenceRefs: ["event:projected"]
    }],
    edges: []
  });
  assert.equal(steers.length, 1);
  assert.equal(pendingMessageCount, 1);
  releaseSubmit.resolve();

  const result = await invocation;
  assert.equal(result.plannerDecision.reason, decision.reason);
  const events = await harness.controller.executionLog.readAll();
  assert.ok(events.some((event) => event.eventType === "planner_state_update_queued"
    && event.payload.submissionInvalidated === false));
  await harness.controller.close({ drainProjectionJobs: false });
});

test("every projector commit sends an evidence-backed semantic manifest to all active executors", async () => {
  const harness = createControllerHarness();
  const steersByTask = new Map<string, string[]>();
  const plannerSteers: string[] = [];
  harness.controllerHarness.activePlannerSessions.add({
    async steer(text: string): Promise<void> {
      plannerSteers.push(text);
    },
    async abort(): Promise<void> {}
  });
  const sessionFor = (taskId: string) => ({
    async steer(text: string): Promise<void> {
      steersByTask.set(taskId, [...(steersByTask.get(taskId) ?? []), text]);
    },
    async abort(): Promise<void> {}
  });
  const stateA = harness.controllerHarness.beginTaskExecution(makeTaskEnvelope({ taskId: "task:alpha" }));
  stateA.executorSession = sessionFor("task:alpha");
  const stateB = harness.controllerHarness.beginTaskExecution(
    makeTaskEnvelope({ taskId: "task:beta", dependsOnTaskRefs: ["task:alpha"] })
  );
  stateB.executorSession = sessionFor("task:beta");
  const stateC = harness.controllerHarness.beginTaskExecution(makeTaskEnvelope({ taskId: "task:gamma" }));
  stateC.executorSession = sessionFor("task:gamma");
  const delta: GraphDelta = {
    sourceEventIds: ["event:1"],
    nodes: [
      {
        id: "vuln:x",
        graphKind: "reasoning",
        type: "Hypothesis",
        label: "session-file inclusion",
        properties: {
          status: "refuted",
          target: "/include",
          method: "session file candidates",
          preconditions: ["unauthenticated"],
          negativeConclusion: "tested candidates did not resolve",
          reopenConditions: "valid session id observed",
          artifactRefs: ["artifact:negative-matrix"]
        },
        evidenceRefs: ["event:1"]
      },
      { id: "vuln:y", graphKind: "reasoning", type: "Vulnerability", label: "y", properties: {}, evidenceRefs: ["event:1"] },
      { id: "cred:z", graphKind: "operation", type: "Credential", label: "z", properties: {}, evidenceRefs: ["event:1"] }
    ],
    edges: [{ from: "cred:z", to: "vuln:x", type: "enables", evidenceRefs: ["event:1"] }]
  };

  await harness.controllerHarness.notifyProjectorGraphCommitted("task:alpha", delta);

  assert.equal(steersByTask.get("task:alpha")?.length, 1);
  assert.match(steersByTask.get("task:alpha")?.[0] ?? "", /作战图已提交增量/);
  assert.match(steersByTask.get("task:alpha")?.[0] ?? "", /"nodeRefs":\["vuln:x","vuln:y","cred:z"\]/);
  assert.match(steersByTask.get("task:alpha")?.[0] ?? "", /tested candidates did not resolve/);
  assert.match(steersByTask.get("task:alpha")?.[0] ?? "", /artifact:negative-matrix/);
  assert.equal(steersByTask.get("task:beta")?.length, 1);
  assert.equal(steersByTask.get("task:gamma")?.length, 1);
  // Planner is mid-invocation: it gets the graph-tool variant of the nudge.
  assert.equal(plannerSteers.length, 1);
  assert.match(plannerSteers[0] ?? "", /请自主判断是否需要查询/);

  await harness.controllerHarness.notifyProjectorGraphCommitted("task:alpha", delta);
  assert.equal(steersByTask.get("task:alpha")?.length, 2);
  assert.equal(steersByTask.get("task:beta")?.length, 2);
  assert.equal(steersByTask.get("task:gamma")?.length, 2);
  assert.equal(plannerSteers.length, 2);

  (harness.controllerHarness as { lastPlannerGraphUpdateSteerAt?: number }).lastPlannerGraphUpdateSteerAt = Date.now() - 61_000;
  stateA.lastGraphUpdateSteerAt = Date.now() - 61_000;
  await harness.controllerHarness.notifyProjectorGraphCommitted("task:alpha", delta);
  assert.equal(steersByTask.get("task:alpha")?.length, 3);
  assert.equal(steersByTask.get("task:beta")?.length, 3);
  assert.equal(steersByTask.get("task:gamma")?.length, 3);
  assert.equal(plannerSteers.length, 3);

  stateB.executorStopRequested = true;
  stateB.lastGraphUpdateSteerAt = Date.now() - 61_000;
  await harness.controllerHarness.notifyProjectorGraphCommitted("task:alpha", delta);
  assert.equal(steersByTask.get("task:alpha")?.length, 4);
  assert.equal(steersByTask.get("task:beta")?.length, 3);
  assert.equal(steersByTask.get("task:gamma")?.length, 4);
  assert.equal(plannerSteers.length, 4);

  await harness.controllerHarness.notifyProjectorGraphCommitted("task:alpha", {
    sourceEventIds: [],
    nodes: [],
    edges: []
  });
  const notified = (await harness.controller.executionLog.readAll())
    .filter((event) => event.eventType === "graph_update_notified");
  assert.equal(notified.length, 4);
  assert.deepEqual([...(notified[0]?.payload.notifiedTaskIds as string[])].sort(), ["task:alpha", "task:beta", "task:gamma"]);
  assert.equal(notified[0]?.payload.nodeCount, 3);
  assert.equal(notified[0]?.payload.edgeCount, 1);
  assert.equal(notified[0]?.payload.plannerUpdateQueued, true);
  assert.deepEqual(notified[0]?.payload.artifactRefs, ["artifact:negative-matrix"]);
  assert.deepEqual(notified[0]?.payload.statusChanges, []);
  assert.deepEqual([...(notified[3]?.payload.notifiedTaskIds as string[])].sort(), ["task:alpha", "task:gamma"]);
  harness.controller.close();
});

test("projection job commit steers the active executor with the graph update", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const steers: string[] = [];
  controllerHarness.agents = {
    planner: {},
    observer: {},
    executor: {
      async steer(text: string): Promise<void> {
        steers.push(text);
      },
      async abort(): Promise<void> {}
    }
  };
  const taskEnvelope = makeTaskEnvelope({ taskId: "task:notify-commit" });
  activateTask(controllerHarness, taskEnvelope);
  const sourceEvent = await persistExecutorEvent(controller, taskEnvelope.taskId, "tool_finished", "panel discovered");
  const projectorSession = createDelayedAbortableMockTextSession(async () => projectionDeltaJson("evidence:panel", sourceEvent.id));
  controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });

  const projection = await controllerHarness.enqueueProjectionJob({
    reason: "project_window:16",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id]
  });

  assert.ok(projection.graphDelta.nodes.length > 0);
  assert.equal(steers.length, 1);
  assert.match(steers[0] ?? "", /作战图已提交增量/);
  assert.match(steers[0] ?? "", /"nodeRefs":\[/);
  const notified = (await controller.executionLog.readAll())
    .filter((event) => event.eventType === "graph_update_notified");
  assert.equal(notified.length, 1);
  assert.deepEqual(notified[0]?.payload.notifiedTaskIds, ["task:notify-commit"]);
  assert.equal(notified[0]?.payload.nodeCount, 2);
  assert.equal(notified[0]?.payload.edgeCount, 1);
  await controller.close({ drainProjectionJobs: false });
});

test("provider outage freezes the epoch clock until provider retry completes", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET } });
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = harness.controllerHarness.agents.executor;
  harness.controllerHarness.activeRun = {
    invocationId: "run:test",
    startedAt: Date.now(),
    maxRunTimeMs: 60_000,
    deadlineAt: Date.now() + 60_000,
    startSeq: 0
  };
  harness.controllerHarness.armEpochTimeSlice(taskEnvelope);
  const initialBudget = state.epochBudgetClock!.snapshot();

  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "provider_retry_started",
    { attempt: 1, delayMs: 500 },
    "event:retry-1"
  ));
  assert.ok(state.epochBudgetClock!.snapshot().pausedAt !== undefined);
  const outageStartedAt = state.epochBudgetClock!.snapshot().pausedAt;
  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "provider_retry_started",
    { attempt: 2, delayMs: 500 },
    "event:retry-2"
  ));
  assert.equal(state.epochBudgetClock!.snapshot().pausedAt, outageStartedAt);

  await new Promise((resolve) => setTimeout(resolve, 25));
  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "provider_retry_completed",
    { attempt: 2, success: true },
    "event:retry-complete-1"
  ));

  const resumedBudget = state.epochBudgetClock!.snapshot();
  assert.equal(resumedBudget.pausedAt, undefined);
  assert.ok(resumedBudget.accumulatedPauseMs >= 20);
  assert.ok(resumedBudget.deadlineAt >= initialBudget.deadlineAt + 20);
  assert.equal(resumedBudget.remainingMs <= initialBudget.remainingMs, true);
  const extended = (await harness.controller.executionLog.readAll())
    .find((event) => event.eventType === "epoch_budget_resumed");
  assert.ok(extended);
  assert.ok(Number(extended.payload.outageMs) >= 20);
  assert.equal(extended.payload.providerDowntimeMs, resumedBudget.accumulatedPauseMs);

  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "turn_usage",
    {},
    "event:turn-after-outage"
  ));
  const budgetUpdate = (await harness.controller.executionLog.readAll())
    .find((event) => event.eventType === "budget_status_updated");
  assert.ok(Number((budgetUpdate?.payload.budgetStatus as Record<string, unknown> | undefined)?.providerDowntimeMs) >= 20);
  assert.ok(harness.steers().some((message) => /providerDowntimeMs: [1-9]\d*/.test(message)));
  harness.controllerHarness.clearEpochTimeSlice();
  harness.controller.close();
});

test("provider outage accounting does not re-arm a closing epoch", async () => {
  const harness = createControllerHarness();
  const taskEnvelope = makeTaskEnvelope({ budget: { ...DEFAULT_TASK_BUDGET } });
  const state = harness.controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = harness.controllerHarness.agents.executor;
  harness.controllerHarness.activeRun = {
    invocationId: "run:test",
    startedAt: Date.now(),
    maxRunTimeMs: 60_000,
    deadlineAt: Date.now() + 60_000,
    startSeq: 0
  };
  harness.controllerHarness.armEpochTimeSlice(taskEnvelope);
  const initialDeadline = state.epochBudgetClock!.snapshot().deadlineAt;

  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "provider_error",
    { errorKind: "llm_error", llmError: { retryable: false, message: "400 bad request" } },
    "event:perror-1"
  ));
  assert.equal(state.epochBudgetClock!.snapshot().pausedAt, undefined);

  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "provider_error",
    { errorKind: "provider_rate_limit", llmError: { retryable: true, message: "429 too many requests" } },
    "event:perror-2"
  ));
  assert.ok(state.epochBudgetClock!.snapshot().pausedAt !== undefined);

  state.lifecycleState = "closing";
  await new Promise((resolve) => setTimeout(resolve, 20));
  await harness.controllerHarness.handleExecutorEventPersisted(makeExecutionEvent(
    taskEnvelope.taskId,
    "provider_retry_completed",
    { attempt: 1, success: false },
    "event:retry-complete-2"
  ));

  const closedBudget = state.epochBudgetClock!.snapshot();
  assert.equal(closedBudget.pausedAt, undefined);
  assert.ok(closedBudget.accumulatedPauseMs >= 15);
  assert.ok(closedBudget.deadlineAt >= initialDeadline + 15);
  assert.equal(
    (await harness.controller.executionLog.readAll()).some((event) => event.eventType === "epoch_budget_resumed"),
    false
  );
  harness.controllerHarness.clearEpochTimeSlice();
  harness.controller.close();
});

test("controller active-task boundary and GraphStore semantic gate remain independently owned", async () => {
  const harness = createControllerHarness();
  await harness.controllerHarness.ensureRootGraph({ userGoal: "Gate test", scopeSummary: "Authorized target only" });
  for (const taskId of ["task:existing", "task:a", "task:b", "task:conflict", "task:running"]) {
    harness.controller.graphStore.createTasks([{
      parentTaskId: "goal:root",
      taskId,
      goal: `Goal of ${taskId}`,
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: [],
      priority: 1
    }]);
  }
  const versionSnapshot = harness.controller.graphStore.plannerVersionSnapshot();
  const patchDecision = (taskId: string): PlannerDecision => ({
    decision: "apply_commands",
    commands: [{ kind: "patch_task", taskId, patch: { priority: 9 }, reason: "mutate", basedOnRefs: [] }],
    reason: "patch",
    basedOnRefs: []
  });

  harness.controllerHarness.beginTaskExecution(makeTaskEnvelope({ taskId: "task:running" }));
  assert.throws(
    () => harness.controllerHarness.normalizePlannerDecisionBoundary(patchDecision("task:running")),
    (error: unknown) => error instanceof Error
      && error.name === "ActiveTaskMutationError"
      && /cannot mutate active Task/.test(error.message)
  );
  assert.throws(() => harness.controller.graphStore.validatePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "set_node_status",
      nodeId: "task:running",
      status: "archived",
      basedOnRefs: []
    }],
    reason: "attempt to bypass the active Task boundary"
  }), /Task task:running status must be changed with set_task_status/);
  for (let index = 0; index < DEFAULT_TASK_BUDGET.maxTurns; index += 1) {
    harness.controller.runtimeStore.recordTaskTurn({
      taskId: "task:existing",
      eventId: `event:exhausted:${index}`
    });
  }
  assert.throws(() => harness.controller.graphStore.validatePlannerDecision({
    decision: "apply_commands",
    commands: [{
      kind: "set_node_status",
      nodeId: "task:existing",
      status: "open",
      basedOnRefs: []
    }],
    reason: "attempt to bypass the exhausted Task boundary"
  }), /Task task:existing status must be changed with set_task_status/);
  assert.throws(
    () => harness.controller.graphStore.validatePlannerDecision(patchDecision("task:missing")),
    /Task task:missing does not exist/
  );
  assert.throws(
    () => harness.controller.graphStore.validatePlannerDecision({
      decision: "apply_commands",
      commands: [
        { kind: "replace_dependencies", taskId: "task:a", dependencyTaskIds: ["task:b"], reason: "x", basedOnRefs: [] },
        { kind: "replace_dependencies", taskId: "task:b", dependencyTaskIds: ["task:a"], reason: "x", basedOnRefs: [] }
      ],
      reason: "cycle",
      basedOnRefs: []
    }),
    /Dependency graph would contain a cycle/
  );
  harness.controller.graphStore.applyPlannerDecision({
    createTasks: [],
    taskCommands: [{
      commandIndex: 0,
      kind: "patch_task",
      taskId: "task:conflict",
      patch: { priority: 5 },
      expectedVersion: versionSnapshot["task:conflict"],
      sourceEventIds: [],
      reason: "bump the version"
    }],
    nodeStatusCommands: [],
    sourceEventIds: []
  });
  assert.doesNotThrow(() => harness.controller.graphStore.validatePlannerDecision(patchDecision("task:conflict")));

  harness.controller.graphStore.validatePlannerDecision(patchDecision("task:existing"));
  harness.controller.graphStore.validatePlannerDecision({
    decision: "apply_commands",
    commands: [{ kind: "set_node_status", nodeId: "goal:root", status: "achieved", reason: "done", basedOnRefs: [] }],
    reason: "close",
    basedOnRefs: []
  });
  harness.controllerHarness.finishTaskExecution("task:running");
  harness.controller.close();
});

test("structured planner invocation rejects a patch-active submit before apply and retries fresh", async () => {
  const harness = createControllerHarness();
  await harness.controllerHarness.ensureRootGraph({ userGoal: "Get the flag", scopeSummary: "Authorized target only" });
  harness.controller.graphStore.createTasks([{
    parentTaskId: "goal:root",
    taskId: "task:running",
    goal: "Keep running",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: [],
    priority: 1
  }]);
  harness.controllerHarness.beginTaskExecution(makeTaskEnvelope({ taskId: "task:running" }));
  harness.controllerHarness.structuredInvocationsEnabled = true;
  const sessions = [
    createStructuredToolSession("planner_submit", {
      decision: "apply_commands",
      commands: [{ kind: "patch_task", taskId: "task:running", patch: { priority: 9 }, reason: "mutate running" }],
      reason: "Mutate the running task",
      basedOnRefs: ["task:running"]
    }),
    createStructuredToolSession("planner_submit", {
      decision: "apply_commands",
      commands: [{ kind: "set_node_status", nodeId: "goal:root", status: "achieved", reason: "done" }],
      reason: "Recover with a valid decision",
      basedOnRefs: ["goal:root"]
    })
  ];
  let sessionIndex = 0;
  harness.controllerHarness.createPlannerSessionForCycle = async () => ({
    session: sessions[Math.min(sessionIndex++, sessions.length - 1)]!,
    isolated: true
  });

  const result = await harness.controllerHarness.invokePlannerCycle({
    userGoal: "Get the flag",
    scopeSummary: "Authorized target only"
  });
  const events = await harness.controller.executionLog.readAll();

  assert.equal(sessionIndex, 2);
  assert.equal(result.plannerDecision.reason, "Recover with a valid decision");
  const failed = events.find((event) => event.eventType === "planner_prompt_failed");
  assert.match(String(failed?.summary), /cannot mutate active Task/);
  assert.equal(events.some((event) => event.eventType === "planner_command_rejected"), false);
  harness.controllerHarness.finishTaskExecution("task:running");
  await harness.controller.close({ drainProjectionJobs: false });
});

test("provider failure after execution evidence preserves and resumes the same Executor session", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const listeners: Array<(event: unknown) => void> = [];
  const prompts: string[] = [];
  let promptCount = 0;
  let disposeCount = 0;
  let executorFactoryCount = 0;
  const executorSession = {
    isStreaming: false,
    sessionFile: "/tmp/mock-session.jsonl",
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      promptCount += 1;
      if (promptCount === 1) {
        for (const listener of [...listeners]) {
          listener({
            type: "tool_execution_start",
            toolCallId: "call:upload",
            toolName: "bash",
            args: { command: "verify upload capability" }
          });
          listener({
            type: "tool_execution_end",
            toolCallId: "call:upload",
            toolName: "bash",
            isError: false,
            result: {
              content: [{
                type: "text",
                text: "Confirmed upload endpoint /upload accepts multipart files."
              }]
            }
          });
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "503 upstream request failed",
              content: []
            }
          });
        }
        return;
      }
      for (const listener of [...listeners]) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{
              type: "text",
              text: JSON.stringify({
                taskId: "task:provider-resume",
                status: "completed",
                summary: "Reused the established upload capability and recovered the target artifact.",
                evidenceRefs: [],
                artifactRefs: []
              })
            }]
          }
        });
      }
    },
    async steer(): Promise<void> {},
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async abort(): Promise<void> {},
    dispose(): void {
      disposeCount += 1;
    }
  };
  const observerSession = createAbortableMockTextSession(observerProjectionJson());
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "create_tasks",
          tasks: [{
            id: "task:provider-resume",
            goal: "Recover the target artifact through the upload capability",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: ["authorized target only"],
            successCriteria: ["recover the target artifact"],
            budget: { maxTurns: 10 },
            priority: 1
          }],
          reason: "Start the primary task",
          basedOnRefs: ["goal:root"]
        }],
        reason: "Start the primary task",
        basedOnRefs: ["goal:root"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [],
        reason: "The retryable provider failure left the Task open with remaining turns; continue it without changing the graph.",
        basedOnRefs: ["task:provider-resume"]
      })
    ]),
    executor: createAbortableMockTextSession("{}"),
    observer: observerSession
  };
  controllerHarness.createObserverSessionForMode = async () => ({
    session: observerSession,
    dynamicObserver: true
  });
  controllerHarness.createExecutorSessionForTask = async () => {
    executorFactoryCount += 1;
    return {
      session: executorSession as never,
      dynamicExecutor: true,
      resumed: promptCount > 0,
      resumeCount: promptCount > 0 ? 1 : 0
    };
  };

  const result = await controller.runUntilDone({
    userGoal: "Recover the target artifact",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 2,
    maxParallelTasks: 1
  });
  const events = await controller.executionLog.readAll();
  const firstEpochError = events.find((event) => (
    event.eventType === "epoch_provider_error" && event.taskId === "task:provider-resume"
  ));

  assert.equal(result.cycles[1]?.taskResult?.status, "completed");
  assert.equal(executorFactoryCount, 2);
  assert.equal(promptCount, 2);
  assert.match(prompts[1] ?? "", /继续执行同一个 Task/);
  assert.match(String(firstEpochError?.summary ?? ""), /503 upstream request failed/);
  assert.ok(events.some((event) => event.eventType === "tool_finished"
    && event.taskId === "task:provider-resume"
    && JSON.stringify(event.payload).includes("Confirmed upload endpoint /upload")));
  assert.ok(events.some((event) => event.eventType === "planner_handoff_resolved"
    && event.taskId === "task:provider-resume"
    && event.payload.resolution === "resume_retryable_epoch"));
  assert.equal(events.some((event) => event.eventType === "task_failed"
    && event.taskId === "task:provider-resume"), false);
  assert.equal(disposeCount, 2);
  assert.equal(controller.graphStore.getTaskNode("task:provider-resume")?.properties.status, "open");
  assert.equal(controller.runtimeStore.getTaskOutcome("task:provider-resume")?.status, "completed");
  await controller.close({ drainProjectionJobs: false, projectionCancelGraceMs: 100 });
});

test("close drains background projector before closing graph store", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({
    nodes: [],
    edges: []
  }));
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);
  const projectorRelease = createDeferred<void>();
  let graphStoreClosed = false;
  const originalClose = harness.controller.graphStore.close.bind(harness.controller.graphStore);
  harness.controller.graphStore.close = (): void => {
    graphStoreClosed = true;
    originalClose();
  };
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    await projectorRelease.promise;
    assert.equal(graphStoreClosed, false);
    return JSON.stringify({
      nodes: [],
      edges: []
    });
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });
  const sourceEvent = await persistExecutorEvent(harness.controller, taskEnvelope.taskId, "task_partial", "task end");

  void harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id]
  });
  await waitFor(async () => (await harness.controller.executionLog.readAll())
    .some((event) => event.eventType === "projection_job_started"));

  let closeResolved = false;
  const closePromise = harness.controller.close({ projectionDrainTimeoutMs: 1000 })
    .then(() => {
      closeResolved = true;
    });
  await waitForSettled();
  assert.equal(closeResolved, false);
  assert.equal(graphStoreClosed, false);

  projectorRelease.resolve();
  await closePromise;
  assert.equal(closeResolved, true);
  assert.equal(graphStoreClosed, true);
});

test("close drains pending terminal projections after active projector slots settle", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({ nodes: [], edges: [] }));
  const taskEnvelopes = [
    makeTaskEnvelope({ taskId: "task:close-drain-a" }),
    makeTaskEnvelope({ taskId: "task:close-drain-b" }),
    makeTaskEnvelope({ taskId: "task:close-drain-terminal" })
  ];
  const releases = taskEnvelopes.map(() => createDeferred<void>());
  let projectorSessionCount = 0;
  let projectionStatesAtClose: Array<{ committedSeq: number; desiredSeq: number }> = [];
  const originalClose = harness.controller.graphStore.close.bind(harness.controller.graphStore);
  harness.controller.graphStore.close = (): void => {
    projectionStatesAtClose = taskEnvelopes.map(({ taskId }) => {
      const state = harness.controller.runtimeStore.getProjectionState(taskId);
      return { committedSeq: state.committedSeq, desiredSeq: state.desiredSeq };
    });
    originalClose();
  };
  harness.controllerHarness.createObserverSessionForMode = async () => {
    const sessionIndex = projectorSessionCount;
    projectorSessionCount += 1;
    return {
      session: createDelayedAbortableMockTextSession(async () => {
        await releases[sessionIndex]?.promise;
        return JSON.stringify({ nodes: [], edges: [] });
      }),
      dynamicObserver: true
    };
  };

  const projectionPromises: Array<Promise<ObserverProjection>> = [];
  for (const [index, taskEnvelope] of taskEnvelopes.entries()) {
    const sourceEvent = await persistExecutorEvent(
      harness.controller,
      taskEnvelope.taskId,
      index === 2 ? "task_partial" : "tool_finished",
      index === 2 ? "terminal task result" : `active projection ${index}`
    );
    projectionPromises.push(harness.controllerHarness.enqueueProjectionJob({
      reason: index === 2 ? "task_end" : "project_window:3",
      taskEnvelope,
      sourceEventIds: [sourceEvent.id],
      ...(index === 2 ? {
        taskResult: {
          taskId: taskEnvelope.taskId,
          status: "partial",
          summary: "terminal projection must drain",
          evidenceRefs: [sourceEvent.id],
          artifactRefs: []
        }
      } : {})
    }));
  }
  await waitFor(() => projectorSessionCount === 2);

  const closePromise = harness.controller.close({ projectionDrainTimeoutMs: 2_000 });
  await waitForSettled();
  assert.equal(projectorSessionCount, 2);

  releases[0]?.resolve();
  releases[1]?.resolve();
  await waitFor(() => projectorSessionCount === 3);
  releases[2]?.resolve();
  await Promise.all([...projectionPromises, closePromise]);

  assert.equal(projectorSessionCount, 3);
  assert.ok(
    projectionStatesAtClose.every((state) => state.committedSeq === state.desiredSeq),
    JSON.stringify(projectionStatesAtClose)
  );
});

test("close without drain cancels and joins projector before closing stores", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({ nodes: [], edges: [] }));
  const taskEnvelope = makeTaskEnvelope();
  activateTask(harness.controllerHarness, taskEnvelope);
  const projectorRelease = createDeferred<void>();
  let graphStoreClosed = false;
  let activeGenerationAtClose: number | undefined;
  let committedSeqAtClose = -1;
  const originalClose = harness.controller.graphStore.close.bind(harness.controller.graphStore);
  harness.controller.graphStore.close = (): void => {
    const projectionState = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
    activeGenerationAtClose = projectionState.activeGeneration;
    committedSeqAtClose = projectionState.committedSeq;
    graphStoreClosed = true;
    originalClose();
  };
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    await projectorRelease.promise;
    return JSON.stringify({ nodes: [], edges: [] });
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });
  const sourceEvent = await persistExecutorEvent(
    harness.controller,
    taskEnvelope.taskId,
    "tool_finished",
    "HTTP/1.1 200 OK"
  );
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, sourceEvent.seq ?? 0);

  void harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id]
  });
  await waitFor(() => projectorSession.promptCount() === 1);

  let closeResolved = false;
  const closePromise = harness.controller.close({ drainProjectionJobs: false }).then(() => {
    closeResolved = true;
  });
  await waitForSettled();
  assert.equal(closeResolved, false);
  assert.equal(graphStoreClosed, false);

  projectorRelease.resolve();
  await closePromise;
  assert.equal(closeResolved, true);
  assert.equal(graphStoreClosed, true);
  assert.equal(activeGenerationAtClose, undefined);
  assert.equal(committedSeqAtClose, 0);
});

test("close keeps stores open when cancelled projector work misses the grace period", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({ nodes: [], edges: [] }));
  const taskEnvelope = makeTaskEnvelope({ taskId: "task:late-projector-close" });
  activateTask(harness.controllerHarness, taskEnvelope);
  const projectorRelease = createDeferred<void>();
  let graphStoreClosed = false;
  const originalClose = harness.controller.graphStore.close.bind(harness.controller.graphStore);
  harness.controller.graphStore.close = (): void => {
    graphStoreClosed = true;
    originalClose();
  };
  const projectorSession = createDelayedAbortableMockTextSession(async () => {
    await projectorRelease.promise;
    return JSON.stringify({ nodes: [], edges: [] });
  });
  harness.controllerHarness.createObserverSessionForMode = async () => ({
    session: projectorSession,
    dynamicObserver: true
  });
  const sourceEvent = await persistExecutorEvent(
    harness.controller,
    taskEnvelope.taskId,
    "tool_finished",
    "late projector result"
  );
  void harness.controllerHarness.enqueueProjectionJob({
    reason: "task_end",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id]
  });
  await waitFor(() => projectorSession.promptCount() === 1);

  let executorResourcesClosed = false;
  const originalCloseExecutorResources = harness.controllerHarness.closeExecutorResources.bind(harness.controllerHarness);
  harness.controllerHarness.closeExecutorResources = async (): Promise<void> => {
    executorResourcesClosed = true;
    await originalCloseExecutorResources();
  };

  await assert.rejects(
    harness.controller.close({ drainProjectionJobs: false, projectionCancelGraceMs: 5 }),
    /stores remain open/
  );
  assert.equal(graphStoreClosed, false);
  assert.equal(executorResourcesClosed, true);
  assert.equal(await harness.controllerHarness.projectorCoordinator.waitForSettled(0), false);

  projectorRelease.resolve();
  assert.equal(await harness.controllerHarness.projectorCoordinator.waitForSettled(1_000), true);
  await harness.controller.close({ drainProjectionJobs: false, projectionCancelGraceMs: 5 });
  assert.equal(graphStoreClosed, true);
});

test("close joins active task runs before closing stores", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const taskEnvelope = makeTaskEnvelope({ taskId: "task:close-settle" });
  const taskRelease = createDeferred<void>();
  let taskSettled = false;
  const taskPromise = (async () => {
    await taskRelease.promise;
    await controller.executionLog.append({
      taskId: taskEnvelope.taskId,
      role: "runtime",
      eventType: "task_close_settled",
      summary: "Task promise settled before stores closed",
      payload: {}
    });
    taskSettled = true;
    return {
      taskEnvelope,
      taskResult: {
        taskId: taskEnvelope.taskId,
        status: "partial" as const,
        summary: "Stopped during close",
        evidenceRefs: [],
        artifactRefs: []
      },
      terminalSeq: 0,
      controlSignal: {
        decision: "checkpoint" as const,
        reason: "Controller shutdown",
        evidenceRefs: []
      }
    };
  })();
  const closeHarness = controller as unknown as {
    activeTaskRuns: Map<string, { taskEnvelope: TaskEnvelope; promise: typeof taskPromise }>;
  };
  closeHarness.activeTaskRuns.set(taskEnvelope.taskId, { taskEnvelope, promise: taskPromise });

  let closeResolved = false;
  const closePromise = controller.close({ drainProjectionJobs: false }).then(() => {
    closeResolved = true;
  });
  await waitForSettled();
  assert.equal(closeResolved, false);
  assert.equal(taskSettled, false);

  taskRelease.resolve();
  await closePromise;
  assert.equal(taskSettled, true);
  assert.equal(closeResolved, true);
});

test("close drains a task-end projection raised while an active task settles", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({ nodes: [], edges: [] }));
  const taskEnvelope = makeTaskEnvelope({ taskId: "task:close-terminal-raise" });
  const sourceEvent = await persistExecutorEvent(
    harness.controller,
    taskEnvelope.taskId,
    "task_partial",
    "Task stopped during controller close"
  );
  const taskRelease = createDeferred<void>();
  let projectionStateAtClose: { committedSeq: number; desiredSeq: number; terminalTargetSeq?: number } | undefined;
  const originalClose = harness.controller.graphStore.close.bind(harness.controller.graphStore);
  harness.controller.graphStore.close = (): void => {
    const state = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
    projectionStateAtClose = {
      committedSeq: state.committedSeq,
      desiredSeq: state.desiredSeq,
      terminalTargetSeq: state.terminalTargetSeq
    };
    originalClose();
  };
  const taskPromise = (async () => {
    await taskRelease.promise;
    await harness.controllerHarness.enqueueProjectionJob({
      reason: "task_end",
      taskEnvelope,
      sourceEventIds: [sourceEvent.id],
      taskResult: {
        taskId: taskEnvelope.taskId,
        status: "partial",
        summary: "Stopped during close",
        evidenceRefs: [sourceEvent.id],
        artifactRefs: []
      }
    });
    return {
      taskEnvelope,
      taskResult: {
        taskId: taskEnvelope.taskId,
        status: "partial" as const,
        summary: "Stopped during close",
        evidenceRefs: [sourceEvent.id],
        artifactRefs: []
      },
      terminalSeq: sourceEvent.seq ?? 0,
      controlSignal: {
        decision: "checkpoint" as const,
        reason: "Controller shutdown",
        evidenceRefs: [sourceEvent.id]
      }
    };
  })();
  const closeHarness = harness.controller as unknown as {
    activeTaskRuns: Map<string, { taskEnvelope: TaskEnvelope; promise: typeof taskPromise }>;
  };
  closeHarness.activeTaskRuns.set(taskEnvelope.taskId, { taskEnvelope, promise: taskPromise });

  const closePromise = harness.controller.close({ projectionDrainTimeoutMs: 1_000 });
  await waitForSettled();
  taskRelease.resolve();
  await closePromise;

  assert.deepEqual(projectionStateAtClose, {
    committedSeq: sourceEvent.seq,
    desiredSeq: sourceEvent.seq,
    terminalTargetSeq: undefined
  });
});

test("discarded projector preparation releases its projection claim", async () => {
  const harness = createObserverControllerHarness(JSON.stringify({ nodes: [], edges: [] }));
  const taskEnvelope = makeTaskEnvelope();
  const sourceEvent = await persistExecutorEvent(
    harness.controller,
    taskEnvelope.taskId,
    "tool_finished",
    "HTTP/1.1 200 OK"
  );
  harness.controller.runtimeStore.raiseProjectionDesired(taskEnvelope.taskId, sourceEvent.seq ?? 0);
  const preparationStarted = createDeferred<void>();
  const preparationRelease = createDeferred<void>();
  const controllerHarness = harness.controllerHarness as ControllerHarness & {
    projectionCancellationRequested: boolean;
    loadProjectorArtifactIndex: () => Promise<{ text: string; itemCount: number; omittedCount: number }>;
  };
  controllerHarness.loadProjectorArtifactIndex = async () => {
    preparationStarted.resolve();
    await preparationRelease.promise;
    return { text: "无相关 artifact。", itemCount: 0, omittedCount: 0 };
  };

  const projectionPromise = controllerHarness.runProjectionJob({
    reason: "project_window:3",
    taskEnvelope,
    sourceEventIds: [sourceEvent.id]
  });
  await preparationStarted.promise;
  controllerHarness.projectionCancellationRequested = true;
  preparationRelease.resolve();
  await projectionPromise;

  const projectionState = harness.controller.runtimeStore.getProjectionState(taskEnvelope.taskId);
  assert.equal(projectionState.activeGeneration, undefined);
  assert.equal(projectionState.committedSeq, 0);
  await harness.controller.close({ drainProjectionJobs: false });
});

test("initialize recovers interrupted projection claim and resumes pending watermark", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const firstController = createControllerWithTestLlmEnv(runtimeDir);
  firstController.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "goal:root", graphKind: "task", type: "Goal", label: "Goal", properties: { status: "open" } },
      { id: "scope:root", graphKind: "task", type: "Scope", label: "Scope", properties: {} },
      {
        id: "task:recover",
        graphKind: "task",
        type: "Task",
        label: "Recover projection",
        properties: {
          status: "partial",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: [],
          successCriteria: []
        }
      }
    ],
    edges: []
  });
  const sourceEvent = await firstController.executionLog.append({
    taskId: "task:recover",
    role: "executor",
    eventType: "tool_finished",
    summary: "tool_finished:bash:ok",
    payload: { toolName: "bash", result: { content: [{ type: "text", text: "HTTP/1.1 200 OK" }] } }
  });
  firstController.runtimeStore.raiseProjectionDesired("task:recover", sourceEvent.seq ?? 0);
  assert.ok(firstController.runtimeStore.claimProjection("task:recover"));
  firstController.graphStore.close();
  firstController.runtimeStore.close();
  firstController.artifactStore.close();
  firstController.executionLog.close();

  const recoveredController = createControllerWithTestLlmEnv(runtimeDir);
  const recoveredHarness = recoveredController as unknown as ControllerHarness;
  recoveredHarness.createObserverSessionForMode = async () => ({
    session: createStructuredToolSession("graph_delta_submit", { nodes: [], edges: [] }),
    dynamicObserver: true
  });

  await recoveredController.initialize();
  await waitFor(async () => (
    recoveredController.runtimeStore.getProjectionState("task:recover").committedSeq === sourceEvent.seq
  ));

  const events = await recoveredController.executionLog.readAll();
  assert.ok(events.some((event) => event.eventType === "projection_recovered"));
  assert.ok(events.some((event) => event.eventType === "projection_job_succeeded"));
  await recoveredController.close();
});

test("terminal root goal prevents stale ready tasks from starting", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  controller.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [{
      id: "task:stale-open",
      graphKind: "task",
      type: "Task",
      label: "Stale open task",
      properties: {
        status: "open",
        targetRefs: ["goal:root"],
        scopeRef: "scope:root",
        constraints: [],
        successCriteria: ["should not run after goal completion"],
        priority: 1
      }
    }],
    edges: []
  });
  const executorSession = createAbortableMockTextSession(JSON.stringify({
    status: "completed",
    summary: "This executor must not run",
    evidenceRefs: [],
    artifactRefs: []
  }));
  const controllerHarness = controller as unknown as ControllerHarness;
  controllerHarness.agents = {
    planner: createMockTextSession(JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_node_status",
        nodeId: "goal:root",
        status: "achieved",
        reason: "Flag already confirmed",
        basedOnRefs: ["task:stale-open"]
      }],
      reason: "Root objective is complete",
      basedOnRefs: ["task:stale-open"]
    })),
    executor: executorSession,
    observer: createMockTextSession(observerProjectionJson())
  };

  const result = await controller.runOnce({
    userGoal: "Get the flag",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });

  assert.equal(executorSession.promptCount(), 0);
  assert.deepEqual(result.taskResults, []);
  assert.equal(
    controller.graphStore.query("task", ["goal:root"], 1).nodes[0]?.properties.status,
    "completed"
  );
  await controller.close();
});

test("planner commands update explicit task and milestone without ending root goal", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  controller.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      {
        id: "task:recon",
        graphKind: "task",
        type: "Task",
        label: "Recon target",
        properties: {
          status: "partial",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: [],
          successCriteria: ["find attack surface"],
          priority: 1
        }
      },
      {
        id: "milestone:recon",
        graphKind: "task",
        type: "Milestone",
        label: "Recon complete",
        properties: { status: "partial" }
      }
    ],
    edges: [
      { from: "task:recon", to: "milestone:recon", type: "produces_milestone" }
    ]
  });
  const controllerHarness = controller as unknown as ControllerHarness;
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([
      JSON.stringify({
        decision: "apply_commands",
        commands: [
          {
            kind: "set_task_status",
            taskId: "task:recon",
            status: "completed",
            reason: "Recon task is complete",
            basedOnRefs: ["milestone:recon"]
          },
          {
            kind: "set_node_status",
            nodeId: "milestone:recon",
            status: "achieved",
            reason: "Recon milestone is achieved",
            basedOnRefs: ["task:recon"]
          }
        ],
        reason: "Recon milestone is complete",
        basedOnRefs: ["task:recon", "milestone:recon"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "create_tasks",
          tasks: [{
            id: "task:use-recon-results",
            goal: "Use recon results to pursue the flag",
            targetRefs: ["milestone:recon"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["find flag"],
            budget: { maxTurns: 1 },
            priority: 1
          }],
          reason: "Root goal is still open after recon",
          basedOnRefs: ["milestone:recon"]
        }],
        reason: "Root goal is still open after recon",
        basedOnRefs: ["milestone:recon"]
      })
    ]),
    executor: createAbortableMockTextSession(JSON.stringify({
      status: "partial",
      summary: "Next phase checkpoint",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  const cycles = [
    await controller.runOnce({ userGoal: "Get the benchmark flag", scopeSummary: "Authorized target only" }),
    await controller.runOnce({ userGoal: "Get the benchmark flag", scopeSummary: "Authorized target only" })
  ];

  assert.equal(cycles[0].plannerDecision.decision, undefined);
  assert.equal(cycles[1].plannerDecision.decision, undefined);
  assert.equal(
    controller.graphStore.query("task", ["task:recon"], 1).nodes[0]?.properties.status,
    "completed"
  );
  assert.equal(
    controller.graphStore.query("task", ["milestone:recon"], 1).nodes[0]?.properties.status,
    "achieved"
  );
  assert.equal(
    controller.graphStore.query("task", ["goal:root"], 1).nodes[0]?.properties.status,
    "open"
  );
  controller.close();
});

test("planner commands patch explicit task and continue scheduling", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  controller.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      {
        id: "task:26ca066d-bbf7-40f6-9e82-897cd8f72367",
        graphKind: "task",
        type: "Task",
        label: "Recon a-04 target",
        properties: {
          status: "partial",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: ["authorized target only"],
          successCriteria: ["recon complete"],
          priority: 1
        }
      },
      {
        id: "milestone:recon-phase2-exploit-ready",
        graphKind: "task",
        type: "Milestone",
        label: "Exploit-ready recon",
        properties: { status: "achieved" }
      }
    ],
    edges: [
      {
        from: "task:26ca066d-bbf7-40f6-9e82-897cd8f72367",
        to: "milestone:recon-phase2-exploit-ready",
        type: "produces_milestone"
      }
    ]
  });
  const controllerHarness = controller as unknown as ControllerHarness;
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([
      JSON.stringify({
        decision: "apply_commands",
        commands: [
          {
            kind: "patch_task",
            taskId: "task:26ca066d-bbf7-40f6-9e82-897cd8f72367",
            patch: {
              budget: { maxTurns: 8 },
              priority: 1
            },
            reason: "侦察任务的预算和优先级已确认",
            basedOnRefs: ["milestone:recon-phase2-exploit-ready"]
          },
          {
            kind: "set_task_status",
            taskId: "task:26ca066d-bbf7-40f6-9e82-897cd8f72367",
            status: "completed",
            reason: "侦察任务的所有成功条件已确认达成",
            basedOnRefs: ["milestone:recon-phase2-exploit-ready"]
          }
        ],
        reason: "侦察任务 task:26ca066d 的所有成功条件已确认达成，该任务应标记为 completed，以便进入利用阶段。",
        basedOnRefs: ["milestone:recon-phase2-exploit-ready"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "create_tasks",
          tasks: [{
            id: "task:retrieve-flag",
            goal: "Use confirmed webshell capability to retrieve the flag",
            targetRefs: ["milestone:recon-phase2-exploit-ready"],
            scopeRef: "scope:root",
            constraints: ["authorized target only"],
            successCriteria: ["flag found"],
            budget: { maxTurns: 1 },
            priority: 1
          }],
          reason: "Recon task is completed and root goal still needs exploitation",
          basedOnRefs: ["milestone:recon-phase2-exploit-ready"]
        }],
        reason: "Recon task is completed and root goal still needs exploitation",
        basedOnRefs: ["milestone:recon-phase2-exploit-ready"]
      })
    ]),
    executor: createAbortableMockTextSession(JSON.stringify({
      status: "partial",
      summary: "Exploit phase checkpoint",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  const cycles = [
    await controller.runOnce({ userGoal: "Get a-04 flag", scopeSummary: "Authorized target only" }),
    await controller.runOnce({ userGoal: "Get a-04 flag", scopeSummary: "Authorized target only" })
  ];
  const events = await controller.executionLog.readAll();

  assert.equal(cycles[0].plannerDecision.decision, undefined);
  assert.equal(cycles[1].plannerDecision.decision, undefined);
  assert.equal(
    controller.graphStore.query("task", ["task:26ca066d-bbf7-40f6-9e82-897cd8f72367"], 1).nodes[0]?.properties.status,
    "completed"
  );
  assert.ok(events.some((event) => event.eventType === "planner_status_applied"));
  assert.ok(events.some((event) => event.eventType === "task_created" && event.summary?.includes("retrieve the flag")));
  controller.close();
});

test("planner task commands in one decision share the same version snapshot", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  controller.graphStore.createTasks([{
    taskId: "task:recon-web",
    goal: "Recon web target",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: ["authorized target only"],
    successCriteria: ["find ssrf entry"],
    budget: { maxTurns: 10 },
    priority: 1
  }]);
  controller.graphStore.markTaskStatus({
    taskId: "task:recon-web",
    status: "partial",
    properties: {
      checkpointReason: "Task budget reached: maxTurns=10",
      retryable: true,
      resumeCursor: "event:last"
    }
  });
  const controllerHarness = controller as unknown as ControllerHarness;
  controllerHarness.agents = {
    planner: createMockTextSession(JSON.stringify({
      decision: "apply_commands",
      commands: [
        {
          kind: "set_task_status",
          taskId: "task:recon-web",
          status: "open",
          reason: "resume checkpointed recon",
          basedOnRefs: ["task:recon-web"]
        },
        {
          kind: "patch_task",
          taskId: "task:recon-web",
          patch: { additionalTurns: 6 },
          reason: "extend recon budget",
          basedOnRefs: ["task:recon-web"]
        }
      ],
      reason: "resume and extend recon in one planner decision",
      basedOnRefs: ["task:recon-web"]
    })),
    executor: createAbortableMockTextSession(JSON.stringify({
      taskId: "task:recon-web",
      status: "partial",
      summary: "Recon resumed after batch update",
      evidenceRefs: [],
      artifactRefs: [],
      checkpointReason: "test checkpoint",
      retryable: true
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  const result = await controller.runOnce({
    userGoal: "Get flag",
    scopeSummary: "Authorized target only"
  });
  const taskNode = controller.graphStore.getTaskNode("task:recon-web");
  const events = await controller.executionLog.readAll();

  assert.equal(result.plannerDecision.decision, undefined);
  assert.equal(taskNode?.properties.version, 2);
  assert.deepEqual(taskNode?.properties.budget, { maxTurns: 16 });
  assert.ok(!events.some((event) => event.eventType === "planner_command_rejected"));
  assert.ok(events.some((event) => event.eventType === "planner_status_applied" && event.taskId === "task:recon-web"));
  const budgetPatch = events.find((event) => event.eventType === "planner_task_patched" && event.taskId === "task:recon-web");
  assert.deepEqual(budgetPatch?.payload.budgetChange, {
    consumedTurns: 0,
    previousMaxTurns: 10,
    additionalTurns: 6,
    newMaxTurns: 16,
    remainingTurns: 16
  });
  controller.close();
});

test("planner conflict refreshes the graph and replans without partial command commits", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  controller.graphStore.createTasks([{
    taskId: "task:versioned",
    goal: "Original task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: ["authorized target only"],
    successCriteria: ["finish"],
    budget: { maxTurns: 10 },
    priority: 1
  }]);
  const plannerSession = createMockTextSessionSequence([
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [{
          id: "task:stale-create",
          goal: "This create must roll back",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: [],
          successCriteria: ["never committed"],
          priority: 1
        }],
        reason: "stale decision"
      }, {
        kind: "patch_task",
        taskId: "task:versioned",
        patch: { priority: 3 },
        reason: "stale decision"
      }],
      reason: "first stale decision",
      basedOnRefs: ["task:versioned"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "patch_task",
        taskId: "task:versioned",
        patch: { priority: 4 },
        reason: "retry with refreshed state"
      }],
      reason: "retry with refreshed state",
      basedOnRefs: ["task:versioned"]
    })
  ]);
  const originalPrompt = plannerSession.prompt.bind(plannerSession);
  let plannerPromptCount = 0;
  plannerSession.prompt = async (text: string) => {
    plannerPromptCount += 1;
    if (plannerPromptCount === 1) {
      controller.graphStore.patchTask({
        taskId: "task:versioned",
        expectedVersion: 1,
        patch: { priority: 2 }
      });
    }
    await originalPrompt(text);
  };
  const controllerHarness = controller as unknown as ControllerHarness;
  controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession(JSON.stringify({
      taskId: "task:versioned",
      status: "completed",
      summary: "Finished after conflict recovery",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  const result = await controller.runOnce({
    userGoal: "Complete the target task",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });
  const events = await controller.executionLog.readAll();

  assert.equal(plannerPromptCount, 2);
  assert.equal(controller.graphStore.getTaskNode("task:stale-create"), undefined);
  assert.equal(controller.graphStore.getTaskNode("task:versioned")?.label, "Original task");
  assert.equal(controller.graphStore.getTaskNode("task:versioned")?.properties.priority, 4);
  assert.equal(result.taskResult?.status, "completed");
  assert.ok(events.some((event) => event.eventType === "planner_decision_conflict"));
  assert.equal(events.some((event) => event.eventType === "run_failed"), false);
  await controller.close({ drainProjectionJobs: false });
});

test("cyclic Planner dependency update is rejected and replanned without ending the run", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  controller.graphStore.createTasks([
    {
      taskId: "task:entry-recon",
      goal: "Understand the public entry surface",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: ["authorized target only"],
      successCriteria: ["identify public routes"],
      priority: 1
    },
    {
      taskId: "task:admin-auth",
      goal: "Obtain an authenticated admin session",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: ["authorized target only"],
      successCriteria: ["admin session is available"],
      priority: 2,
      dependsOnTaskRefs: ["task:entry-recon"]
    },
    {
      taskId: "task:unlinked-resource-discovery",
      goal: "Map authenticated unlinked resources",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: ["authorized target only"],
      successCriteria: ["authenticated resources are mapped"],
      priority: 3,
      dependsOnTaskRefs: ["task:entry-recon", "task:admin-auth"]
    }
  ]);
  const entryTask = controller.graphStore.getTaskEnvelope("task:entry-recon");
  const adminTask = controller.graphStore.getTaskEnvelope("task:admin-auth");
  const discoveryTask = controller.graphStore.getTaskEnvelope("task:unlinked-resource-discovery");
  assert.ok(entryTask);
  assert.ok(adminTask);
  assert.ok(discoveryTask);
  controller.graphStore.updateTaskResult({
    taskEnvelope: entryTask,
    taskResult: {
      taskId: "task:entry-recon",
      status: "completed",
      summary: "Public routes were mapped.",
      evidenceRefs: [],
      artifactRefs: []
    },
    sourceEventIds: ["event:entry-result"]
  });
  controller.graphStore.updateTaskResult({
    taskEnvelope: adminTask,
    taskResult: {
      taskId: "task:admin-auth",
      status: "partial",
      summary: "A reusable admin session exists, but lifecycle validation remains.",
      evidenceRefs: [],
      artifactRefs: [],
      retryable: true
    },
    sourceEventIds: ["event:admin-result"]
  });
  controller.graphStore.updateTaskResult({
    taskEnvelope: discoveryTask,
    taskResult: {
      taskId: "task:unlinked-resource-discovery",
      status: "completed",
      summary: "Authenticated hidden resources were mapped.",
      evidenceRefs: [],
      artifactRefs: []
    },
    sourceEventIds: ["event:discovery-result"]
  });
  controller.runtimeStore.upsertTaskOutcome({
    taskRef: "task:entry-recon",
    epochRef: "epoch:entry",
    status: "completed",
    summary: "Public routes were mapped.",
    evidenceRefs: [],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 1,
    createdAt: "2026-07-30T00:00:00.000Z"
  });
  controller.runtimeStore.upsertTaskOutcome({
    taskRef: "task:admin-auth",
    epochRef: "epoch:admin",
    status: "partial",
    summary: "A reusable admin session exists, but lifecycle validation remains.",
    evidenceRefs: [],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 2,
    createdAt: "2026-07-30T00:01:00.000Z"
  });
  controller.runtimeStore.upsertTaskOutcome({
    taskRef: "task:unlinked-resource-discovery",
    epochRef: "epoch:discovery",
    status: "completed",
    summary: "Authenticated hidden resources were mapped.",
    evidenceRefs: [],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 3,
    createdAt: "2026-07-30T00:02:00.000Z"
  });
  controller.graphStore.setTaskStatus({
    taskId: "task:entry-recon",
    status: "completed",
    reason: "Planner accepted the entry result"
  });
  controller.graphStore.setTaskStatus({
    taskId: "task:unlinked-resource-discovery",
    status: "completed",
    reason: "Planner accepted the discovery result"
  });

  const plannerSession = createMockTextSessionSequence([
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "replace_dependencies",
        taskId: "task:admin-auth",
        dependencyTaskIds: ["task:entry-recon", "task:unlinked-resource-discovery"],
        reason: "incorrectly make the predecessor depend on its successor"
      }, {
        kind: "set_task_status",
        taskId: "task:admin-auth",
        status: "open",
        reason: "resume after discovering hidden resources"
      }],
      reason: "invalid dependency repair attempt",
      basedOnRefs: ["task:admin-auth", "task:unlinked-resource-discovery"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [{
          id: "task:session-lifecycle-validation",
          goal: "Validate the admin session against authenticated hidden resources",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: ["authorized target only"],
          successCriteria: ["session lifecycle works on hidden resources"],
          priority: 1,
          dependsOnTaskRefs: ["task:unlinked-resource-discovery"]
        }],
        reason: "create a successor that preserves dependency direction"
      }],
      reason: "recover by creating a successor Task",
      basedOnRefs: ["task:admin-auth", "task:unlinked-resource-discovery"]
    })
  ]);
  const controllerHarness = controller as unknown as ControllerHarness;
  controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession(JSON.stringify({
      taskId: "task:session-lifecycle-validation",
      status: "completed",
      summary: "Validated session lifecycle on authenticated hidden resources.",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  const result = await controller.runOnce({
    userGoal: "Validate the target without corrupting task dependencies",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });
  const events = await controller.executionLog.readAll();

  assert.equal(plannerSession.promptCount(), 2);
  assert.match(plannerSession.prompts()[1] ?? "", /<previous_decision_rejection>/);
  assert.match(plannerSession.prompts()[1] ?? "", /task:admin-auth -> task:unlinked-resource-discovery -> task:admin-auth/);
  assert.equal(controller.graphStore.getTaskNode("task:admin-auth")?.properties.status, "open");
  assert.deepEqual(controller.graphStore.getTaskEnvelope("task:admin-auth")?.dependsOnTaskRefs, ["task:entry-recon"]);
  assert.equal(controller.graphStore.getTaskNode("task:session-lifecycle-validation")?.properties.status, "open");
  assert.equal(controller.runtimeStore.getTaskOutcome("task:session-lifecycle-validation")?.status, "completed");
  assert.equal(result.plannerDecision.decision, undefined);
  assert.ok(events.some((event) => event.eventType === "planner_decision_rejected"));
  assert.ok(events.some((event) => event.eventType === "task_created" && event.taskId === "task:session-lifecycle-validation"));
  assert.equal(events.some((event) => event.eventType === "run_failed"), false);
  await controller.close({ drainProjectionJobs: false });
});

test("same partial task resumes without a redundant open status write", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const executorBase = createMockTextSessionSequence([
    JSON.stringify({
      taskId: "task:primary",
      status: "partial",
      summary: "Confirmed arbitrary file read from the application contract directory.",
      evidenceRefs: [],
      artifactRefs: [],
      blockerReason: "The confirmed primitive has not yet been applied to /challenge/flag.txt.",
      checkpointReason: "Need more budget to apply the confirmed capability to the remaining goal.",
      retryable: true
    }),
    JSON.stringify({
      taskId: "task:primary",
      status: "completed",
      summary: "Recovered the requested target artifact.",
      evidenceRefs: [],
      artifactRefs: []
    })
  ]);
  let executorDisposeCount = 0;
  let executorFactoryCount = 0;
  const executorSession = {
    ...executorBase,
    sessionFile: "/tmp/mock-primary-session.jsonl",
    async abort(): Promise<void> {},
    dispose(): void {
      executorDisposeCount += 1;
    }
  };
  const observerSession = createAbortableMockTextSession(observerProjectionJson());
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "create_tasks",
          tasks: [{
            id: "task:primary",
            goal: "Validate the primary application capability",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: ["authorized target only"],
            successCriteria: ["recover the target artifact"],
            budget: { maxTurns: 10 },
            priority: 1
          }],
          reason: "Create the initial tasks",
          basedOnRefs: ["goal:root"]
        }],
        reason: "Start with the primary path",
        basedOnRefs: ["goal:root"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "patch_task",
          taskId: "task:primary",
          patch: { budget: { maxTurns: 16 } },
          reason: "Extend the same task budget because it has a confirmed capability.",
          basedOnRefs: ["task:primary"]
        }],
        reason: "Resume the confirmed path and archive the redundant task.",
        basedOnRefs: ["task:primary"]
      })
    ]),
    executor: createAbortableMockTextSession("{}"),
    observer: observerSession
  };
  controllerHarness.createObserverSessionForMode = async () => ({
    session: observerSession,
    dynamicObserver: true
  });
  controllerHarness.createExecutorSessionForTask = async () => {
    executorFactoryCount += 1;
    return {
      session: executorSession,
      dynamicExecutor: true,
      resumed: executorFactoryCount > 1,
      resumeCount: executorFactoryCount > 1 ? 1 : 0
    };
  };

  const cycleInput = {
    userGoal: "Obtain flag{uuid}; the likely filesystem location is /challenge/flag.txt",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  };
  const cycles = [await controller.runOnce(cycleInput), await controller.runOnce(cycleInput)];
  const events = await controller.executionLog.readAll();
  const prompts = executorSession.prompts();

  assert.equal(cycles.length, 2);
  assert.equal(executorFactoryCount, 2);
  assert.equal(executorSession.promptCount(), 2);
  assert.match(prompts[0] ?? "", /<root_goal>[\s\S]*\/challenge\/flag\.txt/);
  assert.match(prompts[1] ?? "", /继续执行同一个 Task/);
  assert.doesNotMatch(prompts[1] ?? "", /<planner_hint>/);
  assert.match(prompts[1] ?? "", /<execution_brief>[\s\S]*Confirmed arbitrary file read/);
  assert.match(prompts[1] ?? "", /The confirmed primitive has not yet been applied to \/challenge\/flag\.txt/);
  assert.match(prompts[1] ?? "", /taskAllocation: 0\/16; remaining: 16/);
  assert.match(prompts[1] ?? "", /epochSlice: 0\/12; remaining: 12/);
  assert.equal(executorDisposeCount, 2);
  const firstPartialIndex = events.findIndex((event) => event.eventType === "task_partial" && event.taskId === "task:primary");
  const resumeDecisionIndex = events.findIndex((event) => event.eventType === "planner_task_patched"
    && event.taskId === "task:primary");
  const secondEpochIndex = events.findIndex((event, index) => index > firstPartialIndex
    && event.eventType === "epoch_transition"
    && event.taskId === "task:primary");
  assert.ok(firstPartialIndex >= 0);
  assert.ok(resumeDecisionIndex > firstPartialIndex);
  assert.ok(secondEpochIndex > resumeDecisionIndex);
  assert.equal(events.some((event) => event.eventType === "planner_status_applied"
    && event.taskId === "task:primary"
    && event.payload.status === "open"), false);
  assert.ok(events.some((event) => event.eventType === "planner_handoff_resolved"
    && event.taskId === "task:primary"
    && event.payload.resolution === "resume_partial"));
  await controller.close({ drainProjectionJobs: false, projectionCancelGraceMs: 100 });
});

test("identified product resumes into vulnerability research before broader probing", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-research-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const listeners: Array<(event: unknown) => void> = [];
  const prompts: string[] = [];
  let executorFactoryCount = 0;
  let promptCount = 0;
  const executorSession = {
    isStreaming: false,
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      promptCount += 1;
      if (promptCount === 1) {
        for (const listener of [...listeners]) {
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{
                type: "text",
                text: JSON.stringify({
                  taskId: "task:dify",
                  status: "partial",
                  summary: "Response and static assets identify a Dify frontend; public vulnerability coverage is still missing.",
                  evidenceRefs: [],
                  artifactRefs: [],
                  suggestedNextGoal: "Research historical Dify vulnerabilities and validate applicable preconditions.",
                  retryable: true
                })
              }]
            }
          });
        }
        return;
      }
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_start",
          toolCallId: "call:vulnerability-search",
          toolName: "vulnerability_search",
          args: { query: "Dify Next.js" }
        });
        listener({
          type: "tool_execution_end",
          toolCallId: "call:vulnerability-search",
          toolName: "vulnerability_search",
          isError: false,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                resultClass: "family_hit",
                negativeSignalStrength: "none",
                publicReferences: [{ url: "https://example.test/dify-advisory" }]
              })
            }]
          }
        });
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{
              type: "text",
              text: JSON.stringify({
                taskId: "task:dify",
                status: "completed",
                summary: "Historical vulnerability research completed and applicable prerequisites were validated on the authorized target.",
                evidenceRefs: [],
                artifactRefs: []
              })
            }]
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async steer(): Promise<void> {},
    async abort(): Promise<void> {},
    dispose(): void {}
  };
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "create_tasks",
          tasks: [{
            id: "task:dify",
            goal: "Identify the application and obtain the target artifact",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: ["authorized target only"],
            successCriteria: ["identify an applicable path to the target artifact"],
            budget: { maxTurns: 8 },
            priority: 1
          }],
          reason: "Establish the application identity first.",
          basedOnRefs: ["goal:root"]
        }],
        reason: "Start with one evidence-producing entry task.",
        basedOnRefs: ["goal:root"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "patch_task",
          taskId: "task:dify",
          patch: {
            budget: { maxTurns: 12 }
          },
          reason: "Dify is identified but historical vulnerability coverage is missing; research it before broader unaided probing.",
          basedOnRefs: ["task:dify"]
        }, {
          kind: "set_task_status",
          taskId: "task:dify",
          status: "open",
          reason: "Resume the same task with the product fingerprint and research objective.",
          basedOnRefs: ["task:dify"]
        }],
        reason: "Close the known-vulnerability intelligence gap.",
        basedOnRefs: ["task:dify"]
      })
    ]),
    executor: createAbortableMockTextSession("{}"),
    observer: createMockTextSession(observerProjectionJson())
  };
  controllerHarness.createExecutorSessionForTask = async () => {
    executorFactoryCount += 1;
    return {
      session: executorSession as never,
      dynamicExecutor: true,
      resumed: executorFactoryCount > 1,
      resumeCount: executorFactoryCount > 1 ? 1 : 0
    };
  };

  const cycleInput = {
    userGoal: "Recover the authorized target artifact",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  };
  const cycles = [await controller.runOnce(cycleInput), await controller.runOnce(cycleInput)];
  const events = await controller.executionLog.readAll();

  assert.equal(cycles.length, 2);
  assert.equal(cycles[1]?.taskResult?.status, "completed");
  assert.equal(executorFactoryCount, 2);
  assert.equal(promptCount, 2);
  assert.match(prompts[1] ?? "", /继续执行同一个 Task/);
  assert.doesNotMatch(prompts[1] ?? "", /<planner_hint>/);
  assert.match(prompts[1] ?? "", /<execution_brief>[\s\S]*public vulnerability coverage is still missing/);
  assert.ok(events.some((event) => event.eventType === "tool_started"
    && event.taskId === "task:dify"
    && event.payload.toolName === "vulnerability_search"));
  assert.ok(events.some((event) => event.eventType === "tool_finished"
    && event.taskId === "task:dify"
    && event.payload.toolName === "vulnerability_search"));
  await controller.close({ drainProjectionJobs: false, projectionCancelGraceMs: 100 });
});

test("maxTurns abort gives the same Executor one unmetered structured finalization turn", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const listeners: Array<(event: unknown) => void> = [];
  const prompts: string[] = [];
  const activeToolHistory: string[][] = [];
  let promptCount = 0;
  let abortCount = 0;
  let disposeCount = 0;
  let executorFactoryCount = 0;
  const networkFinalizationPromptCounts: number[] = [];
  let currentTaskEnvelope: TaskEnvelope | undefined;
  let activeToolNames = ["bash", "read", "artifact_write", "task_result_submit"];
  const executorSession = {
    isStreaming: false,
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      promptCount += 1;
      if (promptCount === 1) {
        assert.ok(currentTaskEnvelope);
        for (let turn = 1; turn <= MIN_TASK_BUDGET.maxTurns; turn += 1) {
          for (const listener of [...listeners]) {
            listener({
              type: "turn_end",
              message: {
                role: "assistant",
                stopReason: "toolUse",
                responseId: `response:exploration:${turn}`,
                usage: { input: 10, output: 10 }
              }
            });
          }
        }
        await waitFor(() => abortCount === 1);
        throw new Error("Request was aborted");
      }
      assert.equal(promptCount, 2);
      assert.deepEqual(networkFinalizationPromptCounts, []);
      for (const listener of [...listeners]) {
        const details = {
          taskId: "task:primary",
          status: "partial",
          summary: "Checkpoint preserves the latest verified capability and its current limitation.",
          evidenceRefs: [],
          artifactRefs: []
        };
        listener({
          type: "tool_execution_start",
          toolCallId: "call:checkpoint-finalization",
          toolName: "task_result_submit",
          args: details
        });
        listener({
          type: "tool_execution_end",
          toolCallId: "call:checkpoint-finalization",
          toolName: "task_result_submit",
          result: { details },
          isError: false
        });
        listener({
          type: "turn_end",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            responseId: "response:checkpoint-finalization",
            usage: { input: 10, output: 10 }
          }
        });
      }
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async abort(): Promise<void> {
      abortCount += 1;
    },
    dispose(): void {
      disposeCount += 1;
    },
    getActiveToolNames(): string[] {
      return [...activeToolNames];
    },
    setActiveToolsByName(toolNames: string[]): void {
      activeToolNames = [...toolNames];
      activeToolHistory.push([...toolNames]);
    },
    getSessionStats() {
      return {
        sessionId: "session:checkpoint-integration",
        userMessages: promptCount,
        assistantMessages: promptCount,
        toolCalls: promptCount === 0 ? 0 : promptCount - 1,
        toolResults: promptCount === 0 ? 0 : promptCount - 1,
        totalMessages: promptCount * 2,
        tokens: {
          input: promptCount * 10,
          output: promptCount * 10,
          cacheRead: 0,
          cacheWrite: 0,
          total: promptCount * 20
        },
        cost: promptCount * 0.001
      };
    }
  };
  controllerHarness.agents = {
    planner: createMockTextSession(JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [{
          id: "task:primary",
          goal: "Recover the target artifact",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: ["authorized target only"],
          successCriteria: ["recover the target artifact"],
          budget: { maxTurns: MIN_TASK_BUDGET.maxTurns },
          priority: 1
        }],
        reason: "Create the primary task",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Start the primary task",
      basedOnRefs: ["goal:root"]
    })),
    executor: createAbortableMockTextSession("{}"),
    observer: createMockTextSession(observerProjectionJson())
  };
  controllerHarness.createExecutorSessionForTask = async (taskEnvelope) => {
    executorFactoryCount += 1;
    currentTaskEnvelope = taskEnvelope;
    return {
      session: executorSession as never,
      dynamicExecutor: true,
      resumed: false,
      resumeCount: 0
    };
  };
  controllerHarness.scheduleExecutorNetworkFinalization = async () => {
    networkFinalizationPromptCounts.push(promptCount);
  };

  const result = await controller.runOnce({
    userGoal: "Recover the target artifact",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });
  const events = await controller.executionLog.readAll();

  assert.equal(result.taskResult?.status, "partial");
  assert.equal(executorFactoryCount, 1);
  assert.equal(promptCount, 2);
  assert.deepEqual(networkFinalizationPromptCounts, [2]);
  assert.match(prompts[1] ?? "", /RUNTIME_BUDGET_CHECKPOINT_FINALIZATION/);
  assert.match(prompts[1] ?? "", /artifact_write/);
  const checkpointTaskEvent = events.find((event) => event.eventType === "task_partial"
    && event.summary === "Checkpoint preserves the latest verified capability and its current limitation.");
  assert.ok(checkpointTaskEvent);
  assert.ok(controller.runtimeStore.listTaskEpochOutcomes("task:primary").some((outcome) =>
    outcome.status === "submitted"
      && outcome.taskOutcomeRef === "task:primary"
      && outcome.terminalSeq >= (checkpointTaskEvent.seq ?? 0)
  ));
  assert.ok(events.some((event) => event.eventType === "projection_job_queued"
    && event.payload.reason === "task_end"));
  assert.equal(controller.runtimeStore.getTaskConsumedTurns("task:primary"), MIN_TASK_BUDGET.maxTurns);
  assert.deepEqual(activeToolHistory, [
    ["task_result_submit"],
    ["bash", "read", "artifact_write", "task_result_submit"]
  ]);
  const executorMetrics = events.filter((event) => event.eventType === "invocation_metrics"
    && event.payload.invocationKind === "executor");
  assert.equal(executorMetrics.length, 2);
  assert.equal(executorMetrics[0]?.payload.phase, undefined);
  assert.equal(executorMetrics[1]?.payload.phase, "checkpoint_finalization");
  assert.ok(!events.some((event) => event.eventType === "executor_provider_retry_scheduled"));
  assert.equal(abortCount, 1);
  assert.equal(disposeCount, 1);
  await controller.close({ drainProjectionJobs: false, projectionCancelGraceMs: 100 });
});

test("planner command targets ignore basedOnRefs and reason task mentions", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  controller.graphStore.createTasks([
    {
      taskId: "task:intended",
      goal: "Intended target",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["intended done"],
      priority: 1
    },
    {
      taskId: "task:referenced-only",
      goal: "Referenced only",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["must not change"],
      priority: 1
    }
  ]);
  controller.graphStore.markTaskStatus({ taskId: "task:intended", status: "partial" });
  controller.graphStore.markTaskStatus({ taskId: "task:referenced-only", status: "partial" });
  const controllerHarness = controller as unknown as ControllerHarness;
  const cleanedTaskIds: string[] = [];
  controller.runtimeStore.upsertExecutorSession({ taskId: "task:intended", sessionFile: "/tmp/task-intended.jsonl" });
  controller.runtimeStore.upsertExecutorSession({ taskId: "task:referenced-only", sessionFile: "/tmp/task-referenced.jsonl" });
  controllerHarness.disposeTaskExecutorResources = async (taskId) => { cleanedTaskIds.push(taskId); };
  controllerHarness.agents = {
    planner: createMockTextSession(JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_task_status",
        taskId: "task:intended",
        status: "completed",
        reason: "Complete task:intended even though task:referenced-only appears in reason",
        basedOnRefs: ["task:referenced-only"]
      }],
      reason: "Only the explicit taskId should be mutated",
      basedOnRefs: ["task:referenced-only"]
    })),
    executor: createAbortableMockTextSession(JSON.stringify({
      status: "completed",
      summary: "executor should not run",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  await controller.runOnce({
    userGoal: "Validate strict task targeting",
    scopeSummary: "Authorized target only"
  });

  assert.equal(
    controller.graphStore.query("task", ["task:intended"], 1).nodes[0]?.properties.status,
    "completed"
  );
  assert.equal(
    controller.graphStore.query("task", ["task:referenced-only"], 1).nodes[0]?.properties.status,
    "partial"
  );
  assert.deepEqual(cleanedTaskIds, ["task:intended"]);
  assert.equal(controller.runtimeStore.getExecutorSession("task:intended"), undefined);
  assert.ok(controller.runtimeStore.getExecutorSession("task:referenced-only"));
  controller.close();
});

test("wakes Planner on the first completion while independent work and dependencies continue", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  controller.graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:a", graphKind: "operation", type: "Host", label: "A", properties: {} },
      { id: "host:b", graphKind: "operation", type: "Host", label: "B", properties: {} }
    ],
    edges: []
  });
  let activePrompts = 0;
  let maxActivePrompts = 0;
  const promptOrder: string[] = [];
  const executorSessions = new Map<string, ReturnType<typeof createDelayedAbortableMockTextSession>>();
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [
          {
            id: "task:recon-a",
            goal: "Recon A",
            targetRefs: ["host:a"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["A done"],
            budget: { maxTurns: 1 },
            priority: 1,
            parentTaskId: "goal:root",
            parallelGroup: "recon"
          },
          {
            id: "task:recon-b",
            goal: "Recon B",
            targetRefs: ["host:b"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["B done"],
            budget: { maxTurns: 1 },
            priority: 1,
            parentTaskId: "goal:root",
            parallelGroup: "recon"
          },
          {
            id: "task:exploit",
            goal: "Exploit after recon",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["flag found"],
            budget: { maxTurns: 1 },
            priority: 2,
            parentTaskId: "goal:root",
            dependsOnTaskRefs: ["task:recon-a", "task:recon-b"]
          }
        ],
        reason: "Recon branches can run in parallel, exploit depends on both.",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Recon branches can run in parallel, exploit depends on both.",
      basedOnRefs: ["goal:root"]
    }), JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_task_status",
        taskId: "task:recon-a",
        status: "completed",
        reason: "Accept the completed first recon branch."
      }],
      reason: "Accept the first completed branch while the second remains active.",
      basedOnRefs: ["task:recon-a"]
    }), JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_task_status",
        taskId: "task:recon-b",
        status: "completed",
        reason: "Accept the completed second recon branch."
      }],
      reason: "Both hard predecessors are now accepted; admit the exploit wave.",
      basedOnRefs: ["task:recon-a", "task:recon-b"]
    })]),
    executor: createAbortableMockTextSession(JSON.stringify({
      status: "completed",
      summary: "fallback executor should not be used for parallel wave",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };
  controllerHarness.createExecutorSessionForTask = async (taskEnvelope, useDynamicExecutor) => {
    const session = createDelayedAbortableMockTextSession(async () => {
      activePrompts += 1;
      maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
      promptOrder.push(taskEnvelope.taskId);
      await new Promise((resolve) => setTimeout(resolve, taskEnvelope.taskId === "task:recon-a"
        ? 10
        : taskEnvelope.taskId === "task:recon-b" ? 40 : 1));
      activePrompts -= 1;
      return JSON.stringify({
        taskId: taskEnvelope.taskId,
        status: "completed",
        summary: `${taskEnvelope.taskId} completed`,
        evidenceRefs: [],
        artifactRefs: []
      });
    });
    executorSessions.set(taskEnvelope.taskId, session);
    return {
      dynamicExecutor: useDynamicExecutor,
      resumed: false,
      resumeCount: 0,
      session
    };
  };

  const cycleInput = {
    userGoal: "Get flag",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 2
  };
  const cycles = [
    await controller.runOnce(cycleInput),
    await controller.runOnce(cycleInput),
    await controller.runOnce(cycleInput)
  ];
  const events = await controller.executionLog.readAll();

  assert.equal(cycles[0].plannerDecision.decision, undefined);
  assert.deepEqual(cycles[0].taskResults?.map((taskResult) => taskResult.taskId), ["task:recon-a"]);
  assert.equal(cycles[1].taskResults?.length, 1);
  assert.equal(cycles[1].taskResults?.[0]?.taskId, "task:recon-b");
  assert.equal(maxActivePrompts, 2);
  assert.deepEqual(promptOrder.slice(0, 2).sort(), ["task:recon-a", "task:recon-b"]);
  assert.equal(promptOrder[2], "task:exploit");
  const exploitPrompt = executorSessions.get("task:exploit")?.prompts()[0] ?? "";
  assert.match(exploitPrompt, /<dependency_outcomes>/);
  assert.match(exploitPrompt, /"taskRef":"task:recon-a"/);
  assert.match(exploitPrompt, /"taskRef":"task:recon-b"/);
  assert.match(exploitPrompt, /task:recon-a completed/);
  assert.match(exploitPrompt, /task:recon-b completed/);
  assert.equal(controller.graphStore.query("task", ["task:exploit"], 1).nodes[0]?.properties.status, "open");
  assert.equal(controller.runtimeStore.getTaskOutcome("task:exploit")?.status, "completed");
  const firstReconCompleted = events.findIndex((event) => event.eventType === "task_completed"
    && event.taskId === "task:recon-a");
  const secondPlannerStarted = events.findIndex((event, index) => index > firstReconCompleted
    && event.eventType === "planner_prompt_started");
  const secondReconCompleted = events.findIndex((event) => event.eventType === "task_completed"
    && event.taskId === "task:recon-b");
  assert.ok(firstReconCompleted >= 0);
  assert.ok(secondPlannerStarted > firstReconCompleted);
  assert.ok(secondReconCompleted > secondPlannerStarted);
  assert.ok(events.some((event) => event.eventType === "task_wave_started"));
  controller.close();
});

test("Planner repairs active Task mutation while still creating a dependent Task", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness & {
    activeTaskRuns: Map<string, unknown>;
  };
  const slowRelease = createDeferred<void>();
  const plannerSession = createMockTextSessionSequence([
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [
          {
            id: "task:fast-owned",
            goal: "Complete the fast branch",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["fast branch completed"],
            priority: 1
          },
          {
            id: "task:slow-owned",
            goal: "Complete the slow branch",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["slow branch completed"],
            priority: 1
          }
        ],
        reason: "Start independent branches",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Start independent branches",
      basedOnRefs: ["goal:root"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [
        {
          kind: "patch_task",
          taskId: "task:slow-owned",
          patch: { priority: 8 },
          reason: "Attempt to mutate a running task",
          basedOnRefs: ["task:fast-owned"]
        },
        {
          kind: "set_task_status",
          taskId: "task:slow-owned",
          status: "archived",
          reason: "Attempt to stop a running task from Planner",
          basedOnRefs: ["task:fast-owned"]
        },
        {
          kind: "create_tasks",
          tasks: [{
            id: "task:after-slow",
            goal: "Use the slow branch outcome",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["dependent branch completed"],
            dependsOnTaskRefs: ["task:slow-owned"],
            priority: 2
          }],
          reason: "Create a dependent task",
          basedOnRefs: ["task:slow-owned"]
        }
      ],
      reason: "Incorrectly mutate the running task while planning its successor",
      basedOnRefs: ["task:fast-owned", "task:slow-owned"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [{
          id: "task:after-slow",
          goal: "Use the slow branch outcome",
          targetRefs: ["goal:root"],
          scopeRef: "scope:root",
          constraints: [],
          successCriteria: ["dependent branch completed"],
          dependsOnTaskRefs: ["task:slow-owned"],
          priority: 2
        }],
        reason: "Create a successor without mutating the running predecessor",
        basedOnRefs: ["task:slow-owned"]
      }],
      reason: "Keep the running Task owned by its Executor",
      basedOnRefs: ["task:slow-owned"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_task_status",
        taskId: "task:slow-owned",
        status: "completed",
        reason: "Accept the slow branch outcome after its Executor handoff."
      }],
      reason: "Release the dependent task after accepting its hard predecessor.",
      basedOnRefs: ["task:slow-owned"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_task_status",
        taskId: "task:after-slow",
        status: "completed",
        reason: "Accept the dependent task outcome."
      }],
      reason: "Accept the final dependent task outcome.",
      basedOnRefs: ["task:after-slow"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [],
      reason: "All admitted tasks are settled.",
      basedOnRefs: ["task:after-slow"]
    })
  ]);
  controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession(observerProjectionJson())
  };
  controllerHarness.createExecutorSessionForTask = async (taskEnvelope) => ({
    dynamicExecutor: true,
    resumed: false,
    resumeCount: 0,
    session: createDelayedAbortableMockTextSession(async () => {
      if (taskEnvelope.taskId === "task:slow-owned") {
        await slowRelease.promise;
      }
      return JSON.stringify({
        taskId: taskEnvelope.taskId,
        status: "completed",
        summary: `${taskEnvelope.taskId} completed`,
        evidenceRefs: [],
        artifactRefs: []
      });
    })
  });

  const runPromise = controller.runUntilDone({
    userGoal: "Preserve active Task ownership",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 3,
    maxParallelTasks: 2,
    maxRunTimeMs: 60_000
  });
  await waitFor(async () => (await controller.executionLog.readAll()).some((event) => (
    event.eventType === "planner_decision_rejected"
    && String(event.summary).includes("cannot mutate active Task")
  )));
  assert.equal(controllerHarness.activeTaskRuns.has("task:slow-owned"), true);
  slowRelease.resolve();
  const result = await runPromise;
  const events = await controller.executionLog.readAll();

  assert.match(result.stoppedReason, /Runtime quiescent after Planner decision/);
  assert.equal(plannerSession.promptCount(), 6);
  assert.equal(controller.graphStore.getTaskNode("task:slow-owned")?.properties.status, "completed");
  assert.equal(controller.graphStore.getTaskNode("task:after-slow")?.properties.status, "completed");
  assert.equal(controller.runtimeStore.getTaskOutcome("task:after-slow")?.status, "completed");
  assert.equal(events.some((event) => event.eventType === "planner_task_patched"
    && event.taskId === "task:slow-owned"), false);
  assert.equal(events.some((event) => event.eventType === "planner_status_applied"
    && event.taskId === "task:slow-owned"
    && event.payload.status === "archived"), false);
  assert.equal(events.filter((event) => event.eventType === "task_created"
    && event.taskId === "task:after-slow").length, 1);
  await controller.close({ drainProjectionJobs: false });
});

test("Planner exhausting active Task mutation repairs keeps active Executors running", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness & {
    activeTaskRuns: Map<string, unknown>;
  };
  const slowRelease = createDeferred<void>();
  const plannerSession = createMockTextSessionSequence([
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [
          {
            id: "task:fast-owned",
            goal: "Complete the fast branch",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["fast branch completed"],
            priority: 1
          },
          {
            id: "task:slow-owned",
            goal: "Complete the slow branch",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["slow branch completed"],
            priority: 1
          }
        ],
        reason: "Start independent branches",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Start independent branches",
      basedOnRefs: ["goal:root"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "patch_task",
        taskId: "task:slow-owned",
        patch: { priority: 8 },
        reason: "Attempt to mutate a running task",
        basedOnRefs: ["task:fast-owned"]
      }],
      reason: "Incorrectly mutate the running task",
      basedOnRefs: ["task:slow-owned"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_task_status",
        taskId: "task:slow-owned",
        status: "archived",
        reason: "Repeat the active task mutation",
        basedOnRefs: ["task:fast-owned"]
      }],
      reason: "Repeat the invalid active task mutation",
      basedOnRefs: ["task:slow-owned"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [],
      reason: "Wait for the active task owner to finish",
      basedOnRefs: ["task:slow-owned"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "set_task_status",
        taskId: "task:slow-owned",
        status: "completed",
        reason: "Accept the completed active task outcome."
      }],
      reason: "Accept the completed active task outcome.",
      basedOnRefs: ["task:slow-owned"]
    }),
    JSON.stringify({
      decision: "apply_commands",
      commands: [],
      reason: "All admitted tasks are settled.",
      basedOnRefs: ["task:slow-owned"]
    })
  ]);
  controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession(observerProjectionJson())
  };
  controllerHarness.createExecutorSessionForTask = async (taskEnvelope) => ({
    dynamicExecutor: true,
    resumed: false,
    resumeCount: 0,
    session: createDelayedAbortableMockTextSession(async () => {
      if (taskEnvelope.taskId === "task:slow-owned") {
        await slowRelease.promise;
      }
      return JSON.stringify({
        taskId: taskEnvelope.taskId,
        status: "completed",
        summary: `${taskEnvelope.taskId} completed`,
        evidenceRefs: [],
        artifactRefs: []
      });
    })
  });

  const runPromise = controller.runUntilDone({
    userGoal: "Preserve active Executors after repeated Planner rejection",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 2,
    maxParallelTasks: 2,
    maxRunTimeMs: 60_000
  });
  await waitFor(async () => (await controller.executionLog.readAll()).some((event) => (
    event.eventType === "planner_decision_rejected"
    && event.payload?.decisionAttempt === 2
    && event.payload?.repairAttemptsExhausted === true
  )));
  assert.equal(controllerHarness.activeTaskRuns.has("task:slow-owned"), true);
  slowRelease.resolve();
  const result = await runPromise;
  const events = await controller.executionLog.readAll();

  assert.match(result.stoppedReason, /Runtime quiescent after Planner decision/);
  assert.equal(plannerSession.promptCount(), 6);
  assert.equal(controller.graphStore.getTaskNode("task:slow-owned")?.properties.status, "completed");
  assert.equal(controller.runtimeStore.getTaskOutcome("task:slow-owned")?.status, "completed");
  assert.ok(!events.some((event) => event.eventType === "run_failed"));
  assert.ok(!events.some((event) => event.eventType === "runtime_control"
    && event.summary === "runtime_abort:controller_abort"));
  assert.equal(events.filter((event) => event.eventType === "planner_decision_rejected").length, 2);
  assert.equal(events.filter((event) => event.eventType === "planner_cycle_deferred").length, 1);
  await controller.close({ drainProjectionJobs: false });
});

test("empty apply_commands schedules existing open tasks", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  controller.graphStore.createTasks([{
    parentTaskId: "goal:root",
    taskId: "task:ready-existing",
    goal: "Run already planned task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["existing task completed"],
    budget: { maxTurns: 1 },
    priority: 1
  }]);
  controllerHarness.agents = {
    planner: createMockTextSession(JSON.stringify({
      decision: "apply_commands",
      commands: [],
      reason: "No graph changes; existing open task should run.",
      basedOnRefs: ["task:ready-existing"]
    })),
    executor: createAbortableMockTextSession(JSON.stringify({
      taskId: "task:ready-existing",
      status: "completed",
      summary: "Existing task completed",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  const result = await controller.runOnce({
    userGoal: "Get flag",
    scopeSummary: "Authorized target only",
    maxParallelTasks: 1
  });
  const events = await controller.executionLog.readAll();

  assert.equal(result.plannerDecision.decision, undefined);
  assert.deepEqual(result.plannerDecision.commands, []);
  assert.equal(result.taskResult?.status, "completed");
  assert.equal(result.quiescent, false);
  assert.ok(events.some((event) => event.eventType === "task_completed"
    && event.taskId === "task:ready-existing"));
  assert.equal(
    controller.graphStore.query("task", ["task:ready-existing"], 1).nodes[0]?.properties.status,
    "open"
  );
  assert.equal(controller.runtimeStore.getTaskOutcome("task:ready-existing")?.status, "completed");
  controller.close();
});

test("empty Planner decision becomes quiescent after completed work instead of cycling", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  controller.graphStore.createTasks([{
    parentTaskId: "goal:root",
    taskId: "task:completed-awaiting-planner",
    goal: "Complete one bounded task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: ["task completed"],
    budget: { maxTurns: 1 },
    priority: 1
  }]);
  const plannerSession = createMockTextSession(JSON.stringify({
    decision: "apply_commands",
    commands: [],
    reason: "No graph change",
    basedOnRefs: ["task:completed-awaiting-planner"]
  }));
  controllerHarness.agents = {
    planner: plannerSession,
    executor: createAbortableMockTextSession(JSON.stringify({
      taskId: "task:completed-awaiting-planner",
      status: "completed",
      summary: "Bounded task completed",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  const result = await controller.runUntilDone({
    userGoal: "Complete one bounded task",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 1_000,
    maxParallelTasks: 1
  });

  assert.match(result.stoppedReason, /Runtime quiescent after Planner decision/);
  assert.equal(result.cycles.length, 1);
  assert.equal(plannerSession.promptCount(), 1);
  assert.equal((await controller.executionLog.readAll())
    .filter((event) => event.eventType === "planner_cycle_deferred").length, 0);
  await controller.close({ drainProjectionJobs: false });
});

test("progressing Planner cycles are not stopped by the no-progress limit", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness & {
    runExecutorTask: (taskEnvelope: TaskEnvelope) => Promise<{
      taskEnvelope: TaskEnvelope;
      taskResult: TaskResult;
      terminalSeq: number;
      controlSignal: ControlSignal;
    }>;
    activeTaskRuns: Map<string, unknown>;
  };
  const slowRelease = createDeferred<void>();
  let slowSettled = false;
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([JSON.stringify({
      decision: "apply_commands",
      commands: [{
        kind: "create_tasks",
        tasks: [
          {
            id: "task:fast-drain",
            goal: "Complete the fast branch",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["fast branch completed"],
            priority: 1
          },
          {
            id: "task:slow-drain",
            goal: "Complete the slow branch",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["slow branch completed"],
            priority: 1
          }
        ],
        reason: "Run both independent branches",
        basedOnRefs: ["goal:root"]
      }],
      reason: "Run both independent branches",
      basedOnRefs: ["goal:root"]
    }), JSON.stringify({
      decision: "apply_commands",
      commands: [],
      reason: "Wait for admitted tasks to settle",
      basedOnRefs: ["task:fast-drain", "task:slow-drain"]
    })]),
    executor: createAbortableMockTextSession("{}"),
    observer: createAbortableMockTextSession(observerProjectionJson())
  };
  controllerHarness.runExecutorTask = async (taskEnvelope) => {
    if (taskEnvelope.taskId === "task:slow-drain") {
      await slowRelease.promise;
      slowSettled = true;
    }
    const taskResult: TaskResult = {
      taskId: taskEnvelope.taskId,
      status: "completed",
      summary: `${taskEnvelope.taskId} completed`,
      evidenceRefs: [],
      artifactRefs: []
    };
    controller.graphStore.markTaskStatus({
      taskId: taskEnvelope.taskId,
      status: "completed",
      properties: { resultSummary: taskResult.summary }
    });
    return {
      taskEnvelope,
      taskResult,
      terminalSeq: taskEnvelope.taskId === "task:slow-drain" ? 20 : 10,
      controlSignal: {
        decision: "continue",
        reason: taskResult.summary,
        evidenceRefs: []
      }
    };
  };
  const releaseTimer = setTimeout(() => slowRelease.resolve(), 40);

  const result = await controller.runUntilDone({
    userGoal: "Drain admitted work",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 2,
    maxParallelTasks: 2,
    maxRunTimeMs: 1_000
  });
  clearTimeout(releaseTimer);

  assert.equal(result.completed, false);
  assert.match(result.stoppedReason, /Runtime quiescent after Planner decision/);
  assert.ok(result.cycles.length > 1);
  assert.equal(slowSettled, true);
  assert.equal(controllerHarness.activeTaskRuns.size, 0);
  assert.equal(controller.graphStore.getTaskNode("task:fast-drain")?.properties.status, "completed");
  assert.equal(controller.graphStore.getTaskNode("task:slow-drain")?.properties.status, "completed");
  await controller.close({ drainProjectionJobs: false });
});

test("runUntilDone continues planning after task graph command cycles", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  controllerHarness.agents = {
    planner: createMockTextSessionSequence([
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "create_tasks",
          tasks: [
            {
              id: "task:first-wave",
              goal: "Run first graph wave",
              targetRefs: ["goal:root"],
              scopeRef: "scope:root",
              constraints: [],
              successCriteria: ["checkpoint"],
              budget: { maxTurns: 1 },
              priority: 1,
              parentTaskId: "goal:root"
            }
          ],
          reason: "First graph wave should hand back to Planner.",
          basedOnRefs: ["goal:root"]
        }],
        reason: "First graph wave should hand back to Planner.",
        basedOnRefs: ["goal:root"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "create_tasks",
          tasks: [{
            id: "task:second-wave",
            goal: "Run second planner cycle",
            targetRefs: ["goal:root"],
            scopeRef: "scope:root",
            constraints: [],
            successCriteria: ["continue after graph"],
            budget: { maxTurns: 1 },
            priority: 1
          }],
          reason: "Planner continues after graph checkpoint.",
          basedOnRefs: ["goal:root"]
        }, {
          kind: "set_task_status",
          taskId: "task:first-wave",
          status: "archived",
          reason: "The first wave handed off to the distinct second wave.",
          basedOnRefs: ["task:first-wave"]
        }],
        reason: "Planner continues after graph checkpoint.",
        basedOnRefs: ["goal:root"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [{
          kind: "set_task_status",
          taskId: "task:second-wave",
          status: "archived",
          reason: "The bounded second checkpoint is complete."
        }],
        reason: "Archive the completed bounded wave.",
        basedOnRefs: ["task:second-wave"]
      }),
      JSON.stringify({
        decision: "apply_commands",
        commands: [],
        reason: "No further graph change after the second checkpoint.",
        basedOnRefs: ["task:second-wave"]
      })
    ]),
    executor: createAbortableMockTextSession(JSON.stringify({
      status: "partial",
      summary: "Task checkpointed for replanning",
      evidenceRefs: [],
      artifactRefs: []
    })),
    observer: createMockTextSession(observerProjectionJson())
  };

  const result = await controller.runUntilDone({
    userGoal: "Keep planning until budget",
    scopeSummary: "Authorized target only",
    maxPlannerCycles: 2
  });

  assert.equal(result.completed, false);
  assert.match(result.stoppedReason, /Runtime quiescent after Planner decision/);
  assert.equal(result.cycles.length, 4);
  assert.equal(result.cycles[0].plannerDecision.decision, undefined);
  assert.equal(result.cycles[1].plannerDecision.decision, undefined);
  assert.ok(
    (await controller.executionLog.readAll())
      .some((event) => event.eventType === "task_created" && event.taskId === "task:second-wave")
  );
  await controller.close({ drainProjectionJobs: false, projectionCancelGraceMs: 100 });
  const auditEvents = readFileSync(join(runtimeDir, "execution.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { eventType: string; payload: Record<string, unknown> });
  assert.ok(auditEvents.some((event) => event.eventType === "run_started"));
  assert.ok(auditEvents.some((event) => event.eventType === "run_result_decided"));
  const runCompleted = auditEvents.find((event) => event.eventType === "run_completed");
  assert.ok(runCompleted);
  assert.equal(runCompleted.payload.completed, false);
  assert.match(String(runCompleted.payload.stoppedReason), /Runtime quiescent after Planner decision/);
});

function createControllerHarness(): {
  controller: SecurityAgentController;
  controllerHarness: ControllerHarness;
  abortCount: () => number;
  observerPromptCount: () => number;
  steers: () => string[];
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  let abortCount = 0;
  let observerPromptCount = 0;
  const steerTexts: string[] = [];
  controllerHarness.agents = {
    planner: {},
    observer: {},
    executor: {
      async steer(text: string): Promise<void> {
        steerTexts.push(text);
      },
      async abort(): Promise<void> {
        abortCount += 1;
      }
    }
  };
  controllerHarness.enqueueSupervisorCheck = async () => {
    observerPromptCount += 1;
    return {
      decision: "continue",
      reason: "no supervision intervention",
      evidenceRefs: [],
      confidence: "low",
      epochRef: "epoch:test",
      throughSeq: 0
    };
  };
  controllerHarness.enqueueProjectionJob = async () => ({
    graphDelta: {
      sourceEventIds: [],
      nodes: [],
      edges: []
    },
    controlSignal: {
      decision: "continue",
      reason: "no projection intervention",
      evidenceRefs: [],
      confidence: "low"
    }
  });
  return {
    controller,
    controllerHarness,
    abortCount: () => abortCount,
    observerPromptCount: () => observerPromptCount,
    steers: () => [...steerTexts]
  };
}

function createObserverControllerHarness(observerOutput: string): {
  controller: SecurityAgentController;
  controllerHarness: ControllerHarness;
  observerPromptCount: () => number;
  observerPrompts: () => string[];
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-controller-"));
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const controllerHarness = controller as unknown as ControllerHarness;
  const observerSession = createAbortableMockTextSession(observerOutput);
  controllerHarness.agents = {
    planner: createMockTextSession("{}"),
    observer: observerSession,
    executor: {
      async steer(): Promise<void> {},
      async abort(): Promise<void> {}
    }
  };
  controllerHarness.createObserverSessionForMode = async () => ({
    session: observerSession,
    dynamicObserver: true
  });
  return {
    controller,
    controllerHarness,
    observerPromptCount: () => observerSession.promptCount(),
    observerPrompts: () => observerSession.prompts()
  };
}

function createControllerWithTestLlmEnv(runtimeDir: string): SecurityAgentController {
  const previousEnv = {
    LLM_API_BASE_URL: process.env.LLM_API_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_DEFAULT_MODEL: process.env.LLM_DEFAULT_MODEL
  };
  process.env.LLM_API_BASE_URL = previousEnv.LLM_API_BASE_URL ?? "https://example.test/api/openai";
  process.env.LLM_API_KEY = previousEnv.LLM_API_KEY ?? "test-key";
  process.env.LLM_DEFAULT_MODEL = previousEnv.LLM_DEFAULT_MODEL ?? "test-model";
  try {
    const controller = new SecurityAgentController({ cwd: process.cwd(), runtimeDir, executorSandboxMode: "workspace" });
    const controllerHarness = controller as unknown as ControllerHarness;
    controllerHarness.createObserverSessionForMode = async () => ({
      session: createAbortableMockTextSession(observerProjectionJson()),
      dynamicObserver: true
    });
    return controller;
  } finally {
    restoreEnv("LLM_API_BASE_URL", previousEnv.LLM_API_BASE_URL);
    restoreEnv("LLM_API_KEY", previousEnv.LLM_API_KEY);
    restoreEnv("LLM_DEFAULT_MODEL", previousEnv.LLM_DEFAULT_MODEL);
  }
}

function restoreEnv(key: "LLM_API_BASE_URL" | "LLM_API_KEY" | "LLM_DEFAULT_MODEL", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function makeTaskEnvelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    taskId: "task:test",
    goal: "Test task",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: [],
    successCriteria: [],
    ...overrides
  };
}

function activateTask(
  controllerHarness: ControllerHarness,
  taskEnvelope: TaskEnvelope,
  overrides: { executorStopRequested?: boolean } = {}
): TestActiveState {
  const state = controllerHarness.beginTaskExecution(taskEnvelope);
  state.executorSession = controllerHarness.agents.executor;
  state.executorStopRequested = overrides.executorStopRequested ?? false;
  return state;
}

function makeExecutionEvent(
  taskId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
  id = `event:${eventType}`
): ExecutionEvent {
  return {
    id,
    taskId,
    role: "executor",
    eventType,
    timestamp: new Date().toISOString(),
    payload
  };
}

async function persistExecutorEvent(
  controller: SecurityAgentController,
  taskId: string,
  eventType: string,
  summary: string
): Promise<ExecutionEvent> {
  return controller.executionLog.append({
    taskId,
    role: "executor",
    eventType,
    summary,
    payload: eventType === "tool_finished"
      ? {
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: summary }] }
      }
      : {}
  });
}

function seedProjectionOrphans(
  controller: SecurityAgentController,
  taskId: string,
  nodes: GraphNode[]
): void {
  controller.runtimeStore.raiseProjectionDesired(taskId, 1);
  const claim = controller.runtimeStore.claimProjection(taskId);
  assert.ok(claim);
  controller.graphStore.commitProjection({
    ...claim,
    delta: {
      sourceEventIds: nodes.flatMap((node) => node.evidenceRefs ?? []),
      nodes,
      edges: []
    }
  });
}

function aliasForProjectionLabel(prompt: string, label: string): string | undefined {
  return prompt.split("\n")
    .find((line) => line.includes(` ${label} `) || line.endsWith(` ${label}`))
    ?.match(/^(existing:\d+)/)?.[1];
}

function observerProjectionJson(): string {
  return JSON.stringify({
    nodes: [],
    edges: []
  });
}

function projectionDeltaJson(nodeId: string, sourceEventId: string): string {
  return JSON.stringify({
    nodes: [
      {
        id: "new:1",
        type: "Evidence",
        label: nodeId,
        properties: {},
        evidenceRefs: [sourceEventId]
      },
      {
        id: "new:2",
        type: "WebEndpoint",
        label: `endpoint for ${nodeId}`,
        properties: {},
        evidenceRefs: [sourceEventId]
      }
    ],
    edges: [{
      from: "new:1",
      to: "new:2",
      type: "observed_on",
      evidenceRefs: [sourceEventId]
    }]
  });
}

function createMockTextSession(output: string): {
  prompt: (text: string) => Promise<void>;
  steer: (text: string) => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  promptCount: () => number;
  prompts: () => string[];
  steers: () => string[];
} {
  return createMockTextSessionSequence([output]);
}

function createCheckpointSubmissionSession(
  details: TaskResult,
  onPrompt?: () => void | Promise<void>
): ReturnType<typeof createMockTextSession> & {
  abort: () => Promise<void>;
  getActiveToolNames: () => string[];
  setActiveToolsByName: (toolNames: string[]) => void;
  activeToolHistory: () => string[][];
} {
  const listeners: Array<(event: unknown) => void> = [];
  const prompts: string[] = [];
  const toolHistory: string[][] = [];
  let activeToolNames = ["bash", "read", "artifact_write", "task_result_submit"];
  return {
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      await onPrompt?.();
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_start",
          toolCallId: "call:checkpoint-finalization",
          toolName: "task_result_submit",
          args: details
        });
        listener({
          type: "tool_execution_end",
          toolCallId: "call:checkpoint-finalization",
          toolName: "task_result_submit",
          result: { details },
          isError: false
        });
      }
    },
    async steer(): Promise<void> {},
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    promptCount: () => prompts.length,
    prompts: () => [...prompts],
    steers: () => [],
    async abort(): Promise<void> {},
    getActiveToolNames: () => [...activeToolNames],
    setActiveToolsByName(toolNames: string[]): void {
      activeToolNames = [...toolNames];
      toolHistory.push([...toolNames]);
    },
    activeToolHistory: () => toolHistory.map((toolNames) => [...toolNames])
  };
}

function createCheckpointArtifactThenResultSession(
  details: TaskResult
): ReturnType<typeof createCheckpointSubmissionSession> {
  const listeners: Array<(event: unknown) => void> = [];
  const prompts: string[] = [];
  const toolHistory: string[][] = [];
  let activeToolNames = ["bash", "read", "artifact_write", "task_result_submit"];
  return {
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolCallId: "call:checkpoint-artifact",
          toolName: "artifact_write",
          result: { details: { artifactRef: "artifact:checkpoint" } },
          isError: false
        });
      }
      assert.deepEqual(activeToolNames, ["artifact_write", "task_result_submit"]);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_start",
          toolCallId: "call:checkpoint-result",
          toolName: "task_result_submit",
          args: details
        });
        listener({
          type: "tool_execution_end",
          toolCallId: "call:checkpoint-result",
          toolName: "task_result_submit",
          result: { details },
          isError: false
        });
      }
    },
    async steer(): Promise<void> {},
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    promptCount: () => prompts.length,
    prompts: () => [...prompts],
    steers: () => [],
    async abort(): Promise<void> {},
    getActiveToolNames: () => [...activeToolNames],
    setActiveToolsByName(toolNames: string[]): void {
      activeToolNames = [...toolNames];
      toolHistory.push([...toolNames]);
    },
    activeToolHistory: () => toolHistory.map((toolNames) => [...toolNames])
  };
}

function createAbortableMockTextSession(output: string): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  return {
    ...createMockTextSession(output),
    async abort(): Promise<void> {}
  };
}

function createAbortSensitivePlannerSession(): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const prompts: string[] = [];
  let resolvePrompt: (() => void) | undefined;
  return {
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      await new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    },
    async steer(): Promise<void> {},
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    promptCount: () => prompts.length,
    prompts: () => [...prompts],
    steers: () => [],
    async abort(): Promise<void> {
      for (const listener of [...listeners]) {
        listener({
          type: "message_end",
          message: {
            stopReason: "error",
            errorMessage: "Request was aborted",
            content: []
          }
        });
      }
      resolvePrompt?.();
    }
  };
}

function createProviderErrorSession(errorMessage: string): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  return createProviderErrorThenSuccessSession(errorMessage, undefined);
}

function createProviderErrorThenSuccessSession(
  errorMessage: string,
  successOutput: string | undefined
): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const promptTexts: string[] = [];
  const steerTexts: string[] = [];
  let prompts = 0;
  return {
    async prompt(text: string): Promise<void> {
      promptTexts.push(text);
      prompts += 1;
      const output = successOutput && prompts > 1 ? successOutput : undefined;
      for (const listener of [...listeners]) {
        listener(output
          ? {
              type: "message_end",
              message: {
                content: [{ type: "text", text: output }]
              }
            }
          : {
              type: "message_end",
              message: {
                stopReason: "error",
                errorMessage,
                content: []
              }
            });
      }
    },
    async steer(text: string): Promise<void> {
      steerTexts.push(text);
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    promptCount(): number {
      return prompts;
    },
    prompts(): string[] {
      return [...promptTexts];
    },
    steers(): string[] {
      return [...steerTexts];
    },
    async abort(): Promise<void> {}
  };
}

function createDelayedAbortableMockTextSession(
  outputFactory: () => Promise<string>
): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const promptTexts: string[] = [];
  const steerTexts: string[] = [];
  let prompts = 0;
  return {
    async prompt(text: string): Promise<void> {
      promptTexts.push(text);
      prompts += 1;
      const output = await outputFactory();
      for (const listener of [...listeners]) {
        listener({
          type: "message_end",
          message: {
            content: [{ type: "text", text: output }]
          }
        });
      }
    },
    async steer(text: string): Promise<void> {
      steerTexts.push(text);
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    promptCount(): number {
      return prompts;
    },
    prompts(): string[] {
      return [...promptTexts];
    },
    steers(): string[] {
      return [...steerTexts];
    },
    async abort(): Promise<void> {}
  };
}

function createPromptAwareMockTextSession(
  outputFactory: (prompt: string, index: number) => string | Promise<string>
): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const promptTexts: string[] = [];
  const steerTexts: string[] = [];
  return {
    async prompt(text: string): Promise<void> {
      const index = promptTexts.length;
      promptTexts.push(text);
      const output = await outputFactory(text, index);
      for (const listener of [...listeners]) {
        listener({
          type: "message_end",
          message: {
            content: [{ type: "text", text: output }]
          }
        });
      }
    },
    async steer(text: string): Promise<void> {
      steerTexts.push(text);
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    promptCount(): number {
      return promptTexts.length;
    },
    prompts(): string[] {
      return [...promptTexts];
    },
    steers(): string[] {
      return [...steerTexts];
    },
    async abort(): Promise<void> {}
  };
}

function createStructuredToolSession(
  toolName: string,
  details: Record<string, unknown>
): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const promptTexts: string[] = [];
  const steerTexts: string[] = [];
  return {
    async prompt(text: string): Promise<void> {
      promptTexts.push(text);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName,
          isError: false,
          result: { details }
        });
      }
    },
    async steer(text: string): Promise<void> {
      steerTexts.push(text);
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    promptCount(): number {
      return promptTexts.length;
    },
    prompts(): string[] {
      return [...promptTexts];
    },
    steers(): string[] {
      return [...steerTexts];
    },
    async abort(): Promise<void> {}
  };
}

function createPromptAwareStructuredToolSession(
  toolName: string,
  detailsFactory: (prompt: string, index: number) => Record<string, unknown> | Promise<Record<string, unknown>>
): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const promptTexts: string[] = [];
  const steerTexts: string[] = [];
  return {
    async prompt(text: string): Promise<void> {
      const index = promptTexts.length;
      promptTexts.push(text);
      const details = await detailsFactory(text, index);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName,
          isError: false,
          result: { details }
        });
      }
    },
    async steer(text: string): Promise<void> {
      steerTexts.push(text);
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    promptCount(): number {
      return promptTexts.length;
    },
    prompts(): string[] {
      return [...promptTexts];
    },
    steers(): string[] {
      return [...steerTexts];
    },
    async abort(): Promise<void> {}
  };
}

function createStructuredToolErrorSession(
  toolName: string,
  message: string
): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const promptTexts: string[] = [];
  return {
    async prompt(text: string): Promise<void> {
      promptTexts.push(text);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName,
          isError: true,
          result: { content: [{ type: "text", text: message }] }
        });
      }
    },
    async steer(): Promise<void> {},
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    promptCount(): number {
      return promptTexts.length;
    },
    prompts(): string[] {
      return [...promptTexts];
    },
    steers(): string[] {
      return [];
    },
    async abort(): Promise<void> {}
  };
}

function createRecoveringStructuredToolSession(
  toolName: string,
  details: Record<string, unknown>
): ReturnType<typeof createMockTextSession> & { abort: () => Promise<void> } {
  const listeners: Array<(event: unknown) => void> = [];
  const promptTexts: string[] = [];
  return {
    async prompt(text: string): Promise<void> {
      promptTexts.push(text);
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName,
          isError: true,
          result: {
            content: [{
              type: "text",
              text: {
                artifactRef: "artifact:planner-validation",
                preview: "Validation failed for tool planner_submit: reason is required"
              }
            }]
          }
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      for (const listener of [...listeners]) {
        listener({
          type: "tool_execution_end",
          toolName,
          isError: false,
          result: { details }
        });
      }
    },
    async steer(): Promise<void> {},
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    promptCount(): number {
      return promptTexts.length;
    },
    prompts(): string[] {
      return [...promptTexts];
    },
    steers(): string[] {
      return [];
    },
    async abort(): Promise<void> {}
  };
}

function createMockTextSessionSequence(outputs: string[]): {
  prompt: (text: string) => Promise<void>;
  steer: (text: string) => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  promptCount: () => number;
  prompts: () => string[];
  steers: () => string[];
} {
  const listeners: Array<(event: unknown) => void> = [];
  const promptTexts: string[] = [];
  const steerTexts: string[] = [];
  let prompts = 0;
  return {
    async prompt(text: string): Promise<void> {
      promptTexts.push(text);
      const output = outputs[Math.min(prompts, outputs.length - 1)] ?? "";
      prompts += 1;
      for (const listener of [...listeners]) {
        listener({
          type: "message_end",
          message: {
            content: [{ type: "text", text: output }]
          }
        });
      }
    },
    async steer(text: string): Promise<void> {
      steerTexts.push(text);
    },
    subscribe(listener: (event: unknown) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    promptCount(): number {
      return prompts;
    },
    prompts(): string[] {
      return [...promptTexts];
    },
    steers(): string[] {
      return [...steerTexts];
    }
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForSettled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function withTestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
