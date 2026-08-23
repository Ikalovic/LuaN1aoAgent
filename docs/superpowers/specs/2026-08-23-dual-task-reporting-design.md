# CTF / 渗透测试双模式与报告产物设计

## 背景

当前项目已经具备 Planner/Executor 任务流、TaskOutcome、ArtifactStore 和 Web Artifact 展示能力，但启动运行时没有区分 CTF 题目与正式渗透测试。两类任务的验收产物不同：CTF 需要可复现的 writeup，渗透测试需要依据用户提供的评分标准和报告模板生成正式报告。

用户提供的 PDF 仅作为当前默认案例的内容来源，不作为运行时文件或仓库资产。项目内保存从该 PDF 整理出的 Markdown 规范。

## 目标与非目标

### 目标

1. 启动运行时显式支持 `ctf` 和 `pentest` 两种任务类型。
2. 未指定类型时默认使用 `pentest`。
3. CTF 完成时生成 `writeup.md`，并作为 `kind="report"` Artifact 持久化。
4. 渗透测试完成时生成 `pentest-report.md`，使用评分标准和报告模板 Markdown 生成，并作为 `kind="report"` Artifact 持久化。
5. Web 面板显示任务类型和对应的可下载产物。
6. 模板由配置指定；未配置时使用项目内默认 Markdown 模板。
7. 运行记录保存任务类型、模板路径和模板摘要，保证可审计。

### 非目标

- 不在项目中复制或依赖原始 PDF。
- 不实现 PDF 解析器或 PDF 上传流程。
- 不改变 FOFA、Beekeeper、网络边界和现有任务调度语义。
- 不自动猜测任务类型；类型以用户选择或 API 字段为准。

## 用户入口与数据模型

Web 启动窗口增加任务类型选择：

- `ctf`：CTF 题目
- `pentest`：渗透测试（默认）

CLI/API 的启动输入增加可选 `taskType` 字段。服务端只接受上述两个值；缺失值规范化为 `pentest`。

运行时元数据保存：

- `taskType`
- `scoringTemplatePath`（仅 pentest）
- `reportTemplatePath`（仅 pentest）
- 模板内容摘要或版本标识

## 模板配置

新增项目内默认模板：

- `templates/pentest/default-scoring-standard.md`
- `templates/pentest/default-report-template.md`

新增环境变量：

- `PENTEST_SCORING_TEMPLATE`：评分标准 Markdown 路径
- `PENTEST_REPORT_TEMPLATE`：报告模板 Markdown 路径

配置路径必须经过运行时路径策略校验，并限制在允许的模板目录或显式配置路径内。模板缺失、不可读或为空时，pentest 运行在启动阶段返回明确的配置错误，不伪造报告；CTF 不读取这些模板。

默认评分 Markdown 根据当前 PDF 整理，覆盖攻击方评分重点、权限/数据/设备等评分项、单位与系统上限、供应链加分、违规扣分、操作记录、授权和 AI 使用要求。默认报告 Markdown 覆盖目标信息、自评分数明细、攻击路径、成果说明、证据、利用代码、账号密码来源、AI 说明和痕迹清除确认表。

## 任务提示与完成条件

启动时将 `taskType` 注入 Root Goal、Planner 和 Executor 的运行上下文。

CTF 模式：

- 以题目求解和 Flag 验证为目标。
- 完成 Task 前必须形成简洁、可复现的解题路径。
- 报告 Task 使用 `artifact_write(kind="report")` 写入 `writeup.md`。
- writeup 至少包含题目元数据、摘要、1–3 个关键步骤、完整脚本或命令路径和 Flag。

Pentest 模式：

- 以授权范围内的证据、漏洞和成果为目标。
- 最终报告 Task 依赖相关侦察、验证和成果 Task。
- 报告必须按评分标准和报告模板组织，未证实内容标为未确认，不得用推测代替证据。
- 报告 Task 使用 `artifact_write(kind="report")` 写入 `pentest-report.md`。
- 报告完成前 Root Goal 不得标记为 completed。

两种模式均要求 TaskOutcome 的 `artifactRefs` 引用真实报告 Artifact，沿用现有完成语义。

## 产物与 Web 展示

报告保存到当前运行时的 ArtifactStore，不新增平行存储系统。Artifact 元数据增加或复用现有字段表达：

- 文件名
- `kind=report`
- Markdown media type
- taskType
- 模板摘要（pentest）

Web 会在运行详情和 Artifacts 区显示任务类型，并提供对应 Markdown 的预览和下载。现有 `deriveFinalReport` 继续以 `kind=report` 和 completed TaskOutcome 作为最终报告判定依据。

## 错误处理与安全边界

- `taskType` 非法：返回 `invalid_request`。
- pentest 模板不存在/不可读：返回 `template_unavailable`，不启动运行。
- 模板过大：按项目现有输入上限拒绝，避免污染模型上下文。
- 模板内容作为规范资料注入提示，不允许覆盖授权范围、网络策略、工具权限或系统指令。
- 报告只引用当前运行中真实存在的 evidenceRefs/artifactRefs。
- 不把凭据、API Key 或未经授权的敏感数据写入默认模板。

## 测试策略

1. API/CLI：`taskType` 接受、默认值和非法值校验。
2. 模板：默认模板可读取；自定义路径生效；缺失和空文件返回明确错误。
3. Prompt：CTF 与 pentest 的完成条件、文件名和模板上下文互不混淆。
4. Controller：两种模式都要求真实报告 Artifact 才能完成最终报告 Task。
5. Web：启动表单提交模式；运行详情和 Artifact 展示模式。
6. 回归：现有 FOFA、Beekeeper、Artifact、运行时和 Web 测试保持通过。

