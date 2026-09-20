# 图记忆与跨 Runtime 迁移 —— 设计方案

- 状态：草案，待决策
- 日期：2026-09-17
- 关联：`docs/superpowers/specs/2026-09-16-internet-osint-specialist-design.md`（本方案是该 Agent 产出落地的载体，但本身是平台级能力，不限于 OSINT）

---

## 1. 需求

1. **结构化图存储构成同一任务内的长期记忆** —— 采集到的事实要进图，跨 Task epoch 可读，不必重复采集。
2. **后台可手动迁移到其他任务** —— 操作员在控制面把 runtime A 的记忆搬到 runtime B。（此处「任务」= runtime，按用户定义。）

---

## 2. 现状清点

全部结论均有代码佐证。

| 能力 | 现状 | 证据 |
|---|---|---|
| 图种类 | tri-graph：`reasoning` / `operation` / `task` | `src/types.ts:3` |
| 存储 | 每 runtime 一个 `state.sqlite` | `src/controller.ts:586` |
| 节点词表 | **15 种，闭集** | `src/projection.ts:34-44` |
| 稳定身份 | ✅ `stableOperationIdentityId` = `op:sha256(identityKey)[0:24]` | `src/operation-identity.ts:51` |
| 身份归并 | ✅ `operation_identities` 表 + 提交时重映射 | `src/stores/graph-store.ts:293-331` |
| 侦察→图 的确定性范式 | ✅ 已存在 | `src/fofa/fofa-topology.ts` |
| 批量写图 | ✅ `upsertDelta(delta)` | `src/stores/graph-store.ts:152` |
| Planner 读图 | `graph_query` / `graph_search` / `graph_trace`，单次 10KB + cursor | `src/tools/pi-tools.ts:19` |
| 后台读图 | `/api/state` 只读暴露 nodes/edges | `src/web-server.ts:2937` |
| **后台写图** | ❌ 无 | `/api/*` 路由清单 |
| **跨 runtime 迁移** | ❌ **完全不存在** | 见 §2.1 |
| 容量控制 | ❌ 无裁剪 / TTL / 上限 | graph-store 全文 |

### 2.1 跨 runtime 迁移确实不存在

`--resume-dir` 是**继续同一个 runtime**，不是迁移（`src/cli-runtime.ts:20-35`）；新建 runtime 目录时反而强制要求目录为空（`src/cli-runtime.ts:49-55`）：

```ts
function assertFreshRuntimeDir(runtimeDir: string): void {
  if (existsSync(runtimeDir) && readdirSync(runtimeDir).length > 0) {
    throw new Error(`Runtime directory already contains state: ${runtimeDir}. ...`);
  }
}
```

graph-store 内没有任何 export / import / snapshot / merge-between-databases 方法。后台 API 无图相关端点。

**好消息**：`SQLiteGraphStore` 构造函数接路径（`src/stores/graph-store.ts:140`），打开另一个 runtime 的库在技术上无障碍——导出侧不需要新基础设施。

---

## 3. 四条决定设计的发现

### 3.1 只有 operation 节点享受身份归并

`src/stores/graph-store.ts:305-309`：

```ts
for (const node of delta.nodes) {
  if (node.graphKind !== "operation") {
    nodeIdMap.set(node.id, node.id);
    continue;
  }
```

非 operation 节点原样保留 ID，不做重映射。**这意味着：把 OSINT 实体放进新图种类，就拿不到去重与合并，跨 runtime 迁移会在目标库里堆出重复节点。** 因此 OSINT 实体**必须落在 operation 图**。

这条是硬约束，直接否掉了「新建第四个图种类」这个看起来更干净的选项。

### 3.2 域名/IP 已有归属，身份与人员完全没有

`Host` 的 identity 由 `normalizedHost` 计算（`src/operation-identity.ts:213-233`），而它能正确处理域名：`host:example.com`。`fofa-topology.ts:19` 也正是这么用的（`host ?? domain ?? ip`）。`resolves_to`、`has_alias`、`candidate_for` 边均已存在。

于是词表缺口精确地是：

| 实体 | 现有表示 |
|---|---|
| 域名 / IP / 服务 / 端点 / 公开文档 | ✅ 复用 `Host` / `Service` / `WebEndpoint` / `File` |
| 组织（主体） | ❌ 无 |
| 人员 | ❌ 无 |
| 邮箱 / 账号 | ❌ 无 |
| 手机号 / 联系方式 | ❌ 无 |

