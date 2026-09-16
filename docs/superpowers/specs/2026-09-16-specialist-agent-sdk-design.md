# 专精 Agent（Specialist Agent）SDK 设计

日期：2026-09-16  
状态：已确认设计，等待实施计划

## 1. 背景与目标

LuaN1aoAgent 目前有两类附加能力：

- **Skill**：`.agents/skills/<name>/SKILL.md` 形式的资料包。Registry 负责扫描、校验与启停，运行期由 LLM 按 Task 目标选择，再把选中目录作为附加 Skill 路径交给 Executor。
- **MCP**：本进程 spawn 的 stdio 子进程（credential / fofa / beekeeper）。`McpRegistry` 是声明式目录，负责配置探测与启停，工具经 `additionalTools` 注入 Executor。

两者都只作用于**同一个 Executor**：全局唯一的 `EXECUTOR_SYSTEM_PROMPT`、固定的工具集合、`llmRuntime.models.executor` 一个模型角色、统一的预算常量（`DEFAULT_TASK_BUDGET.maxTurns`、`DEFAULT_EPOCH_TURN_SLICE`、`TASK_EPOCH_RUN_TIME_SHARE`）。Skill 只能"加资料"，MCP 只能"加工具"，都无法表达"这项工作应该交给一个不同的执行者"。

本次实现 **Specialist Agent SDK**：让开发者显式注册新的专精 Agent（信息搜集、爆破、社工等），每个 Agent 拥有自己的系统提示词、模型档位、工具面、技能策略、预算与生命周期参数；Planner 在 `create_tasks` 时显式选择 Agent；Web 端在统一"能力"页中控制启停与结构化选项。

专精 Agent 是 **Executor 的特化实例**，不是第四种运行时角色：它不修改任务图、不扩大授权、不绕过沙箱与审批。

## 2. 非目标

- 不改变 Planner / Executor / Observer 三角色拓扑，不新增 LLM 运行时角色（不扩展 `LlmAgentRole`）。
- 不新增沙箱后端、不改变 scope 校验、证据契约与工具审批策略。
- 不允许一个 Task 在执行中切换 Agent；切换 Agent 由 Planner 创建后继 Task 表达（可用 `continueFromTaskRef` 继承 workspace 与 Session）。
- 不实现 Agent 市场、远程拉取或版本解析；项目级 Agent 只从本地 `.agents/specialists/` 加载。
- 本轮不做第三方模块的哈希信任门（TOFU）与签名校验：按用户确认，项目级模块采用"完全信任 + 路径与导出结构校验"。不引入 `SPECIALISTS_ALLOW_PROJECT_MODULES` 之类开关。
- 不做 Task 级总墙钟预算（`budget.timeBudgetMs`）。预算差异用"轮次上限 + epoch 轮次片 + epoch 时间份额"表达。
- 不做 Skill/MCP/Agent 三者的联合依赖求解（例如"该 Agent 需要 FOFA 但 FOFA 未配置"仅作为诊断展示，不自动启停 MCP）。

## 3. 概念模型

三者正交：

| 维度 | 回答的问题 | 载体 |
|---|---|---|
| Skill | 执行者可以带哪些**资料** | `.agents/skills/` |
| MCP | 运行时提供哪些**工具** | `.agents/mcp-state.json` + 内置 runtime |
| **Specialist Agent** | **谁来做**，用什么提示词/模型/工具面/预算 | `.agents/specialists/` + 代码 SDK |

### 3.1 `SpecialistAgentDefinition`

```ts
type SpecialistAgentDefinition = {
  id: string;                       // ^[a-z0-9]+(-[a-z0-9]+)*$，<= 64
  name: string;
  description: string;              // Planner 目录：一句话说明用途
  whenToUse?: string;               // Planner 目录：适用/不适用边界
  version?: string;
  prompt: { mode: "extend" | "replace"; content: string };
  tools?: SpecialistToolPolicy;
  createTools?: (context: SpecialistToolContext) => ToolDefinition<any, any, any>[];
  skills?: SpecialistSkillPolicy;
  budget: SpecialistBudgetProfile;
  model?: SpecialistModelProfile;
  concurrency?: { maxParallelTasks?: number };
  options?: Record<string, SpecialistOptionSpec>;
};
```

