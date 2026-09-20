# 开发一个新的专精 Agent

本文是 LuaN1aoAgent 专精 Agent（Specialist Agent）的**开发指南**：从注册、字段语义、工具裁剪、预算、前端选项，到调试排错与测试。

概念与设计取舍见 [`superpowers/specs/2026-09-16-specialist-agent-sdk-design.md`](superpowers/specs/2026-09-16-specialist-agent-sdk-design.md)；概览与运行时可观测见 [`specialist-agent-sdk.md`](specialist-agent-sdk.md)。

---

## 0. 选择注册路径

专精 Agent 是 **Executor 的特化实例**：它拥有自己的系统提示词、模型档位、工具面、Skill 策略、预算与并发上限，由 Planner 在 `create_tasks` 时按 Task 选择。它不能修改任务图、不能扩大授权、不能绕过沙箱与审批。

| 路径 | 适用场景 | 需要改代码 | 能带自定义工具 |
|---|---|---|---|
| **A. 内置代码注册** | 随仓库分发、需要类型安全与单测覆盖 | 是（TypeScript） | 能 |
| **B. 项目级声明式** | 使用方自己加 Agent，只调提示词/工具面/预算/技能 | 否（改 JSON 即可） | 不能 |
| **C. 项目级模块** | 使用方自己加 Agent，且需要自定义工具 | 否（写 `.mjs`） | 能 |

三条路径最终都归一成同一个 `SpecialistAgentDefinition`，运行时行为一致。

---

## 1. 路径 A：内置代码注册

### 1.1 新建定义文件

`src/specialists/builtin/my-agent.ts`：

```ts
import { defineSpecialist } from "../sdk.js";

export const MY_AGENT_ID = "my-agent";

export const myAgent = defineSpecialist({
  id: MY_AGENT_ID,
  name: "我的专精 Agent",
  description: "一句话说明它负责产出什么结论（Planner 会读这句）。",
  whenToUse: "适用场景；以及明确不适用的场景。",
  version: "1.0.0",
  prompt: {
    mode: "extend",
    content: `# 附加方法
1. 先固定当前 Task 的成功条件，再选择最小验证动作。
2. 并发上限 {{options.threads}}，目标 {{options.target}}。`
  },
  tools: { disableGroups: ["fofa", "beekeeper"] },
  skills: { mode: "allowlist", allow: ["port-scan"] },
  budget: {
    defaultMaxTurns: 8,
    maxTurnsCeiling: 12,
    epochTurnSlice: 6,
    epochTimeShare: 0.3
  },
  concurrency: { maxParallelTasks: 1 },
  options: {
    target: { type: "string", title: "目标", default: "", maxLength: 512 },
    threads: { type: "number", title: "并发", default: 4, minimum: 1, maximum: 64, integer: true }
  }
});
```

`defineSpecialist` 会**在定义处**校验 id 格式、预算边界、工具组名、技能策略与选项 schema；写错立即抛 `SpecialistDefinitionError`，不会拖到运行时。

### 1.2 注册到内置清单

`src/specialists/builtin/index.ts`：

```ts
import type { SpecialistAgentDefinition } from "../types.js";
import { GENERAL_SPECIALIST_ID, generalSpecialist } from "./general.js";
import { BRUTEFORCE_SPECIALIST_ID, bruteforceSpecialist } from "./bruteforce.js";
import { MY_AGENT_ID, myAgent } from "./my-agent.js";

export function builtinSpecialists(): SpecialistAgentDefinition[] {
  return [generalSpecialist, bruteforceSpecialist, myAgent];
}
```

不要动 `REQUIRED_SPECIALIST_IDS`，它只包含 `general`（Runtime 兜底，不可停用）。

### 1.3 编译与验证

```bash
npm run build:server
node --test --test-force-exit --test-concurrency=1 dist/test/specialist-registry.test.js
```

---

## 2. 路径 B：项目级声明式（免编译）

### 2.1 目录结构

