---
name: osint-source-reliability
description: How to read coverage and failure signals from public-internet sources so a failed lookup is never reported as an absent fact — per-engine behaviour and operator support, what counts as negative evidence, when a source is a validator rather than a collector, rate limits and anti-bot shapes, and the cross-source confirmation rule. Use when interpreting osint_search coverage output, when a collection round returned nothing, or before recording a negative finding about a target. Do not use it for target-side validation, which requires active testing.
license: MIT
compatibility: Requires the internet-osint Specialist's osint_search and osint_memory_write tools. Works from any environment with third-party internet access.
allowed-tools: Bash Read Write Edit Glob Grep
metadata:
  user-invocable: "false"
---

# 源的可靠性

搜集任务里最贵的错误不是"没找到"，是**把没找到说成不存在**。这份技能讲怎么读源的反馈，以及什么情况下负面结论才成立。

## 一、覆盖状态必须逐个读

`osint_search` 为每个引擎单独给出状态。**不要只看 `results` 数组是否为空**——空数组有六种完全不同的原因：

| 状态 | 判据 | 能得出的结论 |
|---|---|---|
| `ok` | 至少一条通过 `site:` 合规与相关性门 | 可用线索 |
| `no_results` | HTTP 200 且确实没有结果 | **唯一可作负面证据的状态** |
| `operator_unsupported` | 返回了结果但全部偏离 `site:` 指定域 | 该引擎不能做域枚举；它没在回答你的问题 |
| `irrelevant` | 返回了结果但全部缺少查询判别性词 | 引擎答的是另一个问题 |
| `blocked` | 验证码、反爬页 | 无信息；换源或降速 |
| `error` | 网络失败、超时、4xx/5xx | 无信息；重试 |

**`blocked` 和 `error` 不是负面证据。** 把这两个状态写成"目标在公开互联网上没有痕迹"是这类任务里最严重的失真——它把一个网络故障变成了关于目标的断言。

### 实测的引擎行为

| 引擎 | 操作符 | 中文 | 备注 |
|---|---|---|---|
| Sogou | 遵循 `site:` | 准确 | **限速快**，连续数轮后整轮 `blocked`，属正常 |
| 360 | 遵循 `site:` | 准确 | 最稳，多轮任务优先 |
| Bing | **无视 `site:`** | 差，常返回词典页 | 仅作英文后备；结果会被合规校验拦下 |

Bing 的危险之处在于它的失败是**静默**的：返回 `success`、十条结果、URL 全部真实。只有 `site:` 合规校验能识别出来。

## 二、什么时候"没有"才算结论

负面结论成立必须同时满足：

1. 相关查询至少在一个引擎上返回 `no_results`（不是 `blocked`、不是 `error`）。
2. 查询本身覆盖了合理的措辞变体（组织全名、域名、引号短语）。
3. 结论的措辞**限定了范围**——"在 Sogou 与 360 上、用这三种措辞未发现 X"，而不是"X 不存在"。

第 3 条不是文字游戏。公开互联网的索引是不完备的：未收录 ≠ 不存在，删除过的页面仍可能存在于归档里，需要登录才能看到的页面根本不在索引内。

## 三、校验器不是采集器

有些源看起来能做枚举，实际上只能做确认。**用错方向会得到系统性错误结论**：

| 源 | 真实能力 | 误用后果 |
|---|---|---|
| GitHub 提交搜索 | 只支持精确 `author-email:<完整地址>`，不支持域后缀 | `author-email:@corp.com` 返回 0，会被误读成"该组织无人提交" |
| 泄漏库查询 API | 多数需要 API key + 域名所有权证明 | 未授权调用返回 401，会被误读成"无泄漏" |
| 企业信息平台 | 数据接口需登录且有反爬 | 页面拿到但数据为空，会被误读成"无此主体" |

判断方法：**如果一个源的查询语法要求你提供完整精确值，它是校验器。** 采集器接受部分信息并返回候选。

## 四、单源不算确认

一个事实要**两个独立来源**才算确认，否则标记为 `unconfirmed`。

"独立"的判定：
- 两个不同引擎收录**同一个页面** → 一个来源，不是两个。
- 同一个数据在不同聚合站上出现 → 取决于聚合站是否各自采集；多数只是转载，算一个。
- 组织官网自述 vs 第三方记录 → 两个来源。

**推断必须标记为推断。** 从 `zhangsan@corp.com` 推断出"该组织邮箱格式是 `名.姓@corp.com`"是合理推断，但它是 `inferred` 而不是 `observed`——你没看到第二个人的邮箱，你猜的。这条在下游很关键：凭据侧 Agent 会依据置信度决定哪些账号能直接试、哪些只能喷洒。

## 五、写入记忆前自检

调用 `osint_memory_write` 之前逐条问：

- 这条结论的**来源**是什么？没来源的不写。
- 它是 `observed` 还是 `inferred`？如实填。
- 两个人名相同但组织不同，是不是被当成一个人了？（系统按 姓名@组织 区分实体，所以写 person 时要填 `organization`）
- 这条是不是只是同一批搜索结果里的共现？**共现不是关系**——要知道"这个邮箱属于这个人"才填 `person` 字段。
- 目标侧主机在不在授权 scope 内？不在的会被自动降级为待确认线索，但提交时要说清楚。

## 六、预算与限速

- Sogou 触发限速后，**继续打它只会得到更多 `blocked`**。正确动作是切引擎，不是重试。
- 单轮查询条数越多越容易触发限速。目标明确时用少量精准查询优于大量泛查。
- 源调用预算是外层边界。预算耗尽时如实提交 partial，说明哪些问题因预算未覆盖——这比"再试一次"有价值。
