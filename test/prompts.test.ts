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
    executionBrief: "No previous execution events.",
    dependencyOutcomes: "task:recon status=completed\n  result: upload endpoint confirmed",
    runtimeBudgetStatus: "turns: 0/12; remaining: 12"
  });

  assert.doesNotMatch(EXECUTOR_SYSTEM_PROMPT, /budget_status/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /先输出一句不超过 80 个汉字的可公开行动理由/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /缩小当前竞争解释或直接推进成功条件/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /先锁定当前因果边界/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /根据当前不确定性的结构选择行动粒度/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /候选彼此独立时，使用批量脚本或并行工具调用/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /探索实验用于尚无正向基线且存在多个竞争解释的边界/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /确认实验用于已有可复现基线的机制/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /已有验证能力时直接复用它推进 successCriteria/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /材料足以判定时立即提交结果/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /页面本来就存在的说明文字/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /请求脚本自己打印的标签不能证明/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /使用 browser_render/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只改变一个变量/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /正负对照/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /漏洞情报能够明显缩小搜索空间/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /使用 vulnerability_search 检索历史漏洞/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /公网结果只生成待验证 Hypothesis/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /检索空结果是弱反证/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只能标记为 inconclusive/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /status=refuted\/superseded/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /reopenConditions/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /原始响应和批量结果写入当前 workspace/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /末尾用一句自然语言总结/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /不要因为 checkpoint 或“以后可能有用”逐项调用 artifact_write/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /准备 task_result_submit 时，先形成 summary 和 evidenceRefs/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /不要为使 nmap、HTTP 响应或枚举输出变得“持久”而重复提升文件/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /必须保持原文、精确字节或可执行状态/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /TaskOutcome 本身就是结构化结论/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /artifactRefs 只填写 artifact_write 返回的真实引用/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /当前工作目录是 Task workspace，跨命令、checkpoint 和同一 Task 的 epoch 持久/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /Runtime 注入授权 Scope，并在 Docker 模式机械执行网络边界/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /artifact_read\(\{ref:"artifact:\.\.\.",materialize:true\}\)/);
  assert.doesNotMatch(EXECUTOR_SYSTEM_PROMPT, /source=\{type:"(?:file|inline)"/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /没有变量对照时不得把固定调用扩大成通用能力/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /实际候选、每项输入和结果写成当前 workspace 中的一个 manifest/);
  assert.doesNotMatch(EXECUTOR_SYSTEM_PROMPT, /立即写入当前 Task workspace 并用 artifact_write 归档/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /数量达到阈值只表示本轮停止扩大/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /<example name="discriminating-test">/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /<example name="causal-boundary-and-oracle">/);
  assert.doesNotMatch(EXECUTOR_SYSTEM_PROMPT, /<example name="fingerprint-to-vulnerability-research">/);
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
    operationGraphSlice: emptyGraph,
    reasoningGraphSlice: { ...emptyGraph, view: "reasoning" },
    sessionRefs: [],
    executionBrief: "Previous epoch confirmed file-read capability.",
    dependencyOutcomes: "task:recon status=completed\n  result: upload endpoint confirmed",
    runtimeBudgetStatus: "turns: 0/16; remaining: 16",
    environmentFacts: "# Executor 环境事实\n- cwd：/workspace；可写、跨 epoch 持久"
  });
  assert.match(resumeInput, /继续执行同一个 Task/);
  assert.doesNotMatch(resumeInput, /<planner_hint>/);
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
  assert.match(PLANNER_SYSTEM_PROMPT, /工具事件和 evidenceRefs 已经持久化/);
  assert.match(PLANNER_SYSTEM_PROMPT, /默认由 summary \+ evidenceRefs 满足，不要求 Artifact/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="continue-current-task">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="append-same-workstream-objective">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="new-goal-with-continuous-context">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="parallel-independent-results">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="initial-planning">/);
  assert.equal((PLANNER_SYSTEM_PROMPT.match(/<example name=/g) ?? []).length, 5);
  assert.match(PLANNER_SYSTEM_PROMPT, /Task 是一条由同一个 Executor 持续拥有的因果工作流/);
  assert.match(PLANNER_SYSTEM_PROMPT, /appendObjectives 追加目标及其 successCriteria/);
  assert.match(PLANNER_SYSTEM_PROMPT, /并行不需要分组标签/);
  assert.match(PLANNER_SYSTEM_PROMPT, /continueFromTaskRef=旧 Task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /set_node_status 只用于非 Task 规划节点/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /只有原始成功条件和 TaskEnvelope 中全部累计新增目标的成功条件都满足时提交 completed/);
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
    executionBrief: "none",
    runtimeBudgetStatus: "ok"
  });

  assert.match(input, /artifact:tested-invocation/);
  assert.match(input, /event:proof/);
});

