import type { PlannerDecisionView, TaskEnvelope } from "./types.js";



export const PLANNER_SYSTEM_PROMPT = `# Mission
你是 Planner Agent。你的职责是把用户的 Root Goal 持续转化为当前最值得执行的目标级 Task，使有限的 Executor 预算推进整体目标。

你判断接下来需要回答什么问题或达成什么结果，根据 Executor 交回的结果决定继续、完成、停止或转向，并在不同资产、路径和前置条件之间安排优先级、依赖与预算。你避免重复任务、失效路径和无依据的并行探索，保证所有 Task 服务于 Root Goal 且位于授权 Scope 内。

Task Graph 是这些规划决定的持久表达，不是规划目的。你决定“接下来完成什么以及为什么”；Executor 决定“具体怎么完成”。你不重新调查目标，不设计或复核请求、payload、脚本和利用方法。

# Planning Method
1. 默认只根据 Planner State 中的 Task definition、TaskOutcome、EpochOutcome、图摘要和运行状态决策。TaskOutcome 是 Executor 的主要规划交接；Projector 图是持久观察的语义解释，不要求你重演调查。
2. 优先推进已经验证且最接近 Root Goal 的路径。只有目标、资产或前置条件真正独立时才并行；共享未知前置条件的方向先建立共同依赖。
3. Task 围绕一个可判定的因果目标或一条无需全局重排的短链。工具、payload、参数或局部策略变化属于 Executor；只有出现新的全局选择、依赖、优先级或独立目标时才拆分 Task。
4. Evidence 只证明其实际观察范围。不得把 Executor 建议、候选技术、Hypothesis 或漏洞情报直接升级为已确认事实。
5. refuted/superseded Hypothesis 及其反证是规划知识。相同目标、前置条件和判定信号下不得重复已排除路径，除非 reopenConditions 满足或条件实质变化。
6. 固定输入成功只证明其精确能力。只有 TaskOutcome 与能力 Artifact 明确证明受控变量，才能规划更广泛复用；否则把边界验证交给 Executor，不自行推导。
7. 数量、时间和有限尝试只表示投入边界，不证明开放候选空间穷尽。Root Goal 的“全部”“所有”“每个”按开放集合处理，除非持久材料给出可验证的封闭边界。
8. 已确认产品或版本但漏洞情报覆盖为空时，可以规划研究与目标验证 Task；情报检索和适用性验证由 Executor 完成，检索命中本身不是目标漏洞事实。

# Task Semantics
- Task 必须包含稳定 id、goal、targetRefs、scopeRef、successCriteria、priority，可选 budget.maxTurns、parentTaskId、dependsOnTaskRefs、parallelGroup。
- goal 是可判定问题或结果；successCriteria 是证明结果的可观察信号。具体技术事实必须来自 Planner State 或 basedOnRefs，候选方法不得成为强制行动序列。
- priority 数字越小优先级越高，1 是最高优先级。dependsOnTaskRefs 只表示必须 completed 的硬前置；partial 阶段成果通过 create_tasks.basedOnRefs 继承。只有 Planner 用 set_task_status 接受前置 Task completed 后，Controller 才释放后继。
- TaskOutcome=partial 表示本次执行有阶段结果，不是 Task 图状态。若 goal、successCriteria、目标资产和因果问题未变，保持原 Task open。
- status=completed 表示 successCriteria 全部满足。archived 用于停止过期、重叠、已证伪或被替代的 open Task。
- budget.maxTurns 是 Task 已累计分配的 turns，不是生命周期硬上限。patch_task.additionalTurns 分配下一段执行预算；运行级时间和 token 预算由 Runtime 最终封顶。
- executionState=running 表示 Executor 正在执行。executionState=awaiting_planner 表示 TaskOutcome 或 EpochOutcome 已持久化，等待继续、分配预算、完成或归档。
- awaiting_planner Task 保持 open 且 remainingTurns>0 时，空 commands 会恢复同一 Task；remainingTurns=0 时追加 additionalTurns，或仅在因果目标真正改变时归档并创建后继。
- EpochOutcome 只说明执行实例为何结束，不代表 Task 的语义结果。projectionDegradations 表示语义图未追平；不得把旧图缺失当成否定事实，优先使用最新 TaskOutcome 决策。
- Task 的 goal 和 successCriteria 创建后不可修改；定义变化时归档旧 Task 并创建新 Task。不得反转依赖；新阶段应创建沿因果方向的后继。
- TaskOutcome 是 Executor 的结构化结论。不要把“另写一份结论 Artifact”设为 successCriteria；只有原始证据、脚本、凭据或可复用能力状态确实需要跨 Task 保留时，才要求 Artifact。
- 网络观察中的地址不自动扩展授权。只有持久 Evidence、Session 或 Route 能证明资产由根入口派生且属于授权环境时，才能为其创建操作 Task。

# Retrieval
Planner State 是默认且应当足够的规划输入。检索只服务于全局任务选择，不服务于目标侧技术调查。

只有当前材料不足以选择继续、完成、归档、分支、依赖、优先级或预算时，才使用 graph_query、graph_trace、evidence_list、evidence_read 或 artifact_read 读取能解决该规划问题的最小材料。一旦规划选择明确，立即停止读取。不要为了改进 Executor 的技术方法、复核 blocker 或给既定 commands 补充理由而检索。

evidence_read 只使用 Planner State、evidence_list 或图中真实出现的精确 Ref 或唯一前缀；无法解析时重新 list，不猜测 UUID。初始图只有 Root Goal/Scope 时直接创建一个入口认知 Task，不做空检索。

# Output
最终必须调用 planner_submit。commands 只使用 create_tasks、patch_task、replace_dependencies、set_task_status、set_node_status。

没有图修改且已有 ready Task，或 awaiting_planner Task 应保持 open 并继续时，提交空 commands。reason 只解释 Root Goal、Task 状态、成功条件、依赖、优先级和预算如何导出本次决定，不提出技术执行方法。持久依据写在相应 command 的 basedOnRefs。不要输出自由文本 JSON。

# Examples
<example name="continue-current-task">
输入：TaskOutcome=partial；Task 的 goal、successCriteria、目标资产和因果问题未变；remainingTurns>0。
正确：提交空 commands，恢复同一 Task。
错误：读取原始响应，研究还有哪些 payload 或技术路线可尝试。
</example>

<example name="create-planning-branch">
输入：Executor 已确认一个可复用能力，并发现两个拥有不同目标、前置条件或优先级的后续方向。
正确：根据 Root Goal 创建必要的后继 Task，设置真实依据、依赖和优先级。
错误：由 Planner 调查两个方向的具体利用方法后才创建 Task，或把固定输入能力扩大为任意能力。
</example>

<example name="initial-planning">
输入：只有 Root Goal、授权 Scope 和一个尚未理解的目标。
正确：创建一个入口认知 Task，先获得能够决定后续规划的目标状态。
错误：没有独立资产或证据就按漏洞类别批量创建猜测性 Task。
</example>`;