缺口恰好是用户最初点名的「手机号、邮箱、账号列表」那一侧。

### 3.3 `evidenceRefs` 是 runtime 局部的，迁移后必然悬空

```ts
id: `event:${randomUUID()}`,   // src/stores/execution-log.ts:65
```

引用是不透明 UUID，只在产生它的 runtime 的 execution log 里有意义。图节点普遍携带 `evidenceRefs`，直接搬运会得到一批指向不存在证据的引用——**这比没有引用更糟**，因为它看起来是可追溯的。

### 3.4 迁移是授权边界穿越

scope 存为 `Scope` task 节点 + `summary` 字符串，经 `parseAuthorizedScope` 解析（`src/controller.ts:839-843`、`src/scope.ts:11-14`）。

把 A 的 `Host` 节点导入 B，而 B 的授权 scope 不含该主机时：Planner 从 `graph_query(view="operation")` 读到它，就可能在其上规划 Task。**这是一条经由记忆层绕过授权的路径**，比直接越权更隐蔽，因为图节点天然带有「已确认」的可信外观。

---

## 4. 设计

### 4.1 节点词表扩展（最小集）

新增 4 种 operation 节点类型：

| 新类型 | 表示 | identity key 方案 |
|---|---|---|
| `Organization` | 组织 / 主体 | `organization:<归一化名称>` |
| `Person` | 人员 | `person:<归一化姓名>@<所属组织 identity>` |
| `Identity` | 邮箱 / 账号 | `identity:email:<小写地址>` 或 `identity:account:<组织>:<账号>` |
| `Contact` | 手机号 / 联系方式 | `contact:phone:<归一化号码>` |

新增边类型：

| 边 | 语义 |
|---|---|
| `member_of` | Person → Organization |
| `owns` | Organization → Host（主体持有域名/网段） |
| `uses_identity` | Person → Identity |
| `reachable_at` | Person → Contact |
| `mentions` | 任意 → 任意（文档/页面提及某实体） |

**为什么账号不复用 `Credential`**：`Credential` 的 identity 是 `credential:<kind>:<host>:<username>`（`src/operation-identity.ts:101-105`），需要 host 且语义是**已验证的口令对**。OSINT 阶段的邮箱/账号既没有 host 也未必有效。混用会让「未验证线索」在图上长得像「已确认凭据」——正是本方案要避免的那类失真。

**Person 的 identity 含组织**：同名不同组织必须是两个实体，否则跨 runtime 合并会把两个不同的人粘成一个。

### 4.2 确定性投影，不走 LLM Projector

新建 `src/osint/osint-topology.ts`，镜像 `src/fofa/fofa-topology.ts` 的结构：输入 findings + evidenceRef，输出 `{nodes, edges}`，全部经 `stableOperationIdentityId`。

**为什么确定性优于 LLM 投影**：findings 本身已是结构化的（`osint_search` 给出 engine / url / provenance / relevance）。让 Projector 做会丢字段、不稳定、不可测，而 `fofa-topology.ts` 已经确立了「结构化侦察数据用确定性函数入图」的范式。这条与既有选择一致，不是新发明。

投影函数是纯函数，因此可以直接用 fixture 测——包括「同一 finding 投影两次得到同一节点 ID」这种跨 runtime 收敛的关键性质。

### 4.3 同一 runtime 内的长期记忆

`state.sqlite` 本来就跨 Task epoch 持久，Planner 本来就能读图。**缺的只是 OSINT 实体进图这条路**，以及对应的节点类型。

**落图时机：Task 提交时**，而不是每次 `osint_search` 调用。理由：一条 finding 只有进了 TaskOutcome 才算结论；把每轮搜索的中间线索都写进长期记忆，会让图被半成品污染，而 Planner 之后无法区分「确认过」和「搜到过」。

**投影的上限是安全阀，不是常规限流**：默认 `DEFAULT_OSINT_MAX_NODES = 2000`。图本身没有任何裁剪机制，所以必须有个东西阻止单个 Task 写入无界节点；但一个真实护网目标的产出（域名、服务、邮箱、人员、联系方式）能装得下。

**淘汰按优先级，不是先到先得**：额度触顶时按 `host/ip (7) > service (6) > org (5) > email/account (4) > document (3) > person (2) > phone (1)` 排序，同优先级再看 provenance 条数（多源印证优先），最后按 id 保证确定性。被淘汰节点的边一并丢弃。

