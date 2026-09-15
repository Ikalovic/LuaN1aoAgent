# 青玄 自动渗透agent：前端重构准备调研

日期：2026-09-15。状态：前期调研记录，正式设计另见下文链接。本轮不实施前端重构。

更新：用户已明确产品名称为“青玄 自动渗透agent”，并选择深色安全指挥工作台。后续设计以 [正式设计文档](superpowers/specs/2026-09-15-qingxuan-frontend-design.md) 为准；下文中的旧项目名仅指既有代码来源。

追加更新：已通过 git pull 合入远端 `60a1753`，新增 MCP 管理、环境配置和 Agent 详情。用户要求增加独立展示页面，见 [态势大屏设计](superpowers/specs/2026-09-15-qingxuan-wallboard-design.md)；前期对大屏的候选讨论不再代表最终范围。

## 1. 项目定位与当前基础

LuaN1aoAgent 是自主安全研究工作台，核心为 Planner、Executor、Observer 协作，以及任务图、推理图、作战图。适合围绕“目标、发现、证据、执行、人工介入”建立态势感知。

- 技术栈：React 19、TypeScript、Vite 8、Ant Design 6、Lucide。
- 图形：Cytoscape + ELK，已有筛选、缩放、重新布局、节点选择与关联高亮。
- 工作区：react-resizable-panels；轨迹使用 react-virtuoso。
- 页面：执行轨迹、三图、HTTP 流量、连接管理、产物与报告、Skills、审批，以及登录和任务启动。
- 已有中英文、管理员与分析员角色、任务停止和继续执行流程。
- 核对了源码和仓库中的展示截图；未启动应用验证当前运行画面。仓库截图可能早于最新功能。

关键文件：

| 文件 | 重构关注点 |
| --- | --- |
| `web/src/App.tsx` | 454 行，工作区布局、页面选择、任务控制、检查器和状态交织 |
| `web/src/styles.css` | 768 行，全局布局和组件颜色集中，硬编码浅色较多 |
| `web/src/components/GraphView.tsx` | 图生命周期、交互、布局与独立 Canvas 样式 |
| `web/src/graph.ts` | 图投影、配色、筛选和布局，保留领域语义 |
| `web/src/useRuntimeDashboard.ts` | 请求完成后间隔 5 秒轮询，页面隐藏时暂停 |
| `web/src/types.ts`、`web/src/api.ts` | 前端数据契约和认证请求封装 |
| `src/web-server.ts` | 状态聚合、图读取、事件与产物读取上限 |
| `web/src/language.tsx` | 新导航与状态标签需同步双语 |

## 2. 当前界面判断

从源码和现有截图看，界面以浅色三栏工作台为主，功能入口清晰，但顶部指标侧重事件、节点、边和产物数量。风险结论、任务推进和待介入事项尚未形成统一总览。

右侧检查器在部分页面主要显示说明，持续占用空间；顶部目标区、阶段标题和容器边框也分散了主体内容的注意力。图节点文字较密，适合增加按缩放层级展示信息、聚焦路径和节点详情联动。

建议把“高级感”落实为：明确的信息主次、稳定的布局、克制的颜色、精确的对齐，以及可从概览追到证据的交互。

## 3. 可用数据与限制

| 态势模块 | 现有依据 | 需要注意 |
| --- | --- | --- |
| 任务状态分布 | `overview.tasks.byStatus` | 由已加载图节点中的 Task 聚合，不保证运行全量；任务摘要 `items` 再取前 30 项 |
| 资产与连接拓扑 | operation 图、connectivity 接口 | 资产归并与连接映射规则需核对，不能把所有节点都计为资产 |
| 发现与证据链 | reasoning 图、`evidenceRefs`、产物 | Hypothesis、Vulnerability、Exploit 需分别展示，不能混成已确认风险 |
| 最近活动 | `events`、`traceItems` | 状态接口只读取最近 700 条事件；适合近期窗口展示 |
| 产物概览 | `artifacts` | 状态接口只读取最近 240 条记录，现有 count 并非保证完整累计 |
| Agent 动态 | `overview.agents`、运行列表、轨迹 | 每种角色的最新事件不是每个 Agent 的在线心跳 |
| 人工介入 | approvals、阻塞任务、控制信号 | 审批数据按权限展示；不同来源要保留各自含义 |
| HTTP 流量 | 分页 history、详情和 replay | 单页记录不能代表全局流量趋势，聚合需另行设计 |

