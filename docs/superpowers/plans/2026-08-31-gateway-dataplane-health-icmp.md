# Gateway Data Plane Health and ICMP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore authorized TCP traffic from Docker Executors through Gateway, classify infrastructure failures separately from target results, and add scope-controlled ICMP Echo when no SOCKS5 route is active.

**Architecture:** Replace the conflicting Docker `--internal` task bridge with a normal bridge whose Executor default route still points exclusively at Gateway. Add an Executor OUTPUT guard so the bridge gateway cannot become a bypass. Use a synthetic Gateway sentinel plus broker health handshake for end-to-end readiness, and implement ICMP through the Gateway control plane rather than granting raw sockets to Executor.

**Tech Stack:** TypeScript/Node.js, Docker networking, iptables, Python Gateway control service, Go gVisor/TUN Gateway, Node/Go/Python tests.

---

### Task 1: Fix the Docker bridge drop while preserving isolation

**Files:**
- Modify: `src/connectivity/network-sandbox-manager.ts`
- Modify: `src/executor-sandbox-docker.ts`
- Modify: `src/controller.ts`
- Test: `test/network-sandbox-manager.test.ts`
- Test: `test/executor-sandbox-docker.test.ts`

- [ ] **Step 1: Write failing network tests**

Assert that task network creation omits `--internal`, `TaskGateway` exposes `taskNetworkCidr`, and Executor initialization installs these rules in order:

```sh
iptables -I OUTPUT 1 -d "$gateway/32" -j ACCEPT
iptables -A OUTPUT -d "$task_cidr" -j REJECT
```

Also require the default route through Gateway, `CapDrop=ALL`, and no Executor `NET_ADMIN`.

- [ ] **Step 2: Verify tests fail**

```bash
npm run build:server
node --test dist/test/network-sandbox-manager.test.js dist/test/executor-sandbox-docker.test.js
```

Expected: `--internal` is present and subnet guard metadata/rules are missing.

- [ ] **Step 3: Implement the bridge and namespace fix**

Remove `--internal` in `ensureTaskNetwork`. Carry `taskNetworkCidr` through `TaskGateway`, `DockerTaskNetworkAttachment`, and `prepareExecutorSandboxForEpoch`. Keep the current privileged namespace initializer, replace the default route with Gateway, allow the Gateway `/32`, reject all other task-subnet destinations, and retain Docker embedded-DNS drops. Include the subnet in `executor_task_sandbox_ready` metadata.

- [ ] **Step 4: Re-run focused tests and commit**

```bash
npm run build:server
node --test dist/test/network-sandbox-manager.test.js dist/test/executor-sandbox-docker.test.js
git add src/connectivity/network-sandbox-manager.ts src/executor-sandbox-docker.ts src/controller.ts test/network-sandbox-manager.test.ts test/executor-sandbox-docker.test.ts
git commit -m "fix: route executor traffic through gateway"
```

Expected: PASS.

### Task 2: Add a real Docker data-plane regression

**Files:**
- Create: `scripts/network-dataplane-live-smoke.mjs`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Implement the opt-in smoke script**

The script creates a temporary Runtime, listens on a non-loopback host address, authorizes only that `/32`, starts real Gateway and Executor containers, requires an Executor TCP connection to receive `probe-ok`, and confirms target TCP telemetry. It also verifies that Executor cannot access another task-bridge address directly. All resources are disposed in `finally`. Without `LUANNIAO_DOCKER_LIVE_TEST=1`, print `SKIP` and exit zero.

- [ ] **Step 2: Add and run the package command**

Add:

```json
"test:network-live": "node scripts/network-dataplane-live-smoke.mjs"
```

Run:

```bash
npm run build:server
LUANNIAO_DOCKER_LIVE_TEST=1 npm run test:network-live
```

Expected: `PASS authorized TCP traversed Gateway` and the bypass attempt is rejected.

- [ ] **Step 3: Commit**

```bash
git add scripts/network-dataplane-live-smoke.mjs package.json README.md
git commit -m "test: cover live gateway data plane"
```

