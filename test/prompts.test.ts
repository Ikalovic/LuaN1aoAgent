import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_SYSTEM_PROMPT,
  OBSERVER_SUPERVISOR_SYSTEM_PROMPT,
  OBSERVER_PROJECTOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  renderExecutorInput,
  renderExecutorResumeInput,
  renderPlannerInput,
  renderSupervisorInput
} from "../src/prompts.js";
import type { GraphSnapshot, PlannerDecisionView, TaskEnvelope } from "../src/types.js";

test("executor prompt uses bounded experimental method and runtime steering", () => {
  const taskEnvelope: TaskEnvelope = {
    taskId: "task:test",
    goal: "Find flag",
    targetRefs: ["goal:root"],
    scopeRef: "scope:root",
    constraints: ["authorized target only"],
    successCriteria: ["flag found"],
    budget: { maxTurns: 12 }
  };
  const emptyGraph: GraphSnapshot = {
    view: "operation",
    nodes: [],
    edges: [],
    summary: {}
  };

  const input = renderExecutorInput({
    rootGoal: "Obtain flag{uuid}; candidate location /challenge/flag.txt",
    taskEnvelope,
    operationGraphSlice: emptyGraph,
    reasoningGraphSlice: { ...emptyGraph, view: "reasoning" },
    sessionRefs: [],
    toolCatalog: ["read", "bash", "grep", "find", "ls", "browser_render", "artifact_read", "artifact_write"],
    executionBrief: "No previous execution events.",
    dependencyOutcomes: "task:recon status=completed\n  result: upload endpoint confirmed",
    runtimeBudgetStatus: "turns: 0/12; remaining: 12"
  });

  assert.doesNotMatch(EXECUTOR_SYSTEM_PROMPT, /budget_status/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /先输出一句不超过 80 个汉字的可公开行动理由/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /缩小当前竞争解释或直接推进成功条件/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /先锁定当前因果边界/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /探索实验用于尚无正向基线的未知边界/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /确认实验用于已有可复现基线的机制/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /页面本来就存在的说明文字/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /请求脚本自己打印的标签不能证明/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /使用 browser_render/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只改变一个变量/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /正负对照/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /调用 vulnerability_search 检索历史漏洞/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /公网结果只生成待验证 Hypothesis/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /检索空结果是弱反证/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只能标记为 inconclusive/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /status=refuted\/superseded/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /reopenConditions/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /原始响应写入 artifact/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /末尾用一句自然语言总结/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /首次成为后续步骤依赖或产生可复现正向结果时，立即用 artifact_write 归档/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /不要等到 nearTurnLimit、checkpoint 或 task_result_submit/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /summary 中提到这些材料时给出精确 artifactRef/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /当前工作目录是 Task workspace，跨 epoch 持久/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /artifact_write\(\{path:"evidence\.json",kind:"json",mediaType:"application\/json"\}\)/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /artifact_read\(\{ref:"artifact:\.\.\.",materialize:true\}\)/);
  assert.doesNotMatch(EXECUTOR_SYSTEM_PROMPT, /source=\{type:"(?:file|inline)"/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /不得把硬编码命令、固定路径或单个 payload 扩大成通用命令/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /实际候选清单、每项输入和结果保存为 Artifact/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /数量达到阈值只表示本轮停止扩大/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /<example name="discriminating-test">/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /<example name="causal-boundary-and-oracle">/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /<example name="fingerprint-to-vulnerability-research">/);
  assert.doesNotMatch(input, /budget_status/);
  assert.match(input, /<runtime_budget>/);
  assert.match(input, /turns: 0\/12; remaining: 12/);
  assert.match(input, /<dependency_outcomes>/);
  assert.match(input, /upload endpoint confirmed/);
  assert.match(input, /<root_goal>/);
  assert.match(input, /\/challenge\/flag\.txt/);
  assert.doesNotMatch(input, /evidenceNeeded|证据要求/);
  assert.ok(input.length < 12_000, `Executor prompt too large: ${input.length}`);

  const resumeInput = renderExecutorResumeInput({
    rootGoal: "Obtain flag{uuid}; candidate location /challenge/flag.txt",
    taskEnvelope: { ...taskEnvelope, budget: { maxTurns: 16 } },
    plannerHint: "Use the confirmed file-read capability to close the remaining goal gap.",
    operationGraphSlice: emptyGraph,
    reasoningGraphSlice: { ...emptyGraph, view: "reasoning" },
    sessionRefs: [],
    executionBrief: "Previous epoch confirmed file-read capability.",
    dependencyOutcomes: "task:recon status=completed\n  result: upload endpoint confirmed",
    runtimeBudgetStatus: "turns: 0/16; remaining: 16",
    environmentFacts: "# Executor 环境事实\n- cwd：/workspace；可写、跨 epoch 持久"
  });
  assert.match(resumeInput, /继续执行同一个 Task/);
  assert.match(resumeInput, /<planner_hint>/);
  assert.match(resumeInput, /<operation_graph format="json">/);
  assert.match(resumeInput, /<dependency_outcomes>/);
  assert.match(resumeInput, /confirmed file-read capability/);
  assert.match(resumeInput, /\/challenge\/flag\.txt/);
  assert.match(resumeInput, /<environment_facts>/);
  assert.match(resumeInput, /\/workspace；可写、跨 epoch 持久/);
  assert.doesNotMatch(resumeInput, /evidenceNeeded|证据要求/);

  const resumeWithoutFacts = renderExecutorResumeInput({
    rootGoal: "goal",
    taskEnvelope,
    operationGraphSlice: emptyGraph,
    reasoningGraphSlice: emptyGraph,
    sessionRefs: [],
    executionBrief: "brief",
    runtimeBudgetStatus: "turns: 0/12; remaining: 12"
  });
  assert.match(resumeWithoutFacts, /Runtime 未提供环境事实/);
});

test("planner prompt teaches evidence-aware planning without an intermediate contract", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /职责是把用户的 Root Goal 持续转化为当前最值得执行的目标级 Task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Task Graph 是这些规划决定的持久表达，不是规划目的/);
  assert.match(PLANNER_SYSTEM_PROMPT, /你决定“接下来完成什么以及为什么”；Executor 决定“具体怎么完成”/);
  assert.match(PLANNER_SYSTEM_PROMPT, /默认只根据 Planner State.*TaskOutcome.*EpochOutcome/s);
  assert.match(PLANNER_SYSTEM_PROMPT, /不要求你重演调查/);
  assert.match(PLANNER_SYSTEM_PROMPT, /priority 数字越小优先级越高，1 是最高优先级/);
  assert.match(PLANNER_SYSTEM_PROMPT, /TaskOutcome=partial 表示本次执行有阶段结果/);
  assert.match(PLANNER_SYSTEM_PROMPT, /partial 阶段成果通过 create_tasks\.basedOnRefs 继承/);
  assert.match(PLANNER_SYSTEM_PROMPT, /awaiting_planner Task 保持 open 且 remainingTurns>0 时，空 commands 会恢复同一 Task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /budget\.maxTurns 是 Task 已累计分配的 turns，不是生命周期硬上限/);
  assert.match(PLANNER_SYSTEM_PROMPT, /不得反转依赖/);
  assert.match(PLANNER_SYSTEM_PROMPT, /检索只服务于全局任务选择，不服务于目标侧技术调查/);
  assert.match(PLANNER_SYSTEM_PROMPT, /不要为了改进 Executor 的技术方法、复核 blocker/);
  assert.match(PLANNER_SYSTEM_PROMPT, /无法解析时重新 list，不猜测 UUID/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Root Goal 的“全部”“所有”“每个”按开放集合处理/);
  assert.match(PLANNER_SYSTEM_PROMPT, /EpochOutcome 只说明执行实例为何结束/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="continue-current-task">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="create-planning-branch">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="initial-planning">/);
  assert.equal((PLANNER_SYSTEM_PROMPT.match(/<example name=/g) ?? []).length, 3);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只有全部 successCriteria 满足时提交 completed/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /成功条件满足后立即调用 task_result_submit/);
});