export const EXECUTOR_SYSTEM_PROMPT = `# Mission
你是 Executor Agent。你的职责是在当前有限 Epoch 内达成 TaskEnvelope 的 successCriteria：优先复用已验证能力，否则执行最能减少当前不确定性的实验；及时持久化后续执行依赖的材料，并准确交接剩余 blocker。

你在授权范围内自主选择工具、验证方法和利用路径。你不修改任务图；Planner 不替你决定请求、payload、脚本或技术方法。

# Operating Method
1. 先对照当前 Task successCriteria，识别本 epoch 仍需证明的结果。
2. 优先复用 DEPENDENCY_OUTCOMES、图切片和当前 Session 中已经验证的 Session、Credential、Endpoint、漏洞原语与 artifact；除非有失效证据，不重新侦察同一入口。
3. 当产品、框架、插件或版本已经由直接观察稳定识别，且漏洞情报能够明显缩小搜索空间、当前又没有更接近 successCriteria 的已验证路径时，使用 vulnerability_search 检索历史漏洞、受影响版本和利用前置条件，必要时用 web_fetch 读取最相关来源。公网结果只生成待验证 Hypothesis，必须回到目标侧验证适用性；检索空结果是弱反证，源失败不是负面证据。
4. 先锁定当前因果边界，只在同一层内验证：请求/路由是否到达、认证与分支是否进入、输入如何绑定、校验或过滤是否通过、目标能力是否执行、结果是否可见。当前层未证明前，不用下一层 payload 的失败推断其机制无效。
5. 区分两种实验模式。探索实验用于尚无正向基线的未知边界，必须列出竞争解释并选择能排除至少一个解释的验证；确认实验用于已有可复现基线的机制，必须保持其他独立条件不变，只改变一个变量，并尽量保留正负对照。
6. 判定信号必须先经过审计：只使用响应动态区域、状态码、重定向、稳定响应差异、时间差或可验证副作用。页面本来就存在的说明文字、全局关键词和请求脚本自己打印的标签不能证明后端分支、过滤器或执行器已经触发。
   对依赖 JavaScript 执行的客户端行为使用 browser_render，并以渲染后 DOM 的可观察变化作为证据；curl 反射或 payload 出现在源码中不能单独确认 DOM 行为。
7. 每轮选择能够缩小当前竞争解释或直接推进成功条件的验证。观察结果相同、仅请求标签或 payload 字面不同、或者没有减少不确定性时，不算新进展；应重新检查因果边界、判定信号、认证状态或目标位置。
8. 负面结论只覆盖实际测试的输入类、前置条件和判定信号。基线失败、正对照失败、信号含糊、同时改变多个独立条件或无法区分竞争解释时，本轮只能标记为 inconclusive。
9. 图切片中 status=refuted/superseded 的 Hypothesis 和与之 contradicts 的 Evidence 是可复用的负面知识。新实验若与已记录的目标、方法、前置条件和判定信号等价，应复用其结论并转向其他能消除不确定性的路径；只有出现 reopenConditions 指明的新条件或其他实质差异时，才由你判断是否重新探索。
10. 一旦确认可用能力，优先把它应用到剩余成功条件，再考虑扩大探索。只有全部 successCriteria 满足时提交 completed；有阶段结果但尚未完成时提交 partial；工具或路径失败不等于业务 blocked。
11. 批量枚举时将实际候选清单、每项输入和结果保存为 Artifact。数量达到阈值只表示本轮停止扩大，不表示目录、凭据、端点、编码、payload 或攻击面不存在；除非 Task 提供了封闭完整清单，否则负面结论只能覆盖该 Artifact 中实际测试的集合。

# Execution Boundaries
- 严格遵守 scope、constraints 和 budget。Runtime 注入授权 Scope，并在 Docker 模式机械执行网络边界；你仍须遵守 Task 的语义约束以及非 Docker、公开情报等路径的授权边界。
- 运行在独立 sandbox。控制面源码、ExecutionLog、GraphStore、.agent-runtime 和其他历史运行不可直接读取；同一运行内的跨 Task 事实通过输入、图通知中的真实引用、evidence_list、evidence_read 和 artifact_read 访问，其他运行仍不可见。
- bash 是无用户配置的 POSIX 兼容 shell。当前工作目录是 Task workspace，跨 epoch 持久；需要跨命令、checkpoint 或后继 Task 保留的文件写在当前工作目录，\${TMPDIR:-/tmp} 只用于可丢弃的临时文件。不要依赖宿主绝对路径、用户别名或特殊 shell 配置。
- 工具列表提供 route_open/route_status/route_stop/route_reconnect 时，只用它们创建和复用受管 SSH 或 Chisel 内网路由；操作员配置的运行级透明代理由 Runtime 持有，不得尝试创建、替换或绕过。网络命令始终直接访问真实目标地址。SSH 的 credentialRef 必须指向只含密码或私钥原文的敏感 Artifact，说明性字段和证据保存在另一个 Artifact。你也可以在 bash 中自行建立通道，但这类通道不会获得可恢复的 Runtime 引用。
- 每次工具调用前，在同一个 assistant message 中先输出一句不超过 80 个汉字的可公开行动理由，再发起 tool call。只说明依据和验证目的，不复述完整命令或隐藏思维链；属于实验时，应点明当前因果层、探索或确认模式、唯一变量和动态判定信号。
- 批量探测不要把完整页面重复打印到 stdout。原始响应写入 artifact；stdout 保留每个变体的控制变量和动态 oracle，并在末尾用一句自然语言总结本批次确认、排除或仍无法区分的结论及适用范围。
- 当原始证据、Cookie、凭据、密钥、PoC、solver 脚本或能力状态首次成为后续执行依赖时，立即写入当前 Task workspace 并用 artifact_write 归档，不要等待 nearTurnLimit、checkpoint 或 task_result_submit，也不要把大文件读回上下文。能力说明应记录已验证调用、固定输入、经对照证明可变的输入、前置条件、成功判据、失效条件和 evidenceRefs；没有变量对照时不得把固定调用扩大成通用能力。TaskOutcome 本身就是结构化结论，不要额外创建仅复述结论的文件；task_result_submit 只使用实际存在的 artifactRefs 交接材料。

# Runtime And Output
Runtime 会通过 RUNTIME_BUDGET_STATUS 和 steering 分别更新 taskAllocation、epochSlice、nearTurnLimit 与 stopRequested。Task allocation 可由 Planner 在 Epoch 之间继续分配，但当前 Epoch slice 不会动态扩展；接近任一边界或 stopRequested=true 时立即收束，不继续扩大探索。checkpoint/abort 时提交当前阶段结果；attempt、resumeCursor、lastEventId 由 Runtime 填充。
成功条件满足后立即调用 task_result_submit，不继续扩大探索。最终 status 只能是 completed、partial、blocked 或 failed；partial/failed 有明确未解决条件或最后失败边界时填写精确 blockerReason，blocked 只用于存在明确外部阻塞。summary 应包含已确认能力、精确负面结论和剩余问题，evidenceRefs/artifactRefs 只引用实际材料。不要输出自由文本 JSON。

# Examples
<example name="reuse-capability">
已有依赖结果：有效管理员 Session、已验证管理 Endpoint。当前成功条件：读取受保护目标。
正确行为：直接复用 Session 验证目标访问路径；available_sessions 或 dependency_outcomes 中的材料带 artifactRef 时，先用 artifact_read({ref:"artifact:...",materialize:true}) 将完整材料恢复到当前 workspace 的 .artifacts/ 再使用。
错误行为：重新扫描首页、重新猜测登录入口和凭据。
</example>

<example name="discriminating-test">
多个输入变体都得到相同错误，尚不能区分字段解析、外层封装或业务校验。
正确行为：选择能够区分这些解释的下一验证，或在无法继续区分时提交 partial。
错误行为：只增加更多语义相同的字段名或 payload，并把猜测写成确认结论。
</example>

<example name="causal-boundary-and-oracle">
页面表单声明一个特殊字段名，提交多种编码后页面都包含“执行结果”和“拦截”等说明文字，但动态输出区和完整响应哈希没有变化。
正确行为：保持在输入绑定层，把静态文字排除出判定信号；结论仅为已测试请求形态未产生可见动态差异。只有证明分支和参数绑定后，才测试过滤器与执行能力。
错误行为：因为页面包含“拦截”就判断过滤器已触发，或因为多个执行 payload 无输出就判断执行器不可利用。
</example>`;

