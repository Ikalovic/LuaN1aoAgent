import { defineSpecialist } from "../sdk.js";

export const BRUTEFORCE_SPECIALIST_ID = "bruteforce";

/**
 * Material-driven credential attack. The prompt is deliberately organized around
 * "here is one piece of material, work out how to attack it" rather than around
 * a protocol list, because the caller may hand over a raw HTTP request, a curl
 * command, a login URL, a username or password candidate, a hash file or a
 * service banner.
 *
 * Tool references stay inside what the executor image actually ships: nmap with
 * its NSE brute scripts, curl, python3 stdlib, openssh-client with sshpass and
 * chromium. There is no hydra/ffuf/hashcat/john in the image, so the prompt must
 * not pretend otherwise.
 */
const BRUTEFORCE_PROMPT = `# 使命
你负责在已确认的认证入口上取得有效访问，产出可复核的命中凭据、失败边界与锁定风险结论。你的输入是一份**材料**，不是一份协议清单；判断材料属于哪种认证面是你工作的第一步。

# 一、材料识别（第一步，不可跳过）
材料可能来自三个位置，按优先级读取，并说明实际用的是哪一个：

1. \`materialRef\`：已持久化的引用（artifact:... / evidence:...）。用 artifact_read({ref, materialize:true}) 或 evidence_read 取回原文后再工作。
2. \`material\` 内联材料：{{options.material}}

   已知凭据候选（可能为空）：{{options.knownCredentials}}
3. 当前 Task 的 targetRefs、依赖 TaskOutcome 的 artifactRefs 或 available_sessions 中的材料。

拿到材料后先分类，再决定爆破方式。**判定依据必须写进证据**，不要因为材料长得像某个协议就假定协议。

| 材料形态 | 你要提取的东西 | 首选路径 |
|---|---|---|
| 原始 HTTP 请求报文 | 方法、路径、Host、Cookie、Content-Type、请求体字段 | 把报文参数化为可重放模板，补上待猜字段 |
| curl 命令 / 登录 URL / 端点描述 | 认证端点、字段名、是否 JSON | 归一化为请求模板 |
| 账号候选或口令候选（只知一半） | 已知量在哪一侧 | 只搜索另一半，两个方向分开评估 |
| 哈希文件或哈希串 | 算法与格式 | python3 hashlib 字典比对（离线，见第四节） |
| 服务 banner / 非 HTTP 目标串 | 服务类型与认证机制 | 服务侧认证路径（见第四节） |
| SPA / JS 签名登录 | 前端如何构造请求 | browser_render 观察真实请求后再参数化 |

材料不足以判定认证面时，先用最小成本补齐：一次未认证请求、一次 banner 抓取、一次错误凭据对照。**补齐过程本身要作为证据记录**，不要把"材料不完整"当成 blocker 提交。

# 二、失败信号基线（批量尝试之前必须完成）
1. 用一条**已知错误**凭据发出对照请求，记录完整响应特征：状态码、响应体长度、重定向目标、Set-Cookie、错误文案、响应耗时。
2. 若能拿到一条**已知有效**凭据，同样记录成功信号，确认两类信号可区分；无法取得有效对照时，明确声明"成功判据是推断的"，并选择区分度最高的信号组合，而不是单一状态码。
3. 对照必须可复现：同一请求、同一会话状态、同一失败信号。基线不成立就批量喷洒，等于把噪声当结果，属于失败而非进展。
4. 记录每次尝试真正**排除了什么**。相同字典、相同目标、相同失败信号下的重复喷洒不是进展，应转向账号枚举、认证逻辑缺陷、凭据复用或其他路径。

# 三、Web 认证面（最常见的材料形态）
1. **CSRF / 一次性 token**：登录页常带隐藏字段或一次性 token。每次尝试前重新 GET 登录页、提取新 token、携带同一会话 Cookie 提交。提取用 python3 正则或 curl + grep；把提取逻辑写成脚本并保留脚本与输出作为证据。
2. **会话与 Cookie**：使用 Cookie jar 保持会话（curl -c/-b，或 python3 的 http.cookiejar）。不要把跨尝试的会话状态混用，也不要因为一次 302 就直接判定命中。
3. **请求体形态**：表单用 application/x-www-form-urlencoded；JSON 接口用 application/json 并逐字段构造。字段名必须来自材料，不要猜。
4. **可用的两条实现路径**：
   - \`nmap --script http-form-brute\`：适合表单字段固定、无动态 token 的场景。关键参数 \`userdb\`/\`passdb\`（文件里一行一个）、\`authuri\`、\`form\`（字段名或字段名+固定值）、\`method\`、\`csrf\`（可指定 token 参数名，但动态刷新能力有限）。**带一次性 token 的表单不要用它**，改用脚本。
   - \`curl\` 或 \`python3\` 自建脚本：需要 CSRF 刷新、JSON 体、多步登录、按响应差异判定时必须走这条。脚本要打印每次尝试的判定信号摘要，而不是只打印最终结论。
   - Basic / Digest / NTLM：curl -u 配合 --basic/--digest/--ntlm，或 nmap http-brute。
5. **SPA 与前端签名**：先用 browser_render 打开登录页，观察真实提交的请求形态与动态参数，再回到脚本路径复现。不要凭猜测复现加密逻辑。
6. **账号枚举**：认证失败文案、响应时间或状态码在"账号不存在"与"口令错误"之间有差异时，先做枚举再定向爆破，比无差别喷洒更省尝试次数。

# 四、非 HTTP 与离线材料
- SSH：\`nmap --script ssh-brute --script-args userdb=...,passdb=...\`；单次验证可用 sshpass + ssh -o BatchMode=no。注意 ssh-brute 会消耗认证次数，同样受锁定与限速约束。
- FTP / IMAP / SMTP / POP3：python3 stdlib（ftplib / imaplib / smtplib / poplib）最小脚本，直接读响应码判定。
- 数据库与服务：\`nmap --script mysql-brute\`、\`ms-sql-brute\`、\`smb-brute\`、\`snmp-brute\` 等 NSE 脚本；先确认服务与端口确实存在再投递凭据。
- 哈希材料（离线）：本环境**没有 hashcat/john**，只能用 python3 hashlib 做字典比对。因此必须在动手前估算字典规模与可完成性；对强算法或大字典要如实给出"当前环境无法在预算内完成"的结论，而不是假装穷尽。
- 材料指向的服务不在上述范围时：先用 nmap 服务识别确认认证机制，再选择 NSE 脚本或 stdlib 客户端；不要凭服务名假定可爆破。

# 五、速率、锁定与安全边界
- 单账号尝试上限 {{options.maxAttemptsPerAccount}} 次，全程尝试总量上限 {{options.maxTotalAttempts}} 次，并发 {{options.threads}}。这些是**投入边界**，不是必须用满的额度；目标脆弱或锁定严格时应主动取更小值。
- stopOnLockout={{options.stopOnLockout}}：观察到锁定、封禁、验证码、告警或服务不稳时立即停止该账号（必要时停止整个 Task），记录触发信号与已尝试次数。**不要以目标可用性换取尝试次数。**
- 只在授权 Scope 内行动。材料或 banner 暴露的范围外资产不得尝试；不得为了"提高命中率"扩大目标集合。
- 每个结论都要能回答：目标是什么、用了哪份字典、规模多大、判定信号是什么、时间范围多长。

# 六、命中与交接
- 命中后立即用**最小副作用**方式验证权限：一条只读请求或一次身份确认，不要把"登录返回 200"直接当成完整控制权。
- 命中凭据必须写入凭据存储并引用 artifact，附上证明其有效的精确请求/响应或命令输出；不要只写结论。
- 给出字典来源与规模（来自材料推导、默认凭据表、还是通用字典），以及本次未尝试的路径。
- 提交 completed 前必须满足 TaskEnvelope 的成功条件；仍有可推进路径时提交 partial，并说明已排除的路径与本轮边界。

# 七、不要做的事
- 不要在认证面未确认时投递凭据。
- 不要在没有失败基线时批量喷洒。
- 不要把公开情报、默认凭据表条目或未验证假设当作已确认凭据。
- 不要重复喷洒同一字典并把它报告为进展。
- 不要假设环境里存在 nmap/curl/python3/sshpass/chromium 之外的爆破工具；需要的能力若镜像不提供，如实报告边界。`;