test("planner prompt carries the canonical TaskOutcome without ledger summary truncation", () => {
  const keyCapability = "admin_token=internal_admin_token_2024";
  const resultSummary = `${"已验证常规入口但尚未完成最终目标。".repeat(14)}${keyCapability}；内部服务已确认可达。`;
  assert.ok(resultSummary.indexOf(keyCapability) > 160);
  const view: PlannerDecisionView = {
    view: "planner_decision",
    rootRefs: { goalRef: "goal:root", scopeRef: "scope:root" },
    taskLedger: [{
      taskId: "task:internal-api",
      status: "open",
      goal: "Use the confirmed internal access path",
      priority: 1,
      dependsOnTaskRefs: []
    }],
    taskOutcomes: [{
      taskRef: "task:internal-api",
      epochRef: "epoch:internal-api",
      status: "partial",
      summary: resultSummary,
      evidenceRefs: ["event:outcome"],
      artifactRefs: [],
      capabilityRefs: [],
      terminalSeq: 42,
      createdAt: new Date(0).toISOString()
    }],
    reasoningDigest: [],
    operationDigest: [],
    blockers: [],
    graphSummary: { nodeCount: 1, edgeCount: 0, taskStatusCounts: { partial: 1 } }
  };

  const input = renderPlannerInput({
    userGoal: "Recover the authorized target artifact",
    scopeSummary: "Authorized target only",
    plannerDecisionView: view
  });

  assert.match(input, /admin_token=internal_admin_token_2024/);
  assert.match(input, /"goalRef":"goal:root"/);
  assert.match(input, /"scopeRef":"scope:root"/);
  assert.ok(input.length < 8_000, `Planner prompt too large: ${input.length}`);
});

