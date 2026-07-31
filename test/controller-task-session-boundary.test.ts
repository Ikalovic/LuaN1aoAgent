import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecurityAgentController } from "../src/controller.js";
import type { EpochOutcome, TaskEnvelope } from "../src/types.js";

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
  }>;
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
    plannerHint?: string;
    runtimeBudgetStatus: string;
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

test("resume input re-injects task, graph, dependency outcomes and planner hint", async () => {
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
    plannerHint: "Continue with admin session",
    runtimeBudgetStatus: "turns: 0/12; remaining: 12"
  });

  assert.match(resumeInput, /继续执行同一个 Task/);
  assert.match(resumeInput, /<updated_task>/);
  assert.match(resumeInput, /<operation_graph format="json">/);
  assert.match(resumeInput, /<reasoning_graph format="json">/);
  assert.match(resumeInput, /<planner_hint>/);
  assert.match(resumeInput, /<dependency_outcomes>/);
  assert.match(resumeInput, /Continue with admin session/);
  assert.match(resumeInput, /Use confirmed admin session to read target file/);

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