export const OBSERVER_PROJECTOR_SYSTEM_PROMPT = `# Mission
你是 Observer Agent 的 Projector 模式。你的职责是为后续 Planner 和 Executor 维护最小、可追溯、非重复的世界状态：只把本次 observation 中可靠且会改变后续判断的语义写入推理图和作战图，而不是镜像执行日志。

你不执行调查、不规划任务、不输出 ControlSignal。

# Method
先在内部完成两步，再提交一次 delta：

1. **Ground claims**：逐个 observation 提取能够直接指向原始 input/outcome 的最小 claim，形式是“在明确条件下，对明确对象执行明确动作，观察到明确结果”。命令中提到的候选、Executor commentary、静态页面文字和模型解释都不是结果。input 或 outcome 被截断、缺失、混杂，或无法把结果绑定到某个动作时，只保留仍可逐字核对的部分。
2. **Project changes**：将 claim 与现有图比较，只提交会改变后续判断的新增语义。相同事实合并 evidenceRefs，已有事实没有变化就提交空 delta。

# Epistemic Boundary
- Evidence 只写 ground claim，不写后端实现、根因、存在性外推、未测试分支或能力泛化。
- Hypothesis status 只能是 open、inconclusive、confirmed、refuted、superseded；不存在 contradicted 状态，反对该假设的 Evidence 用 contradicts 边表达。从直接结果推导出的解释只写成 status=open/inconclusive 的 Hypothesis；存在局部反证但尚不能裁决完整假设时保持 inconclusive。只有 observation 本身给出区分性实验并证伪该 Hypothesis 的精确范围时，才更新为 refuted，并填写精确 negativeConclusion 和 evidenceRefs。
- 只有完整、可绑定的正向结果证明受控输入突破安全边界时创建 Vulnerability；只有实际读取敏感数据、执行代码、创建会话或完成目标时创建 succeeded Exploit。一次固定成功只证明该固定能力。
- 负面结论不得大于实验范围。没有有效正负对照、同时改变多个条件、有限候选未命中或统一错误响应，都不能证明机制、文件、服务或漏洞类别不存在。
- executor_commentary_non_evidence 只能用于定位原始材料；与动态 input/outcome 冲突时忽略 commentary。Artifact 是材料指针，不自行构成 Evidence。

# Graph Mapping
- Host、Port、Service、WebEndpoint、Parameter、Credential、AgentSession、ShellSession、Session、File、Process 属于作战图；Evidence、Hypothesis、Vulnerability、Exploit 属于推理图。
- typed connectivity observation 是 Runtime 的直接状态事实。live session 创建或更新 ShellSession，properties.sessionId 等于 connectionRef，并以 session_on 连接真实 Pivot Host；停止或降级更新同一节点。Route 表示可达性，不等于 Session，CIDR 和 connectivity_context 本身不证明 Host 存在。
- Tunnel 和 Route 用 Host -tunnels_to/proxy_route-> Host 表达，不创建 Tunnel/ProxyRoute 节点。只有 observation 实际发现目标 Host 时才建立关系。
- observation 中的 artifact:* 必须原样写入相关节点的 artifactRef 或 artifactRefs；沙箱路径不是持久引用。

# Edge Vocabulary And Direction
- Evidence -observed_on-> Host/Port/Service/WebEndpoint/Parameter/Credential/Session/File/Process
- Evidence -supports-> Hypothesis
- Evidence -contradicts-> Hypothesis/Vulnerability
- Evidence -confirms-> Vulnerability
- Hypothesis -promoted_to-> Vulnerability
- Vulnerability -exploited_by-> Exploit
- Vulnerability/Exploit -affects-> Host/Port/Service/WebEndpoint/Parameter/File
- Host -has_port-> Port
- Port -runs_service-> Service
- Service -exposes_endpoint-> WebEndpoint
- WebEndpoint -has_parameter-> Parameter
- Credential -authenticates_to-> Service/WebEndpoint
- Credential -creates_session-> AgentSession/ShellSession/Session
- AgentSession/ShellSession/Session -session_on-> Host
- Host -tunnels_to/proxy_route-> Host
- Host -contains_file-> File
- Host/AgentSession/ShellSession/Session -spawns_process-> Process
- Evidence/Exploit -produces_evidence-> Evidence

# Example
<example name="grounded-endpoint-claim">
observation o1：向既有 WebEndpoint 提交未认证请求，动态响应区出现可复现的唯一标记；页面静态说明还声称“导入已执行”。
正确：创建引用 o1 的 Evidence，以 Evidence -observed_on-> WebEndpoint 连接目标；若执行机制仍只是解释，用 Evidence -supports-> status=open 的 Hypothesis。
错误：把静态说明直接投成 confirmed Vulnerability 或 succeeded Exploit，或让 WebEndpoint 反向连接 Evidence。
</example>

# Submission Contract
existing:N 只用于更新已有节点，只提交 id 和变化的 properties/evidenceRefs；new:N 必须提交 id、type、label。evidenceRefs 只能使用本次 o1、o2 等 observation 别名。Task、Milestone、Blocker、Goal、Scope 不得创建、更新或连接。

只有当前 graph_context 无法判断实体是否已存在或如何合并时，才使用最小只读图查询；不能形成可靠语义变化时提交空 delta。禁止把 secret、token、password、cookie、authorization、privateKey 或完整响应 body 写入 properties。最终调用 graph_delta_submit。任何校验错误都会拒绝整份草稿；修正草稿后必须重新提交完整 delta。`;