- `prompt.mode = "extend"`（默认）：运行期 `EXECUTOR_SYSTEM_PROMPT` + 生成的 `# Specialist` 段 + 机器生成的 `# Runtime Contract` 段。
- `prompt.mode = "replace"`：仅作者内容 + `# Runtime Contract` 段。`# Runtime Contract` 由 Runtime 生成且不可覆盖，保证终止工具契约、任务图只读、scope 与证据纪律在任何模式下成立。提示词内容支持 `{{options.<key>}}` 占位符替换。
- `tools`：见 3.2。策略**只能收窄**工具面。
- `createTools`：Agent 自带工具。仅代码注册的内置 Agent 与项目级模块可以提供；工具名不得与运行时工具重名（重名即丢弃并产生诊断）。自带工具与其它工具一样经过 `ToolApprovalRegistry` 与危险工具策略。
- `skills`：`auto`（沿用现有 LLM 选择器）/ `allowlist`（选择器只在给定候选内选）/ `pinned`（固定集合，跳过选择器）/ `off`。
- `budget`：`defaultMaxTurns`（Planner 未指定时的默认）、`maxTurnsCeiling`（Planner 指定值的上限，可低于全局 `MIN_TASK_BUDGET`）、`epochTurnSlice`（单个 Epoch 的轮次片）、`epochTimeShare`（单个 Epoch 占全局剩余运行时间的比例，0 < s <= 1）。
- `model`：可选覆盖 `model`/`thinkingLevel`/`contextWindow`；缺省沿用 `executor` 角色。
- `concurrency.maxParallelTasks`：该 Agent 同时可运行的 Task 数上限。
- `options`：可在 Web 端配置的结构化选项。类型为 `string | text | number | boolean | enum | string-list`，每项含 `title`、可选 `description`、`default` 与校验边界。

### 3.2 工具组

工具按运行时工厂划分为组，策略以组为单位收窄，可选再用工具名 allow/deny 细化：

| 组 | 来源 |
|---|---|
| `sandbox` | `sandbox.createTools()`（read/bash/grep/find/ls/write/edit） |
| `research` | `web_fetch` / `web_search` / `vulnerability_search` |
| `browser` | `browser_render` |
| `artifact` | `artifact_read` / `artifact_write` |
| `evidence` | `evidence_list` / `evidence_read` |
| `connectivity` | `route_open` / `route_status` / `route_stop` / `route_reconnect` |
| `network_diagnostics` | 网络诊断工具 |
| `fofa` | FOFA 工具 + `topology_validation` |
| `beekeeper` | Beekeeper 工具 |
| `credentials` | 凭据工具 |
| `submit` | `task_result_submit`（运行时契约，不可禁用） |

`disableGroups` 先扣减，`allow`（白名单）再收窄，`deny`（黑名单）最终覆盖。`allow` 中出现未知工具名、或 `deny` 命中 `submit` 时产生诊断并按安全侧处理。

### 3.3 内置 Agent

- `general`：等价于当前 Executor 行为（`extend` 模式空内容、全工具组、`skills.mode=auto`、`defaultMaxTurns=12`、`maxTurnsCeiling=40`、`epochTurnSlice=20`、`epochTimeShare=0.5`）。是 Planner 省略 `specialist` 字段时的兜底，不可禁用。
- `bruteforce`（本轮唯一示例）：爆破/口令猜测场景。`skills.mode=allowlist`（把 LLM 选择器限制在口令类 Skill 内），收窄 `fofa`/`beekeeper`/`network_diagnostics` 三个工具组，`epochTimeShare` 高于 `general`，`concurrency.maxParallelTasks=1`，并暴露 `threads`/`wordlist`/`protocols`/`maxAttemptsPerAccount`/`stopOnLockout` 选项。

## 4. 注册与加载

### 4.1 代码 SDK

`src/specialists/sdk.ts` 导出：

- `defineSpecialist(definition)`：类型标注 + 构造期校验（id 格式、预算边界、选项 schema、技能策略一致性）。
- `defineSpecialistTool(tool)`：等价 `defineTool` 的转发，便于第三方模块在无仓库依赖时构造工具。
- `SPECIALIST_MODULE_API`：注入项目级模块的 API 对象（`Type`、`defineTool`、`defineSpecialist`、`SPECIALIST_TOOL_GROUPS`）。
- 类型再导出：`SpecialistAgentDefinition`、`SpecialistToolContext`、`SpecialistOptionSpec` 等。

`src/index.ts` 增补导出，使 SDK 成为包出口的一部分。

### 4.2 项目级加载

目录约定：`.agents/specialists/<id>/`

- `specialist.json`（必需）：声明式定义。
- `prompt.md`（可选）：当 `prompt.file` 指向它时作为提示词正文。
- `entry`（可选）：`specialist.json` 中的相对路径，指向 `.mjs` / `.js` 模块。

