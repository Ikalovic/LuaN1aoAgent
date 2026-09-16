# 专精 Agent（Specialist Agent）SDK 实施计划

日期：2026-09-16  
设计：`docs/superpowers/specs/2026-09-16-specialist-agent-sdk-design.md`  
状态：待实施

## 目标

按设计文档交付完整纵切：SDK + Registry + Planner 选择 + 运行时应用 + 统一"能力"页 + 内置 `general` 与 `bruteforce` 示例 + 文档与测试。

## 阶段划分

### P0 环境与基线（已完成）

- `npm ci`（本机 npm 缓存只读，使用 `--cache /tmp/npm-cache`）。
- 基线：`npm run build:server`、`npm run build:web`、`node --test dist/test/*.test.js` 均通过。
- 注意：本机 Node 为 v22.22.1，`package.json` 要求 `>=25`，仅产生 `EBADENGINE` 警告；`node:sqlite` 可用。

### P1 SDK 内核（无行为变更）

新增：

- `src/specialists/types.ts`：定义、策略、预算、选项 schema、诊断、快照、解析结果、工具绑定与工具组类型。
- `src/specialists/tools.ts`：`SPECIALIST_TOOL_GROUPS`、`applySpecialistToolPolicy`、`validateSpecialistTools`。
- `src/specialists/prompt.ts`：`renderSpecialistSystemPrompt`、`{{options.*}}` 替换、`# Runtime Contract` 生成、占位符诊断。
- `src/specialists/sdk.ts`：`defineSpecialist`、`defineSpecialistTool`、`SPECIALIST_MODULE_API`、类型再导出。
- `src/specialists/registry.ts`：内置 + 项目级清单/模块加载、状态文件、`scan`/`describeAll`/`resolve`/`catalog`/`setEnabled`/`setOptions`。
- `src/specialists/builtin/general.ts`、`src/specialists/builtin/bruteforce.ts`、`src/specialists/builtin/index.ts`。
- `src/index.ts` 增补导出。

测试：`test/specialist-sdk.test.ts`、`test/specialist-registry.test.ts`。

验收：新增测试通过；`npm run build:server` 通过；无既有行为变化。

### P2 Planner 链路

修改：

- `src/types.ts`：`TaskDefinition.specialist`、`PlannerTaskSpec.specialist`、`PlannerTaskLedgerItem.specialist`（含 `status`）。
- `src/tools/pi-tools.ts`：`PlannerTaskSpecSchema.specialist`。
- `src/stores/graph-store.ts`：Task 节点持久化 `properties.specialist`、`taskNodeToEnvelope` 读回、ledger 输出。
- `src/prompts.ts`：`PLANNER_SYSTEM_PROMPT` 的 Specialist Selection 段、`renderPlannerInput` 的 `<available_specialists>`、`renderExecutorInput`/`renderExecutorResumeInput` 的专精 Agent 行。

验收：未指定 `specialist` 的 Task 行为不变；指定时 `TaskEnvelope.specialist` 正确往返。

### P2 运行时应用

修改：

- `src/agents.ts`：`createExecutorAgentSession` 接收已解析的 specialist（提示词/模型/工具绑定/自定义工具）。
- `src/controller.ts`：
  - 构造注入 `specialistRegistry`；
  - `createTaskRuntimeTools` → 带工具组的绑定；
  - `runExecutorTask` 解析 Agent、落 `specialist_selected`、缓存到 `ActiveTaskState`；
  - `selectTaskSkillDirs` 支持 pinned/allowlist/off；
  - 预算 clamp（初始 + `additionalTurns`）、`budgetStatusSnapshot` 与 `armEpochTimeSlice` 参数化、Supervisor 窗口；
  - `reconcileReadyTasks`/`admitReadyTasks` 的按 Agent 并发上限与不可用 Task 排除；
  - `invocation_metrics.details.specialistId`。

测试：`test/controller-specialists.test.ts`。

验收：`general` 路径与现状等价；`bruteforce` 的工具裁剪、预算与并发生效。

### P3 Web 服务端

修改 `src/web-server.ts`：`GET /api/agents`、`POST /api/agents/:id/state`、`PUT /api/agents/:id/options`。

测试：`test/web-server-specialists.test.ts`。

### P3 前端

新增：`web/src/components/CapabilitiesView.tsx`、`web/src/components/AgentsPanel.tsx`、`web/src/components/SpecialistOptionsDrawer.tsx`。

修改：`web/src/types.ts`（ViewKey + 类型）、`web/src/api.ts`、`web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/language.tsx`、`web/src/styles.css`。

测试：`web/src/components/AgentsPanel.test.tsx`、`web/src/components/CapabilitiesView.test.tsx`，并同步 `Sidebar.test.tsx` / `App.test.tsx` / `api.test.ts`。

验收：`?view=capabilities&tab=agents` 与旧 `?view=skills|mcp` 均可用；非 admin 只读；选项保存生效。

### P4 文档与脚手架

- `templates/specialists/example-module/`：`specialist.json` + `index.mjs` + `prompt.md` 示例。
- `docs/create_agent.md`：新 Agent 开发指南（注册路径、字段语义、工具裁剪、预算、选项、排错、测试）。
- `docs/specialist-agent-sdk.md`：SDK 概念概览（指向开发指南与设计文档）。
- `README.md` / `README_CN.md`：核心能力与仓库结构补充。

### P5 最终验证

- `npm run build`。
- `node --test --test-force-exit --test-concurrency=1` 运行新增与受影响的测试文件。
- `npm run test:web`。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 预算 clamp 破坏既有测试对 `MIN_TASK_BUDGET` 的断言 | `general` 的 ceiling 设为全局上限，clamp 逻辑仅在专精 Agent 上收紧 |
| 工具裁剪漏掉某个工厂导致工具泄漏 | 工具组装收敛到单一 `SpecialistToolBinding[]`，`createExecutorAgentSession` 是唯一入口，并对 `submit` 组做保护性校验 |
| 前端合并视图破坏既有测试 | 复用 `SkillsView`/`McpView` 组件本身；只在 App 层做 Tab 容器与深链映射 |
| 项目级模块加载影响启动 | 仅在 `enabled` 时加载，失败降级为诊断，不影响其它 Agent |