export const OBSERVER_SUPERVISOR_SYSTEM_PROMPT = `# Mission
你是 Observer Agent 的 Supervisor 模式。你的职责是保护 Executor 的有效执行时间：判断当前 Epoch 是否仍在推进 Task，是否需要改变局部策略，或是否已经到达 Planner 才能处理的边界。

你不执行目标侧调查，不读取 Artifact，不投影图，不创建或裁决 Task，也不给出具体请求、payload、脚本或命令。Runtime 负责 Scope、硬预算、checkpoint 和停止机制；Planner 负责任务完成状态、拓扑、优先级和预算分配。你唯一可调用的工具是 control_submit。

# Decisions
- continue：当前实验正在减少与 successCriteria 相关的不确定性，或现有信息不足以证明需要干预。
- redirect：Task 和当前因果目标不变，但最近策略持续没有产生区分性结果；guidance 只说明应改变的验证方向。
- handoff：successCriteria 已出现完整结果，存在明确外部阻塞，或下一步需要 Planner 改变 Task、依赖、优先级或全局路径。
- stop_executor：输入显示明确的 Scope 风险，或 Runtime stopRequested=true。不要用于普通失败、低收益或预算接近上限。

# Method
1. 只使用当前 TaskEnvelope、最近执行轨迹、SUPERVISION_STATE、循环信号和相关负面知识。你没有其他可靠会话记忆。
2. 进展是能够支持或排除竞争解释的动态结果。新的 URL、payload、字段名、工具输出或不同 stdout 文本本身不等于进展；静态页面说明、请求脚本标签和全局关键词不能证明动态分支、过滤器或执行器已触发。
3. 缺少有效判定信号、同时改变多个独立条件后统一失败，或连续实验没有排除任何解释，说明当前策略低收益。仍有不同信息来源时 redirect；必须改变全局任务选择时 handoff。
4. 只评价当前因果边界的最近窗口。更早的高价值 Session、Credential 或漏洞原语不能证明当前窗口仍有进展，但只要当前路径仍产生区分性结果就 continue。
5. Runtime 独立处理预算边界。不得仅因 turn 数、nearTurnLimit、有限枚举失败或阶段成果而 handoff；开放候选空间也不能由有限失败推断为穷尽。
6. PRIOR_RELEVANT_KNOWLEDGE 中只有 refuted/superseded Hypothesis 可支持“重复已知死路”。target、method、preconditions、observedResult 和判定信号必须等价，且 reopenConditions 未满足；否则视为新分支。依赖该知识 redirect/handoff 时，在 reason 中引用对应真实 evidenceRefs。
7. 如果证据不足且没有明确 Scope 风险或 Runtime stopRequested，选择 continue。不要为了补证据扩大监督调查。

# Examples
<example name="similar-output-with-new-variable">
最近两次请求响应相似，但第二次首次控制了认证状态并产生了可比较的动态响应区域。
正确：continue；新实验仍可能区分认证与参数绑定。
错误：仅因响应文本相似而 handoff。
</example>

<example name="repeated-causal-boundary">
连续实验使用等价前置条件和判定信号，只替换语义相同的 payload；动态区域、响应哈希和副作用均未变化，相关 refuted Hypothesis 也覆盖该条件。
正确：存在不同验证来源时 redirect；必须改变 Task 或全局路径时 handoff，并引用真实反证。
错误：继续把 payload 数量或 stdout 文本变化当作进展。
</example>

# Output
完成判断后必须调用 control_submit，不要输出自由文本 JSON：
{
  "decision": "continue | redirect | handoff | stop_executor",
  "reason": "监督理由",
  "evidenceRefs": ["..."],
  "guidance": "仅 redirect 时提供的方向性建议；其他情况省略"
}`;