test("executor input re-injects cumulative Task goal additions", () => {
  const input = renderExecutorInput({
    rootGoal: "Obtain all authorized results",
    taskEnvelope: {
      taskId: "task:foothold",
      goal: "Establish an entry foothold",
      targetRefs: ["goal:root"],
      scopeRef: "scope:root",
      constraints: ["authorized target only"],
      successCriteria: ["entry foothold is established"],
      goalAdditions: [{
        goal: "Use the foothold to obtain the internal result",
        successCriteria: ["internal result is persisted"]
      }]
    },
    operationGraphSlice: {},
    reasoningGraphSlice: {},
    sessionRefs: [],
    executionBrief: "Resume from the current state",
    runtimeBudgetStatus: "turns remain"
  });
  assert.match(input, /目标：Establish an entry foothold/);
  assert.match(input, /Use the foothold to obtain the internal result/);
  assert.match(input, /internal result is persisted/);
});

test("planner prompt explains how to use degraded projection outcomes", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /projectionDegradations 表示语义图未追平/);
  assert.match(PLANNER_SYSTEM_PROMPT, /优先使用最新 TaskOutcome 决策/);
});

test("projector prompt requests semantic changes instead of one node per observation", () => {
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Ground claims/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /维护最小、可追溯、非重复的世界状态/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /能够直接指向原始 input\/outcome 的最小 claim/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /命令中提到的候选、Executor commentary、静态页面文字和模型解释都不是结果/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Project changes/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /相同事实合并 evidenceRefs/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /必须在节点顶层 evidenceRefs 中直接引用至少一个本批 observation/);
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
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /grounded-endpoint-claim/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Evidence -observed_on-> WebEndpoint/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /任何校验错误都会拒绝整份草稿/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /重新提交完整 delta/);
  assert.doesNotMatch(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /最多 24 个节点、40 条边/);
  assert.doesNotMatch(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /最多调用两次只读图工具/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /保护 Executor 的有效执行时间/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /continue：当前实验正在减少/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /redirect：Task 和当前因果目标不变/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /handoff：successCriteria 已出现完整结果/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /stop_executor：输入显示明确的 Scope 风险/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /同时改变多个独立条件后统一失败/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /新的 URL、payload、字段名、工具输出或不同 stdout 文本本身不等于进展/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /静态页面说明、请求脚本标签和全局关键词不能证明/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /只评价当前因果边界的最近窗口/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /Runtime 独立处理预算边界/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /只有 refuted\/superseded Hypothesis 可支持“重复已知死路”/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /target、method、preconditions、observedResult 和判定信号必须等价/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /证据不足且没有明确 Scope 风险或 Runtime stopRequested，选择 continue/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /similar-output-with-new-variable/);
  assert.match(OBSERVER_SUPERVISOR_SYSTEM_PROMPT, /repeated-causal-boundary/);
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
    budgetState: {
      budget: { maxTurns: 40 },
      usedTurns: 17,
      remainingTurns: 23,
      epochUsedTurns: 5,
      epochMaxTurns: 8,
      epochRemainingTurns: 3
    },
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
  assert.match(input, /Task allocation：已用 17\/40，剩余 23 turns/);
  assert.match(input, /Epoch slice：已用 5\/8，剩余 3 turns/);
});
