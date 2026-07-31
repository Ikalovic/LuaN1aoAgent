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
  assert.match(EXECUTOR_SYSTEM_PROMPT, /可复用材料（Cookie、凭据、密钥、PoC、solver 脚本）必须及时用 artifact_write 归档/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /summary 中提到这些材料时给出精确 artifactRef/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /artifact_write\(\{path:"\/workspace\/evidence\.json",kind:"json",mediaType:"application\/json"\}\)/);
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
  assert.match(PLANNER_SYSTEM_PROMPT, /priority 数字越小优先级越高，1 是最高优先级/);
  assert.match(PLANNER_SYSTEM_PROMPT, /evidence_list 列出 Task 的持久观察/);
  assert.match(PLANNER_SYSTEM_PROMPT, /evidence_read 按真实 event Ref 读取原始观察/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Task status=completed 表示 Planner 已接受/);
  assert.match(PLANNER_SYSTEM_PROMPT, /completed TaskOutcome 是局部完成报告/);
  assert.match(PLANNER_SYSTEM_PROMPT, /replace_dependencies 显式调整依赖/);
  assert.match(PLANNER_SYSTEM_PROMPT, /partial 只存在于 TaskOutcome/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Controller 只会执行 status=open.*Planner 接受为 status=completed/);
  assert.match(PLANNER_SYSTEM_PROMPT, /archived 只用于停止仍为 open 的过期或重叠 Task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /相互冲突的解释/);
  assert.match(PLANNER_SYSTEM_PROMPT, /能够消除关键不确定性的目标/);
  assert.match(PLANNER_SYSTEM_PROMPT, /一个当前可判定的因果目标.*短连续链/);
  assert.match(PLANNER_SYSTEM_PROMPT, /路径、工具、payload 和技术细节可以出现/);
  assert.match(PLANNER_SYSTEM_PROMPT, /中间结果.*全局决策点/);
  assert.match(PLANNER_SYSTEM_PROMPT, /固定命令、固定路径或单个 payload 成功，只能规划其精确复用/);
  assert.match(PLANNER_SYSTEM_PROMPT, /创建 dependent Task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /dependsOnTaskRefs 只列必须 completed 的硬前置/);
  assert.match(PLANNER_SYSTEM_PROMPT, /partial 阶段成果通过 create_tasks\.basedOnRefs 继承，不复用前驱 Session/);
  assert.match(PLANNER_SYSTEM_PROMPT, /不得反转依赖/);
  assert.match(PLANNER_SYSTEM_PROMPT, /版本由 Runtime 自动绑定并进行原子冲突检测/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="conflicting-observations">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="confirmed-capability">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="capability-chain-split">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="tactical-task-definition">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /goal 可以直接写明该参数和路径/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /不要写入具体 payload、命令、工具步骤/);
  assert.match(PLANNER_SYSTEM_PROMPT, /初始图只有 Goal\/Scope.*默认只创建一个入口认知 Task/s);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="initial-fanout">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="evidence-backed-parallelism">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /因为共享 Root Goal 就强制串行这些已经独立的分支/);
  assert.match(PLANNER_SYSTEM_PROMPT, /历史漏洞与目标适用性/);
  assert.match(PLANNER_SYSTEM_PROMPT, /有限候选列表只限制探索投入，不证明候选空间已经穷尽/);
  assert.match(PLANNER_SYSTEM_PROMPT, /persisted Evidence、Session 或 Route 能证明该资产由 authorized_scope 中的根入口派生/);
  assert.match(PLANNER_SYSTEM_PROMPT, /<example name="known-vulnerability-research">/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /Runtime 会复用原 Executor Session/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /<example name="same-task-resume">/);
  assert.match(PLANNER_SYSTEM_PROMPT, /整个提交只在顶层给出一次总体 reason/);
  assert.match(PLANNER_SYSTEM_PROMPT, /持久化依据只写在对应 command 的 basedOnRefs/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Root Goal 含“全部”“所有”“每个”等全称完成条件时，按开放集合处理/);
  assert.match(PLANNER_SYSTEM_PROMPT, /EpochOutcome 只说明执行实例为何结束/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /need_user_input/);
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
    graphSummary: { nodeCount: 1, edgeCount: 0, taskStatusCounts: { partial: 1 } },
    retrievalHints: {
      tools: ["graph_query", "graph_trace", "evidence_read"],
      note: "Read more only when needed"
    }
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
      priority: 1,
      dependsOnTaskRefs: []
    }],
    taskOutcomes: [],
    reasoningDigest: [],
    operationDigest: [],
    blockers: [],
    graphSummary: { nodeCount: 3, edgeCount: 0, taskStatusCounts: { open: 1 } },
    retrievalHints: {
      tools: ["graph_query", "graph_trace", "evidence_read"],
      note: "Read authoritative stores when needed"
    }
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
  assert.doesNotMatch(input, /<goal>/);
  assert.doesNotMatch(input, /<authorized_scope>/);
  assert.doesNotMatch(input, /"goal":"Map the target".*"status":"open"/);
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
  assert.match(PLANNER_SYSTEM_PROMPT, /projectionDegradations 表示对应 Task 的语义图尚未追平/);
  assert.match(PLANNER_SYSTEM_PROMPT, /优先使用 taskOutcomes 中的持久化结果/);
});

test("projector prompt requests semantic changes instead of one node per observation", () => {
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /语义变化集/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /多个 observation 支持同一事实时合并/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /已有节点已表达该事实时更新 existing 别名/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /禁止写入或连接 Task、Milestone、Blocker、Goal、Scope/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /session opened\/reconnected.*必须创建或更新一个 ShellSession.*sessionId 必须等于 connectionRef.*session_on/s);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Evidence 只描述 observation 直接支持的事实/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /错误投影：Evidence 声称“确认后端调用 request\.json\.get\('url'\)”/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /直接 GET 返回 404 不能证明文件在所有访问方式下不存在/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /确认实验没有可复现基线/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /不得据此创建“该机制无效”/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /executor_interpretation_non_evidence 是 Executor/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /material_integrity/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /不得把 refuted Hypothesis 重开/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /不能补全缺失材料/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /不能单独作为 Evidence/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /artifact:\* 引用必须原样保留到对应节点的 properties\.artifactRef/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /引用是持久材料的指针，不是秘密值/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /existing:N 节点只提交 id 和需要追加的 properties\/evidenceRefs/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /身份字段由 Runtime 从只读别名注册表恢复/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /operation 节点 type 只能是 Host、Port、Service、WebEndpoint、Parameter、Credential、AgentSession、ShellSession、Session、File、Process/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /只修正错误信息点名的节点或边，其余内容原样重交/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /禁止创造 hosted_on、serves_endpoint、targets、exploits、suggests、refines、refutes、extends、uses_parameter/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Service -exposes_endpoint-> WebEndpoint/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Vulnerability -exploited_by-> Exploit/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Task、Milestone、Blocker、Goal、Scope 不会作为可用 existing 别名提供/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /没有匹配关系时省略该边.*提交空 delta/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /<example name="semantic-merge">/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /negativeConclusion 和 reopenConditions/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /Evidence -contradicts-> Hypothesis/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /随机不存在的 \/\.definitely-missing/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /原样 \.\.\/ 可穿越.*窄 Hypothesis 标为 refuted/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /不得据此反驳其父级漏洞类别/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /有限枚举的 Evidence 必须保留实际候选清单或其 Artifact 引用/);
  assert.match(OBSERVER_PROJECTOR_SYSTEM_PROMPT, /一次固定调用成功只支持该固定调用/);
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
