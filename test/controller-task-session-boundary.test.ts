import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecurityAgentController } from "../src/controller.js";
import type { EpochOutcome, PlannerDecision, TaskEnvelope } from "../src/types.js";

type ControllerHarness = {
  agents: {
    planner: unknown;
    executor: { abort: () => Promise<void>; steer?: (text: string) => Promise<void> };
    observer: unknown;
  };
  runtimeStore: SecurityAgentController["runtimeStore"];
  graphStore: SecurityAgentController["graphStore"];
  executionLog: SecurityAgentController["executionLog"];
  isolatedSessionsEnabled: boolean;
  structuredInvocationsEnabled: boolean;
  enqueueProjectionJob: (input: unknown) => Promise<unknown>;
  enqueueSupervisorCheck: (input: unknown) => Promise<unknown>;
  createExecutorSessionForTask: (
    taskEnvelope: TaskEnvelope,
    useDynamicExecutor: boolean
  ) => Promise<{
    session: { abort: () => Promise<void>; sessionFile?: string };
    dynamicExecutor: boolean;
    resumed: boolean;
    resumeCount: number;
    continuedFromTaskRef?: string;
  }>;
  claimExecutorContextForTask: (taskEnvelope: TaskEnvelope) => Promise<{ workspaceKey: string }>;
  assertPlannerRuntimeTransitions: (commands: NonNullable<PlannerDecision["commands"]>) => void;
  applyPlannerCommands: (
    decision: PlannerDecision,
    scopeSummary: string,
    plannerEventId: string,
    versionSnapshot: Record<string, number>
  ) => Promise<TaskEnvelope[]>;
  createNewExecutorSessionForTask: (
    taskEnvelope: TaskEnvelope,
    useDynamicExecutor: boolean
  ) => Promise<{
    session: { abort: () => Promise<void>; sessionFile?: string };
    dynamicExecutor: boolean;
    resumed: boolean;
    resumeCount: number;
  }>;
  persistEpochOutcome: (
    state: ReturnType<ControllerHarness["beginTaskExecution"]>,
    input: Pick<EpochOutcome, "status" | "reason" | "retryable" | "taskOutcomeRef">
  ) => Promise<{ outcome: EpochOutcome; eventId: string }>;
  renderResumeExecutorInput: (input: {
    rootGoal: string;
    taskEnvelope: TaskEnvelope;
    taskStatus?: Record<string, unknown>;
    runtimeBudgetStatus: string;
    continuedFromTaskRef?: string;
  }) => Promise<string>;
  beginTaskExecution: (taskEnvelope: TaskEnvelope) => {
    epochId: string;
    executorStopRequested: boolean;
    controlSignal?: { decision: string; reason: string; evidenceRefs: string[] };
    abortContext?: {
      kind: string;
      reason: string;
      controlSignal?: { decision: string; reason: string; evidenceRefs: string[] };
    };
  };
  finishTaskExecution: (taskId: string, reason?: string) => void;
  ensureRootGraph: (input: { userGoal: string; scopeSummary: string }) => Promise<void>;
  createTaskRuntimeTools: (taskEnvelope: TaskEnvelope) => Array<{
    name: string;
    execute: (
      toolCallId: string,
      params: never,
      signal: AbortSignal,
      onUpdate: () => void,
      context: never
    ) => Promise<{ content: Array<{ type: string; text?: unknown }> }>;
  }>;
};

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
    return new SecurityAgentController({ cwd: process.cwd(), runtimeDir, executorSandboxMode: "workspace" });
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

function createHarness(runtimeDir: string): { controller: SecurityAgentController; harness: ControllerHarness } {
  const controller = createControllerWithTestLlmEnv(runtimeDir);
  const harness = controller as unknown as ControllerHarness;
  harness.agents = {
    planner: {},
    observer: {},
    executor: { async abort(): Promise<void> {} }
  };
  harness.enqueueSupervisorCheck = async () => ({
    decision: "continue",
    reason: "no supervision intervention",
    evidenceRefs: [],
    confidence: "low"
  });
  harness.enqueueProjectionJob = async () => ({
    graphDelta: { sourceEventIds: [], nodes: [], edges: [] },
    controlSignal: { decision: "continue", reason: "no projection intervention", evidenceRefs: [], confidence: "low" }
  });
  return { controller, harness };
}