export function renderPlannerInput(input: {
  userGoal: string;
  scopeSummary: string;
  plannerDecisionView: PlannerDecisionView;
  previousPlannerDecisionView?: PlannerDecisionView;
  previousDeliverySeq?: number;
  deliverySeq?: number;
  repairFeedback?: string;
}): string {
  const compactDecisionView = compactPlannerDecisionViewForPrompt(input.plannerDecisionView);
  const previousCompactDecisionView = input.previousPlannerDecisionView
    ? compactPlannerDecisionViewForPrompt(input.previousPlannerDecisionView)
    : undefined;
  const statePayload = previousCompactDecisionView
    ? plannerDecisionViewDelta(previousCompactDecisionView, compactDecisionView, {
      fromEventSeq: input.previousDeliverySeq,
      throughEventSeq: input.deliverySeq
    })
    : {
      delivery: plannerDeliveryMetadata("snapshot", undefined, input.deliverySeq),
      ...compactDecisionView
    };
  const repairFeedback = input.repairFeedback?.trim()
    ? `\n<previous_decision_rejection>\n${truncatePromptText(input.repairFeedback, 1_200)}\n</previous_decision_rejection>\n`
    : "";
  const fixedContext = previousCompactDecisionView
    ? ""
    : `<goal>\n${input.userGoal}\n</goal>\n\n<authorized_scope>\n${input.scopeSummary}\n</authorized_scope>\n\n`;
  return `${fixedContext}<planner_state format="compact-json">
${stableCompactJson(statePayload)}
</planner_state>
${repairFeedback}

根据 Planning Method 选择下一步。snapshot 中的 rootRefs 是 Root Goal/Scope 的真实节点引用；delta 未重复的非 Task 字段沿用上一状态，taskLedger 始终包含当前决策相关 Task 的 canonical definition。创建任务时直接使用真实 ID，不要添加 node: 前缀或改写名称。

先仅根据 planner_state 决策。只有缺失的持久事实会改变全局任务选择时才读取最小材料；技术链路、payload 或 blocker 解决方法的不确定性不是 Planner 检索理由。立即调用 planner_submit，不要输出具体执行动作或自由文本 JSON。`;
}

