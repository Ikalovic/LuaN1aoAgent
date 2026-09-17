# 互联网信息搜集 Agent —— 设计方案（v8）

- 状态：**P1 已实现**，P2–P6 待决策
- 日期：2026-09-16
- 演进：v5（10 工具 / 10 技能 / 护网全链路）→ v6（1 工具 / 2 技能，含**错误结论**）→ v7（更正结论）→ v8（P1 落地，对齐实现）
- 关联：`docs/superpowers/research/2026-09-16-recon-primitive-inventory.md`、`docs/superpowers/research/2026-09-16-recon-data-sources-survey.md`

---

## 0. 结论更正记录

v6 的核心论点是「`web_fetch` 100% 失效 + 搜索引擎返回随机垃圾」。**这两个结论都是在 Clash 开启状态下测得的，Clash 关闭后不成立。** v7 已更正；v8 追加更正 v7 的 IPv6 结论。

| 结论 | 实际情况 |
|---|---|
| v6：`web_fetch` 7/7 全部抛错 | **Clash 开着时才这样。** 关闭后 `rdap.org`、`urlscan.io`、`rfc-editor.org` 全部 200 且内容诚实 |
| v6：搜索引擎返回随机无关结果 | **Clash 开着时**确实如此。关闭后不再随机，但暴露了更本质的问题（见 §1.1） |
| v6：`198.18.0.0/15` 拦截是 P0 阻塞 | **降级为 P6 健壮性修复**。仍会让所有 Clash 用户（本项目受众常态）的 `web_fetch` 全废，但不阻塞开发 |
| v7：IPv6 无路由需客户端优先 IPv4 | **已撤销**，见 §1.3。默认解析顺序下三个引擎全部正常 |

保留下来的结论：**「`web_search` 会报 `success: true` 却给出无用结果」成立**，且原因比 v6 写的更具体（Bing 无视 `site:`）。这是 `osint_search` 存在的理由。

---

## 1. 已确认的产品缺陷

### 1.1 `web_search` 的主力后端对 OSINT 无用，但报告成功

Clash 关闭后复测 Bing（`www.bing.com` 与 `global.bing.com` 均测）：

| 查询 | Bing 返回 |
|---|---|
| `site:example.com contact` | IMDb《Contact (1997)》、剑桥词典 "CONTACT"、Merriam-Webster |
| `香农熵 定义` | 知乎「买卖基金…费用更低」「怎么查基金的PE百分位」 |

结论：**Bing 的抓取路径完全无视 `site:` 操作符，且把多词查询塌缩成单个通用词的词典/词条匹配。**

`site:` 是 OSINT 最重要的操作符（枚举目标域下所有页面）。而现有 `searchPublicWeb` 在拿到这 10 条结果时返回：

```json
{ "success": true, "backend": "bing_html", "results": [ …10 条… ] }
```

**没有 `site:` 合规性检查，没有相关性门，没有污染标记。** 这是必须修的产品缺陷：对 OSINT 而言，「返回了结果但结果不是目标域的」比「没有结果」危险得多。

### 1.2 跳转包装导致 URL 不可用、去重失效

三个引擎都返回包装 URL：

| 引擎 | 形态 | 能否无状态解开 |
|---|---|---|
| Bing | `bing.com/ck/a?...&u=a1<base64url>` | **能**，base64url 解码 |
| Sogou | `/link?url=<opaque>` | **不能**，无会话时 302 → `/` |
| 360 | `so.com/link?m=<opaque>` | **不能**，无会话时 400 |

但实测 **SERP HTML 内联了真实 URL**：360 的响应里可直接抽出 `https://example.com/`、`https://example.com/index.html`；Sogou 的 `<cite>` 显示真实域名。

→ 实现要求：**从 SERP 标记里抽真实 URL（`data-mdurl` / `<cite>` / 显示域名），不依赖跟跳转。**

### 1.3 IPv6 有 AAAA 记录但无路由（v7 结论，已降级）

v7 认为这需要出网客户端显式优先 IPv4。Clash 关闭后复测，**该结论同样被推翻**：