test("Executor evidence_list can follow graph notifications across sibling tasks in the same runtime", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.executionLog.append({
    taskId: "task:sibling",
    role: "executor",
    eventType: "tool_finished",
    summary: "Sibling task evidence",
    payload: { toolName: "bash" }
  });
  const evidenceList = harness.createTaskRuntimeTools(makeTaskEnvelope({ taskId: "task:consumer" }))
    .find((tool) => tool.name === "evidence_list");
  assert.ok(evidenceList);
  const result = await evidenceList.execute(
    "call:evidence",
    { taskRef: "task:sibling" } as never,
    new AbortController().signal,
    () => undefined,
    {} as never
  );
  const payload = JSON.parse(String(result.content[0]?.text ?? "{}")) as {
    events: Array<{ eventType: string }>;
  };
  assert.equal(payload.events[0]?.eventType, "tool_finished");
  await controller.close({ drainProjectionJobs: false });
});

test("runtime store persists executor session file per task", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const taskEnvelope = makeTaskEnvelope();

  const first = await harness.createExecutorSessionForTask(taskEnvelope, true);

  assert.equal(first.dynamicExecutor, true);
  assert.equal(first.resumed, false);
  assert.equal(first.resumeCount, 0);
  assert.ok(first.session.sessionFile, "session file should be persisted");

  const persisted = harness.runtimeStore.getExecutorSession(taskEnvelope.taskId);
  assert.ok(persisted);
  assert.equal(persisted.sessionFile, first.session.sessionFile);
  assert.equal(persisted.resumeCount, 0);

  await first.session.abort();
  await controller.close({ drainProjectionJobs: false });
});

test("same task reopens the same persisted executor session file", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const taskEnvelope = makeTaskEnvelope();

  const first = await harness.createExecutorSessionForTask(taskEnvelope, true);
  const firstFile = first.session.sessionFile;
  await first.session.abort();

  const second = await harness.createExecutorSessionForTask(taskEnvelope, true);

  assert.equal(second.resumed, true);
  assert.equal(second.resumeCount, 1);
  assert.equal(second.session.sessionFile, firstFile);

  const persisted = harness.runtimeStore.getExecutorSession(taskEnvelope.taskId);
  assert.equal(persisted?.resumeCount, 1);

  await second.session.abort();
  await controller.close({ drainProjectionJobs: false });
});

test("dependent task gets its own executor session file", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const parentTask = makeTaskEnvelope({ taskId: "task:parent" });
  const childTask = makeTaskEnvelope({
    taskId: "task:child",
    dependsOnTaskRefs: ["task:parent"]
  });

  const parentSession = await harness.createExecutorSessionForTask(parentTask, true);
  const childSession = await harness.createExecutorSessionForTask(childTask, true);

  assert.equal(childSession.resumed, false);
  assert.notEqual(childSession.session.sessionFile, parentSession.session.sessionFile);
  assert.ok(childSession.session.sessionFile, "child session file should be persisted");

  await parentSession.session.abort();
  await childSession.session.abort();
  await controller.close({ drainProjectionJobs: false });
});

test("explicit sequential successor resumes the predecessor session under one owner", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const parentTask = makeTaskEnvelope({ taskId: "task:parent" });
  const childTask = makeTaskEnvelope({
    taskId: "task:child",
    goal: "Complete a new goal with the established state",
    dependsOnTaskRefs: ["task:parent"],
    continueFromTaskRef: "task:parent"
  });

  const parentSession = await harness.createExecutorSessionForTask(parentTask, true);
  const parentFile = parentSession.session.sessionFile;
  await parentSession.session.abort();
  const claimed = await harness.claimExecutorContextForTask(childTask);
  const childSession = await harness.createExecutorSessionForTask(childTask, true);

  assert.equal(claimed.workspaceKey, "task:parent");
  assert.equal(harness.runtimeStore.getExecutorSession("task:parent"), undefined);
  assert.equal(harness.runtimeStore.getExecutorSession("task:child")?.workspaceKey, "task:parent");
  assert.equal(childSession.session.sessionFile, parentFile);
  assert.equal(childSession.resumed, true);
  assert.equal(childSession.continuedFromTaskRef, "task:parent");

  await childSession.session.abort();
  await controller.close({ drainProjectionJobs: false });
});

