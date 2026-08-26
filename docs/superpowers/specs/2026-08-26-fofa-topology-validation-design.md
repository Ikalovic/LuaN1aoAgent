# FOFA 候选资产验证与作战图更新设计

## 目标

在现有 Operation Graph 基础上，将 FOFA 发现的子站、旁站、CNAME、证书关联主机和端口服务纳入统一拓扑，并通过低风险验证更新其状态。候选资产不得自动扩大授权范围或直接进入漏洞利用流程。

## 数据流

```text
FOFA MCP search/search_next
        ↓
Observer 解析 Artifact/工具事件
        ↓
candidate Host/WebEndpoint/Port/Service 节点
        ↓
Planner 创建资产验证 Task
        ↓
Executor 执行 DNS、HTTP、TLS/SAN、CNAME、重定向验证
        ↓
Observer 提交带 evidenceRefs 的 graph_delta
        ↓
GraphStore 合并并更新 Operation Graph
```

## 节点与关系

候选节点使用现有 operation graph 类型：`Host`、`Port`、`Service`、`WebEndpoint`。节点属性增加：

- `source=fofa`
- `classification=candidate_only|in_scope`
- `validationStatus=pending|validated|rejected`
- `validationSignals`（dns/http/tls/cname/redirect）
- `active_testing_allowed=false`（候选资产始终为 false）

新增关系类型：

- `discovered_by`：资产由 FOFA 发现
- `candidate_for`：候选资产关联授权主目标
- `resolves_to`：域名解析到 IP
- `has_alias`：旁站、别名或 CNAME 关系
- `validated_by`：资产由验证证据确认

已有关系 `has_port`、`runs_service`、`exposes_endpoint` 继续用于端口、服务和 Web 端点层级。

## 验证边界

自动验证仅允许：DNS 解析、HTTP HEAD/GET、TLS 证书/SAN 读取、CNAME 查询和重定向关联。验证请求仍受原始运行网络边界控制，不执行漏洞扫描、目录枚举、登录尝试或利用。

验证成功只将 `validationStatus` 更新为 `validated` 并补充证据，不改变 `active_testing_allowed=false`，不修改授权 Scope。验证失败更新为 `rejected` 或保留 `pending`，并记录失败证据和适用条件。

## 自动化触发

FOFA 运行成功后，系统自动把候选记录作为 Planner 可见的拓扑事实。Planner 对尚未验证的候选节点创建验证 Task；同一候选节点使用稳定 Operation Identity 去重，不重复创建验证任务。Executor 完成验证后提交 TaskOutcome，Observer 使用真实事件和 Artifact 引用更新图。

如果没有 FOFA 配置、查询失败、结果为空或运行是无公网资产的 CTF，流程跳过，不阻塞其他任务。

## 安全与审计

- 每个候选节点、关系和验证结论必须携带 FOFA Artifact 或验证事件的 `evidenceRefs`。
- FOFA 结果中的旁站不自动转化为授权目标。
- 图查询、候选升级和验证任务创建均保留原始来源引用。
- 节点合并使用现有 `operation-identity.ts`，避免同一主机被 FOFA、nmap、httpx 重复建点。

## 测试

1. FOFA 记录映射为候选 Host/Port/Service/WebEndpoint。
2. 子站、旁站、CNAME 和证书关联关系生成正确。
3. 验证 Task 只执行低风险验证并保留证据。
4. 验证成功/失败更新状态但不扩大 Scope。
5. 重复 FOFA 与后续模块结果能合并到同一稳定节点。
6. FOFA 不可用、空结果和 CTF 场景不阻塞主流程。