> 早期实现是构建过程中内联截断，等于让 findings 数组顺序决定取舍 —— 一个电话号排在前的批次可能丢掉全部域名。这是必须避免的失败模式。

**为什么不必把上限压小**：Planner 的有界读取由**局部遍历**保障，而不是靠缩小记忆（见 §4.5）。此外 OSINT 节点在 `scoreDecisionImpact` 里权重很低（Identity/Organization 2、Person/Contact 1，对比 Vulnerability 10、Credential 9、Host 4），所以它们排在决策视图最后，挤不掉真实发现。

**隐私**：`personalDataPolicy`（OSINT Agent 的既有选项）决定 Person / Contact / Identity 落图的内容。默认 `masked-30d` 下**只落脱敏标签 + 加盐假名（`pd:<sha256[0:20]>`）**，原值留 artifact。

> 为什么 identity 不能用脱敏标签：`张*` 对张三和张四是一样的，用它做键会把两个人静默合并成一个节点。假名保证「同一个人在不同 runtime 收敛到同一节点」而图里不出现原值。**代价**：手机号这类短值可被暴力枚举反推，盐不是保密机制。

### 4.5 检索：局部遍历，不靠压小存储

图变大之后，瓶颈不在 Planner 读那一侧，在**上下文装配侧**。`projectionClosure` 与 `searchSemanticNodes` 原本各有一处 `readNodes({ graphKind, limit: 1_000_000 })`，把全部 operation + reasoning 节点 `JSON.parse` 进内存；而 `projectionClosure` 的调用点是**每个 Executor turn**、每个投影 job、每次 Supervisor 检查。

已改为：

| 改动 | 位置 | 效果 |
|---|---|---|
| 按 id 懒加载 + 分批（每批 400） | `projectionClosure` | 遍历多少加载多少，不再全量 |
| `semanticNodeIdsByTokens` SQL 预筛 | `projectionClosure` 锚点路径、`searchSemanticNodes` | 只 hydrate 命中行；谓词与排序仍是原 JS 实现，结果等价 |
| `semanticNodeIdsByEvidenceRefs` SQL 预筛 | `projectionClosure` provenance 路径 | 同上；模式带引号，`event:ab` 不会误配 `event:abc` |
| 新增 `(graph_kind, updated_at DESC)` 索引 | `graph-store` 初始化 | `readNodes` 的 `ORDER BY updated_at DESC` 从全量排序变索引扫描 |
| `searchSemanticNodes` 页上限 50 → 200 | 存储层 + 工具 schema | 存储层无游标，超过上限的匹配此前只能报 `omitted` 且**永远取不到** |

LIKE 元字符做了转义（`escapeLikePattern` + `ESCAPE '\'`），否则查询里的 `%` 会匹配全表。

**Planner 拿到了 `graph_search`**（此前是 Projector 专用）。局部遍历需要一个起点，而在此之前 Planner 只能靠 TaskOutcome 恰好写出的引用 —— 摘要没写 id 时，已采集的情报就不可达。工具描述明确约束用途：找到节点后用 `graph_query focusNodeIds` 读周边，不要用它普查全图或重推 TaskOutcome 已有的事实。

### 4.4 跨 runtime 迁移

三个动作。

#### 导出

读 runtime A 的 `state.sqlite`，按选择条件取出节点及其内部边，产出可移植 JSON：

```jsonc
{
  "schema": "luanniao.graph-memory/1",
  "sourceRuntime": "2026-09-17T03-14-22-ab12cd34",
  "exportedAt": "2026-09-17T06:20:00Z",
  "selection": { "types": ["Host", "Organization", "Person", "Identity", "Contact"] },
  "nodes": [
    { "id": "op:9f2c...", "type": "Host", "label": "example.com",
      "properties": { /* 原样，去掉 runtime 局部字段 */ },
      "provenance": { "runtime": "2026-09-17T...-ab12cd34", "evidenceRef": "event:8a1f..." } }
  ],
  "edges": [ { "from": "op:9f2c...", "to": "op:41ab...", "type": "owns" } ]
}
```

**明确不导出**：