export function compactPlannerDecisionViewForPrompt(view: PlannerDecisionView): Record<string, unknown> {
  const compactDigest = (item: PlannerDecisionView["reasoningDigest"][number]) => ({
    id: item.id,
    type: item.type,
    label: truncatePromptText(item.label, 150),
    status: item.status,
    properties: compactPromptProperties(item.properties)
  });
  const taskLedger = view.taskLedger.map((task) => {
    return {
      taskId: task.taskId,
      status: task.status,
      executionState: task.executionState,
      goal: task.goal,
      targetRefs: task.targetRefs,
      basisRefs: task.basisRefs,
      scopeRef: task.scopeRef,
      successCriteria: task.successCriteria,
      parentTaskId: task.parentTaskId,
      priority: task.priority,
      maxTurns: task.maxTurns,
      consumedTurns: task.consumedTurns,
      remainingTurns: task.remainingTurns,
      dependsOnTaskRefs: task.dependsOnTaskRefs?.slice(0, 4),
      projection: task.projection
    };
  });
  return {
    view: view.view,
    rootRefs: view.rootRefs,
    taskLedger,
    taskOutcomes: view.taskOutcomes,
    epochOutcomes: view.epochOutcomes,
    projectionDegradations: view.projectionDegradations,
    reasoningDigest: view.reasoningDigest.map(compactDigest),
    operationDigest: view.operationDigest.map(compactDigest),
    blockers: view.blockers.map(compactDigest),
    graphSummary: {
      nodeCount: view.graphSummary.nodeCount,
      edgeCount: view.graphSummary.edgeCount,
      taskStatusCounts: view.graphSummary.taskStatusCounts
    }
  };
}

function plannerDeliveryMetadata(
  kind: "snapshot" | "delta",
  fromEventSeq?: number,
  throughEventSeq?: number
): Record<string, unknown> {
  return {
    kind,
    fromEventSeq,
    throughEventSeq,
    sources: {
      taskState: "GraphStore committed task graph",
      taskOutcomes: "RuntimeStore persisted TaskOutcome",
      epochOutcomes: "RuntimeStore persisted latest EpochOutcome per Task",
      semanticKnowledge: "GraphStore committed reasoning and operation graphs"
    },
    completeness: kind === "snapshot"
      ? "current compact state; full stores remain available through tools"
      : "all structural additions, changes, and removals in the delivered Planner view since its previous state"
  };
}

function plannerDecisionViewDelta(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  watermark: { fromEventSeq?: number; throughEventSeq?: number }
): Record<string, unknown> {
  return {
    delivery: plannerDeliveryMetadata("delta", watermark.fromEventSeq, watermark.throughEventSeq),
    changes: {
      rootRefs: changedValue(previous.rootRefs, current.rootRefs),
      taskLedger: current.taskLedger,
      taskOutcomes: diffRecordArray(previous.taskOutcomes, current.taskOutcomes, "taskRef"),
      epochOutcomes: diffRecordArray(previous.epochOutcomes, current.epochOutcomes, "taskRef"),
      projectionDegradations: diffRecordArray(
        previous.projectionDegradations,
        current.projectionDegradations,
        "taskRef"
      ),
      reasoningDigest: diffRecordArray(previous.reasoningDigest, current.reasoningDigest, "id"),
      operationDigest: diffRecordArray(previous.operationDigest, current.operationDigest, "id"),
      blockers: diffRecordArray(previous.blockers, current.blockers, "id"),
      graphSummary: changedValue(previous.graphSummary, current.graphSummary)
    }
  };
}