```
.agents/specialists/recon-lite/     # 目录名必须等于 id
├── specialist.json                 # 必需
└── prompt.md                       # 可选，供 prompt.file 引用
```

> `.agents/` 已在 `.gitignore` 中（与 Skills 一致），不会进版本库。可直接复制脚手架：`cp -r templates/specialists/recon-lite .agents/specialists/`

### 2.2 specialist.json

```json
{
  "id": "recon-lite",
  "name": "轻量信息搜集 Agent",
  "description": "只做小范围、低风险的信息搜集与资产确认。",
  "whenToUse": "适用于资产、端口、服务尚未确认的 Task；不适用于已确认入口后的利用工作。",
  "enabled": true,
  "prompt": { "mode": "extend", "file": "prompt.md" },
  "tools": { "disableGroups": ["fofa", "beekeeper", "credentials"] },
  "skills": { "mode": "allowlist", "allow": ["port-scan", "subdomain-enum"] },
  "budget": { "defaultMaxTurns": 6, "maxTurnsCeiling": 10, "epochTurnSlice": 5, "epochTimeShare": 0.15 },
  "concurrency": { "maxParallelTasks": 2 },
  "options": {
    "scopeNote": { "type": "text", "title": "补充说明", "default": "", "maxLength": 2000 }
  }
}
```

要点：

- 目录名、`id` 必须一致；`prompt` 用 `content`（内联）或 `file`（同目录文件，≤256 KiB）。
- `enabled` 是**初始默认值**；之后的启停以 `.agents/specialists-state.json` 为准。
- 解析失败、字段缺失、目录名不匹配都会产生诊断并把该 Agent 标为无效，**不影响其它 Agent**。

---

## 3. 路径 C：项目级模块（自定义工具）

### 3.1 清单只声明 id 与入口

`.agents/specialists/my-module-agent/specialist.json`：

```json
{ "id": "my-module-agent", "enabled": false, "entry": "index.mjs" }
```

`entry` 必须是 `.mjs` / `.js`，且解析后仍在该 Agent 目录内（拒绝 `../` 与符号链接逃逸）。有 `entry` 时，清单里的其它字段被忽略，一切以模块导出为准。

### 3.2 模块形态

`.agents/specialists/my-module-agent/index.mjs`：

```js
export default function createAgent(api) {
  return {
    id: "my-module-agent",              // 必须等于目录名
    name: "模块 Agent",
    description: "演示自定义工具。",
    prompt: { mode: "extend", content: "# 附加方法\n使用 probe_target 记录每次探测。" },
    budget: { defaultMaxTurns: 8, maxTurnsCeiling: 12, epochTurnSlice: 6, epochTimeShare: 0.3 },
    options: { target: { type: "string", title: "目标", default: "" } },
    createTools: (context) => [
      api.defineTool({
        name: "probe_target",
        label: "Probe target",
        description: "对目标记录一次受控探测并返回观测到的运行时上下文。",
        parameters: api.Type.Object({
          target: api.Type.String({ minLength: 1, maxLength: 512 }),
          note: api.Type.Optional(api.Type.String({ maxLength: 512 }))
        }, { additionalProperties: false }),
        execute: async (_toolCallId, params) => {
          const result = { target: params.target, taskId: context.taskId, options: context.options };
          await context.executionLog?.append({
            taskId: context.taskId,
            role: "executor",
            eventType: "my_module_probe",
            summary: `probe ${params.target}`,
            payload: result
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
      })
    ]
  };
}
```

默认导出也可以是**定义对象**（不写工厂）：

```js
export default { id: "my-module-agent", /* ... */ };
```

### 3.3 模块 API

工厂收到的 `api` 就是 `SPECIALIST_MODULE_API`：

| 成员 | 用途 |
|---|---|
| `defineTool` | 与仓库内一致的 Pi 工具工厂 |
| `Type` | TypeBox schema 构造器 |
| `defineSpecialist` | 校验并返回定义（可选，用于早失败） |
| `defineSpecialistTool` | `defineTool` 的转发封装 |
| `toolGroups` | 全部工具组名数组 |
| `defaultBudget` | 默认预算（`12/40/20/0.5`） |