test("Planner accepts a completed direct dependency as an Executor context source", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  await harness.ensureRootGraph({ userGoal: "Obtain result", scopeSummary: "authorized target" });
  const source = makeTaskEnvelope({ taskId: "task:source", successCriteria: ["foothold established"] });
  harness.graphStore.createTask({ ...source, priority: 1 });
  harness.runtimeStore.upsertTaskOutcome({
    taskRef: source.taskId,
    epochRef: "epoch:source",
    status: "completed",
    summary: "Authenticated foothold established",
    evidenceRefs: ["event:source"],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 1,
    createdAt: new Date(0).toISOString()
  });
  harness.runtimeStore.upsertExecutorSession({
    taskId: source.taskId,
    sessionFile: "/runtime/source.jsonl"
  });
  const successor = {
    id: "task:successor",
    goal: "Obtain a distinct final result",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    successCriteria: ["final result persisted"],
    priority: 1,
    dependsOnTaskRefs: [source.taskId],
    continueFromTaskRef: source.taskId
  };

  assert.doesNotThrow(() => harness.assertPlannerRuntimeTransitions([{
    kind: "set_task_status",
    taskId: source.taskId,
    status: "completed"
  }, {
    kind: "create_tasks",
    tasks: [successor]
  }]));
  assert.throws(() => harness.assertPlannerRuntimeTransitions([{
    kind: "create_tasks",
    tasks: [{ ...successor, id: "task:not-dependent", dependsOnTaskRefs: [] }]
  }]), /only from a direct dependency/);
  assert.throws(() => harness.assertPlannerRuntimeTransitions([{
    kind: "set_task_status",
    taskId: source.taskId,
    status: "completed"
  }, {
    kind: "create_tasks",
    tasks: [
      successor,
      { ...successor, id: "task:second-successor" }
    ]
  }]), /can have only one successor/);

  await controller.close({ drainProjectionJobs: false });
});

test("Planner cannot complete or transfer context from a Task with a partial latest outcome", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  await harness.ensureRootGraph({ userGoal: "Obtain result", scopeSummary: "authorized target" });
  const source = makeTaskEnvelope({ taskId: "task:source", successCriteria: ["enumeration recorded"] });
  harness.graphStore.createTask({ ...source, priority: 1 });
  harness.runtimeStore.upsertTaskOutcome({
    taskRef: source.taskId,
    epochRef: "epoch:source",
    status: "partial",
    summary: "Enumeration is sufficient; exploitation remains",
    evidenceRefs: ["event:source"],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 1,
    createdAt: new Date(0).toISOString()
  });
  harness.runtimeStore.upsertExecutorSession({
    taskId: source.taskId,
    sessionFile: "/runtime/source.jsonl"
  });

  assert.throws(() => harness.assertPlannerRuntimeTransitions([{
    kind: "set_task_status",
    taskId: source.taskId,
    status: "completed"
  }, {
    kind: "create_tasks",
    tasks: [{
      id: "task:successor",
      goal: "Exploit the enumerated service",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      successCriteria: ["result persisted"],
      priority: 1,
      dependsOnTaskRefs: [source.taskId],
      continueFromTaskRef: source.taskId
    }]
  }]), /requires a completed TaskOutcome/);

  await controller.close({ drainProjectionJobs: false });
});

test("Planner cannot reuse a completed outcome after Task objectives are appended", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  await harness.ensureRootGraph({ userGoal: "Obtain result", scopeSummary: "authorized target" });
  const task = makeTaskEnvelope({ taskId: "task:source", successCriteria: ["foothold established"] });
  harness.graphStore.createTask({ ...task, priority: 1 });
  harness.runtimeStore.upsertTaskOutcome({
    taskRef: task.taskId,
    epochRef: "epoch:source",
    objectiveRevision: 1,
    status: "completed",
    summary: "The original foothold objective is complete",
    evidenceRefs: ["event:source"],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 1,
    createdAt: new Date(0).toISOString()
  });

  const appendCommand = {
    kind: "patch_task" as const,
    taskId: task.taskId,
    patch: {
      appendObjectives: [{
        goal: "Use the foothold to obtain the remaining result",
        successCriteria: ["remaining result persisted"]
      }]
    }
  };
  assert.throws(() => harness.assertPlannerRuntimeTransitions([
    appendCommand,
    { kind: "set_task_status", taskId: task.taskId, status: "completed" }
  ]), /current objective definition/);

  harness.graphStore.patchTask({ taskId: task.taskId, patch: appendCommand.patch });
  assert.throws(() => harness.assertPlannerRuntimeTransitions([{
    kind: "set_task_status",
    taskId: task.taskId,
    status: "completed"
  }]), /current objective definition/);

  harness.runtimeStore.upsertTaskOutcome({
    taskRef: task.taskId,
    epochRef: "epoch:continued",
    objectiveRevision: 2,
    status: "completed",
    summary: "The original and appended objectives are complete",
    evidenceRefs: ["event:continued"],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 2,
    createdAt: new Date(1).toISOString()
  });
  assert.doesNotThrow(() => harness.assertPlannerRuntimeTransitions([{
    kind: "set_task_status",
    taskId: task.taskId,
    status: "completed"
  }]));

  await controller.close({ drainProjectionJobs: false });
});

