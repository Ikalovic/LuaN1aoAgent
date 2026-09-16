---
name: password-attack
description: Methodology for controlled credential guessing against an authentication surface — building a failure-signal baseline, choosing between password spraying, single-account exhaustion and credential reuse, detecting lockout/rate-limit/CAPTCHA boundaries, and verifying and handing off a hit. Use when the task is to obtain valid credentials for a known authentication entry point (web login, SSH, FTP, database, SMB, or an offline hash). Do not use it for attack-surface discovery (a login endpoint must already be identified or be identifiable from the supplied material), for exploiting authentication logic flaws that need no guessing, or for social engineering.
license: MIT
compatibility: Requires a filesystem-based agent with bash, curl, and Python 3. The executor image ships nmap with NSE brute scripts, curl, python3 (stdlib only), openssh-client with sshpass, and chromium; it does not ship hydra, medusa, ncrack, patator, ffuf, gobuster, hashcat or john.
allowed-tools: Bash Read Write Edit Glob Grep
metadata:
  user-invocable: "false"
---

# 口令攻击方法学

这份技能只讲"怎么把猜测做得可信"，具体协议的实现细节见 `web-login-bruteforce`，凭据来源见 `default-credentials` 与 `credential-stuffing`。

## 一、先确认认证面，再投递任何凭据

在第一次尝试之前必须能回答：认证端点是什么、认证字段是什么、失败信号是什么、有没有锁定与限速。

材料不足时用最小成本补齐，并把补齐动作本身记成证据：

```bash
# 端点是否存活、是否要求认证（401/403 与 200 的区别）
curl -sS -o /dev/null -w 'status=%{http_code} len=%{size_download} type=%{content_type}\n' http://TARGET/
# 服务与认证机制（不要凭端口号猜服务）
nmap -sV -Pn -p PORT TARGET
# 认证方法（HTTP 侧）
curl -sSI http://TARGET/ | grep -i '^www-authenticate'
```

## 二、失败信号基线（不可跳过）

用一条**已知错误**凭据建立对照，记录完整响应特征，而不是只看状态码：

```bash
curl -sS -o /tmp/bad.txt -D /tmp/bad.hdr -w 'status=%{http_code} len=%{size_download} time=%{time_total}\n' \
  -X POST http://TARGET/login -d 'user=nosuchuser&pass=nosuchpass'
head -20 /tmp/bad.hdr      # 重定向目标、Set-Cookie
wc -c /tmp/bad.txt         # 响应体长度
```

判定信号优先级（区分度从高到低）：

1. 响应体中"登录成功"才有的一次性字段（欢迎语、用户名回显、令牌、跳转目标）。
2. 重定向目标差异（成功跳 `/index.php`，失败跳 `/login.php`）——**这是最常用的可靠信号**。
3. 新增的会话 Cookie（`Set-Cookie` 里出现认证会话名）。
4. 响应体长度聚类（同一模板下成功页与失败页长度通常稳定不同）。
5. 状态码差异（很多系统成功失败都返回 200，最不可靠，单独使用会误判）。

能把 1–3 中任意两个组合起来就不要依赖 4–5。**无法取得已知有效凭据做正向对照时，必须在结论里声明"成功判据是推断的"**。

基线不成立就开始批量喷洒，等于把噪声当结论，属于失败而不是进展。

## 三、三种策略及其取舍

| 策略 | 形态 | 适用 | 代价 |
|---|---|---|---|
| 密码喷洒 password spraying | 少量常见口令 × 大量账号 | 有账号清单、锁定策略严格 | 命中率低，但每账号只试 1–3 次，最不容易触发锁定 |
| 单账号穷举 | 一个账号 × 大字典 | 已知目标账号且锁定宽松 | 最容易触发锁定与告警 |
| 凭据填充 credential stuffing | 已知 user:pass 配对跨系统复用 | 有泄露/配置/上游凭据材料 | 命中取决于复用率，见 `credential-stuffing` |

选择顺序（在同等代价下优先高收益）：

1. 已知有效凭据复用（材料里已有凭据，先验证它在这台机器上是否有效）。
2. 默认与产品文档凭据（见 `default-credentials`）。
3. 从目标线索推导的字典（产品名、域名、年份、单位缩写 + 常见后缀）。
4. 通用弱口令字典。
5. 只在 1–4 都排除后才考虑扩大字典规模。

**账号枚举优先于穷举**：如果"账号不存在"与"口令错误"的响应可区分（文案、长度、耗时），先枚举出有效账号，再对有效账号定向尝试。这通常比无差别喷洒少一个数量级的尝试次数。

## 四、锁定、限速与验证码

每个目标在动手前先判断防护类型，并把探测结果记成证据：

- **探测锁定**：对同一个明显不存在的账号连续尝试 3–5 次，观察是否出现锁定文案、响应时间阶梯上升、或开始返回 429/403。
- **探测限速**：连续快速请求，记录 `time_total` 是否阶梯上升、是否出现 `Retry-After`。

出现以下任一信号立即停止该账号（必要时停止整个任务）并记录触发点：锁定/封禁文案、验证码或人机校验、429/403 持续出现、认证服务响应变慢或报错、目标出现告警类文案。

**不要以目标可用性换取尝试次数。** 若任务要求"确保拿不到就继续加压"，这属于超出授权强度的要求，应提交 partial 并说明边界，而不是执行。

并发与尝试上限在运行期由 Agent 选项给出（`threads`、`maxAttemptsPerAccount`、`maxTotalAttempts`、`stopOnLockout`）。这些是**投入边界**，不是必须用满的额度。

## 五、命中之后

1. 用**最小副作用**方式验证：一条只读请求或一次身份确认（例如成功登录后请求一个需要认证的只读页面），不要执行任何写操作。
2. 记录精确证据：完整请求（脱敏后）、关键响应头、判定字段。
3. 把凭据写入凭据存储并引用 artifact；说明它有效的证据，而不是只写结论。
4. 立刻停止对该入口的继续尝试——命中之后继续喷洒只会增加告警面。

## 六、反模式

- 没有失败基线就批量喷洒。
- 只看状态码判定命中（大量系统成功失败都是 200 或都是 302）。
- 用同一字典对同一目标重复喷洒并报告为进展。
- 把默认凭据表条目、公开泄露线索当作已确认凭据。
- 假设环境里有 hydra / hashcat / john / ffuf。这个环境没有；用 `nmap` 的 NSE 爆破脚本、`curl` 或 python3 stdlib 实现。
- 把"尝试了 N 次"当作"排除了 N 个候选"——只有可复现的判定信号才能支撑排除结论。