模块也可以直接 `import { defineTool } from "@earendil-works/pi-coding-agent"`（模块位于仓库内，Node 会向上解析到 `node_modules`），但用 `api` 更稳定。

### 3.4 `createTools(context)` 契约

`context` 字段：`taskId`、`specialistId`、`options`（已合并默认值的生效值）、`cwd`、`workspaceDir?`、`artifactStore`、`executionLog?`、`enabledGroups`、`disabledGroups`。

- 必须返回 `ToolDefinition[]`；每个元素需要 `name`（非空字符串）与 `execute`（函数），否则整条工具被丢弃并产生诊断。
- **工具名不得与运行时已有工具重名**：重名即丢弃（`specialist_tool_collision`），避免遮蔽运行时工具。
- `createTools` 抛错不会拖垮 Task：该会话仍以其余工具启动，并落 `specialist_diagnostic` 事件。
- 自定义工具与内置工具同权，**同样经过工具审批与危险工具策略**。
- `execute` 内直接 `throw` 表示工具失败；返回值形如 `{ content: [{ type: "text", text }], details }`，`details` 是给 Runtime 的结构化载荷。

> ⚠️ 安全边界：模块在 Runtime 进程内执行。Runtime 只校验路径与导出结构，**不沙箱化模块**。不要安装不可信的 Agent。

---

## 4. 字段速查

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | `^[a-z0-9]+(-[a-z0-9]+)*$`，≤64；项目级必须等于目录名 |
| `name` | ✅ | 展示名 |
| `description` | ✅ | Planner 目录文本：一句话说清产出什么 |
| `whenToUse` | | Planner 目录文本：适用/不适用边界 |
| `version` | | 自由字符串，仅展示 |
| `prompt.mode` | ✅ | `extend`（默认，叠加在 Executor 契约上）或 `replace`（仅作者内容） |
| `prompt.content` | ✅ | 支持 `{{options.<key>}}` 占位符 |
| `tools.disableGroups` | | 见第 5 节 |
| `tools.allow` / `tools.deny` | | 工具名白/黑名单，`deny` 优先 |
| `createTools` | | 自定义工具（路径 A/C 可用） |
| `skills.mode` | | `auto`（默认）/ `allowlist` / `pinned` / `off` |
| `skills.allow` / `skills.pinned` | | 分别对应 `allowlist` / `pinned` 模式，必须非空 |
| `budget` | ✅ | 见第 6 节 |
| `model.model` / `model.thinkingLevel` / `model.contextWindow` | | 覆盖 `executor` 角色默认值 |
| `concurrency.maxParallelTasks` | | 1–16，该 Agent 同时运行的 Task 数上限 |
| `optionsMode` | | `planner`（默认，最严）或 `user`；未声明 `authority` 的选项跟随它，见第 7.2 节 |
| `options` | | 见第 7 节，≤32 项 |

两种 `prompt.mode` 都会追加 Runtime 生成的 `# Runtime Contract`（终止工具契约、任务图只读、Scope 与证据纪律），**不可被覆盖**。若 `mode=extend` 且 `content` 为空、`options` 也为空，则完全沿用原 Executor 系统提示词（`general` 就是这个形态，保证既有行为逐字节不变）。

---

## 5. 工具裁剪

工具按工厂分为 11 个组，策略**只能做减法**：

| 组 | 内容 |
|---|---|
| `sandbox` | `read` / `bash` / `grep` / `find` / `ls` / `write` / `edit` |
| `research` | `web_fetch` / `web_search` / `vulnerability_search` |
| `browser` | `browser_render` |
| `artifact` | `artifact_read` / `artifact_write` |
| `evidence` | `evidence_list` / `evidence_read` |
| `connectivity` | `route_open` / `route_status` / `route_stop` / `route_reconnect` |
| `network_diagnostics` | 网络诊断工具 |
| `fofa` | FOFA 工具 + `topology_validation` |
| `beekeeper` | Beekeeper 工具 |
| `credentials` | 凭据工具 |
| `submit` | `task_result_submit`（**不可禁用/拒绝**） |