```
                      verbatim(默认)        ipv4first
www.sogou.com         HTTP 200   244ms      HTTP 200    87ms
www.so.com            HTTP 200   162ms      HTTP 200    84ms
www.bing.com          HTTP 302   167ms      HTTP 302    74ms
example.com           HTTP 200   222ms      HTTP 200    66ms
html.duckduckgo.com   ERR ETIMEDOUT         ERR ETIMEDOUT
```

默认 `verbatim` 下三个引擎全部正常，`html.duckduckgo.com` 两种顺序都超时（该域在国内本就不通，与 IPv6 无关）。`ipv4first` 只带来 2–3 倍延迟收益，**不是正确性修复**，不值得为此加全局副作用。

→ 结论：**不做 IPv4 特殊处理**。保留的只是错误分类——网络失败与超时归入 `error`，绝不落入 `no_results`（已实现并有测试覆盖）。

---

## 2. 搜索引擎可用性实测矩阵（Clash 关闭后）

| 引擎 | 状态 | 遵循 `site:` | 说明 |
|---|---|---|---|
| **Sogou** | ✅ 200 / 288KB–684KB / ~1.1s | **是** | `site:example.com` → 正确返回唯一页面；`香农熵 定义` → 百度百科/知乎/原创力文档，全部切题。**但限速快**：连续数轮后返回验证页（已由 `blocked` 状态如实上报） |
| **360 (so.com)** | ✅ 200 / 229KB–450KB / ~0.8s | **是** | `site:example.com` → Example Domain；`香农熵 定义` → CSDN/简书，全部切题。实测最稳，多轮任务首选 |
| Bing | ⚠️ 200 / 96–107KB / ~0.4s | **否** | 无视 `site:`，多词塌缩为单词匹配（§1.1） |
| Brave | 需 API key | — | `.env` 无 `BRAVE_SEARCH_API_KEY`，P1 未接入 |
| DuckDuckGo | ❌ | — | 超时 + 反爬（`verbatim`/`ipv4first` 均如此） |
| Baidu | ❌ | — | 200 + 百度安全验证（1438B） |
| Yandex | ❌ | — | CAPTCHA + JS 要求 |
| Startpage | ❌ | — | 超时 |
| Mojeek | ❌ | — | 403 |
| Ecosia | ❌ | — | JS 壳，0 结果 |
| Marginalia | ❌ | — | 200 但 1KB 空页 |
| searx.be | ❌ | — | 超时 |

**结论：`osint_search` 的主力后端应当是 Sogou + 360。**（P1 已按此实现。）这两个恰好也是中文目标（护网场景）最对口的源。Bing 保留为门控后备。

其余可用源（实测内容诚实，Clash 关闭后）：`rdap.org`、`urlscan.io` API、`rfc-editor.org`；`crt.sh` 表现不稳（同一会话内先返回正确 CT 记录、一分钟后 `fetch failed`），**需要重试策略，不能单次失败即判源不可用**。

---

## 3. 设计

### 3.1 定位

Planner 下发信息搜集 Task（给定域名、组织名、人名、邮箱、手机号、系统指纹等），本 Agent 通过**多轮查询**在公开互联网上找出目标相关的资产、人员、联系方式、系统信息，产出结构化发现交给 Planner。

不在范围内：漏洞利用、主动扫描、凭据提取与入库（凭据侧拆给后续独立 Agent）。

### 3.2 工具层

#### `osint_search`（核心新工具）

一次调用 = 一轮：输入一批查询变体，而不是一条查询。

```
osint_search({
  queries: string[],     // 1–6 个变体，一轮内并发（引擎间并发，同引擎内串行）
  engines?: ("sogou" | "so360" | "bing")[],
  maxResults?: number    // 1–20，默认 8（每引擎、每查询过滤后的上限）
})
```

**相对 v7 的偏离**：去掉了 `focus` 枚举与 `excludeDomains`。`focus` 的查询模板本质是提示词知识，放技能里比做成工具参数更合适；工具只负责「一次跑一批查询并诚实汇报每个源的覆盖度」，保持单一职责。

返回结构沿用仓内既有范式（`searchVulnerabilities` 已确立 coverage + resultClass + negativeSignalStrength + evidenceSummary）：

