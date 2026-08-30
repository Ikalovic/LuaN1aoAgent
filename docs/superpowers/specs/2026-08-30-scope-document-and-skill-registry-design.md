# 授权范围文件解析与 Skill Registry 设计

日期：2026-08-30  
状态：已确认设计，等待实施计划

## 1. 背景与目标

LuaN1aoAgent 当前能够从 Web/CLI 文本参数接收域名、IPv4 和 IPv4 CIDR，但自动范围解析只处理 Goal 中明确出现的 IPv4/CIDR，且没有授权文件入口。项目对 Skill 的支持则仅是把项目本地 `.agents/skills` 目录作为 Pi Runtime 的附加 Skill 路径交给 Executor，缺少统一发现、校验、任务匹配、状态查询和运行记录。

本次实现两个相互独立、向后兼容的增强：

1. AI 能从用户提供的授权文件中识别渗透范围，并将域名、IPv4 和 IPv4 CIDR 固化为任务授权边界。
2. 增加统一 Skill Registry，让 AI 可按任务自动选择 Skill，并向 Web/API 暴露 Skill 状态和诊断。

未上传文件、未安装 Skill、没有匹配 Skill 或 Skill 加载失败时，现有任务流程必须继续可用。

## 2. 非目标

- 不对扫描版 PDF 做 OCR。
- 不把端口、协议、URL 路径作为授权边界。
- 不支持 IPv6。
- 不允许根据 DNS、网络邻接关系、FOFA 结果或模型常识扩大授权范围。
- Skill 不是新的 MCP 协议，也不替代现有工具或 MCP；它仍是指导模型使用现有能力的说明资源。

## 3. 授权文件解析

### 3.1 支持格式

第一版支持：

- `.txt`、`.md`
- `.csv`
- `.json`
- `.docx`
- 带文本层的 `.pdf`

格式由文件内容与扩展名共同检查。设置单文件大小、解压后大小、页数/段落数和解析时间上限，防止压缩炸弹、超大文件或异常解析器阻塞服务。PDF 不含可提取文本时返回明确的 `scanned_pdf_not_supported` 诊断。

### 3.2 解析管线

新增 `ScopeDocumentParser`，处理流程为：

1. 验证文件类型、大小和基本结构。
2. 使用格式专用适配器提取纯文本与位置元数据。
3. 确定性规则提取域名、IPv4、IPv4 CIDR。
4. 对自然语言中的范围描述调用受约束的 AI 解析步骤。
5. 将 AI 候选与原文证据逐项绑定；缺少原文证据的候选直接丢弃。
6. 复用 `src/scope.ts` 完成规范化、去重和合法性校验。
7. 输出范围预览、来源证据和诊断，等待用户确认。

AI 只用于理解文件中已经写出的内容，不能做 DNS 查询、补全相似域名、推导更宽网段或生成原文没有的资产。裸 IPv4 规范化为 `/32`。域名沿用当前精确域名/子域语义；CIDR 保留原前缀长度。

### 3.3 结构化结果

解析结果采用稳定结构：

```ts
type ParsedScopeDocument = {
  documentId: string;
  fileName: string;
  domains: ScopeCandidate[];
  ipv4Cidrs: ScopeCandidate[];
  diagnostics: ScopeDocumentDiagnostic[];
};

type ScopeCandidate = {
  value: string;
  source: "rule" | "ai";
  evidence: {
    page?: number;
    paragraph?: number;
    line?: number;
    excerpt: string;
  };
};
```

保存原始文件、受长度限制的提取文本、规范化结果和证据关联。日志及 Web 页面不得无上限展示原文，避免敏感授权材料泄漏或撑大模型上下文。

### 3.4 Web、API 与 CLI

- Web 创建任务对话框增加文件上传、解析进度、范围预览、诊断和确认步骤。
- API 分离“上传/解析”和“确认/启动”。启动请求引用已解析文档，并携带用户确认后的最终范围。
- CLI 增加可重复的 `--scope-file <path>`。交互模式显示预览并确认；非交互模式要求显式确认参数，否则只输出解析结果而不启动。
- 手动 `--scope`/Web 文本范围继续支持；手动范围与已确认文件范围取并集。
- 未提供文件时完全沿用现有路径和请求格式。

### 3.5 授权边界

最终确认的结构化范围仍是 FOFA、网络访问、候选验证和拓扑写入的唯一授权依据。FOFA 或其他模块发现的旁站、子站、IP 只能作为候选；只有落在已确认域名/IP/CIDR 范围内的资产才可被验证并写入受信拓扑。文件解析不能成为绕过现有 scope guard 的第二条路径。

无有效候选、内容冲突、只有模糊描述或解析失败时，不自动启动任务，要求用户修改或确认范围。

## 4. Skill Registry

### 4.1 当前行为与兼容边界

当前项目只在 `.agents/skills` 存在时把整个目录作为 `additionalSkillPaths` 交给 Executor。Pi Runtime 读取 Skill 名称、描述和位置，把这些元数据加入系统提示；模型在认为任务匹配时自行读取对应 `SKILL.md`。Planner 和 Observer 不加载项目 Skill。

