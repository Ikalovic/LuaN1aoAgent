# Shenxd FOFA Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly enabled, minimal Shenxd PHP proxy adapter for `fofa_search` while preserving every existing FOFA MCP security boundary.

**Architecture:** Extend the existing typed FOFA configuration with a provider discriminator and insecure-HTTP opt-in. Keep the public five-tool MCP surface stable, route only search calls directly to the configured PHP endpoint, and reject unsupported Shenxd operations in the host Runtime before quota reservation or network access.

**Tech Stack:** TypeScript, Node.js 25, node:test, TypeBox, Zod, MCP v2, SQLite RuntimeStore

---

### Task 1: Provider Configuration Boundary

**Files:**
- Modify: `test/fofa-config.test.ts`
- Modify: `src/fofa/fofa-config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing configuration tests**

Add tests asserting that `FOFA_PROVIDER=shenxd` accepts the complete remote HTTP PHP URL only when `FOFA_ALLOW_INSECURE_HTTP=1`, rejects it without the opt-in, and keeps `official` as the default. Assert that the child environment contains only the provider selection and explicit opt-in in addition to the existing allowlist.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm exec --yes --package=node@25 -- bash -c 'npm run build:server && node --test dist/test/fofa-config.test.js'
```

Expected: FAIL because `FofaConfig` has no provider discriminator and remote HTTP is always rejected.

- [ ] **Step 3: Implement the minimal typed configuration**

Extend `FofaConfig` with:

```ts
provider: "official" | "shenxd";
allowInsecureHttp: boolean;
```

Normalize `FOFA_PROVIDER`, require the exact `shenxd` value for proxy mode, and allow remote HTTP only when both the selected provider is `shenxd` and `FOFA_ALLOW_INSECURE_HTTP === "1"`. Preserve loopback HTTP under `NODE_ENV=test`. Add `FOFA_PROVIDER` and `FOFA_ALLOW_INSECURE_HTTP` to the child environment generated from the already validated config.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: all FOFA configuration tests pass.

- [ ] **Step 5: Document environment keys and commit**

Add commented examples to `.env.example`, then commit:

```bash
git add src/fofa/fofa-config.ts test/fofa-config.test.ts .env.example
git commit -m "feat: configure Shenxd FOFA provider"
```

### Task 2: Direct PHP Search Adapter

**Files:**
- Modify: `test/fofa-client.test.ts`
- Modify: `src/fofa/fofa-client.ts`

- [ ] **Step 1: Write failing request-mapping tests**

Add a Shenxd config fixture and an injectable fetch that records its URL. Assert that `search()` calls the complete PHP URL without appending `/api/v1/search/all`, and sends `qbase64`, optional `email`, `key`, comma-separated `fields`, bounded `size`, and `full`.

- [ ] **Step 2: Write failing error-normalization tests**

Return:

```json
{"error":true,"message":"API密钥无效或已过期"}
```

Assert `fofa_auth_failed`, and assert the card value and email are absent from the thrown error.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npm exec --yes --package=node@25 -- bash -c 'npm run build:server && node --test dist/test/fofa-client.test.js'
```

Expected: FAIL because the client appends the official path and ignores `message`.

- [ ] **Step 4: Implement direct search routing**

Choose the request path by provider:

```ts
const path = this.config.provider === "shenxd"
  ? this.config.baseUrl
  : "/api/v1/search/all";
```

Teach the request helper to accept either an official relative path or the validated full proxy endpoint. Do not duplicate retry, timeout, cancellation, response validation, or credential-redaction logic.

- [ ] **Step 5: Normalize proxy errors**

Read provider text from `errmsg` or `message`. Classify messages containing invalid/expired key or card semantics, including `密钥无效` and `已过期`, as `fofa_auth_failed`; preserve existing points, plan, rate-limit, and generic mappings.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run the Step 3 command. Expected: all FOFA client tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/fofa/fofa-client.ts test/fofa-client.test.ts
git commit -m "feat: route FOFA search through Shenxd proxy"
```

### Task 3: Reject Unsupported Proxy Operations Before Quota

**Files:**
- Modify: `test/fofa-mcp-runtime.test.ts`
- Modify: `src/mcp/fofa-runtime.ts`
- Modify: `src/mcp/fofa-server.ts`

- [ ] **Step 1: Write a failing Runtime test**