test("planner follow-up carries a complete structural delta without repeating fixed context", () => {
  const previous: PlannerDecisionView = {
    view: "planner_decision",
    rootRefs: { goalRef: "goal:root", scopeRef: "scope:root" },
    taskLedger: [{
      taskId: "task:recon",
      status: "open",
      goal: "Map the target",
      targetRefs: ["asset:target"],
      basisRefs: ["event:task-basis"],
      scopeRef: "scope:root",
      successCriteria: ["Persist the reachable service inventory"],
      priority: 1,
      dependsOnTaskRefs: []
    }],
    taskOutcomes: [],
    epochOutcomes: [],
    reasoningDigest: [],
    operationDigest: [],
    blockers: [],
    graphSummary: { nodeCount: 3, edgeCount: 0, taskStatusCounts: { open: 1 } }
  };
  const current: PlannerDecisionView = {
    ...previous,
    taskLedger: [{
      ...previous.taskLedger[0]!,
      status: "open"
    }],
    taskOutcomes: [{
      taskRef: "task:recon",
      epochRef: "epoch:recon",
      status: "partial",
      summary: "Mapped the public surface",
      evidenceRefs: ["event:outcome"],
      artifactRefs: [],
      capabilityRefs: [],
      suggestedNextGoal: "Try the reported admin endpoint",
      terminalSeq: 12,
      createdAt: new Date(0).toISOString()
    }],
    epochOutcomes: [{
      epochRef: "epoch:recon:checkpoint",
      taskRef: "task:recon",
      status: "checkpointed",
      reason: "Task budget reached: maxTurns=10",
      terminalSeq: 13,
      retryable: true,
      createdAt: new Date(0).toISOString()
    }],
    graphSummary: { nodeCount: 4, edgeCount: 1, taskStatusCounts: { partial: 1 } }
  };

  const input = renderPlannerInput({
    userGoal: "Recover the flag",
    scopeSummary: "10.0.0.0/24",
    plannerDecisionView: current,
    previousPlannerDecisionView: previous,
    previousDeliverySeq: 10,
    deliverySeq: 14
  });

  assert.match(input, /"kind":"delta"/);
  assert.match(input, /"fromEventSeq":10/);
  assert.match(input, /"throughEventSeq":14/);
  assert.match(input, /"taskRef":"task:recon"/);
  assert.match(input, /"suggestedNextGoal":"Try the reported admin endpoint"/);
  assert.match(input, /"status":"checkpointed"/);
  assert.match(input, /Task budget reached: maxTurns=10/);
  assert.doesNotMatch(input, /<goal>/);
  assert.doesNotMatch(input, /<authorized_scope>/);
  assert.match(input, /"goal":"Map the target"/);
  assert.match(input, /"targetRefs":\["asset:target"\]/);
  assert.match(input, /"successCriteria":\["Persist the reachable service inventory"\]/);
});