test("Planner completion preserves a session reserved for an explicit successor", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  await harness.ensureRootGraph({ userGoal: "Obtain result", scopeSummary: "authorized target" });
  const source = makeTaskEnvelope({ taskId: "task:source", successCriteria: ["foothold established"] });
  harness.graphStore.createTask({ ...source, priority: 1 });
  harness.runtimeStore.upsertTaskOutcome({
    taskRef: source.taskId,
    epochRef: "epoch:source",
    status: "completed",
    summary: "Authenticated foothold established",
    evidenceRefs: ["event:source"],
    artifactRefs: [],
    capabilityRefs: [],
    terminalSeq: 1,
    createdAt: new Date(0).toISOString()
  });
  harness.runtimeStore.upsertExecutorSession({
    taskId: source.taskId,
    sessionFile: "/runtime/source.jsonl"
  });

  const created = await harness.applyPlannerCommands({
    commands: [{
      kind: "set_task_status",
      taskId: source.taskId,
      status: "completed"
    }, {
      kind: "create_tasks",
      tasks: [{
        id: "task:successor",
        goal: "Obtain a distinct final result",
        targetRefs: ["goal:root"],
        scopeRef: "scope:root",
        successCriteria: ["final result persisted"],
        priority: 1,
        dependsOnTaskRefs: [source.taskId],
        continueFromTaskRef: source.taskId
      }]
    }],
    reason: "The first goal is complete; continue its state into the next goal"
  }, "authorized target", "event:planner", { [source.taskId]: 1 });

  assert.equal(created[0]?.continueFromTaskRef, source.taskId);
  assert.equal(harness.graphStore.getTaskEnvelope("task:successor")?.continueFromTaskRef, source.taskId);
  assert.ok(harness.runtimeStore.getExecutorSession(source.taskId));
  assert.equal(harness.runtimeStore.getExecutorSession("task:successor"), undefined);
  assert.throws(() => harness.assertPlannerRuntimeTransitions([{
    kind: "create_tasks",
    tasks: [{
      id: "task:competing-successor",
      goal: "Compete for the same context",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      successCriteria: ["result"],
      priority: 1,
      dependsOnTaskRefs: [source.taskId],
      continueFromTaskRef: source.taskId
    }]
  }]), /already reserved by task:successor/);

  await harness.applyPlannerCommands({
    commands: [{
      kind: "set_task_status",
      taskId: "task:successor",
      status: "archived"
    }],
    reason: "The reserved successor is no longer needed"
  }, "authorized target", "event:archive", { "task:successor": 1 });
  assert.equal(harness.runtimeStore.getExecutorSession(source.taskId), undefined);
  await controller.close({ drainProjectionJobs: false });
});

test("resume input re-injects canonical task, graph and dependency outcomes", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const taskEnvelope = makeTaskEnvelope({
    goal: "Use confirmed admin session to read target file",
    successCriteria: ["file content extracted"]
  });
  await harness.ensureRootGraph({ userGoal: "Obtain flag", scopeSummary: "authorized target" });
  harness.graphStore.createTask({
    ...taskEnvelope,
    priority: 1
  });

  const resumeInput = await harness.renderResumeExecutorInput({
    rootGoal: "Obtain flag",
    taskEnvelope,
    taskStatus: { plannerReason: "Continue with admin session" },
    runtimeBudgetStatus: "turns: 0/12; remaining: 12"
  });

  assert.match(resumeInput, /继续执行同一个 Task/);
  assert.match(resumeInput, /<updated_task>/);
  assert.match(resumeInput, /<operation_graph format="json">/);
  assert.match(resumeInput, /<reasoning_graph format="json">/);
  assert.doesNotMatch(resumeInput, /<planner_hint>/);
  assert.match(resumeInput, /<dependency_outcomes>/);
  assert.match(resumeInput, /Use confirmed admin session to read target file/);

  await controller.close({ drainProjectionJobs: false });
});