function diffRecordArray(
  previousValue: unknown,
  currentValue: unknown,
  identityKey: string
): { upsert: Record<string, unknown>[]; remove: string[] } {
  const previous = recordArray(previousValue);
  const current = recordArray(currentValue);
  const previousById = new Map(previous.map((item) => [String(item[identityKey]), item]));
  const currentById = new Map(current.map((item) => [String(item[identityKey]), item]));
  return {
    upsert: current.filter((item) => !samePromptValue(previousById.get(String(item[identityKey])), item)),
    remove: previous
      .map((item) => String(item[identityKey]))
      .filter((id) => !currentById.has(id))
  };
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function changedValue(previous: unknown, current: unknown): unknown {
  return samePromptValue(previous, current) ? undefined : current;
}

function samePromptValue(left: unknown, right: unknown): boolean {
  return stableCompactJson(left) === stableCompactJson(right);
}

function compactPromptProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).slice(0, 8).map(([key, value]) => [
    key,
    typeof value === "string"
      ? truncatePromptText(value, 140)
      : Array.isArray(value)
        ? value.slice(0, 6)
        : value
  ]));
}

function truncatePromptText(value: string | undefined, limit: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 14))}...[truncated]`;
}

export function renderExecutorInput(input: {
  rootGoal: string;
  taskEnvelope: TaskEnvelope;
  operationGraphSlice: unknown;
  reasoningGraphSlice: unknown;
  sessionRefs: unknown[];
  executionBrief: string;
  dependencyOutcomes?: string;
  runtimeBudgetStatus: string;
  environmentFacts?: string;
}): string {
  return `<root_goal>
${input.rootGoal}
</root_goal>

<current_task>
- taskId：${input.taskEnvelope.taskId}
- 目标：${input.taskEnvelope.goal}
- 目标节点：${input.taskEnvelope.targetRefs.join("，") || "无"}
- 依据引用：${input.taskEnvelope.basisRefs?.join("，") || "无"}
- Scope：${input.taskEnvelope.scopeRef}
- 约束：${input.taskEnvelope.constraints.join("；") || "无"}
- 成功条件：${input.taskEnvelope.successCriteria.join("；") || "无"}
</current_task>

<environment_facts>
${input.environmentFacts ?? "Runtime 未提供环境事实；先通过 pwd 与 $TMPDIR 确认可写位置，不要假设存在 /workspace。"}
</environment_facts>

<operation_graph format="json">
${stableJson(input.operationGraphSlice)}
</operation_graph>

<reasoning_graph format="json">
${stableJson(input.reasoningGraphSlice)}
</reasoning_graph>

<available_sessions format="json">
${stableJson(input.sessionRefs)}
</available_sessions>

<runtime_budget>
${input.runtimeBudgetStatus}
</runtime_budget>

<execution_brief>
${input.executionBrief}
</execution_brief>

<dependency_outcomes>
${input.dependencyOutcomes ?? "无直接依赖任务结果。"}
</dependency_outcomes>

请按 Operating Method 自主执行。优先复用 dependency_outcomes 中的已验证能力；预算变化由 Runtime steering 推送；成功条件满足后立即调用 task_result_submit。`;
}

export function renderExecutorResumeInput(input: {
  rootGoal: string;
  taskEnvelope: TaskEnvelope;
  operationGraphSlice: unknown;
  reasoningGraphSlice: unknown;
  sessionRefs: unknown[];
  executionBrief: string;
  dependencyOutcomes?: string;
  runtimeBudgetStatus: string;
  environmentFacts?: string;
}): string {
  return `继续执行同一个 Task，保留并复用当前 Pi Session 中已有的工具结果、文件、会话状态和执行上下文；不要无理由重新侦察已经确认的入口或能力。

<root_goal>
${input.rootGoal}
</root_goal>

<updated_task>
- taskId：${input.taskEnvelope.taskId}
- 目标：${input.taskEnvelope.goal}
- 目标节点：${input.taskEnvelope.targetRefs.join("，") || "无"}
- Scope：${input.taskEnvelope.scopeRef}
- 约束：${input.taskEnvelope.constraints.join("；") || "无"}
- 成功条件：${input.taskEnvelope.successCriteria.join("；") || "无"}
</updated_task>

<environment_facts>
${input.environmentFacts ?? "Runtime 未提供环境事实；先通过 pwd 与 $TMPDIR 确认可写位置，不要假设存在 /workspace。"}
</environment_facts>

<operation_graph format="json">
${stableJson(input.operationGraphSlice)}
</operation_graph>

<reasoning_graph format="json">
${stableJson(input.reasoningGraphSlice)}
</reasoning_graph>

<available_sessions format="json">
${stableJson(input.sessionRefs)}
</available_sessions>

<runtime_budget>
${input.runtimeBudgetStatus}
</runtime_budget>

<execution_brief>
${input.executionBrief}
</execution_brief>

<dependency_outcomes>
${input.dependencyOutcomes ?? "无直接依赖任务结果。"}
</dependency_outcomes>

请继续自主执行。成功条件满足时立即调用 task_result_submit；预算接近上限时提交阶段性 TaskResult。`;
}

export function renderObserverInput(input: {
  projectionJob: string;
  observations: string;
  artifactIndex: string;
  graphContext: string;
  connectivityContext: unknown;
}): string {
  return `<projection_job>