生效顺序：`disableGroups` 先扣减 → `allow` 白名单收窄 → `deny` 黑名单最终覆盖 → `submit` 组强制保留。

- `allow` 里出现不存在的工具名会产生 `specialist_tool_name_unknown` 诊断（不会静默忽略）。
- 试图禁用 `submit` 组或 deny `task_result_submit` 会产生 `specialist_tool_group_protected` 诊断并被忽略。
- 未启用的运行时能力（例如未配置 FOFA）本来就不会出现在工具集里，裁剪它不会报错。

---

## 6. 预算与生命周期

```ts
budget: {
  defaultMaxTurns: 8,     // Planner 未指定 budget.maxTurns 时使用；同时决定下限
  maxTurnsCeiling: 12,    // Planner 指定值的上限，可低于全局最小值 10
  epochTurnSlice: 6,      // 单个 Epoch 允许的轮次片（全局默认 20）
  epochTimeShare: 0.3     // 单个 Epoch 占全局剩余运行时间的比例（全局默认 0.5）
}
```

生效规则：

- `maxTurns = clamp(Planner 值 ?? defaultMaxTurns, floor, min(maxTurnsCeiling, 40))`，其中 `floor = min(10, defaultMaxTurns)`。
  - 想让 Agent 比通用 Executor 更省：把 `defaultMaxTurns` 设到 10 以下（例如信息搜集 6），它会拿到自己的小预算。
  - 想让 Agent 有更大投入：抬高 `defaultMaxTurns` 与 `maxTurnsCeiling`（例如爆破 16 / 24）。
  - `general`（默认 12 / 上限 40）精确复现历史的 10/12/40 区间。
- Planner 的 `patch_task.additionalTurns` 只对**显式指定了 Agent** 的 Task 施加 ceiling 收窄；未指定的 Task 保持历史累积行为。
- `epochTimeLimitMs = min(floor(全局剩余时间预算 × epochTimeShare), 剩余时间)`。
- 达到 `epochTurnSlice` 或时间片会用尽时，Runtime 请求该 Epoch 收尾（handoff），Task 可在后续 Epoch 继续。
- `concurrency.maxParallelTasks` 限制该 Agent 同时运行的 Task 数（例如爆破限 1，避免凭据喷洒并发）。

预算只影响**投入上限**，不影响终止条件；Agent 仍必须在成功条件满足时立即 `task_result_submit`。

---

## 7. 选项（options）、权威模型与前端表单

Web「能力 → 专精 Agent」会按 `options` schema 自动生成表单，保存到 `.agents/specialists-state.json`。

### 7.1 选项类型

| 类型 | 字段 | 说明 |
|---|---|---|
| `string` | `default` `maxLength` `pattern` `placeholder` | 单行文本，`pattern` 在服务端校验 |
| `text` | `default` `maxLength` `placeholder` | 多行文本 |
| `number` | `default` `minimum` `maximum` `integer` | 数值；`integer: false` 允许小数 |
| `boolean` | `default` | 开关 |
| `enum` | `default` `options: [{ value, label }]` | 下拉选择 |
| `string-list` | `default` `maxItems` | 标签输入，值是 `string[]` |

每项都需要 `title`，可选 `description`（显示在表单里）。

### 7.2 权威模型（谁决定这个值）

这是本 SDK 最重要的一条设计约束：**能力面与安全参数由 Agent 作者固定，不由在线用户或 Planner 决定**。每个选项的权威（authority）有三档，从最严到最松：

| 权威 | 值来自哪里 | 用户在能力页能做什么 | Planner 能做什么 |
|---|---|---|---|
| `author` | 作者声明的 `default` | 不能改，表单只读并标注「作者固定」 | 不能改，提交的值被丢弃并产生诊断 |
| `planner` | Planner 在 `create_tasks.specialistOptions` 中给出 | 只能设**边界**：`number` 设上限，`string-list` 收窄为子集 | 在 `[minimum, min(maximum, 用户上限)]` 内选具体值 |
| `user` | 用户在能力页填写的值 | 直接生效（受作者边界夹紧） | 不能改 |

