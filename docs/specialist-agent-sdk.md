# 专精 Agent（Specialist Agent）概览

> 开发一个新的 Agent，请看 **[`create_agent.md`](create_agent.md)**（注册路径、字段语义、工具裁剪、预算、选项表单、调试排错、测试范式）。
> 设计取舍与不变量，见 [`superpowers/specs/2026-09-16-specialist-agent-sdk-design.md`](superpowers/specs/2026-09-16-specialist-agent-sdk-design.md)。
> 实施过程，见 [`superpowers/plans/2026-09-16-specialist-agent-sdk.md`](superpowers/plans/2026-09-16-specialist-agent-sdk.md)。

## 它解决什么问题

专精 Agent 是 **Executor 的特化实例**：它拥有自己的系统提示词、模型档位、工具面、Skill 策略、预算与并发上限，由 Planner 在 `create_tasks` 时按任务选择。

| 维度 | 回答的问题 | 载体 |
|---|---|---|
| Skill | 执行者可以带哪些资料 | `.agents/skills/` |
| MCP | 运行时提供哪些工具 | `.agents/mcp-state.json` + 内置 runtime |
| **专精 Agent** | **谁来做**，用什么提示词/模型/工具面/预算 | `.agents/specialists/` + 代码 SDK |

Skill 只能"加资料"、MCP 只能"加工具"，两者都作用于同一个 Executor；只有专精 Agent 能改变执行者本身。

## 三条注册路径

| 路径 | 适用 | 改代码 | 自定义工具 |
|---|---|---|---|
| 内置代码注册（`defineSpecialist`） | 随仓库分发 | 是 | 能 |
| 项目级声明式（`.agents/specialists/<id>/specialist.json`） | 使用方自行扩展 | 否 | 不能 |
| 项目级模块（清单 + `entry` 指向 `.mjs`/`.js`） | 使用方自行扩展且需自带工具 | 否 | 能 |

内置 `general` 是 Planner 省略 `specialist` 字段时的兜底，其参数与引入本 SDK 之前的历史行为逐字节一致，且不可停用。

## 不变量

1. 专精 Agent **只能收窄**能力：工具策略是纯减法，`task_result_submit` 所在的 `submit` 组不可移除。
2. 自定义工具与内置工具同权，同样受工具审批与危险工具策略约束。
3. 沙箱边界、Scope 校验、证据契约、任务图只读不变；Agent 不得扩大授权或修改任务图。
4. 一个 Task 的拥有者创建后固定；切换 Agent 必须由 Planner 创建后继 Task。
5. 项目级模块在**启用后**才会被导入执行；加载失败只影响该 Agent，其它 Agent 不受影响。
6. **选项权威显式声明**：安全与能力参数由作者固定（`authority: "author"`，能力页只读），Planner 只能在作者与用户共同确定的边界内取值，用户不能突破作者声明的 `minimum`/`maximum`。详见 [`create_agent.md` 第 7.2 节](create_agent.md)。
7. **能力面写操作是管理动作**：专精 Agent / Skill / MCP 的启停与参数写入需要 `admin:capability`（仅 `admin` 角色）；读操作对所有已认证用户开放。

## 运行时可观测

| 事件 | 含义 |
|---|---|
| `specialist_registry_scanned` | 启动时扫描到的 Agent 与诊断 |
| `specialist_selected` | 某 Task 被分配给某 Agent，含工具裁剪、技能模式、预算与选项快照 |
| `specialist_unavailable` | Agent 不可用（未知/禁用/无效/加载失败），Task 已交回 Planner |
| `specialist_diagnostic` | Agent 级诊断（未知工具名、占位符未声明、工具重名或工厂抛错） |
| `specialist_catalog_failed` | Planner 目录构建失败，按无专精 Agent 继续 |
| `invocation_metrics` | `payload.specialistId` 标识调用归属，可按 Agent 统计轮次/时长/token/成本 |

## Web 控制面

侧栏「能力」→ `专精 Agent` 标签页（与 Skill / MCP 同页）：注册表列表、启停开关、来源与可执行性、工具组与技能策略摘要、预算摘要、诊断；「配置」抽屉按 `options` schema 自动生成表单，其中的模式总开关在 `planner` 指定与 `user` 指定之间切换，作者固定项以只读形式展示。

权限：`GET /api/agents` 需要 `viewer:metadata`；能力面写操作（`POST /api/agents/:id/state`、`PUT /api/agents/:id/options`、`POST /api/agents/:id/options-mode`，以及 Skill / MCP 的 state 路由）需要 `admin:capability`，只有 `admin` 角色持有，UI 与 API 的判定一致。

## 兼容与降级

- 未声明 `specialist` 的 Task 行为与引入本 SDK 之前完全一致（预算、提示词、工具面、技能选择均不变）。
- 未安装任何项目级 Agent、Registry 异常、模块加载失败时都降级为仅有 `general`，运行不中断。
- `?view=skills` / `?view=mcp` 旧深链仍然可用，会映射到统一能力页的对应标签。