```jsonc
{
  "success": true,
  "resultClass": "direct_hit | mention_hit | no_public_hit | source_failure",
  "negativeSignalStrength": "none | weak",
  "queries": ["site:example.com", "example.com contact"],
  "sourceCoverage": {
    "sogou": { "status": "ok", "hits": 12, "kept": 8,
               "reason": "2 further result(s) dropped by site: compliance or the relevance gate" },
    "so360": { "status": "ok", "hits": 9,  "kept": 7 },
    "bing":  { "status": "operator_unsupported", "hits": 20, "kept": 0,
               "reason": "all 10 parsed result(s) are off the domain named by the site: operator" }
  },
  "results": [ { "title", "url", "displayUrl", "snippet", "engine", "query",
                 "relevance": "site_match | token_match",
                 "flags": ["engine_flagged_unreachable", "path_truncated"] } ],
  "droppedCounts": { "bing:site_mismatch": 10, "so360:engine_property": 3 },
  "evidenceSummary": "...",
  "recommendedNextSteps": ["..."]
}
```

五个代码级机制（不是提示词约束）：

1. **`site:` 合规校验** —— 查询含 `site:X` 时，逐条检查结果 URL 主机是否为 X 或其子域，使用与 `src/scope.ts:25-36` 一致的点锚定后缀语义（`hostMatchesDomain`，有测试锁定 `notexample.com` 与 `example.com.evil.net` 均不匹配）。存在 `site:` 时它同时充当充分判据，不再叠加 token 匹配。
2. **相关性门** —— 无 `site:` 时取查询判别性 token，全部不出现即判 `irrelevant`。中文有独立的语篇停用词表（`定义`/`介绍`/`信息`/`教程` 等）——这是实测驱动的：保留 `定义` 会让一篇讲「香道」的知乎文章命中「香农熵 定义」。**联络类名词（电话/邮箱/联系/地址）刻意不做停用词**，它们正是联络搜集的枢转词。
3. **引擎自有域过滤** —— 360 会把自己的垂直频道（`image.so.com`/`tv.360kan.com`/`ai.so.com`）混进结果容器。主机命中引擎自有域的结果丢弃并计为 `engine_property`，避免把搜索引擎的导航当成目标的发现。
4. **URL 归一化与去重** —— Bing `ck/a?u=a1<base64url>` 解码（保留为防御，实测该包装只在代理路径下出现）；360 取 `data-mdurl`（`/link?m=` 无 cookie 时返回 400）；Sogou 取 cite 中形似 URL 的 span（其首个 span 是站点名，且路径常被截断为 `...`，截断时打 `path_truncated` 标记）；剥离跟踪参数后跨引擎去重。
5. **失败语义**（只有 `200 + 空` 是负面证据）：

| 状态 | 判据 |
|---|---|
| `ok` | 至少一条通过全部过滤 |
| `no_results` | 200 且解析结果为空 —— **唯一可作为负面证据的状态** |
| `operator_unsupported` | 有解析结果但全部因 `site:` 不合规被丢弃 |
| `irrelevant` | 有解析结果但全部缺少查询判别性 token |
| `blocked` | 反爬特征：验证码文案、`百度安全验证`、`enable javascript` 等 |
| `error` | 网络失败、超时、HTTP 4xx/5xx、解析异常 |

`operator_unsupported` 与 `irrelevant` 必须分开：前者是引擎能力缺失（无视操作符），后者是引擎答了另一个问题，两者处置方式不同。

#### 实测表现（真实网络，非 fixture）

| 场景 | 耗时 | resultClass | 结果 |
|---|---|---|---|
| `site:example.com` + `example.com contact` | 1.3s | `direct_hit` | 9 条；Bing 20 条中 19 条被门控丢弃 |
| `香农熵 定义` + `香农熵 信息熵` | 1.3s | `mention_hit` | 10 条；Bing 20 条全判 `irrelevant` |
| `site:example.com filetype:pdf` | 1.2s | `no_public_hit` | 0 条；Sogou 报 `blocked`、360 报 `no_results`、Bing 报 `operator_unsupported` |