**有效权威的计算规则**（`effectiveOptionAuthority`）：

1. `authority: "author"` 是绝对锁定，任何模式都改不动它。
2. `authority: "user"` 是作者显式交付给用户的选项。
3. `authority: "planner"` 只在"用户设边界"有意义时成立：`number` 必须声明 `maximum`，`string-list` 必须有非空 `default` 作为授权全集。否则该声明降级为 `author` 锁定，而不是发明一套边界语义。
4. 不写 `authority` 时由 `optionsMode` 决定：可调项跟随模式；不可调项（boolean/enum/string/text 以及没声明 `maximum` 的 number）在默认 `planner` 模式下**一律锁定**，只有 `optionsMode: "user"` 才交给用户。

`optionsMode` 有两个值：`"planner"`（默认，最严）与 `"user"`。作者在定义里给出默认模式，用户在能力页可以切换，但切换只影响没有显式声明 `authority` 的选项，且永远不能突破作者声明的 `minimum`/`maximum`。

```ts
optionsMode: "planner",
options: {
  // 作者固定：安全开关，只读
  stopOnLockout: { type: "boolean", title: "检测到锁定即停止", default: true, authority: "author" },
  // Planner 可调，但天花板由作者钉死
  threads: { type: "number", title: "并发线程数", default: 4, minimum: 1, maximum: 8, integer: true },
  // 显式交给用户：任务目标类参数
  material: { type: "text", title: "输入材料", default: "", authority: "user" }
}
```

要点：

- 作者的 `minimum`/`maximum` 是**硬边界**。用户提交越界值会被拒绝（不是静默改写），错误信息会带上约束原文（例如 `must be an integer between 1 and 8`）。
- `planner` 权威选项对用户而言填的是**上限**，对 Planner 而言才是取值。所以同一字段在两种角色下含义不同，UI 会显示为「上限」控件。
- Planner 只在 catalog 的 `tunableOptions` 里看到 `planner` 权威选项；`author` 与 `user` 选项不会进入 Planner 的可写视野。Planner 提交未公开的键会被 `create_tasks` 校验直接拒绝，并提示可调项清单。
- Planner 提交越界值会被夹紧到有效边界，并产生 `specialist_option_clamped` 诊断事件。
- 想给某个选项留出运行期自由度，就把它声明成 `planner` 并给一个**你愿意接受的最大值**；不要用 `user` 表达"可调"，那等于把决定权完全交给在线用户。
- `boolean` 与 `enum` 不能声明 `planner`：这两类没有"上限"语义，`defineSpecialist` 会在定义处直接报错。

### 7.3 在提示词中读取

```
默认 threads={{options.threads}}，材料：{{options.material}}
```

- 未在 `options` 中声明的占位符会保留原样并产生 `specialist_prompt_placeholder_unknown` 诊断。
- 声明了选项但提示词没引用时，运行时会在系统提示词里追加 `## 当前配置` 列出生效值。
- 服务端只接受 schema 中声明过且**可编辑**的键；未知键、`author` 权威键、越界值、类型不符都会被拒绝（Web 端返回 400）。
- 「恢复默认」= 提交空对象 `{}`，服务端清空已存选项并回到作者默认值。
- 运行期还有一个总开关 API（`POST /api/agents/:id/options-mode`），把 `optionsMode` 在 `planner` 与 `user` 之间切换；传 `null` 表示回到作者默认模式。

---

## 8. 技能策略

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 沿用现有 LLM 选择器，在全部可用 Skill 中挑 |
| `allowlist` | LLM 选择器**只在 allow 名单内**挑（候选集在调用模型前就收窄） |
| `pinned` | 固定使用 pinned 名单，跳过 LLM 调用（省 token、结果确定） |
| `off` | 不使用任何 Skill |