Create a Runtime with `provider: "shenxd"`. Invoke account info, next-page search, statistics, and host aggregation. Assert each rejects with `fofa_plan_unsupported`, the MCP client factory/call is never used for those calls, and RuntimeStore reports zero result and aggregation consumption.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm exec --yes --package=node@25 -- bash -c 'npm run build:server && node --test dist/test/fofa-mcp-runtime.test.js'
```

Expected: FAIL because Runtime currently reserves quota and forwards every tool.

- [ ] **Step 3: Add provider capability preflight**

At the start of `FofaMcpRuntime.call`, before connection startup and quota reservation, allow only `fofa_search` for `shenxd`; throw a stable non-retryable `FofaError("fofa_plan_unsupported", ...)` for the other four tools.

Add the same provider check in MCP handlers as defense in depth for direct child clients. Do not alter the five advertised tool names.

- [ ] **Step 4: Run focused Runtime and server tests**

```bash
npm exec --yes --package=node@25 -- bash -c 'npm run build:server && node --test dist/test/fofa-mcp-runtime.test.js dist/test/fofa-mcp-server.test.js'
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/fofa-runtime.ts src/mcp/fofa-server.ts test/fofa-mcp-runtime.test.ts
git commit -m "feat: bound Shenxd FOFA capabilities"
```

### Task 4: Documentation and Live Smoke Compatibility

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `说明.md`
- Modify: `scripts/fofa-live-smoke.mjs`
- Test: `test/fofa-config.test.ts`

- [ ] **Step 1: Add a failing smoke-selection check**

Exercise the smoke script with a mock/local Shenxd configuration and assert it still requests one result through `FofaClient.search`. The default disabled smoke must continue to exit with status 2 before network access.

- [ ] **Step 2: Implement only required smoke changes**

Keep the existing one-result query. Make its status output provider-neutral and never print the endpoint, card, email, authenticated URL, or raw provider error.

- [ ] **Step 3: Update documentation**

Document the five environment variables, the one-tool limitation, the explicit insecure transport risk, and the fact that the existing Scope/candidate/quota/Artifact controls still apply. Use placeholders only; never include the live card value or account email.

- [ ] **Step 4: Run build and disabled smoke**

```bash
npm exec --yes --package=node@25 -- bash -c 'npm run build'
env -u FOFA_LIVE_TEST -u FOFA_API_KEY npm exec --yes --package=node@25 -- bash -c 'npm run test:fofa-live'; test "$?" -eq 2
```

Expected: build passes and the disabled smoke refuses network access.

- [ ] **Step 5: Commit**

```bash
git add README.md README_CN.md 说明.md scripts/fofa-live-smoke.mjs
git commit -m "docs: explain Shenxd FOFA adapter"
```

### Task 5: Full Verification and Opt-In Live Test

**Files:**
- Review only; modify only files implicated by a failing check.

- [ ] **Step 1: Audit credential-prone code**

```bash
rg -n 'console\.(log|error)|FOFA_API_KEY|FOFA_EMAIL|searchParams.*key|[?&]key=' src/fofa src/mcp scripts/fofa-live-smoke.mjs
git diff --check main...HEAD
```

Expected: credentials appear only in config/environment and request construction; no authenticated URL or live value is logged.

- [ ] **Step 2: Run all automated suites**

```bash
npm exec --yes --package=node@25 -- bash -c 'npm test'
(cd traffic-proxy && go test ./...)
(cd network-image/gateway-tun && go test ./...)
(cd network-image/socks-connector && go test ./...)
python3 -m unittest discover -s network-image -p 'test_*.py'
```

Expected: Node/Web, Go, and Python suites pass without external FOFA requests.

- [ ] **Step 3: Execute one live proxy search**

Supply the card through hidden process stdin, export it only into the child process, set `NO_PROXY=map.shenxd.top`, `FOFA_LIVE_TEST=1`, `FOFA_PROVIDER=shenxd`, `FOFA_ALLOW_INSECURE_HTTP=1`, the configured email, and the PHP endpoint. Run `npm run test:fofa-live` and expect `{"ok":true,"returned":1}` without credential output.

- [ ] **Step 4: Inspect cleanup and status**

```bash
git status --short
ps -eo pid=,ppid=,command= | rg '[f]ofa-server\.js' || true
```

Expected: clean feature worktree and no FOFA child process.

