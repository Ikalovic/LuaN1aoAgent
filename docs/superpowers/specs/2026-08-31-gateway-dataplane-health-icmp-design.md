# Gateway 数据面健康与 ICMP 支持设计

## 目标

修复 Docker Executor 对授权目标的 TCP 主动探测无法进入 Gateway/TUN、从而把基础设施故障误报为目标端口 `filtered` 的问题；同时为未配置 SOCKS5 代理的任务增加受控 ICMP Echo 支持。

## 已确认的问题

- Executor 的默认路由指向任务 Gateway，但故障会话的网络遥测只有到 Gateway DNS 的 UDP 流量，没有到授权目标的 TCP 流量。
- 同期宿主机与 Runtime 回调工具可访问目标，证明目标本身不是“全部端口 filtered”。
- Executor 使用范围外的百度等地址做正对照，这些地址会被 Scope Guard 按设计拒绝，不能用于判断外网是否正常。
- Gateway 当前不转发 ICMP，`ping` 超时不能作为主机离线证据。
- 任务达到轮次预算后会提交阶段性 `partial`，但当前结果文本没有可靠区分目标无响应与基础设施失败。

## 方案

### 1. 修复 TCP 数据面

保留现有路径：

```text
Executor -> task bridge -> Gateway policy routing -> TUN/gVisor
         -> HostEgressBroker 或已配置的 SOCKS5 Route -> 授权目标
```

通过集成测试复现“Executor 发起 TCP connect，但 Gateway 没有目标 TCP 记录”，逐层验证：Executor 默认路由、Gateway mangle mark、策略路由、TUN 入包、gVisor Forwarder、HostEgressBroker 拨号。修复必须落在第一个丢失流量的边界，不能用宿主网络或放宽 Scope 绕过 Gateway。

### 2. 数据面自检与故障分类

Gateway 就绪检查从“进程和 ready 文件存在”提升为两层：

- 控制面健康：Gateway 控制 socket、DNS、TUN/gVisor 和 HostEgressBroker 可用。
- 任务数据面健康：使用 Runtime 管理的一次性授权范围内 TCP 探针，确认 Executor 网络发出的连接确实到达 Gateway。探针不得访问范围外公网地址，也不得要求目标端口必须开放；是否到达数据面与目标最终响应分开判断。

Runtime 使用结构化状态：

- `healthy`：请求进入 Gateway，出口组件工作正常。
- `scope_blocked`：目标不在授权范围。
- `gateway_unreachable`：Executor 无法把请求交给 Gateway。
- `broker_unreachable`：Gateway 无法连接 HostEgressBroker 或代理 Route。
- `target_timeout`：数据面健康，但目标未响应。
- `icmp_proxy_unsupported`：启用 SOCKS5 时请求 ICMP。

数据面不健康时，Runtime 应产生基础设施事件并阻止该批扫描结果被解释为目标状态。

### 3. TaskOutcome 证据约束

Executor 环境事实与提示词增加以下规则：

- 禁止使用授权范围外地址作为网络正对照。
- `nmap filtered/no-response` 只有在同期数据面状态为 `healthy` 时才能作为目标证据。
- 数据面状态不是 `healthy` 时，扫描结论必须标记为 `inconclusive/infrastructure_failure`。
- ICMP 无响应只代表 ICMP 没有响应，不能推出主机离线。
- Gateway 地址的 80/443 没有监听服务是正常现象，不能用于判断透明转发是否健康。

Runtime 在 Task prompt 中提供已核实的网络能力状态，避免模型自行猜测透明代理实现。

### 4. ICMP Echo

只在没有配置 SOCKS5 `--proxy` 时支持 ICMP Echo：

- 仅允许 IPv4 Echo Request/Echo Reply，不开放任意 ICMP 或原始数据包。
- 目标必须命中现有授权 CIDR；域名目标必须先由受控 DNS 解析并命中动态授权集合。
- 每 Task 和每目标限速，防止洪泛。
- 记录请求、响应、超时和 Scope 拒绝遥测，但不持久化无关包体。
- ICMP 由 Gateway 的受控组件处理；Executor 保持无 capability、无 raw socket 权限扩张。
- 配置 SOCKS5 时立即返回 `icmp_proxy_unsupported`，不得绕过代理直连。

由于常规 `ping` 需要 raw socket，而 Executor 明确无 capability，Runtime 应提供受控 ICMP 工具或由 Gateway 接管受限 Echo 请求；不向 Executor 添加 `CAP_NET_RAW`。

## 安全边界

- 不改变既有授权范围语义，不允许健康检查扩大 Scope。
- 不使用 `--network host`，不让 Executor 绕过 Gateway。
- 不把 HostEgressBroker 端口、令牌或代理凭据暴露给模型或 Executor。
- 数据面错误默认失败关闭；仅目标级超时可以继续作为弱证据。
- ICMP 不支持 SOCKS5 时必须显式失败，不能静默走宿主直连。

## 兼容性

- 未使用 ICMP 的现有 Task 行为保持兼容。
- 非 Docker sandbox 不依赖 Gateway，继续使用其现有网络边界，但采用相同的证据分类规则。
- FOFA MCP、Runtime `validate_candidate_asset` 和 `web_fetch` 保持独立能力；它们的成功不能自动证明 Executor 数据面健康。

## 测试与验收

### 自动测试

- 授权目标 TCP 请求从 Executor 到达 Gateway/TUN，并由 HostEgressBroker拨号。
- 范围外 TCP 请求被归类为 `scope_blocked`。
- 停止 Gateway、HostEgressBroker 时分别产生 `gateway_unreachable`、`broker_unreachable`。
- 数据面故障下的 `filtered/timeout` 不得投影成目标端口状态。
- 未配置代理时，授权 CIDR 的 ICMP Echo 可成功或明确返回目标无响应。
- 范围外 ICMP 被拒绝；配置 SOCKS5 时返回 `icmp_proxy_unsupported`。
- ICMP 限速和遥测符合预期。

### 实机验收

以授权目标 `110.42.96.9/32` 启动新 Task：

1. Executor 的 TCP connect/nmap `-sT` 对 80、443、9090 产生目标 TCP 遥测。
2. 80、443、9090 的结果与宿主机/Runtime 校验一致，不再全部显示 `filtered`。
3. 对范围外地址的请求明确显示策略拒绝，不显示“外网不可达”。
4. 未配置 SOCKS5 时可执行受控 ICMP Echo；配置 SOCKS5 时明确提示不支持。
5. 人为停止 HostEgressBroker 后，TaskOutcome 标记基础设施失败而不是目标端口 filtered。

## 非目标

- 不通过 SOCKS5 隧道模拟 ICMP。
- 不开放任意 raw socket、UDP 或 ICMP 类型。
- 不因为本次修复改变 FOFA 查询、拓扑发现或授权扩展规则。
- 不把目标端口开放作为 Gateway 启动的硬性前提。