### Task 3: Add structured end-to-end health

**Files:**
- Modify: `src/connectivity/host-egress-broker.ts`
- Modify: `src/connectivity/network-sandbox-manager.ts`
- Modify: `src/connectivity/connectivity-runtime.ts`
- Modify: `network-image/gateway-tun/route_proxy.go`
- Modify: `network-image/gateway-tun/protocol_gateway.go`
- Modify: `network-image/index_server.py`
- Test: `test/host-egress-broker.test.ts`
- Test: `test/network-sandbox-manager.test.ts`
- Test: `network-image/gateway-tun/route_proxy_test.go`
- Test: `network-image/test_index_server.py`

- [ ] **Step 1: Define the tested status contract**

```ts
export type TaskNetworkHealth = {
  status: "healthy" | "scope_blocked" | "gateway_unreachable" |
    "broker_unreachable" | "target_timeout" | "icmp_proxy_unsupported";
  tcpDataPlane: boolean;
  broker: boolean;
  icmp: "supported" | "proxy_unsupported";
  checkedAt: string;
  detail?: string;
};
```

Tests cover malformed control replies, stopped broker, healthy broker, and ensure tokens never enter results/logs.

- [ ] **Step 2: Add broker health and a synthetic sentinel**

Add an authenticated broker health request alongside existing `LNDB1` dial requests. Reserve `198.18.0.1:9` inside Gateway only: Scope Guard permits that exact endpoint, its packet still crosses bridge, PREROUTING mark, policy route, TUN and gVisor Forwarder, and `protocolGateway` responds `LN-HEALTH` without external dialing. Exclude sentinel activity from assets and topology.

- [ ] **Step 3: Probe health before model invocation**

After sandbox start, connect from Executor to the sentinel and require `LN-HEALTH`; then combine Gateway control health and broker health into `TaskNetworkHealth`. Emit `executor_network_health`. Preserve dial errors as `scope_blocked`, `broker_unreachable`, `target_timeout`, or target refusal.

- [ ] **Step 4: Run focused suites and commit**

```bash
npm run build:server
node --test dist/test/host-egress-broker.test.js dist/test/network-sandbox-manager.test.js
(cd network-image/gateway-tun && go test ./...)
python3 -m unittest network-image/test_index_server.py
git add src/connectivity network-image test
git commit -m "feat: classify gateway data plane health"
```

Expected: all PASS.

### Task 4: Stop infrastructure failures becoming target findings

**Files:**
- Modify: `src/executor-environment.ts`
- Modify: `src/prompts.ts`
- Modify: `src/controller.ts`
- Test: `test/executor-environment.test.ts`
- Test: `test/prompts.test.ts`
- Test: `test/controller-budget-supervision.test.ts`

- [ ] **Step 1: Write failing evidence-policy tests**

Require Executor context to state:

```text
Do not use assets outside authorized Scope as connectivity controls.
Gateway ports 80/443 are not proxy listeners.
ICMP silence does not prove a host is down.
filtered/no-response is target evidence only when tcpDataPlane=true.
```

When `tcpDataPlane=false`, a submitted “all ports filtered” result must remain `partial`, become retryable, and gain an `infrastructure_failure` blocker rather than confirmed port-state evidence.

- [ ] **Step 2: Inject health facts and enforce lifecycle classification**

Extend Executor environment facts with the latest `TaskNetworkHealth`. Refresh it after recovery/resume. In `enrichTaskResultLifecycle`, normalize negative network results to inconclusive infrastructure evidence while leaving positive Runtime/FOFA evidence intact.

- [ ] **Step 3: Test and commit**

```bash
npm run build:server
node --test dist/test/executor-environment.test.js dist/test/prompts.test.js dist/test/controller-budget-supervision.test.js
git add src/executor-environment.ts src/prompts.ts src/controller.ts test
git commit -m "fix: separate network failures from target findings"
```

### Task 5: Add controlled ICMP Echo