最后一行正是设计目的：三种不同的「没有结果」被如实区分，而不是塌缩成一个空数组。

#### 已知运行约束

**Sogou 限速很快**：连续数轮「3 查询 × 3 引擎」后即返回验证页。工具如实报 `blocked`（这是设计生效，不是缺陷），但意味着高频多轮任务应优先用 360，或降低单轮查询数。

#### `osint_fetch` / `osint_extract`（已决定不做）

P1 决策为都不做：抽取交给模型，重试合进 `web_fetch`。保留为后续可选项。

### 3.3 sandbox 与公网能力

决策：**保留 sandbox，同时放开公网访问能力**。这样 Agent 可以用 `curl` / `python3` 直连 Sogou、360、CT、RDAP，这是 OSINT 最灵活的路径；`osint_*` 工具则作为确定性/覆盖度层，而不是唯一通道。

当前 sandbox 是 scope 门控的，需要两处改动：

| 位置 | 现状 | 需要 |
|---|---|---|
| `network-image/gateway-tun/route_proxy.go:174-195` `directAllowed()` | 只放行 `allowPrefixes`（授权 scope CIDR） | 增加 per-run 的「公网放行」标志：目标 IP 属公网则放行；`denyPrefixes` 与基础设施端点保护不变 |
| `network-image/scope_dns.py:49-50` | scope 外域名一律 REFUSED (rcode 5) | 公网域名正常解析；仅内部/保留域名拒绝 |

**这是实质性的安全放松，必须 per-run 且仅限本 Agent 的 run mode**，不能成为全局默认。授权 scope 仍然生效（scope 内目标照常可达）；放松的只是「非 scope 的公网地址」这一档。

**待确认**：`ipset` 那侧的 fail-closed 守卫（`directAllowed` 注释里提到的 "task namespace's fail-closed ipset guard"）在 `allowDomainResolved=false` 的路径上如何配合，需要在实现前读通 `main.go` 与 `routeStore`。

### 3.4 Agent 定义

```
id: internet-osint
name: 互联网信息搜集 Agent
version: 1.0.0
tools.disableGroups: ["beekeeper", "credentials", "network_diagnostics", "fofa"]
skills.allow: ["osint-query-strategy", "osint-source-reliability"]
budget: 18 / 28 / 14 / 0.7
concurrency.maxParallelTasks: 2
optionsMode: "planner"
```

保留 `sandbox`（§3.3）与 `browser`。关闭 `beekeeper` / `credentials`：本 Agent 不写凭据，工具表里不存在凭据存储调用，「不会写凭据库」是结构性保证。关闭 `fofa`：FOFA 是 scope 门控的资产搜索通道，与本 Agent 的公网搜集职责不重叠，且需要 key。

`osint` 工具组（P1 已落地）提供 `osint_search`，是本 Agent 的核心能力；它在 `executorToolBindings()` 中随所有 Executor 一起装配，由 `disableGroups` 决定是否裁剪——与 `fofa` / `beekeeper` 等组同构。

选项（`optionsMode: "planner"`）：

| key | 类型 | 权限 | 默认 | 说明 |
|---|---|---|---|---|
| `targets` | text | user | `""` | 目标清单（域名/组织/人名/邮箱/手机号/指纹），maxLength 4000 |
| `collectionGoal` | enum | user | `all` | `assets` \| `contact` \| `people` \| `system` \| `all` |
| `personalDataPolicy` | enum | user | `masked-30d` | `off` \| `masked-30d` \| `full-audited` |
| `sources` | string-list | author | `["sogou","so360","bing"]` | 启用的搜索引擎 |
| `maxSourceCalls` | number | planner | 20（1–60） | 本轮源调用上限 |

### 3.5 多轮交互回路（本 Agent 的实际价值）

Planner 只给目标，查询策略由 Agent 承担。每一轮就是一次 `osint_search` 调用，一轮内并发若干查询变体：

