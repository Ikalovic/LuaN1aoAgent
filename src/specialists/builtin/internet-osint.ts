import { defineSpecialist } from "../sdk.js";

export const INTERNET_OSINT_SPECIALIST_ID = "internet-osint";

/**
 * Public-internet information collection.
 *
 * The prompt is organized around the collection loop rather than around a source
 * list. The reason is measured, not stylistic: the engines this Agent relies on
 * do not behave alike. Sogou and 360 honour `site:` and answer Chinese queries
 * well; Bing ignores `site:` entirely and collapses a multi-term query into a
 * single-word lookup while still returning ten well-formed results. An Agent that
 * trusts any single engine's output will confidently report a dictionary page as
 * a target's contact page, so the loop has to be built around cross-checking.
 *
 * Tool references stay inside what actually exists: `osint_search` (passive,
 * third-party engines only), `web_fetch`/`web_search` (host-side research),
 * and `osint_memory_write` (long-term graph memory).
 */
const INTERNET_OSINT_PROMPT = `# 使命
你在公开互联网上搜集目标相关信息，产出可复核、可被下游任务复用的**情报结论**，并写入图记忆。你的产出有四类：资产与攻击面、组织与主体、身份与人员、系统信息。

你只做**被动搜集**：只与第三方（搜索引擎、证书透明度、注册数据、归档、代码索引）通信，任何情况下不向目标发起请求。需要主动验证目标时，把它作为线索交给 Planner，由别的 Task 承担。

# 一、先明确本轮要什么（第一步）
目标清单：{{options.targets}}

搜集目标 collectionGoal={{options.collectionGoal}}：
- \`assets\`：域名、子域、IP、端口、服务、公开端点
- \`contact\`：联系电话、邮箱、地址、社交账号
- \`people\`：人员姓名、职务、所属部门、账号形态
- \`system\`：技术栈、版本、中间件、报错信息、登录入口
- \`all\`：以上全部，按 assets → system → contact → people 的顺序推进

目标清单为空时，先读 Task 定义与已有图记忆，不要凭空猜目标；确实无法确定时提交 partial 并说明缺什么。

# 二、搜集回路（核心）
每一轮就是一次 \`osint_search\`，一轮内并发多条查询变体（上限 {{options.maxQueriesPerRound}} 条）：

1. **广撒**：目标域名 \`site:\` 查询 + 组织全名 + 联系方式类措辞。
2. **读结果**：从标题与摘要里抽出**实体**——下属域名、组织全称、邮箱形态、人名、技术指纹。这是下一步的查询词。
3. **实体枢转**：把上一轮抽到的实体作为新查询词。护网式的推进顺序是：组织主体 → 备案/域名 → 子域/IP → 邮箱与账号 → 人员与联系方式 → 入口系统。
4. **收敛**：对已经出现的候选做交叉验证。
5. **补漏**：针对仍无证据的问题定向查询，或如实声明源失败。

停止条件（任一满足即停止并提交）：
- 本轮目标已达成
- 源调用达到预算（{{options.maxSourceCalls}} 次）
- **连续两轮没有新增实体** —— 不要靠换措辞刷 turn

# 三、结果的可靠性（这一段决定结论对不对）
\`osint_search\` 会为每个引擎给出覆盖状态。**你必须读它，并区别对待**：

| 状态 | 含义 | 你能得出的结论 |
|---|---|---|
| \`ok\` | 有结果且通过校验 | 可作为线索 |
| \`no_results\` | 200 且确实为空 | **唯一可作为负面证据的状态** |
| \`operator_unsupported\` | 返回了结果但无视 \`site:\` | 该引擎不能用于域枚举；结果已丢弃 |
| \`irrelevant\` | 有结果但缺少查询判别性词 | 该引擎答的是另一个问题 |
| \`blocked\` | 验证码/反爬 | 换引擎或降速；**不是"目标没有"** |
| \`error\` | 网络失败、超时 | 重试；**不是"目标没有"** |

三条硬规矩：
1. **源失败 ≠ 资产不存在。** 只有 \`no_results\` 能支撑"公开互联网上没有"这种结论，而且只能覆盖你实际查过的引擎与措辞。
2. **单源不算确认。** 一个事实要两个独立来源，否则标 \`unconfirmed\`。这条由 {{options.crossSourceConfirmation}} 控制，开启时必须遵守。
3. **搜索引擎摘要只是线索。** 要作为结论记录的联系方式、人名、系统指纹，应当用 \`web_fetch\` 打开页面确认（{{options.readPages}}）。

Sogou 限速很快，连续几轮后可能整轮 \`blocked\`——这是正常的，换 360 继续，不要重复打同一个引擎。

# 四、网页搜索与页面读取
- \`osint_search\` 是主力。它遵循 \`site:\`、做引擎自有域过滤、并解开跳转包装。
- \`web_search\` 是通用后备，**它的 Bing 后端无视 \`site:\`**，用它做域枚举会得到看似完整的错误结果。要用就先确认返回结果真的落在目标域上。
- \`web_fetch\` 读具体页面。结果是正文转 markdown，用它核实摘要里的说法。
- 不要用 bash 去访问公网——这个 Agent 的沙箱是 scope 门控的，对目标之外的主机不通。

# 五、写图记忆（每轮结束时一次）
用 \`osint_memory_write\` 把这一轮**得出的结论**写进长期记忆，而不是把搜到的每条结果都写进去。

- 一条 finding = 一个实体结论："这家公司持有这个域名"、"这个邮箱属于该组织"、"这台主机跑 nginx"。
- \`kind\` 取值：org / person / email / account / phone / host / ip / service / document。
- **关系靠字段表达，不靠同批出现**：写 email 时若知道属于谁，填 \`person\`；写 host 时若知道归属主体，填 \`owner\`。同一次调用里出现两个实体**不代表它们相关**，不要靠共现建立关系。
- \`provenance\` 填你实际依据的来源（url/title/source）。没有来源的结论不要写。
- \`confidence\` 如实填：\`observed\`（页面上直接看到）、\`inferred\`（从多个线索推断，如邮箱格式）、\`unconfirmed\`（单一弱线索）。**推断出的账号格式必须写 inferred，不能写 observed。**
- 目标侧主机若不在授权 scope 内，系统会自动降级为待确认线索，你不需要自己过滤，但**必须在提交时说明哪些是 scope 外的**。

隐私：personalDataPolicy={{options.personalDataPolicy}}。开启脱敏时记忆里只存脱敏值与假名，原值不入图——这是设计如此，不要试图绕过。

# 六、不要做的事
- 不要向目标发起任何请求（扫描、爆破、目录枚举、漏洞验证）。需要这些就写进 TaskOutcome 交给 Planner。
- 不要把邮箱、账号、手机号写成待验证的凭据或口令——凭据侧有独立的 Agent。**公开信息里的邮箱不是密码。**
- 不要把搜索引擎摘要当作已验证事实记入记忆。
- 不要在源失败时编造"未发现"的负面结论。
- 不要为了凑数把每一个搜索结果都写成 finding。
- 不要重复调用相同查询；相同措辞换个引擎可以，原样重放不行。

# 七、交接
提交 TaskOutcome 时说明：
- 本轮**确认**了什么（附证据引用）
- 本轮**推断**了什么，依据是什么
- 哪些是 scope 外线索、哪些源失败导致覆盖不全
- 下一步建议（例如「发现 3 个登录入口，建议创建主动验证 Task」）

summary 必须能回答：查了什么目标、用了哪些引擎、哪些结论有两个独立来源、哪些问题仍未有证据。`;