`specialist.json` 有两种形态：

1. **纯声明**（无 `entry`）：`id` / `name` / `description` / `whenToUse` / `version` / `prompt`（`content` 或 `file`）/ `tools` / `skills` / `budget` / `model` / `concurrency` / `options` / `enabled`（初始默认值）。
2. **模块**（有 `entry`）：模块默认导出：
   - 一个完整的 `SpecialistAgentDefinition` 对象，或
   - 一个 `(api) => SpecialistAgentDefinition` 工厂。

   模块定义的 `id` 必须与目录 id 一致。清单中除 `id` / `entry` / `enabled` 外的字段在模块提供时被忽略（`entry` 优先）。

校验与诊断：

- 目录名、清单 `id`、模块导出 `id` 三者必须一致。
- `entry` 必须解析在 Agent 目录内（`realpath` 包含校验，拒绝符号链接逃逸），扩展名限定 `.mjs` / `.js`。
- 模块导出结构校验：`id`/`name`/`description`/`prompt` 必需；`budget` 必须给出四个数值字段且在合法区间；`createTools` 若存在必须是函数；返回的工具必须形如 `{ name: string, execute: function }`。
- 加载失败 → 该 Agent 标记为 `valid: false` 并产生 `specialist_module_failed` 诊断，其它 Agent 不受影响。
- **禁用的 Agent 不加载模块**：`scan()` 与 `snapshot()` 从不执行第三方代码。

### 4.3 状态文件

`.agents/specialists-state.json`：

```json
{
  "bruteforce": { "enabled": true, "options": { "threads": 8 } }
}
```

- 与 `skills-state.json` / `mcp-state.json` 一致：`0600` 权限、临时文件 + `rename` 原子替换、容错解析（坏文件视为空状态）。
- `setEnabled` / `setOptions` 前先校验 Agent 存在；`setOptions` 按 schema 校验，未知键拒绝。
- 未显式配置时 `enabled` 缺省为 `true`（与 MCP 一致），但内置 `general` 恒为可用。

### 4.4 Registry 接口

```ts
class SpecialistRegistry {
  constructor(options: {
    cwd: string;
    builtins?: SpecialistAgentDefinition[];
    projectDir?: string;   // 默认 <cwd>/.agents/specialists
    statePath?: string;    // 默认 <cwd>/.agents/specialists-state.json
  });
  scan(): SpecialistRegistrySnapshot;              // 同步，不执行模块
  describeAll(): Promise<SpecialistRegistrySnapshot>; // 仅对 enabled 的模块 Agent 加载并补全 options
  snapshot(): SpecialistRegistrySnapshot;
  resolve(id: string): Promise<SpecialistResolution>;
  catalog(): SpecialistCatalogEntry[];             // enabled + valid，供 Planner
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setOptions(id: string, options: Record<string, unknown>): Promise<void>;
}
```

- `SpecialistResolution` 为 `{ ok: true, definition, options, entry }` 或 `{ ok: false, reason: "unknown" | "disabled" | "invalid" | "load_failed", message, entry? }`。
- `scan()` 结果里模块 Agent 的 `options` 为空并由 `executability: "module"` 标记；`describeAll()`（Web API 使用）在 enabled 时补全。
- 每次 `resolve()` / `catalog()` 重读状态文件，使 Web 端启停对后续 Task 立即生效（不复制 `skillSnapshot` 的进程级缓存行为）。

### 4.5 诊断码

`specialist_id_invalid`、`specialist_manifest_invalid`、`specialist_manifest_missing`、`specialist_duplicate_id`、`specialist_entry_outside_root`、`specialist_entry_extension`、`specialist_module_failed`、`specialist_module_invalid_export`、`specialist_tool_name_unknown`、`specialist_tool_collision`、`specialist_option_invalid`、`specialist_option_unknown`、`specialist_prompt_placeholder_unknown`。

## 5. Planner 选择