四种模式都会再次校验 Skill 的 `valid` / `enabled` / `modelInvocable`；名单里不存在的 Skill 会被跳过并落 `skill_skipped` 事件，不会报错。

**allowlist 与真实文件必须对齐。** 名单里的名字若在本项目 `.agents/skills/` 下不存在，该 Agent 的**知识面就是空的**——运行期会写 `allowlist_skill_unknown`（名字没有对应技能）与 `allowlist_skill_empty`（收窄后一个可用技能都不剩）事件，但不会让 Agent 失效，所以很容易被忽略。写完 allowlist 后请核对：

```bash
ls .agents/skills/            # 只有这里出现的 name 才是可用候选
grep -h '^name:' .agents/skills/*/SKILL.md
```

`.agents/` 是项目本地目录且被 git 忽略（技能按项目安装）。要让技能随仓库分发，把受版本控制的副本放在 `templates/skills/<name>/SKILL.md`，`install.sh` 会把它们安装到 `.agents/skills/`。

---

## 9. 让 Planner 选中你的 Agent

Planner 只看到 `<available_specialists>` 目录里的 `id` / `name` / `description` / `whenToUse` / 预算 / 被裁剪的工具组 / 并发上限。要让它稳定选对：

1. **`description` 写产出，不写方法**：`"产出已确认的认证面清单与失败信号基线"` 优于 `"用 nmap 扫描"`。
2. **`whenToUse` 同时写边界**：明确"不适用于……"，否则 Planner 会在相邻场景里误用。
3. **预算就是它的画像**：小预算 + 窄工具面会自然让 Planner 只在轻量场景派它。
4. Agent 只出现在目录里的前提是 `enabled && valid`；被禁用时 Planner 看不到它，已建的 Task 会收到 `specialist_unavailable` 并被交回重新决策。

Task 的拥有者创建后固定：要换 Agent，由 Planner 完成/归档当前 Task 并创建后继 Task（可用 `continueFromTaskRef` 继承 workspace 与 Session）。

---

## 10. 调试与排错

### 10.1 一次性查看注册表

```bash
npm run build:server
cat > .check-agent.mjs <<'EOF'
import { SpecialistRegistry } from "./dist/src/specialists/registry.js";
const registry = new SpecialistRegistry({ cwd: process.cwd() });
const snapshot = await registry.describeAll();
for (const s of snapshot.specialists) {
  console.log(s.id, { source: s.source, valid: s.valid, enabled: s.enabled, introspected: s.introspected, budget: s.budget });
}
console.log("diagnostics:", snapshot.diagnostics.map((d) => `${d.code}: ${d.message}`));
EOF
node .check-agent.mjs && rm .check-agent.mjs
```

### 10.2 执行事件

| 事件 | 含义 |
|---|---|
| `specialist_registry_scanned` | 启动时扫描结果（含每个 Agent 的 enabled/valid/可执行性） |
| `specialist_selected` | Task 被分配给某个 Agent，含工具裁剪、技能模式、预算与选项快照 |
| `specialist_diagnostic` | Agent 级诊断（未知工具名、占位符未声明、工具重名等） |
| `specialist_unavailable` | Agent 不可用，Task 已交回 Planner（含 `reason` 与 registry 状态） |
| `specialist_catalog_failed` | Planner 目录构建失败（此时按无专精 Agent 继续） |
| `invocation_metrics` | `payload.specialistId` 标识本次 Executor 调用归属，用于按 Agent 统计轮次/时长/token/成本 |

查看方式：Web 工作台的运行轨迹，或 `.agent-runtime/sessions/<session>/execution.jsonl`。

### 10.3 诊断码