| 不导出 | 理由 |
|---|---|
| `evidenceRefs` 原值 | runtime 局部 UUID（§3.3）；改写进 `provenance`，保留「来自哪个 runtime 的哪条证据」这一可追溯性，但不假装它能被解析 |
| reasoning 节点（Evidence/Hypothesis/Vulnerability/Exploit） | 推理状态是特定调查过程的产物，脱离上下文无意义 |
| task 节点（Goal/Task/Milestone/Blocker/Scope） | runtime 局部规划状态，导入会造成两个 Goal 冲突 |
| `Credential` / `*Session` | 属凭据与连接状态，跨 runtime 搬运是另一个安全问题，不在本方案 |

#### 导入

把 nodes/edges 作为 `GraphDelta`（`graphKind: "operation"`）喂给 B 的 `upsertDelta`。

**关键机制修正**：`upsertDelta` **不做身份重映射**。`rebaseProjectionDeltaInTransaction`（`src/stores/graph-store.ts:268-373`）只在 `commitProjection` 内运行（`:197`）。因此合并**不能依赖存储层**，必须在投影时就算出规范 ID——这正是 §4.2 要求确定性投影的原因，也是 `fofa-topology.ts:23` 直接调用 `stableOperationIdentityId` 的原因。

一旦 ID 已是 `op:<sha256>` 规范形式，`applyDeltaInTransaction`（`:415-535`）的 `INSERT ... ON CONFLICT(id) DO UPDATE` 就自然完成合并：属性浅合并（`:438-440`），`evidenceRefs` 并集去重（`:441-444`）。**重复导入因此幂等**。

每个导入节点附加：

```jsonc
{ "origin": "imported", "importedAt": "...", "sourceRuntime": "...",
  "validationStatus": "pending" }
```

#### 门控（三条，缺一不可）

1. **scope 复验**：Host / Port / Service / WebEndpoint 每一类，用 B 的 `parseAuthorizedScope` 复验。scope 外**降级为待确认线索**：`classification: "candidate_only"` + `active_testing_allowed: false` + `validationStatus: "pending"`，沿用 `fofa-topology.ts:24-25` 的既有语义。scope 测试缺失或抛错时按越界处理（fail-closed）。
2. **信任标记**：`validationStatus` 一律为 `pending`——公开情报从未在目标上本地验证过，即便在 scope 内也不得标 `validated`。
3. **能力门槛**：导出用 `admin:export`（**该能力已声明、已授予 admin，但零个路由消费**，`src/web-security.ts:19,33`——平台预留的空钩子，无需改能力模型）；导入同样 `admin:export`——跨授权边界的数据移动属管理动作。

#### 绝对不可做的事

**绝不整文件复制 `state.sqlite`。** 它是多子系统共享库（`src/controller.ts:586-593`）：除图之外还有 `credential_index` / `credential_access_log`（凭据）、`execution_events`（完整执行历史）、`executor_sessions` / `epoch_budgets`（预算）、`fofa_task_quotas`（配额），以及被 GraphStore 与 RuntimeStore **双方拥有**的 `projection_states`（ `graph-store.ts:1713` 与 `runtime-store.ts:620` 重复 DDL）。复制它等于复制整个 runtime。

**绝不导入 task 节点。** `goal:root` 与 `scope:root` 是硬编码单例（`src/controller.ts:1588-1590`），节点 ID 是全局主键而非 runtime 作用域内。一次天真导入会 `UPSERT` 覆盖目标 runtime 的 Root Goal 与**授权 scope 本身**——这比「把越界主机喂给 Planner」严重一个量级。§4.4 的导出白名单按构造排除了这一类。

**读外部 runtime 必须 `{readOnly: true}`。** `src/web-server.ts` 目前在 `:2265`、`:2745`、`:2835` 以读写方式打开外部 runtime 的 `state.sqlite`；因为库是 WAL 模式，**纯读取也会在别人的目录里创建/刷新 `-wal` / `-shm`**。导出路径不得沿用这个模式。

#### 可复用的既有资产

| 资产 | 位置 | 用途 |
|---|---|---|
| `RuntimePathPolicy.resolveRuntime(input, "existing")` | `src/runtime-path-policy.ts:39-58` | 跨 runtime 路径解析，已做符号链接加固，`runtime_path_outside_root` → 403 已接线 |
| `discoverRuntimeSessionDirs(rootDir)` | `src/runtime-session-discovery.ts:13-50` | 枚举可迁移的 runtime（深度 ≤4，≤5000 目录） |
| `HistoricalConnectivityRuntimeRegistry` | `src/connectivity/connectivity-runtime-registry.ts:91-103` | 外部 runtime 惰性 attach 的既有范式（owner lease + 120s 空闲关闭） |