- `PlannerTaskSpec.specialist?: string`（typebox：`pattern: ^[a-z0-9]+(-[a-z0-9]+)*$`、`maxLength: 64`、描述说明"省略即 general"）。
- `TaskDefinition.specialist?: string`，持久化到 Task 节点 `properties.specialist`，并出现在 Planner ledger 与前端任务图。
- `renderPlannerInput` 在存在至少一个非 `general` 的可用 Agent 时追加 `<available_specialists>`（`catalog()` 的紧凑 JSON：id/name/description/whenToUse/预算/技能模式/被禁用的工具组/并发上限）。
- `PLANNER_SYSTEM_PROMPT` 增加 "Specialist Selection" 规则段：按 Task 的因果工作流选择；不确定时省略（general）；不得编造 id；预算字段只是默认值；切换 Agent 需要后继 Task。
- **决策校验**：`createValidatedPlannerSubmitTool` 的 `validate` 回调中校验 `specialist`；未知 / 禁用 / 无效 → 抛 `PlannerProtocolError`，进入现有修复循环（`PLANNER_DECISION_REPAIR_ATTEMPTS=2`），反馈文本列出可用 id。
- **预算联动**：`budget.maxTurns` 若超过所选 Agent 的 `maxTurnsCeiling` 则被 clamp 到 ceiling；`patch_task.additionalTurns` 同样受 ceiling 约束；`defaultMaxTurns` 仅在 Planner 未给出时使用。
- **运行期失效**：Task 已创建、执行前发现 Agent 被禁用/失效 → 不静默降级为 general，也不换成别的 Agent。Runtime 记录 `specialist_unavailable` 事件、把该 Task 排除出可运行集合（`awaitingPlannerTaskIds`），并在 Planner ledger 的 `specialist.status` 上暴露 `disabled` / `invalid` / `unknown`。由于该 Task 已不在可运行集合中，现有的"Root Goal 仍 open 且无 ready Task 时不得提交空 commands"校验会强制 Planner 重新决策。

## 6. 运行时应用

| 关注点 | 接入点 |
|---|---|
| Agent 解析与缓存 | `SecurityAgentController.specialistRegistry`（构造注入），`ActiveTaskState.specialist` |
| 系统提示词 | `createExecutorAgentSession` 的 `systemPromptOverride` |
| 模型 / thinkingLevel / contextWindow | `createExecutorAgentSession` 的 `model` / `thinkingLevel` / `settingsManager` |
| 工具组装与裁剪 | `createExecutorAgentSession` 内按 `SpecialistToolBinding[]` 组装后应用策略；控制器把 `createTaskRuntimeTools` 改为返回带组的绑定 |
| 技能策略 | `selectTaskSkillDirs(taskGoal, taskId, specialist)` |
| 轮次预算 clamp | `taskEnvelopeFromSpec` / `normalizeInitialTaskBudget` / `resolvePlannerBudgetPatches` |
| Epoch 轮次片 | `budgetStatusSnapshot`、Supervisor 检查窗口 |
| Epoch 时间片 | `armEpochTimeSlice` |
| 并发上限 | `reconcileReadyTasks` / `admitReadyTasks` |
| 审计事件 | `specialist_selected`、`specialist_unavailable`、`specialist_module_loaded`、`specialist_module_failed` |
| 指标 | `invocation_metrics.details.specialistId` |
| Executor 输入 | `renderExecutorInput` 的 `<current_task>` 增加"专精 Agent"行 |

语义要点：

- **预算**：`maxTurns = clamp(Planner 值 ?? defaultMaxTurns, floor, min(maxTurnsCeiling, 40))`，其中 `floor = min(全局 MIN_TASK_BUDGET, defaultMaxTurns)`。因此 `defaultMaxTurns` 低于全局下限的轻量 Agent（如信息搜集）能拿到自己的小预算，而 `general`（默认 12 / 上限 40）精确复现历史的 10/12/40 区间。`patch_task.additionalTurns` 只对显式指定了 Agent 的 Task 施加 ceiling 收窄，未指定的 Task 保持历史累积行为。
- **时间**：`epochTimeLimitMs = min(floor(maxRunTimeMs * epochTimeShare), remainingRunMs)`，`epochTimeShare` 缺省仍为 0.5。
- **并发**：按 Agent 计数，达到 `concurrency.maxParallelTasks` 的 Agent 不再准入新 Task；未声明则不受限。
- **技能**：`pinned` 走 `SkillRegistry.resolveSelection`（仍校验 valid/enabled/modelInvocable），`allowlist` 走现有选择器的 allowlist 参数，`off` 直接返回空列表，`auto` 保持现状。
- **失败降级**：`createTools` 抛错或返回非法工具 → 记诊断与事件，该次会话仍以其余工具启动（不因第三方工具损坏而放弃整个 Task）。

### 6.1 安全不变量