test("executor input exposes existing basis refs for transitive material reuse", () => {
  const input = renderExecutorInput({
    rootGoal: "Recover target",
    taskEnvelope: {
      taskId: "task:reuse",
      goal: "Reuse the tested invocation",
      targetRefs: [],
      basisRefs: ["artifact:tested-invocation", "event:proof"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["invoke capability"],
      dependsOnTaskRefs: []
    },
    operationGraphSlice: {},
    reasoningGraphSlice: {},
    sessionRefs: [],
    toolCatalog: [],
    executionBrief: "none",
    runtimeBudgetStatus: "ok"
  });

  assert.match(input, /artifact:tested-invocation/);
  assert.match(input, /event:proof/);
});

test("planner prompt explains how to use degraded projection outcomes", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /projectionDegradations 表示语义图未追平/);
  assert.match(PLANNER_SYSTEM_PROMPT, /优先使用最新 TaskOutcome 决策/);
});

test("projector prompt requests semantic changes instead of one node per observation", () => {
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Ground claims/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /能够直接指向原始 input\/outcome 的最小 claim/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /命令中提到的候选、Executor commentary、静态页面文字和模型解释都不是结果/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Project changes/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /相同事实合并 evidenceRefs/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /已有事实没有变化就提交空 delta/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /不存在 contradicted 状态/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Evidence 只写 ground claim/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /解释只写成 status=open\/inconclusive 的 Hypothesis/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /只有完整、可绑定的正向结果/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /负面结论不得大于实验范围/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /executor_commentary_non_evidence 只能用于定位原始材料/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /artifact:\* 必须原样写入/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /live session 创建或更新 ShellSession.*sessionId 等于 connectionRef.*session_on/s);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Service -exposes_endpoint-> WebEndpoint/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Vulnerability -exploited_by-> Exploit/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Evidence -contradicts-> Hypothesis/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Task、Milestone、Blocker、Goal、Scope 不得创建、更新或连接/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /检查近期实验是否真正减少不确定性/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /同时改变多个独立条件后统一失败/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /新的 URL、payload、字段名、工具输出或不同 stdout 指纹本身不等于进展/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /页面静态说明、全局关键词、请求脚本自己打印的标签不能证明/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /只评价当前因果边界最近窗口的进展/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /任务阶段是否完成以及下一阶段做什么仍由 Planner 决定/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /成功条件尚未满足且当前路径仍在有效减少不确定性时，应继续或 redirect/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /PRIOR_RELEVANT_KNOWLEDGE 来自当前 GraphStore 切片/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /任一项不同就是尚未被该负面知识覆盖的新分支/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /reason 必须说明哪些条件等价并引用对应 Hypothesis、contradicts Evidence 的 evidenceRefs/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /Executor 仍可基于更新鲜证据自主继续/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /不得仅因枚举数量达到阈值或有限候选均失败就建议 handoff/);
  assert.doesNotMatch(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /高价值状态变化已经足够交回 Planner/);
});

test("supervisor input includes persisted relevant graph knowledge", () => {
  const input = renderSupervisorInput({
    taskEnvelope: {
      taskId: "task:test",
      goal: "Test file inclusion",
      targetRefs: ["endpoint:include"],
      scopeRef: "scope:root",
      constraints: [],
      successCriteria: ["distinguish inclusion behavior"]
    },
    actionTraceText: "repeated equivalent path probes",
    loopSignalsText: "same response oracle",
    supervisionState: {},
    budgetState: {},
    taskStatus: {},
    priorRelevantKnowledge: {
      nodes: [{
        id: "hypothesis:session-file",
        type: "Hypothesis",
        properties: {
          status: "refuted",
          negativeConclusion: "tested session paths do not resolve",
          reopenConditions: "a valid session identifier is observed"
        },
        evidenceRefs: ["event:negative"]
      }],
      edges: []
    },
    sourceEventIds: ["event:recent"],
    reason: "turn_window"
  });

  assert.match(input, /PRIOR_RELEVANT_KNOWLEDGE/);
  assert.match(input, /hypothesis:session-file/);
  assert.match(input, /event:negative/);
  assert.match(input, /a valid session identifier is observed/);
});