新实现保留 Agent Skills 的 `SKILL.md` 目录约定和 Pi Runtime 加载入口，但不在错误时盲目加载整个目录：

- 没安装 Skill：按当前无 Skill 流程执行。
- Registry 异常：记录警告，按无 Skill 流程执行。
- 单个 Skill 无效：跳过该 Skill，其余有效 Skill 继续可用。
- 旧目录中的合法 Skill：无需修改即可被 Registry 发现。

### 4.2 Registry 职责

新增 `SkillRegistry`，负责：

- 扫描项目 `.agents/skills` 中含 `SKILL.md` 的目录。
- 解析名称、描述、模型调用开关和来源。
- 校验名称、描述、文件可读性、目录边界、符号链接及重名冲突。
- 生成有效 Skill 清单与逐项诊断。
- 支持运行级启用、禁用和允许列表。
- 为任务选择步骤提供只含名称、描述和状态的紧凑元数据。
- 将最终选择转换为 Pi Runtime 可接受的精确 Skill 路径，而不是整个未校验目录。

Registry 不执行 Skill，不授予新工具权限，也不能突破 Executor 沙箱。

### 4.3 AI 自动选择

在创建 Executor 会话前增加受约束的 Skill 选择步骤：输入任务 Goal/Task 摘要和 Registry 中的有效 Skill 元数据，输出零个或多个 Skill 名称及选择理由。输出必须通过 Registry 校验，只能引用有效且本次运行允许的 Skill。

选择失败、超时、返回未知名称或没有匹配项时使用空列表继续任务。不得因为安装了 Skill 就强制模型使用；Executor 仍需按 Skill 描述判断是否读取其完整 `SKILL.md`。这保持渐进披露，并避免把所有 Skill 正文塞入上下文。

Planner 只获得有效 Skill 的紧凑元数据，便于规划适合的任务，不直接读取或执行 Skill 正文。Observer 默认不加载 Skill。

### 4.4 Web/API 与运行可见性

提供只读 Skill 清单接口和运行级配置接口，至少返回：

- 名称、描述、来源路径
- 是否有效、是否启用、是否允许模型自动调用
- 校验警告或冲突
- 最近一次扫描时间

Web 增加 Skill 状态页面或面板，支持查看、启停和刷新。任务详情记录以下运行事件：

- Registry 扫描结果
- 自动选择的 Skill 与理由
- Skill 加载成功或跳过原因
- 无 Skill 回退原因

这些事件用于证明 AI 是否实际获得并读取了 Skill；仅“已安装”不等同于“已使用”。

### 4.5 安装与安全

继续支持 `install.sh` 将第三方 Skill 安装到项目本地 `.agents/skills`。Registry 不自动联网下载 Skill。第三方 Skill 仍是外部供应链内容；启用前显示来源和校验状态。Skill 内引用的文件必须位于其目录或明确允许的只读根中，不能借相对路径越界读取。

## 5. 错误处理与降级

文件解析和 Skill 系统采用独立故障域：

- 文件解析器故障只影响本次文件范围输入，不影响原有手动范围任务。
- AI 文件解析失败时保留规则提取结果并显示诊断；不得静默扩大范围。
- Skill Registry/选择/加载故障只产生警告，Executor 使用现有无 Skill 流程。
- 新数据库字段和 API 字段均可选，使用兼容迁移，旧请求与旧任务可正常读取。
- 所有解析错误均返回稳定错误码，Web 不只显示“服务器内部错误”。

## 6. 测试策略

### 6.1 范围文件

- 每种格式的有效域名、IPv4、CIDR 提取。
- TXT/MD/CSV/JSON 编码与结构边界。
- DOCX 解压大小限制、异常包和外部关系处理。
- 文本 PDF、多页证据定位、加密 PDF、扫描 PDF。
- 去重、裸 IPv4 `/32` 转换、非法地址和域名。
- AI 候选无证据、擅自扩大 CIDR、DNS 推导等拒绝场景。
- 手动范围与文件范围合并、预览确认及旧接口回归。
- 最终范围对 FOFA、网络访问和拓扑更新的强制约束。

### 6.2 Skill

- 空目录/目录不存在时任务正常运行。
- 有效 Skill 发现、无效 frontmatter、重名和路径越界。
- 自动匹配零个、一个、多个 Skill。
- 未知选择、选择超时、Registry 异常时无 Skill 降级。
- 运行级启停/允许列表与 Web/API 状态。
- Executor 只获得已选择 Skill，Planner 只获得元数据，Observer 不加载。
- 旧 `.agents/skills/<name>/SKILL.md` 无需改动即可工作。

## 7. 完成标准

- 用户能从 Web 和 CLI 提供受支持文件，预览并确认域名/IP/CIDR 范围后启动任务。
- 扫描版 PDF 得到清晰的不支持提示，而不是空范围或 500。
- 文件中没有明确证据的资产不能进入授权范围。
- Web/API 能查看 Skill 清单、状态和诊断，并配置本次运行的启停/允许列表。
- AI 能按任务选择并读取有效 Skill，运行记录能够证明选择和读取过程。
- 没有 Skill 或 Skill 任一环节失败时，现有任务仍能启动并完成。
- 原有文本范围、CLI、Web API、FOFA 和拓扑约束测试继续通过。