/**
 * Built-in public-internet collection Specialist.
 *
 * Capability surface: credential storage, gateway diagnostics, FOFA and tunnel
 * management are removed outright, so "this Agent does not write credentials"
 * and "this Agent does not touch the target" are structural rather than
 * prompt-enforced. The author pins the two method invariants
 * (`writeGraphMemory`, `crossSourceConfirmation`); the operator owns the target
 * list, collection goal, personal-data policy and source selection; the Planner
 * can only move the collection volume inside the author's maxima.
 */
export const internetOsintSpecialist = defineSpecialist({
  id: INTERNET_OSINT_SPECIALIST_ID,
  name: "互联网信息搜集 Agent",
  description: "在公开互联网上被动搜集目标相关情报：资产与攻击面、组织与主体、身份与人员、系统信息，交叉验证后写入图记忆供后续任务复用。",
  whenToUse: "适用于已知目标线索（域名、组织名、人名、邮箱、手机号、系统指纹），需要在公开互联网上扩展攻击面、找出联系方式与人员、或确认技术栈的 Task。也适用于需要把上一轮搜集结果沉淀为可复用记忆的场景。不适用于：需要主动扫描或漏洞验证（交给通用 Executor）、需要爆破或凭据验证（交给爆破 Agent）、凭据泄漏库查询（后续独立 Agent）。",
  version: "1.0.0",
  prompt: {
    mode: "extend",
    content: INTERNET_OSINT_PROMPT
  },
  tools: {
    // Credential stores and FOFA are other Specialists' channels; FOFA is also
    // scope-gated active asset search, which would break the passivity guarantee
    // this Agent's prompt makes. Connectivity management is tunnel state, which
    // information collection never needs.
    disableGroups: ["beekeeper", "credentials", "network_diagnostics", "fofa", "connectivity"]
  },
  skills: {
    mode: "allowlist",
    allow: ["osint-query-strategy", "osint-source-reliability"]
  },
  budget: {
    defaultMaxTurns: 18,
    maxTurnsCeiling: 28,
    epochTurnSlice: 14,
    epochTimeShare: 0.7
  },
  concurrency: {
    maxParallelTasks: 2
  },
  optionsMode: "planner",
  options: {
    targets: {
      type: "text",
      title: "目标清单",
      description: "要搜集的目标：域名、组织全名、人名、邮箱、手机号、系统指纹，一行一个。留空时 Agent 会先从 Task 定义与已有图记忆里确认目标。",
      default: "",
      maxLength: 4_000,
      placeholder: "example.com\n某某科技有限公司\n张三 / zhangsan@example.com",
      authority: "user"
    },
    collectionGoal: {
      type: "enum",
      title: "搜集目标类型",
      description: "本轮要产出哪一类情报。all 会按 资产 → 系统 → 联系 → 人员 的顺序推进。",
      default: "all",
      options: [
        { value: "all", label: "全部" },
        { value: "assets", label: "资产与攻击面" },
        { value: "system", label: "系统信息" },
        { value: "contact", label: "联系方式" },
        { value: "people", label: "人员信息" }
      ],
      authority: "user"
    },
    personalDataPolicy: {
      type: "enum",
      title: "个人信息处理",
      description: "决定人员、邮箱、手机号如何进入长期记忆。脱敏档只把脱敏值与假名写入图，原值留在 artifact；关闭档完全不建立个人信息节点。",
      default: "masked-30d",
      options: [
        { value: "off", label: "不记录个人信息" },
        { value: "masked-30d", label: "脱敏，保留 30 天" },
        { value: "masked-7d", label: "脱敏，保留 7 天" },
        { value: "full-audited", label: "记录原值（全程审计）" }
      ],
      authority: "user"
    },
    minConfidence: {
      type: "enum",
      title: "最低记录置信度",
      description: "低于该档的结论不写入图记忆。inferred 适合邮箱格式这类推断；unconfirmed 会记入大量单源弱线索。",
      default: "inferred",
      options: [
        { value: "observed", label: "仅已观察（页面上直接看到）" },
        { value: "inferred", label: "含推断（推荐）" },
        { value: "unconfirmed", label: "含未确认的单源线索" }
      ],
      authority: "user"
    },
    readPages: {
      type: "boolean",
      title: "打开结果页面核实",
      description: "开启时会对候选结论用 web_fetch 读原页确认，而不是只依据搜索摘要。关闭会更快，但摘要里的说法不会被核实。",
      default: true,
      authority: "user"
    },
    sources: {
      type: "string-list",
      title: "启用的搜索引擎",
      description: "sogou 与 so360 遵循 site: 且中文结果准确，是主力；bing 无视 site:，仅作英文后备（结果会被 site: 合规校验拦下）。",
      default: ["sogou", "so360", "bing"],
      maxItems: 3,
      authority: "user"
    },
    excludeDomains: {
      type: "string-list",
      title: "排除的域名",
      description: "命中这些域（含子域）的结果会被丢弃。用于排除自己单位的域名、已知镜像站或搜索结果农场。",
      default: [],
      maxItems: 32,
      authority: "user"
    },
    maxMemoryNodes: {
      type: "number",
      title: "图记忆节点上限",
      description: "本次 Task 写入图记忆的节点上限。超出的部分按类型优先级淘汰（资产优先，联系方式最先丢弃），被淘汰的不会写入。",
      default: 2_000,
      minimum: 100,
      maximum: 5_000,
      integer: true,
      authority: "user"
    },
    maxRounds: {
      type: "number",
      title: "搜集轮次上限",
      description: "多轮搜集的最大轮数。每轮是一次 osint_search，含多条查询变体。",
      default: 4,
      minimum: 1,
      maximum: 12,
      integer: true
    },
    maxQueriesPerRound: {
      type: "number",
      title: "单轮查询变体上限",
      description: "一次 osint_search 里并发执行的查询条数。加大能在一轮里覆盖更多措辞，也更容易触发引擎限速。",
      default: 3,
      minimum: 1,
      maximum: 6,
      integer: true
    },
    maxResultsPerQuery: {
      type: "number",
      title: "单查询结果上限",
      description: "每条查询在每个引擎上保留的结果条数。",
      default: 8,
      minimum: 1,
      maximum: 20,
      integer: true
    },
    maxSourceCalls: {
      type: "number",
      title: "源调用预算",
      description: "本次 Task 允许的引擎调用总量，是比轮次更外层的投入边界。Sogou 限速较快，预算大时应优先分配给它之外的引擎。",
      default: 24,
      minimum: 1,
      maximum: 120,
      integer: true
    },
    writeGraphMemory: {
      type: "boolean",
      title: "写入图记忆（作者固定）",
      description: "固定为开启：搜集结果必须沉淀为可复用的图记忆，否则后续任务要重做同样的搜集。由 Agent 作者固定，不可配置。",
      default: true,
      authority: "author"
    },
    crossSourceConfirmation: {
      type: "boolean",
      title: "要求跨源确认（作者固定）",
      description: "固定为开启：单一来源的结论只能标记为 unconfirmed，不得当作已确认事实。由 Agent 作者固定，不可配置。",
      default: true,
      authority: "author"
    }
  }
});
