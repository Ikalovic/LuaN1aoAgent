---
name: osint-query-strategy
description: Query construction and entity pivoting for public-internet collection — how to use the site, inurl and filetype operators, which search engines actually honour which operators, how to turn one round's results into the next round's queries, and how to tell "change the wording" apart from "change the source". Use when collecting information about a target from public sources and the first query did not settle the question. Do not use it for target-side technical investigation, active scanning, or credential attacks.
license: MIT
compatibility: Requires the internet-osint Specialist's osint_search tool and web_fetch. Works from any environment with third-party internet access; never requires reaching the target itself.
allowed-tools: Bash Read Write Edit Glob Grep
metadata:
  user-invocable: "false"
---

# 查询构造与实体枢转

这份技能讲两件事：**一次查询怎么写**，以及**一轮结果怎么变成下一轮的查询**。搜集的推进力来自后者——同样的引擎、同样的预算，会枢转的人两轮能到的地方，不会枢转的人十轮也到不了。

## 一、操作符：先确认引擎支不支持

这是实测结论，不是通用建议。**同一个查询在不同引擎上语义完全不同**：

| 操作符 | Sogou | 360 | Bing（抓取路径） |
|---|---|---|---|
| `site:` | ✅ 正确 | ✅ 正确 | ❌ **完全无视** |
| 多词查询 | ✅ 语义匹配 | ✅ 语义匹配 | ❌ 塌缩成单个通用词 |
| 中文查询 | ✅ 准确 | ✅ 准确 | ❌ 常返回词典/翻译页 |
| `filetype:` / `inurl:` | 部分支持 | 部分支持 | 不可靠 |

**`site:` 是域枚举唯一的正确工具，而它只在 Sogou 和 360 上有效。** 在 Bing 上写 `site:example.com contact` 会得到「contact 这个词的词典释义」——十条格式完整、URL 真实、与目标毫无关系的结果。`osint_search` 的 `site:` 合规校验会把这批结果整批丢弃并报 `operator_unsupported`，所以你看到的是"这个引擎不能用"，而不是"目标域下没有这个页面"。

**推论**：域枚举永远不要只用一个引擎。Sogou 被限速时换 360，两个都不可用时才考虑降级。

### 常用查询形态

```
site:example.com                     # 该域下所有被收录页面
site:example.com -www                # 排除主站
site:example.com filetype:pdf        # 公开文档
site:example.com inurl:login         # 路径含 login
"某某科技有限公司"                     # 精确短语，避开分词
"@example.com"                       # 邮箱后缀形态
"某某科技有限公司" 联系电话              # 组织 + 联络意图
"某某科技有限公司" 招聘                 # 招聘页常含部门与邮箱格式
```

引号很重要：中文分词在不同引擎上差异很大，组织全名不加引号会被拆成碎片。

## 二、枢转：一轮结果变成下一轮查询

搜集的价值在于**沿着实体走**，而不是在同义词之间打转。每读完一轮结果，先列出这一轮新出现的实体，再决定下一轮查什么：

| 上一轮拿到 | 下一轮查什么 | 意图 |
|---|---|---|
| 组织全名 | `"<全名>" 官网`、`"<全名>" 备案` | 找到主体持有的域名 |
| 域名 | `site:<域名>`、`site:<域名> filetype:pdf` | 枚举该域内容 |
| 邮箱 `a@corp.com` | `"@corp.com"`、`"corp.com" 邮箱` | 收集同域其他账号与命名规则 |
| 用户名 `zhangsan` | `"zhangsan" "<组织>"` | 关联到人 |
| 人名 + 组织 | `"<姓名>" "<组织>" 邮箱`、`"<姓名>" 职务` | 联系方式与角色 |
| 页面里的技术指纹 | `"<指纹原文>"`、`site:<域名> inurl:admin` | 找同类入口 |
| CNAME / 证书 SAN | `<别名域>`、`site:<别名域>` | 发现旁站与历史域名 |

护网式的推进顺序（信息论上每一步都在缩小不确定性）：

```
组织主体 → ICP 备案/域名 → 子域与 IP → 邮箱与账号 → 人员与联系方式 → 入口系统
```

**每一轮都要能在结果里指出"我新学到了哪个实体"。** 指不出来就说明该停或该换源了。

## 三、换措辞还是换源

这是最容易做错的一步。判断依据是**失败的样子**，不是"有没有结果"：

| 现象 | 诊断 | 动作 |
|---|---|---|
| `no_results`（200 + 空） | 这个引擎确实没收录 | 换措辞，或换引擎再试 |
| `operator_unsupported` | 引擎不支持这个操作符 | **换源**，不要换措辞 |
| `irrelevant` | 引擎答的是另一个问题 | 换措辞（加引号、加限定词），或换源 |
| `blocked` | 被反爬拦了 | **降速或换源**；换措辞无效 |
| `error` | 网络失败 | 重试；不要当作"没有" |

**不要在 `blocked` / `error` 的状态下反复换措辞**——那是在跟限速较劲，不是在搜集。Sogou 连续几轮后会整轮返回验证页，这时该做的是切到 360 继续推进。

## 四、什么时候停下

三个条件，任一满足即停：

1. 本轮目标已达成（要的联系方式/资产清单都拿到了）。
2. 源调用预算用尽。
3. **连续两轮没有新增实体。**

第三条最容易被忽略。搜集任务失控的典型形态是：每一轮都返回一屏结果，看着很忙，但抽不出任何新实体——只是在用不同措辞问同一个已经问清楚的问题。这时候正确的动作是提交，并在 TaskOutcome 里说明**哪些问题仍然没有证据**，而不是继续烧预算。

## 五、中英文措辞差异

中文目标的公开信息大量存在于中文引擎的索引里，英文措辞会系统性漏掉：

- 组织信息优先用**全称 + 中文意图词**（联系电话、招聘、简介、官网）。
- 技术指纹、报错信息、代码与配置优先用**英文原文**（这些内容本身就是英文）。
- 邮箱、域名、IP、CVE 编号是语言无关的，直接查。
- 同一个事实中英文各查一次，是廉价的交叉验证手段——但不是两个独立来源（同一个页面被两个引擎收录只算一个来源）。
