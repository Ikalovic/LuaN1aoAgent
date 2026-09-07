# Runtime 所有权与 Docker 清理隔离修复设计

## 背景

活跃的 Connectivity Runtime 会在运行目录中保存所有权 lease，并用该 lease 阻止其他进程清理其 Docker 容器和网络。当前实现为本进程和外部进程生成了不同格式的进程启动身份：本进程使用 Node `performance.timeOrigin`，外部进程在 Linux 上使用 `/proc/<pid>/stat` 的启动 ticks。因此，另一个 Web 或测试进程会把仍然存活的所有者误判为陈旧进程，抢占 lease，并由孤儿资源清理器删除活跃任务的 Docker 网络。

此外，Web 和 Agent Runtime 启动清理器时把项目工作目录作为清理根目录。这会让一个使用临时 runtime 目录启动的测试 Web 进程扫描项目下其他会话的资源，扩大了清理影响范围。

## 目标

- 活跃 Runtime 的 lease 能被其他进程稳定识别，不会被错误抢占。
- Web、测试进程和单次 Agent Runtime 只能清理其明确管理范围内的 Docker 资源。
- 保留陈旧 lease 回收与孤儿 Docker 资源清理能力。
- 不改变 Task、Planner、Gateway、授权 Scope 或网络路由语义。

## 设计

### 统一进程启动身份

`ConnectivityRuntimeOwnerLease` 不再为当前 Node 进程使用单独的 `performance.timeOrigin` 格式。

- Linux：所有 PID（包括当前进程）均读取 `/proc/<pid>/stat`，使用进程启动 ticks 生成 `linux:<pid>:<startTicks>`。
- 非 Linux：所有 PID 均通过 `ps -o lstart=` 读取启动时间，生成 `<platform>:<pid>:<startedAt>`。
- 无法读取启动身份时沿用现有降级规则，仅依赖 PID 存活和 heartbeat，不把读取失败当成 lease 陈旧。

这样，lease 写入者与外部检查者对同一进程得到完全相同的身份。

### 收窄 Docker 清理范围

清理器本身继续只处理 `roots` 内、且带有 LuaN1ao 托管标签的资源；调用方不再传入宽泛的项目工作目录。

- Web Server 启动：只传入 `runtimePathPolicy.rootDir`。默认情况下仍可清理 `.agent-runtime` 下的陈旧会话，但临时测试 Web 不会扫描项目目录。
- 单次 Agent Runtime 启动：只传入当前 `input.runtimeDir`，避免一个新任务清理其他会话。

清理器仍会先尝试获取目标 runtime 的 lease。活跃 lease 会使该 runtime 被跳过；只有无所有者或陈旧所有者的资源才会删除。

## 数据流

1. Runtime 获取 lease，写入统一格式的 PID 启动身份。
2. 另一个进程启动清理器，只枚举明确 cleanup root 内的托管资源。
3. 清理器检查每个资源对应 runtime 的 lease。
4. 活跃所有者的 PID、heartbeat 和启动身份匹配，资源被跳过。
5. 无所有者或已确认陈旧的 runtime 才允许清理容器和网络。

## 错误处理

- `/proc` 或 `ps` 临时读取失败时，不推断 PID 已复用；保持现有保守行为。
- Docker inspect 或 remove 失败继续记录在清理结果中，不影响无关 runtime。
- 不通过放宽文件权限或禁用清理器规避问题。

## 测试

- 父进程获取 lease，独立 Node 子进程执行 `inspect`，必须识别父进程为 active。
- 独立竞争者不能从活跃父进程抢走 lease。
- 清理范围测试证明显式 root 之外的资源不会进入删除操作。
- Agent Runtime bootstrap 测试验证调用方不再把 `cwd` 作为清理根。
- 运行 TypeScript 构建、相关 Node 测试、完整测试和 Docker 数据面 smoke test。

## 非目标

- 不重构 Planner 对 blocked Task 的恢复机制。
- 不改变 Docker 网络命名或 Gateway 生命周期。
- 不引入全局锁、中心化资源注册服务或新的持久化表。