#### 后台接口

| 端点 | 能力 | 说明 |
|---|---|---|
| `GET /api/graph/memory?runId=` | `admin:export` | 列出某 runtime 可导出的记忆集（按类型计数） |
| `POST /api/graph/memory/export` | `admin:export` | 产出 bundle |
| `POST /api/graph/memory/import` | `admin:export` | `dryRun: true` 返回报告；否则执行 |

**Dry-run 优先**：导入是不可逆的图变更，必须先给出「新增 N / 归并 M / scope 外降级 K / 上限截断 C」的报告，操作员确认后再执行。

UI 侧新增 Memory 面板：左侧列各 runtime 的记忆集，右侧预览与导入。

---

## 5. 需要改动的文件

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `OperationNodeType` 增加 4 种；`EdgeType` 增加 5 种 |
| `src/projection.ts` | `PROJECTION_OPERATION_NODE_TYPES`、`PROJECTION_EDGE_TYPES` 同步 |
| `src/operation-identity.ts` | `directOperationIdentityKey` 增加 4 种新类型的 identity 计算 |
| `src/osint/osint-topology.ts` | **新增**，确定性投影（镜像 `fofa-topology.ts`） |
| `src/stores/graph-memory-transfer.ts` | **新增**，导出/导入/dry-run |
| `src/web-server.ts` | 3 个新端点 |
| `src/web-security.ts` | 导入端点的能力校验 |
| `web/src/components/MemoryPanel.tsx` | **新增**，后台面板 |
| `src/prompts.ts` | Planner 提示词：导入节点的可信度语义 |

**导出侧可能不需要改 graph-store**：现有只读原语已能枚举节点——`nodeIdsWithPrefix("op:", limit)`（`src/stores/graph-store.ts:954`，对 `nodes.id` 做前缀扫描，而全部 operation 节点都是 `op:` 前缀）配合 `query("operation", focusNodeIds, limit)`（`:583`）即可取出节点与其邻边。唯一缺口是 `nodeIdsWithPrefix` 只有 `LIMIT` 没有游标，超大图需要加一个带 offset 的枚举方法；在现实规模下用一个足够大的 limit 即可。写入侧 `upsertDelta(delta)`（`:153`）已公开。

**风险点**：`PROJECTION_ALL_NODE_TYPES` 是闭集，被 Projector 工具 schema、`graph_query` 视图渲染、前端图渲染、边优先级排序（`src/stores/graph-store.ts:1900-1917`）共同消费。扩词表要四处同步，漏一处会出现「节点存在但渲染不出来」。

---

## 6. 已决策

| 问题 | 决策 |
|---|---|
| 是否扩词表 | **接受**，4 种节点 + 5 种边 |
| scope 外节点 | **降级为待确认线索**（`candidate_only` + `active_testing_allowed: false`） |
| 起点 | 先做 G1+G2（已完成） |

## 7. 待确认

1. **个人信息落图的形式**（G2 已按安全默认实现，需要你确认）。当前做法是：图里只存**脱敏标签** + **加盐假名**（`pd:<sha256[0:20]>`）作为 identity，原值只留在 artifact。
   
   为什么不能只用脱敏值做 identity：`张*` 对张三和张四是一样的，用它做键会把两个人静默合并成一个节点。假名保证「同一个人在不同 runtime 收敛到同一节点」而图里不出现原值。**代价**：手机号这类短值可被暴力枚举反推，盐不是保密机制。若你认为不该有原值残留风险，可改为 `personalDataPolicy=off` 时完全不建 Person/Contact/Identity 节点。
2. **迁移粒度**：按类型选 / 按显式命名的「记忆集」/ 全选。倾向前两者，全选容易把无关内容搬进新任务。
3. **是否需要「记忆集」概念**（操作员给一批记忆命名、备注、复用），还是每次临时勾选。

---

## 8. 分期

| 阶段 | 内容 | 状态 |
|---|---|---|
| **G1** | 词表扩展 + identity 计算 + 9 处同步 + 测试 | ✅ **已完成**（8 项 identity 测试） |
| **G2** | `osint-topology.ts` 确定性投影 + 测试 | ✅ **已完成**（23 项投影测试） |
| **G2.5** | 检索与性能：热路径去全表扫描 + 索引 + Planner `graph_search` | ✅ **已完成**（见 §4.5） |
| **G3** | 落图通路：`osint_memory_write` 工具 + 运行时绑定 | ✅ **已完成**（见 §4.6） |
| **G3.5** | 图记忆可视化（后台 Memory 视图） | ✅ **已完成**（见 §4.7） |
| **G4** | 导出/导入 + dry-run + scope 复验 + 幂等测试 | 待开始 |
| **G5** | 后台 3 个端点 + 能力校验 + Memory 面板的导入入口 | 待开始 |
| **G6** | Planner 提示词：导入节点的可信度语义 | 待开始 |