${input.projectionJob}
</projection_job>

<observations>
${input.observations}
</observations>

<artifact_evidence>
${input.artifactIndex}
</artifact_evidence>

<graph_context>
${input.graphContext}
</graph_context>

<connectivity_context format="json">
${stableJson(input.connectivityContext)}
</connectivity_context>

请只基于以上 observations、artifact 片段和图上下文调用 graph_delta_submit。connectivity_context 仅是当前 Route 引用状态：可用于识别本次 observation 已发现目标所命中的既有 route，但不能独立证明 Host、Session、Evidence 或关系。只有 graph_context 无法判断实体是否已存在或如何合并时才做最小只读查询；多个 observation 支持同一语义变化时合并表达。`;
}

export function renderSupervisorInput(input: {
  taskEnvelope: TaskEnvelope;
  actionTraceText: string;
  loopSignalsText: string;
  supervisionState: unknown;
  budgetState: unknown;
  taskStatus: unknown;
  lastControlSignal?: unknown;
  priorRelevantKnowledge?: unknown;
  sourceEventIds: string[];
  reason: string;
}): string {
  const budgetState = input.budgetState as {
    toolExecutionEndCount?: number;
    usedTurns?: number;
    remainingTurns?: number;
    epochUsedTurns?: number;
    epochMaxTurns?: number;
    epochRemainingTurns?: number;
    budget?: { maxTurns?: number };
    globalRemainingMs?: number;
    epochRemainingMs?: number;
    epochTimeLimitMs?: number;
    stopRequested?: boolean;
  };
  const taskStatus = input.taskStatus as Record<string, unknown> | undefined;
  const lastControlSignal = input.lastControlSignal as Record<string, unknown> | undefined;
  return `你正在监督当前 Executor 是否陷入低收益循环、偏离任务、遇到外部阻塞，或已经应该交回 Planner。

触发原因：${input.reason}
触发事件：${input.sourceEventIds.join(", ") || "无"}

当前任务：
- taskId：${input.taskEnvelope.taskId}
- 目标：${input.taskEnvelope.goal}
- 成功条件：${input.taskEnvelope.successCriteria.join("；") || "未提供"}
- 关键约束：${input.taskEnvelope.constraints.join("；") || "未提供"}
- Task allocation：已用 ${budgetState.usedTurns ?? 0}/${budgetState.budget?.maxTurns ?? "?"}，剩余 ${budgetState.remainingTurns ?? "?"} turns
- Epoch slice：已用 ${budgetState.epochUsedTurns ?? 0}/${budgetState.epochMaxTurns ?? "?"}，剩余 ${budgetState.epochRemainingTurns ?? "?"} turns
- 时间预算：全局剩余 ${formatRemainingTime(budgetState.globalRemainingMs)}；当前 Epoch 剩余 ${formatRemainingTime(budgetState.epochRemainingMs)} / ${formatRemainingTime(budgetState.epochTimeLimitMs)}
- Runtime 停止请求：${budgetState.stopRequested === true ? "yes" : "no"}
- 工具调用：已完成 ${budgetState.toolExecutionEndCount ?? 0} 次，仅用于观察窗口，不作为预算中止条件

任务状态：
- status：${String(taskStatus?.status ?? "unknown")}
- attempt：${String(taskStatus?.attempt ?? "unknown")}
- checkpointReason：${String(taskStatus?.checkpointReason ?? "none")}
- retryable：${String(taskStatus?.retryable ?? "unknown")}
- resumeCursor：${String(taskStatus?.resumeCursor ?? "none")}

最近监督信号：
- decision：${String(lastControlSignal?.decision ?? "none")}
- reason：${String(lastControlSignal?.reason ?? "none")}

SUPERVISION_STATE:
${stableJson(input.supervisionState)}

PRIOR_RELEVANT_KNOWLEDGE:
${stableJson(input.priorRelevantKnowledge ?? { nodes: [], edges: [] })}

最近执行轨迹：
${input.actionTraceText}

若轨迹中的 materialIntegrity 不是 complete，说明完整材料只存在于所列 Artifact；不得把当前不可见部分解释为失败、无进展或机制不成立。

循环/漂移信号：
${input.loopSignalsText}

请调用 control_submit 提交 ControlSignal。只判断是否 continue、redirect、handoff 或 stop_executor；redirect 只能提供方向性 guidance。不要输出自由文本 JSON、GraphDelta 或具体 HTTP 请求、payload、shell 命令。`;
}

function formatRemainingTime(value: number | undefined): string {
  if (value === undefined) {
    return "unbounded";
  }
  return `${Math.max(0, Math.ceil(value / 1000))}s`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(flattenKeys(value)).sort(), 2);
}

function stableCompactJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(flattenKeys(value)).sort());
}

function flattenKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenKeys(item, keys);
    }
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [propertyName, propertyValue] of Object.entries(value)) {
      keys[propertyName] = true;
      flattenKeys(propertyValue, keys);
    }
  }
  return keys;
}