**Files:**
- Create: `src/tools/network-diagnostics-tools.ts`
- Modify: `src/connectivity/network-sandbox-manager.ts`
- Modify: `src/connectivity/connectivity-runtime.ts`
- Modify: `src/controller.ts`
- Modify: `network-image/Dockerfile`
- Modify: `network-image/index_server.py`
- Test: `test/network-diagnostics-tools.test.ts`
- Test: `test/network-sandbox-manager.test.ts`
- Test: `network-image/test_index_server.py`

- [ ] **Step 1: Write failing ICMP result tests**

```ts
type IcmpEchoResult = {
  status: "reply" | "timeout" | "scope_blocked" |
    "icmp_proxy_unsupported" | "infrastructure_failure";
  target: string;
  address?: string;
  roundTripMs?: number;
};
```

Cover authorized IP/domain, out-of-scope target, matching SOCKS route, timeout, rate limit, and Gateway failure.

- [ ] **Step 2: Implement `icmp.echo` in Gateway control**

Accept one hostname/IPv4 and 250–3000 ms timeout. Resolve only authorized domains; require each selected IPv4 to match CIDR or the dynamic DNS authorization set; return `icmp_proxy_unsupported` when a SOCKS route matches; rate-limit to one request/second with burst three; send exactly one Echo Request. Install `iputils-ping` and add `NET_RAW` only to Gateway. Executor remains capability-free and cannot access the mode-`0600` control socket.

- [ ] **Step 3: Add Runtime tools**

Expose `network_status` and `icmp_echo` from `createTaskRuntimeTools`. Tool descriptions explicitly say ICMP silence is not host-down evidence and SOCKS5 ICMP is unsupported. Scope cannot be overridden by model parameters.

- [ ] **Step 4: Test, rebuild image, and commit**

```bash
npm run build:server
node --test dist/test/network-diagnostics-tools.test.js dist/test/network-sandbox-manager.test.js
python3 -m unittest network-image/test_index_server.py
npm run build:network-image
LUANNIAO_DOCKER_LIVE_TEST=1 npm run test:network-live
git add src/tools/network-diagnostics-tools.ts src/connectivity src/controller.ts network-image test
git commit -m "feat: add controlled gateway icmp echo"
```

Expected: authorized Echo returns `reply` or `timeout`; policy cases return explicit statuses; TCP smoke still passes.

### Task 6: Full verification and handoff

**Files:**
- Modify: `README.md`
- Modify: `说明.md` if present

- [ ] **Step 1: Build and run all tests**

```bash
npm run build:executor-image
npm run build:network-image
npm test
(cd network-image/gateway-tun && go test ./...)
python3 -m unittest discover -s network-image -p 'test_*.py'
LUANNIAO_DOCKER_LIVE_TEST=1 npm run test:network-live
```

Expected: all PASS.

- [ ] **Step 2: Run fresh-target acceptance**

Start a new authorized session for `110.42.96.9/32`; do not resume the stale session. Verify Executor TCP probes to 80/443/9090 create Gateway target telemetry and no longer all report `filtered`. Verify an out-of-scope request is policy-blocked, not reported as an outage. Verify ICMP without SOCKS gives `reply` or `timeout`, while SOCKS returns `icmp_proxy_unsupported`.

- [ ] **Step 3: Verify security invariants**

```bash
docker inspect <executor> --format '{{json .HostConfig.CapAdd}} {{json .HostConfig.CapDrop}}'
docker exec <executor> ip route
docker exec <executor> iptables -S OUTPUT
docker inspect <gateway> --format '{{json .HostConfig.CapAdd}}'
```

Expected: Executor has no added capabilities, default route points to Gateway, bridge bypass is rejected, and only Gateway has `NET_RAW`.

- [ ] **Step 4: Document and commit**

Document statuses, ICMP proxy limitation, live test command, and that old TaskOutcomes are not retroactively corrected.

```bash
git add README.md
test ! -f 说明.md || git add 说明.md
git commit -m "docs: explain gateway health and icmp behavior"
git status --short
```

Expected: only pre-existing unrelated untracked files remain.