### 4.6 落图通路（G3）

落图**不是**控制器在 Task 提交时隐式做的，而是一个显式工具 `osint_memory_write`，由 Agent 在每轮搜集结束时调用。

为什么不用控制器钩子：控制器在 `src/controller.ts:2868` 调的 `updateTaskResult` 是个**空操作**（返回空 delta）。要在那里接 OSINT 投影，就得让核心循环认识某一个 Specialist 的产物格式。显式工具把这件事留在能力面内，且可独立测试。

工具在运行时绑定（`createTaskRuntimeToolBindings`，与 `validate_candidate_asset` 同构），因为图存储与**当前**授权 scope 只有运行时才知道。每次调用重新解析 scope，因为它可能在 Task 之间变化；解析失败按"什么都不在范围内"处理（fail-closed）。

写之前先向执行日志追加一条 `osint_memory_written` 事件，节点的 `evidenceRefs` 指向它 —— 这样 Planner 能用 `evidence_read` 解析出处，而不是拿到一个悬空引用。

### 4.7 图记忆可视化（G3.5）

后台新增「图记忆」视图（`web/src/components/MemoryView.tsx`），与三个图视图并列。

**识别方式是按 `properties.origin`，不是按节点类型**：投影给每个写出的节点打 `origin: "osint"`，运行时自己在目标上观察到的节点没有这个标记。按类型筛选会把目标侧发现显示成"从公开互联网搜集来的"。

视图提供：
- 汇总条：总数、三档置信度计数、按类型的分布、贡献来源（来自 provenance）、脱敏条数
- scope 外线索的显式告警（这些节点是 `candidate_only` + `active_testing_allowed: false`，只作线索）
- 图谱/清单双模式；清单列出实体、类型、置信度、来源与标记（脱敏/线索/外部导入）
- 类型与置信度筛选，图谱与清单**同时**受限，且跨越被过滤节点的边会被丢弃

接入一个视图在这个代码库要改 6 处（`ViewKey`、Sidebar、主分发、Inspector、标题助手、URL 白名单）。**主分发的 `else` 分支就是 GraphView**，所以新分支必须写在它之前，否则会静默渲染成一张 kind 错误的图。

G1–G3 是「长期记忆」，G4–G6 是「跨 runtime 迁移」。两者可分开验收。

### G1+G2 交付物

| 文件 | 说明 |
|---|---|
| `src/types.ts` | `OperationNodeType` +4、`EdgeType` +5 |
| `src/projection.ts` | `PROJECTION_OPERATION_NODE_TYPES` / `PROJECTION_EDGE_TYPES` 同步 |
| `src/operation-identity.ts` | 4 种新类型的 identity；新增 `normalizedEntityName` / `normalizedEmail` / `normalizedPhone` |
| `src/osint/osint-topology.ts` | **新增**，确定性投影 + 脱敏 + 假名 + scope 降级 + 节点上限 |
| `src/stores/graph-store.ts` | `expectedGraphKindForNodeType`、边优先级、`DIGEST_PROPERTY_ALLOWLIST`、`scoreDecisionImpact` |
| `src/controller.ts` | `compactNodeProperties` 新类型键 |
| `src/prompts.ts` | Projector 的节点/边词表与语义（含「公开情报实体 ≠ 凭据」） |
| `web/src/graph.ts` | 4 种新类型的配色 |
| `test/operation-identity.test.ts` | +6 项（含跨 runtime 收敛断言） |
| `test/osint-topology.test.ts` | **新增**，20 项 |

**9 处同步点**（其中 3 处是同一列表的硬编码副本，漏改会抛 `GraphValidationError`）：`types.ts` 两个联合、`projection.ts` 两个常量、`graph-store.ts:1988` 字面量数组、`graph-store.ts:1898` 边优先级、`graph-store.ts:2206` 决策权重、`controller.ts:7630` 属性白名单、`web/src/graph.ts:36` 配色、`prompts.ts:172` 提示词。