补充约束：图读取存在 SQLite 与增量回退路径。SQLite 图查询也限制 1,200 节点、2,400 边，增量读取上限为 260 条；TaskOutcome/EpochOutcome 分别最多 500/1,000 项。总览应显示数据来源和更新时间，并明确不完整或过期状态。

当前强类型接口未提供统一漏洞 severity/CVSS、完整时间序列或地理坐标契约；图的自由属性可能包含相关内容，但需先核验。审批的 `riskLevel` 表示工具审批风险，不能直接当漏洞严重性。

全局累计、跨运行资产去重、准确风险分布和历史态势回放，需要进一步定义后端聚合口径。加载失败或字段缺失应显示未知，不应变成零。

## 4. 网页与视觉参考

以下链接于调研日检索并打开。借鉴信息组织与交互，不直接搬用品牌素材。

### Elastic Security：总览与调查入口

- [官方 Overview Dashboard](https://www.elastic.co/docs/solutions/security/dashboards/overview-dashboard)
- [官方界面截图](https://www.elastic.co/docs/solutions/images/security-overview-pg.png)
- 文档展示告警与事件概览、时间直方图、主机与网络事件分组。
- 本项目可借鉴：统一时间范围、可点击指标、最近活动与详情调查联动。不能把本项目的安全测试事件直接称为外部攻击告警。

### Grafana Node Graph：拓扑阅读与逐步探索

- [官方 Node Graph 文档](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/node-graph/)
- [官方界面截图](https://grafana.com/media/docs/grafana/panels-visualizations/screenshot-node-graph-v11.3.png)
- [交互示例入口所在页面](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/node-graph/#configure-a-node-graph-visualization)
- 文档支持节点与边携带指标、上下文详情、图与网格切换及隐藏节点逐步展开。
- 本项目可借鉴：节点只放关键字段，细节通过选中展示，按需展开关联路径。实现上优先延续 Cytoscape，无需因此引入 Grafana。

### Cortex Xpanse：攻击面业务组织

- [官方产品页面](https://www.paloaltonetworks.com/cortex/cortex-xpanse)
- 可用于攻击面、资产发现和风险优先级的产品表达参考。该页以产品介绍为主，不作为具体交互细节已验证的依据。

现有项目视觉基线：`docs/assets/workbench-live-trace.png` 与 `docs/assets/workbench-reasoning-graph.png`。本轮实际查看了后者。

### Elastic 产品实访补充（2026-09-15）

用户提供的 XLSX 含 26 条 HTTP 请求。虽然描述为 Cortex Xpanse 抓包，实际目标为 Elastic Cloud Kibana，来源页面为 `/app/discover`。已还原表格中的换行转义，在内存中读取认证信息并验证接口返回 200，再通过 Playwright 进入产品。没有把 Cookie、令牌、完整请求或租户地址写入仓库。

实访范围与证据：

| 页面 | 实际观察 | 边界 |
| --- | --- | --- |
| Discover | 窄导航、会话标签、查询编辑区、时间栏、字段侧栏和空结果状态 | 默认最近 15 分钟内无结果，未验证有数据时的记录详情 |
| 安全仪表板 | 安全视图入口与缩略图、定制仪表板列表和筛选栏 | 没有创建或保存仪表板 |
| 安全概览 | 最近案例/时间线、告警趋势、事件柱状图、主机与网络事件分组 | Today 窗口最终显示 2 条事件，其他多个区域为空；不能代表丰富数据下的态势效果 |
| 时间选择器 | 实际点击打开，查看预置、最近、日历、自定义范围及时区入口 | 未修改持久化设置 |
| Attack Discovery | 页面明确提示迁移至 Detections 下的 Attacks | 原入口不是攻击分析主体 |
| Attacks | 主导航与检测二级导航、攻击页骨架 | 观察窗口内主体仍为加载状态，没有验证攻击列表或证据链交互 |

实访截图保存在本机临时目录，未加入仓库：

- `/tmp/luaniao-elastic-discover.png`
- `/tmp/luaniao-elastic-dashboards.png`
- `/tmp/luaniao-elastic-overview.png`（首次截图图表尚在加载）
- `/tmp/luaniao-elastic-time-filter.png`（时间弹层打开，事件图表已显示）
- `/tmp/luaniao-elastic-attack-discovery.png`
- `/tmp/luaniao-elastic-attacks.png`（加载骨架）

对本项目的具体启发：

1. 一级导航采用紧凑图标加短标签，二级导航按场景展开，减少永久侧栏占用。
2. 在每个分析页面顶部明确当前运行、筛选与时间窗口；切换细节视图时保留上下文。
3. 汇总区提供清晰的详情入口，让任务统计进入任务列表、发现统计进入证据列表。
4. 字段区与详情区可折叠；避免无内容的检查器持续占用主画布。
5. 区分加载、空结果、缺少数据源和请求失败；图表应在数据加载后再判断为空。
6. 布局与交互可以借鉴；具体视觉仍需按项目设计。实访是浅色界面，不构成暗色方案已验证的依据。

本次已结束浏览器会话；只执行页面浏览、读取与时间弹层展开，没有主动创建规则、生成攻击分析或修改项目设置。

## 5. 三种候选方向

### 补充参考：Ant Design 设计体系

用户提供了 [Ant Design 设计介绍](https://ant.design/docs/spec/introduce-cn/)。本次阅读了介绍、主题定制与暗黑模式文档，未在浏览器中逐项操作组件示例。

- 定位：作为本项目的组件与交互规范基础；项目已依赖 `antd ^6.5.0`，无需另行迁移组件库。
- 当前入口：`web/src/language.tsx` 中的 `ConfigProvider` 和 `appTheme`。已有全局颜色、字体、圆角，以及 Button、Input、Menu 的部分定制。
- [主题定制](https://ant.design/docs/react/customize-theme-cn/)：使用 Design Token 统一颜色、尺寸和状态样式；支持暗色算法、紧凑算法、组件级定制及局部主题。
- [暗黑模式规范](https://ant.design/docs/spec/dark-cn/)：作为暗色方案设计参考，最终仍需核验实际表格、表单、弹窗和图谱的阅读体验。
- 建议：沿用 Ant Design 的基础控件与交互，设计项目自己的态势总览和图谱布局。CSS 与 Cytoscape 需同步接入主题，修改 ConfigProvider 本身不能覆盖它们的硬编码颜色。
- 暗色、紧凑均是候选配置；是否采用及其密度需通过设计稿验证，不等同于最终风格已确定。

| 方向 | 视觉与布局 | 优点与代价 |
| --- | --- | --- |
| A. 安全指挥工作台，推荐 | 中性石墨背景、清晰白字、青绿活动色、琥珀待处理、红色风险；中心拓扑配紧凑列表 | 有态势感，适合日常操作；需要统一 Ant Design、CSS 和 Canvas 主题 |
| B. 精密分析工作台 | 浅灰白底、深色导航、严谨表格和局部深色拓扑 | 长时间阅读友好，延续现状成本较低；视觉变化相对温和 |
| C. 展示大屏 | 拓扑主导、少量关键指标、近期动态 | 演示直观；复杂操作和移动端需要独立工作台承接，维护成本更高 |

用户已选择 A，并追加 C 作为独立展示页面；具体方案以正式设计与大屏子规格为准。以真实目标资产拓扑作为第一视觉焦点，地理地图仍需有可信位置数据和地域分析需求。

## 6. 推荐的信息架构草案

- 态势总览：当前目标、范围、运行状态、任务分布、已确认发现、待处理事项、近期活动。
- 资产与路径：作战图为基础，展示资产、服务、可达连接和关联发现。
- 任务与执行：任务图、角色轨迹、当前动作、阻塞与继续执行。
- 发现与证据：推理链、结论状态、来源事件、报告和产物。
- 流量与连接：请求列表、报文详情、重放、连接操作。
- 管理：Skills、审批等，遵循现有权限。

总览布局草案：顶栏放运行切换和控制；其下为紧凑指标带；中间为资产拓扑与发现列表；底部为任务状态和近期活动。选中实体后再展开关联详情。

核心阅读路径：总览发现 -> 对应资产/推理节点 -> 来源事件 -> 产物或报文。全程保留当前运行、选中实体和筛选上下文。

这只是调研草案，尚未确定导航名称、页面合并方式和默认首页。

## 7. 下一轮实施前准备

1. 明确主场景：日常操作优先，还是演示展示优先；默认建议前者。
2. 使用相同真实数据结构制作总览、图谱、轨迹三张设计稿，检查长中文目标和密集节点。
3. 明确统计口径：当前快照、近期窗口、全量累计；确定第一期需要补充的接口。
4. 先建立 CSS 与 Ant Design 共用的主题变量，再调整布局；同步处理 Cytoscape 配色。
5. 分阶段迁移总览与工作区、图谱与轨迹、流量与其他页面，沿用现有请求和领域逻辑。
6. 验证登录、启动/停止/继续、权限、双语、刷新、图选中、流量重放与报告下载；增加桌面和移动端截图检查。

本轮仅调研和记录，没有运行测试、安装依赖或启动服务；未修改应用代码。现有未跟踪文档保持原样。