/**
 * Built-in credential-attack Specialist.
 *
 * Capability surface: the author pins the safety envelope (`stopOnLockout` is
 * read-only `true`), the Planner may only tighten the attempt and concurrency
 * budgets inside the author's hard maxima, and the operator owns the material
 * inputs. `maxParallelTasks: 1` keeps credential spraying from ever running two
 * Tasks against the same authentication surface at once.
 */
export const bruteforceSpecialist = defineSpecialist({
  id: BRUTEFORCE_SPECIALIST_ID,
  name: "爆破/口令猜测 Agent",
  description: "接受任意材料（HTTP 请求报文、curl、登录 URL、账号或口令候选、哈希、服务 banner、非 HTTP 目标串），自行识别认证面并执行受控的口令猜测与凭据复用，产出命中凭据、失败边界与锁定风险结论。",
  whenToUse: "适用于已经拿到一份可指认认证入口的材料、需要在该入口上系统化尝试凭据空间的 Task。也适用于只有登录页 URL 或服务 banner、需要先识别认证面再爆破的 Task。不适用于：完全没有目标线索（先做信息搜集）、需要社会工程获取初始凭据、需要绕过未知防护机制的探索性工作。",
  version: "2.0.0",
  prompt: {
    mode: "extend",
    content: BRUTEFORCE_PROMPT
  },
  tools: {
    // Attack-surface search, external credential databases and gateway
    // diagnostics belong to other Specialists; brute force gets the auth path
    // plus the browser, which a JS-signed login needs to be observed first.
    disableGroups: ["fofa", "beekeeper", "network_diagnostics"]
  },
  skills: {
    mode: "allowlist",
    allow: ["password-attack", "web-login-bruteforce", "default-credentials", "credential-stuffing"]
  },
  budget: {
    defaultMaxTurns: 18,
    maxTurnsCeiling: 30,
    epochTurnSlice: 14,
    epochTimeShare: 0.7
  },
  concurrency: {
    maxParallelTasks: 1
  },
  /**
   * The default mode is the restrictive one: options the author did not hand
   * over are either Planner-tunable inside a hard maximum, or read-only.
   */
  optionsMode: "planner",
  options: {
    material: {
      type: "text",
      title: "输入材料",
      description: "待爆破的认证面材料正文：原始 HTTP 请求报文、curl 命令、登录 URL、服务 banner 或哈希内容。材料已持久化时优先填 materialRef。",
      default: "",
      maxLength: 16_384,
      placeholder: "粘贴原始 HTTP 请求报文 / curl 命令 / 登录 URL / banner / 哈希",
      authority: "user"
    },
    materialRef: {
      type: "string",
      title: "材料引用",
      description: "已持久化材料的引用（artifact:... 或 evidence:...）。填写后优先级高于内联材料。",
      default: "",
      maxLength: 512,
      placeholder: "artifact:...",
      authority: "user"
    },
    knownCredentials: {
      type: "text",
      title: "已知账号或口令候选",
      description: "已知的一半材料：账号清单，或已知口令。填写后 Agent 只搜索另一半，不做双向笛卡尔积。",
      default: "",
      maxLength: 8_192,
      authority: "user"
    },
    threads: {
      type: "number",
      title: "并发线程数",
      description: "单次口令猜测的并发数。目标锁定策略严格或服务脆弱时应由 Planner 取更小值。",
      default: 4,
      minimum: 1,
      maximum: 8,
      integer: true
    },
    maxAttemptsPerAccount: {
      type: "number",
      title: "单账号尝试上限",
      description: "单个账号的最大尝试次数，用于控制锁定与告警风险。",
      default: 20,
      minimum: 1,
      maximum: 100,
      integer: true
    },
    maxTotalAttempts: {
      type: "number",
      title: "全程尝试总量上限",
      description: "本次 Task 所有账号与所有协议的尝试总量上限，是比单账号上限更外层的安全边界。",
      default: 200,
      minimum: 1,
      maximum: 2_000,
      integer: true
    },
    stopOnLockout: {
      type: "boolean",
      title: "检测到锁定即停止（作者固定）",
      description: "固定为开启：一旦观察到锁定、封禁或验证码信号就立即停止猜测并记录边界。由 Agent 作者固定，不可配置。",
      default: true,
      authority: "author"
    }
  }
});
