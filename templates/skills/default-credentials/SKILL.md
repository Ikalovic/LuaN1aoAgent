---
name: default-credentials
description: Default, vendor-documented and product-derived credential reference for common appliances, middleware, CMS, databases and admin panels, plus the procedure for fingerprinting a product and version first and then matching it against the right credential set. Use when an authentication surface has been identified and the cheapest next step is trying what the vendor ships. Do not use it as a generic wordlist (see credential-stuffing) or when the product cannot be identified — fingerprint first, then come back.
license: MIT
compatibility: Requires bash and curl for fingerprinting. No internet access is required for the tables below; internet access improves version-specific accuracy.
allowed-tools: Bash Read Write Edit Glob Grep WebFetch WebSearch
metadata:
  user-invocable: "false"
---

# 默认与产品凭据

## 一、先指纹，再匹配

**不要对着一个未识别的登录框盲试默认凭据。** 先确认产品与版本，再只试对应的凭据集，这样尝试次数少一个数量级，也更容易解释"为什么是这个候选"。

```bash
# 响应头与页面线索
curl -sSI http://TARGET/ | grep -iE 'server|x-powered-by|set-cookie|x-aspnet|x-generator'
curl -sS http://TARGET/ | grep -oiE '(generator|wp-content|joomla|drupal|tomcat|jenkins|grafana|phpmyadmin|weblogic)' | sort -u
# 登录页标题与静态资源路径往往直接暴露产品
curl -sS http://TARGET/login | grep -oiE '<title>[^<]*</title>|/(static|assets|wp-|administrator)/[a-z0-9._/-]+' | head
# favicon 哈希也是可靠指纹
curl -sS http://TARGET/favicon.ico | md5sum
```

观察到产品与版本后再对照下表。**版本相关**的默认凭据必须结合版本使用，新版通常已强制首次改密。

## 二、常见默认凭据表

| 产品 / 服务 | 默认账号 | 默认口令 | 备注 |
|---|---|---|---|
| DVWA | `admin` | `password` | 登录带 CSRF `user_token`；`setup.php` 可重置回默认 |
| Tomcat Manager | `tomcat` / `admin` / `manager` | `tomcat` / `s3cret` / `admin` | `/manager/html`，Basic 认证 |
| Jenkins | `admin` | 首次安装生成的 `initialAdminPassword` | 未初始化时 `/securityRealm/` 直接可用；老版本 `admin:admin` |
| Weblogic | `weblogic` | `weblogic` / `Welcome1` | `/console` |
| JBoss / WildFly | `admin` | `admin` | 管理端口 9990 |
| phpMyAdmin | `root` | （空） / `root` / `toor` | MySQL root |
| MySQL / MariaDB | `root` | （空） / `root` / `mysql` | 见 `mysql-brute` |
| PostgreSQL | `postgres` | `postgres` / `password` | |
| MSSQL | `sa` | （空） / `sa` / `Password123` | 见 `ms-sql-brute` |
| Redis | — | 无认证（默认） | `redis-cli -h TARGET ping`，返回 PONG 即未授权 |
| MongoDB | — | 无认证（旧版默认） | 27017 |
| Elasticsearch | — | 无认证（< 8 默认关闭安全） | `curl http://TARGET:9200/_cat/indices` |
| RabbitMQ 管理台 | `guest` | `guest` | 默认仅允许 localhost，需从目标本机试 |
| Grafana | `admin` | `admin` | 首次登录强制改密 |
| Kibana | — | 无认证 | |
| WordPress | `admin` | 安装时设定 | 用户名可通过 `/?author=1` 枚举 |
| Joomla | `admin` | 安装时设定 | `/administrator` |
| Drupal | `admin` | 安装时设定 | `/user/login` |
| Zabbix | `Admin` | `zabbix` | 注意首字母大写 |
| pfSense / OPNsense | `admin` | `pfsense` / `opnsense` | |
| 常见路由器（TP-Link/Netgear/华硕） | `admin` | `admin` / `password` | |
| Hikvision 摄像头 | `admin` | `12345` | |
| SNMP | `public` / `private` | — | community string，不是账号口令 |
| FTP 匿名 | `anonymous` | 任意邮箱 | 见 `ftp-anon` |
| CUPS | — | — | 通常无认证 |

## 三、产品名派生候选（比通用字典命中率高得多）

产品被识别后，按目标线索派生候选，并**记录派生规则**（这是可复核的推理，也是后续复用能力）：

```
<产品名>            dvwa, tomcat, jenkins, grafana
<产品名>+年份       dvwa2025, dvwa2026
<产品名>+123        tomcat123, jenkins123
<产品名>+@123       grafana@123
<单位缩写>+年份      仅当材料给出单位线索时使用
首字母大写变体       Admin, Administrator, admin1
```

不要把这些变体无限展开成笛卡尔积；每个产品保留 5–15 个高价值候选即可。

## 四、命中判据

默认凭据的成功信号与普通爆破完全相同，**先建立失败基线**（见 `web-login-bruteforce`），尤其是：

- 有些产品对错误凭据返回 200 并在页面内提示，对正确凭据跳转；
- 有些产品对默认凭据强制跳转到"首次改密"页面，这**也算命中**（凭据有效），但要用只读方式确认，不要顺手改密。

## 五、纪律

- 默认凭据表是**候选来源**，不是"已确认凭据"。写结论时必须说明是哪条候选命中、证据是什么。
- 每次尝试都要计入 `maxAttemptsPerAccount` / `maxTotalAttempts` 边界；默认凭据多、更容易无意识放量。
- 目标可能是蜜罐：默认凭据"秒中"且随后所有操作都成功、或响应异常一致时，先降速，把观察写成证据再判断，不要直接宣告控制权。