1. 专精 Agent 只能**收窄**能力；工具策略是纯减法，`submit` 组不可移除。
2. `createTools` 新增的工具与内置工具同权，同样受工具审批与危险工具策略约束。
3. 沙箱边界、scope 校验、证据契约、Task 图只读不变。
4. 项目级模块在**启用后**才会被导入执行；加载失败只影响该 Agent。
5. 每个 Task 的 Agent 在执行期间固定；变更必须通过 Planner 的后继 Task。

## 7. Web 控制面

### 7.1 统一"能力"页

- 侧栏合并为单个"能力"入口；页面内用 `Tabs` 分 `Skills` / `MCP` / `Agents`，直接复用现有 `SkillsView` 与 `McpView`（不改写其内部实现与测试）。
- URL 采用 `?view=capabilities&tab=<skills|mcp|agents>`；兼容旧深链 `?view=skills` / `?view=mcp`，映射到对应 Tab。`ViewKey` 增加 `"capabilities"`。
- 页眉、标题、副标题、Inspector 提示同步切换；CSS 复用 `.skills-view` / `.mcp-view` 共享选择器组。

### 7.2 Agents 面板

- 摘要（总数 / 启用 / 无效 / 诊断）+ 搜索 + 状态过滤 + 表格：
  - 列：id、名称与描述、来源（builtin/project）、可执行性（prompt-only/module）、工具组摘要（启用/禁用）、技能模式、预算（默认/上限/轮次片/时间份额）、并发上限、启用开关、配置按钮。
  - 非 admin 只读（`Switch` 禁用并给出 tooltip，与 Skills/MCP 一致）。
  - `general` 的启用开关禁用（不可禁用）。
- `SpecialistOptionsDrawer`：按 `options` schema 生成表单（string/text/number/boolean/enum/string-list），展示默认值，保存 `PUT /api/agents/:id/options`（整体替换，`{}` 即恢复默认）。
- 诊断区展示 registry 级与 Agent 级诊断。

### 7.3 HTTP API

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/agents` | `viewer:metadata` | 返回 `describeAll()` 快照 |
| POST | `/api/agents/:id/state` | `operator:mutate` | body `{ enabled: boolean }`，返回单个 Agent |
| PUT | `/api/agents/:id/options` | `operator:mutate` | body `{ options: Record<string, unknown> }`，返回单个 Agent |

沿用既有约定：`readJsonBody` + `assertOnlyKeys`、id 正则校验、`404 specialist_not_found`、`400 invalid_request`、错误信封 `{ error: { code, message } }`。

## 8. 测试策略

- **SDK**：`defineSpecialist` 校验、工具策略应用（组/allow/deny/`submit` 保护/未知名诊断）、提示词渲染与 `{{options.*}}` 替换、`# Runtime Contract` 注入。
- **Registry**：内置注册、纯声明 Agent、模块 Agent（临时目录写 `.mjs`）、id 不一致、`entry` 越界与扩展名、模块抛错降级、禁用 Agent 不加载模块、启停与选项持久化、选项校验与未知键拒绝。
- **Controller**：`specialistRegistry` 注入、`selectTaskSkillDirs` 的 pinned/allowlist/off、预算 clamp（含 ceiling 低于全局下限）、工具绑定裁剪、`specialist_unavailable` 路径、事件落盘。
- **Web 服务端**：三个端点的鉴权、参数校验、404/400、快照形状。
- **前端**：能力页三个 Tab 渲染与深链、Agents 面板加载/搜索/过滤、admin 启停、非 admin 只读、选项抽屉保存与校验错误、加载失败重试。
- **文档**：SDK 指南（如何写内置 Agent、如何写项目级清单与模块、工具组与预算语义）。

## 9. 兼容性与回滚

- 未声明 `specialist` 的 Task 行为与现状完全一致（`general` 参数等于现有常量）。
- 未安装任何项目级 Agent、Registry 异常、模块加载失败时均降级为仅有 `general`，运行不中断。
- 现有 API 与视图保持不变，`?view=skills` / `?view=mcp` 深链继续可用。
- 回滚只需移除 Planner 目录段与前端入口；Task 节点上的 `properties.specialist` 是纯附加字段，旧版本读取时忽略。

## 10. 未来工作

- 项目级模块的 TOFU 哈希信任门与 `SPECIALISTS_ALLOW_PROJECT_MODULES` 紧急开关。
- Task 级总墙钟预算 `budget.timeBudgetMs`。
- Agent 级聚合遥测（按 Agent 的轮次/时长/token/成本）与"可优化"视图。
- `credential` runtime 的 factory 注入缝（当前为硬 `new`）。
- Agent 声明 MCP/Skill 前置依赖后的自动启停与准入检查。