test("transferred session input makes the successor Task authoritative", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const taskEnvelope = makeTaskEnvelope({
    taskId: "task:successor",
    goal: "Use the established foothold to obtain the protected result",
    successCriteria: ["protected result extracted"],
    dependsOnTaskRefs: ["task:foothold"],
    continueFromTaskRef: "task:foothold"
  });

  const input = await harness.renderResumeExecutorInput({
    rootGoal: "Obtain the final result",
    taskEnvelope,
    runtimeBudgetStatus: "turns: 0/12; remaining: 12",
    continuedFromTaskRef: "task:foothold"
  });

  assert.match(input, /旧 Task task:foothold 已结束/);
  assert.match(input, /现在执行新的 TaskEnvelope/);
  assert.match(input, /Use the established foothold to obtain the protected result/);
  assert.doesNotMatch(input, /继续执行同一个 Task/);
  await controller.close({ drainProjectionJobs: false });
});

test("provider errors persist an EpochOutcome without fabricating a TaskOutcome", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const taskEnvelope = makeTaskEnvelope();

  const state = harness.beginTaskExecution(taskEnvelope);
  const { outcome } = await harness.persistEpochOutcome(state, {
    status: "provider_error",
    reason: "429 Too Many Requests: rate limit exceeded",
    retryable: true,
    taskOutcomeRef: undefined
  });

  assert.equal(outcome.status, "provider_error");
  assert.equal(outcome.retryable, true);
  assert.match(outcome.reason, /rate limit exceeded/);
  assert.equal(harness.runtimeStore.getTaskOutcome(taskEnvelope.taskId), undefined);
  const persisted = harness.runtimeStore.getEpochOutcome(state.epochId);
  assert.equal(persisted?.epochRef, outcome.epochRef);
  assert.equal(persisted?.status, outcome.status);
  assert.equal(persisted?.reason, outcome.reason);

  harness.finishTaskExecution(taskEnvelope.taskId, "provider_error");
  await controller.close({ drainProjectionJobs: false });
});

test("budget abort persists a resumable EpochOutcome without fabricating task semantics", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const taskEnvelope = makeTaskEnvelope();
  const state = harness.beginTaskExecution(taskEnvelope);
  const budgetSignal = {
    decision: "handoff",
    reason: "Task budget reached: maxTurns=12",
    evidenceRefs: ["event:budget"]
  };
  state.executorStopRequested = true;
  state.controlSignal = budgetSignal;
  state.abortContext = { kind: "budget_abort", reason: budgetSignal.reason, controlSignal: budgetSignal };

  const { outcome } = await harness.persistEpochOutcome(state, {
    status: "checkpointed",
    reason: budgetSignal.reason,
    retryable: true,
    taskOutcomeRef: undefined
  });

  assert.equal(outcome.status, "checkpointed");
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.reason, budgetSignal.reason);
  assert.equal(harness.runtimeStore.getTaskOutcome(taskEnvelope.taskId), undefined);

  harness.finishTaskExecution(taskEnvelope.taskId, "budget_exhausted");
  await controller.close({ drainProjectionJobs: false });
});

test("unforced Supervisor handoff advice creates neither task nor epoch outcome", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-session-boundary-"));
  const { controller, harness } = createHarness(runtimeDir);
  await controller.initialize();
  const taskEnvelope = makeTaskEnvelope();

  const state = harness.beginTaskExecution(taskEnvelope);
  state.controlSignal = {
    decision: "handoff",
    reason: "handoff to planner",
    evidenceRefs: ["event:handoff"]
  };

  assert.equal(harness.runtimeStore.getTaskOutcome(taskEnvelope.taskId), undefined);
  assert.equal(harness.runtimeStore.getEpochOutcome(state.epochId), undefined);

  harness.finishTaskExecution(taskEnvelope.taskId, "supervisor_handoff");
  await controller.close({ drainProjectionJobs: false });
});