| 码 | 原因 | 处理 |
|---|---|---|
| `specialist_id_invalid` | id 不合规，或目录名 ≠ `id` ≠ 模块导出 id | 统一三者 |
| `specialist_manifest_missing` | Agent 目录没有 `specialist.json` | 补文件或删除目录 |
| `specialist_manifest_invalid` | JSON 结构/字段不合法（含 prompt 缺 content/file） | 按 `defineSpecialist` 的校验规则修 |
| `specialist_duplicate_id` | id 与内置或其它项目 Agent 冲突 | 改 id（内置优先，项目条目被忽略） |
| `specialist_entry_outside_root` | `entry`/`prompt.file` 越出 Agent 目录 | 放回目录内，去掉符号链接 |
| `specialist_entry_extension` | `entry` 不是 `.mjs`/`.js` | 改扩展名 |
| `specialist_module_failed` | 模块 import 或工厂执行抛错 | 看事件里的 message（含原始错误） |
| `specialist_module_invalid_export` | 导出不是对象/工厂，或 id 不匹配，或工具缺 name/execute | 修导出结构 |
| `specialist_tool_name_unknown` | `allow`/`deny` 里写了不存在的工具名 | 核对第 5 节组内工具名 |
| `specialist_tool_group_protected` | 试图禁用 `submit` 组或 deny `task_result_submit` | 去掉该策略（不会生效） |
| `specialist_tool_collision` | 自定义工具与已有工具重名 | 改名 |
| `specialist_tool_factory_failed` | `createTools` 执行时抛错（该会话仍以其余工具启动） | 看事件 message 修工具实现 |
| `specialist_option_unknown` / `specialist_option_invalid` | 存储的选项含未声明键、类型不符或越出作者边界 | 在 Web 端按错误信息里的约束修正或「恢复默认」 |
| `specialist_option_not_editable` | 试图写入 `author` 权威的选项（含存储文件里的残留值） | 该选项由作者固定；要放开就在定义里改成 `planner` 或 `user` |
| `specialist_option_not_planner_tunable` | Planner 在 `create_tasks.specialistOptions` 里写了 `author`/`user` 权威的键 | 只用 catalog 中 `tunableOptions` 公布的键 |
| `specialist_option_clamped` | 取值被夹紧到有效边界（用户上限或作者上限） | 正常行为；若不符合预期就检查用户设的上限 |
| `specialist_option_bound_below_minimum` / `specialist_option_bound_excludes_all` | 用户设的边界低于作者最小值，或把授权集合收窄为空 | 按错误信息调整边界 |
| `specialist_prompt_placeholder_unknown` | 提示词引用了未声明的 `{{options.x}}` | 补进 `options` 或删掉占位符 |

### 10.4 常见症状

| 症状 | 可能原因 |
|---|---|
| Planner 从不选我的 Agent | Agent 被禁用或 `valid=false`；`description`/`whenToUse` 太泛；目录未出现在 `<available_specialists>` |
| 自定义工具不在工具列表里 | `entry` 路径/扩展名不对；模块加载失败；工具缺 `name`/`execute`；与内置工具重名 |
| 提示词里的 `{{options.x}}` 没被替换 | 该 key 未在 `options` 中声明 |
| 某个选项在能力页是灰的 | 它被解析成 `author` 权威：要么写了 `authority: "author"`，要么它是 `boolean`/`enum`/`string`/`text`，或是个没声明 `maximum` 的 `number`，而当前是默认的 `planner` 模式 |
| Planner 说某个选项"不接受 Task 级取值" | 该选项不是 `planner` 权威；只有这类选项才会出现在 catalog 的 `tunableOptions` 里 |
| Planner 提交被拒 | 选了未知/禁用/无效的 id，或写了未公开的 `specialistOptions` 键：错误信息会列出可用 id 与可调项，Planner 会在同一轮内改 |
| 任务停着不动、状态是 `awaiting_planner` | 该 Agent 在运行中被禁用或变为无效，Task 已交回 Planner 重新决策 |
| 预算比预期小/大 | 受 `defaultMaxTurns` 决定的下限与 `maxTurnsCeiling` 上限约束（见第 6 节） |

---

## 11. 测试你的 Agent

### 11.1 单元测试（Node test runner）