```
第 1 轮  广撒：目标域名 site: 查询 + 组织全名 + 「联系电话」类措辞
   ↓ 读结果，抽出实体（域名、组织全称、邮箱形态、人名、系统指纹）
第 2 轮  实体枢转：把上一轮抽到的实体作为新查询词（人名 + 组织、@domain 邮箱形态、指纹措辞）
   ↓
第 3 轮  收敛：对候选做交叉验证（同一事实两个独立源）
   ↓
第 4 轮  补漏：针对尚未拿到证据的问题定向查询，或如实声明源失败
停止     成功条件满足 / 源预算耗尽 / 连续两轮无新增实体
```

三条硬规则（写进提示词，因为工具无法强制）：

1. **源失败 ≠ 资产不存在**。只有 `no_results` 是负面证据；`blocked` / `error` / `operator_unsupported` / `irrelevant` 都不是。
2. **单源不算确认**。一个事实需两个独立源，否则标 `unconfirmed`。
3. **连续两轮无新增实体就停止**，不要靠换措辞刷 turn；Sogou 限速会让刷查询更快失效。

### 3.6 产出契约（Planner 消费的部分）

1. **`task_result_submit`** —— `summary` 写结论，`evidenceRefs` 引用工具事件，`artifactRefs` 引用下面的 Artifact。
2. **`artifact_write(kind="report")` → `osint-findings.json`**：

```jsonc
{
  "target": "原始目标",
  "findings": [
    {
      "kind": "phone | email | account | person | org | host | ip | service | version | doc | lead",
      "value": "…",
      "confidence": "observed | inferred | unconfirmed",
      "personalData": true,
      "masked": true,
      "provenance": [
        { "url": "…", "title": "…", "snippet": "…", "source": "sogou", "observedAt": "…" }
      ]
    }
  ],
  "sourceCoverage": { "…": { "status": "ok", "hits": 3 } },
  "negativeFindings": [ { "claim": "…", "basis": "200 + 空结果", "sources": ["…"] } ],
  "openQuestions": ["…"]
}
```

Planner 用法：`kind ∈ {host, ip, service, version}` 用于资产枢转；`email` / `account` 交给凭据侧 Agent；`phone` / `person` 作为线索。

---

## 4. 技能（2 个）

| 技能 | 内容 |
|---|---|
| `osint-query-strategy` | 查询改写与实体枢转：`site:` / `inurl:` / `filetype:` 用法与**哪些引擎不支持哪些操作符**、中英文措辞差异、何时换措辞何时换源、联络与人员信息的枢转模板（这些模板刻意放在技能里而不是做成工具参数） |
| `osint-source-reliability` | 逐源可靠性：引擎操作符支持矩阵、反爬与污染识别、负面证据成立条件、交叉验证要求 |

**注意**：`templates/specialists/recon-lite/specialist.json` 里 `skills.allow` 列的 `port-scan` / `subdomain-enum` / `fingerprint` 三个技能**在仓库中并不存在**，那是空知识面。本 Agent 的两个技能必须连同正文一起落地。

---

## 5. 验证方案

### 5.1 P1 已实现（`test/osint-search-tools.test.ts`，19 项，全部通过）

测试全部由 `test/fixtures/osint/` 下的**真实 SERP 响应**驱动，依赖注入 `fetch`，不打真实网络。

| 用例 | 断言 |
|---|---|
| `site:` 合规 | Bing 对 `site:example.com contact` 的真实返回 → 10 条整批判 `operator_unsupported`，`droppedCounts["bing:site_mismatch"] === 10` |
| 引擎遵循 `site:` | Sogou/360 的真实返回 → `direct_hit`，全部结果主机属于 `example.com` |
| 360 真实 URL | 取 `data-mdurl` 而非会话绑定的 `/link?m=` |
| 跨引擎去重 | Sogou 的 `http://example.com` 与 360 的 `https://example.com/` 归一化后只报一条 |
| 相关性门 | 中文查询打到英文词典结果 → `irrelevant`，0 条保留 |
| 引擎自有域 | 360 真实返回里的 `image.so.com`/`tv.360kan.com` 被丢弃，外部结果保留 |
| 负面语义 | `200 + 空` → `no_results` + `negativeSignalStrength: "weak"` |
| 源失败语义 | 全部 5xx → `source_failure`，`success: false`，不产生负面结论 |
| 反爬语义 | 验证码页 → `blocked`，不是 `no_results` |
| 网络失败语义 | `fetch` 抛错 → `error`，不计为「不存在」 |
| 查询归一化 | 去重、丢弃过短项、单次调用最多发出 6 条查询 |
| 包装解码 | 真实 Bing `ck/a?u=a1<base64url>` → 目标 URL |
| 域匹配点锚定 | `notexample.com`、`example.com.evil.net` 均不匹配 `example.com` |
| token 抽取 | 操作符去除；中文语篇词去除；联络类名词保留 |
| URL 归一化 | 剥离跟踪参数、统一大小写与 `www.`、非 HTTP 协议返回 `undefined` |