```ts
// test/my-agent.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpecialistRegistry } from "../src/specialists/registry.js";

test("my-agent resolves with narrowed tools and options", async () => {
  const registry = new SpecialistRegistry({ cwd: mkdtempSync(join(tmpdir(), "my-agent-")) });
  const resolution = await registry.resolve("my-agent");
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.deepEqual(resolution.definition.tools?.disableGroups, ["fofa", "beekeeper"]);
  assert.equal(resolution.options.threads, 4);
});
```

项目级 Agent 的测试就按 `test/specialist-registry.test.ts` 的写法：把 `specialist.json` 与模块写进临时目录，再断言 `describeAll()` / `resolve()` 的结果与诊断。

```bash
npm run build && node --test --test-force-exit --test-concurrency=1 dist/test/my-agent.test.js
```

### 11.2 端到端验证

1. `npm run build && node dist/src/web-server.js`
2. 打开工作台 →「能力」→「专精 Agent」：确认你的 Agent 出现、状态与摘要正确、开关可切换。
3. 启动一次运行，给出一个明确落在 `whenToUse` 内的目标；在运行轨迹里确认出现 `specialist_selected`，且 `payload.specialistId` 是你的 Agent。
4. 在「配置」里改一个选项并保存，确认下一次运行的系统提示词里带上新值。

---

## 12. 安全与边界（必须遵守）

1. 专精 Agent **只能收窄**能力：工具策略是纯减法，`submit` 组不可移除。
2. 自定义工具与内置工具同权，必须经得起工具审批与危险工具策略。
3. 沙箱边界、Scope 校验、证据契约、任务图只读不变；Agent 不得自行扩大授权。
4. 项目级模块是**受信代码**：启用即在本进程执行，Runtime 不做沙箱化。
5. 一个 Task 的拥有者运行期固定，切换必须经 Planner 的后继 Task。

---

## 13. 提交前检查清单

- [ ] `id` 合规，且目录名 = 清单 `id` = 模块导出 `id`
- [ ] `description` / `whenToUse` 写清了产出与边界
- [ ] `budget` 四个字段齐全且 `defaultMaxTurns <= maxTurnsCeiling`
- [ ] `tools.disableGroups` 只列了真实组名，未触碰 `submit`
- [ ] `skills` 模式与其名单一致（`allowlist`→`allow`，`pinned`→`pinned`）
- [ ] 提示词里的 `{{options.*}}` 都已在 `options` 声明
- [ ] 自定义工具 `name` 唯一、`parameters` 用 `additionalProperties: false`
- [ ] 自定义 Agent 有单测；项目级 Agent 用临时目录覆盖加载与诊断
- [ ] `npm run build` 通过，相关测试全绿

---

## 14. 参考实现

| 文件 | 说明 |
|---|---|
| `src/specialists/builtin/general.ts` | 基线 Agent（零附加内容，参数等于历史行为） |
| `src/specialists/builtin/bruteforce.ts` | 完整示例：材料驱动提示词 + 工具裁剪 + Skill allowlist + 大时间份额 + 并发限 1 + 三档权威选项（author/planner/user） |
| `templates/specialists/recon-lite/` | 纯声明式脚手架：小预算、窄工具面、1 个选项 |
| `templates/specialists/example-module/` | 模块脚手架：`api.defineTool` + `executionLog` 写入 + 2 个选项 |
| `templates/skills/` | 随仓库分发的技能包（`.agents/` 被 git 忽略，这里是受版本控制的副本，`install.sh` 会安装它们） |
| `src/specialists/options.ts` | 选项权威解析、边界夹紧与 Planner 可调项投影 |
| `src/specialists/sdk.ts` | `defineSpecialist` 校验规则与选项规范化 |
| `src/specialists/tools.ts` | 工具组策略与自定义工具校验 |
| `src/specialists/registry.ts` | 清单/模块加载、状态文件、`resolve`/`catalog`/`statusIndex` |
| `test/specialist-sdk.test.ts`、`test/specialist-registry.test.ts`、`test/controller-specialists.test.ts` | 可复制的测试范式 |