### 5.2 待实现（对应后续阶段）

| 用例 | 阶段 |
|---|---|
| fake-IP 放行 | P6（域名解析到 `198.18.0.163` → 放行；字面 `http://198.18.0.1/` → 拒绝） |
| 公网放行边界 | P2（断言 `denyPrefixes` 与基础设施端点在公网模式下仍被拒） |
| 产出契约 | P4（`osint-findings.json` 通过 schema 校验；`personalDataPolicy=off` 时不含个人信息字段） |

---

## 6. 分期

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | `osint` 工具组 + `osint_search`：Sogou/360/Bing 后端、`site:` 合规、相关性门、引擎自有域过滤、URL 归一化、覆盖度语义 | ✅ **已完成**（19 项测试，真实网络验证通过） |
| **P2** | sandbox 公网放行：`directAllowed()` per-run 标志 + `scope_dns.py` 公网解析 | 待开始 |
| **P3** | Agent 定义 + 提示词（多轮回路）+ 选项 | 待开始 |
| **P4** | `osint-findings.json` 契约 | 待开始 |
| **P5** | 两个技能正文 + 端到端实测 | 待开始 |
| **P6** | 健壮性修复：`web_fetch` fake-IP 放行（§0）、`web_fetch` 重试 | 可并行；IPv4 项已按 §1.3 撤销 |

### P1 交付物

| 文件 | 说明 |
|---|---|
| `src/tools/osint-search-tools.ts` | 新增，`osint_search` 工具与全部过滤/覆盖度逻辑 |
| `test/osint-search-tools.test.ts` | 新增，19 项测试 |
| `test/fixtures/osint/*.html` | 新增，5 份真实 SERP 响应（Sogou/360/Bing × site 查询与中文查询） |
| `src/specialists/types.ts` | `SPECIALIST_TOOL_GROUPS` 增加 `osint` |
| `src/agents.ts` | `createExecutorOsintTools()` + 接入 `executorToolBindings()` |

回归结果：922 项测试 / 919 通过 / 1 失败 / 2 跳过。唯一失败项为 `Beekeeper adapter`，原因是 `spawn .beekeeper-mcp-venv/bin/python ENOENT`（本机未建 Beekeeper venv），属既有环境问题，与本次改动无关。web 套件 129/129。

---

## 7. 待决策

1. **P6 的 fake-IP 修复是否要做**。它不影响开发（Clash 关掉即可），但会让所有 Clash 默认配置用户（本项目受众常态）的 `web_fetch` 全废。做 = 少量代码 + 明确取舍（字面 IP 恒拒、域名场景放行、范围可由 `LUANNEE_TRUSTED_PROXY_CIDRS` 覆盖）。
2. **护网主体测绘（ICP 备案反查、主体级 scope、`derivedRefs` 复活、互联网渲染器）确认移出**，作为后续独立方案。原因：需改动 `src/scope.ts` 的授权模型，风险与工作量远超「搜索驱动搜集」主线。

### 已决策（v7 阶段）

| 问题 | 决策 |
|---|---|
| sandbox 是否保留 | **保留**，并按 §3.3 放开公网能力 |
| 公网放行范围 | **允许任意公网 IP**，由 `denyPrefixes` 兜底内网与保留段 |
| `osint_extract` / `osint_fetch` | **都不做**；抽取交给模型，重试合进 `web_fetch` |
| 起点 | 先做 P1（已完成） |
