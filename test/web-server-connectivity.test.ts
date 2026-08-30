import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/stores/artifact-store.js";
import { ConnectivityStore, stableConnectivityId } from "../src/stores/connectivity-store.js";
import { SQLiteGraphStore } from "../src/stores/graph-store.js";
import { RuntimeStore } from "../src/stores/runtime-store.js";
import { WebAuthService } from "../src/web-auth.js";

type Fixture = {
  baseUrl: string;
  root: string;
  runtimeDir: string;
  adminCookie: string;
  analystCookie: string;
  process: ChildProcess;
  indexServer: import("node:http").Server;
  historyIndexServer: import("node:http").Server;
  historyIndexRequests: string[];
  dockerLog: string;
};

let fixture: Fixture;

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test.before(async () => {
  fixture = await createFixture();
});

test.after(async () => {
  if (fixture) await destroyFixture(fixture);
});

test("connectivity routes require authentication, admin capability, and CSRF", async () => {
  const unauthenticated = await fetch(`${fixture.baseUrl}/api/connectivity?runtimeDir=${encodeURIComponent(fixture.runtimeDir)}`);
  assert.equal(unauthenticated.status, 401);

  const analystRead = await authenticatedGet(fixture.analystCookie, "/api/connectivity");
  assert.equal(analystRead.status, 200);

  const analystMutation = await mutate(fixture.analystCookie, "/api/connectivity/tunnels", tunnelBody(), true);
  assert.equal(analystMutation.status, 403);
  assert.equal((await json(analystMutation)).error.code, "authorization_forbidden");

  const adminWithoutCsrf = await fetch(`${fixture.baseUrl}/api/connectivity/tunnels`, {
    method: "POST",
    headers: { cookie: fixture.adminCookie, "content-type": "application/json" },
    body: JSON.stringify(tunnelBody())
  });
  assert.equal(adminWithoutCsrf.status, 403);
  assert.equal((await json(adminWithoutCsrf)).error.code, "csrf_token_missing");

  const routeForget = await mutate(
    fixture.analystCookie,
    `/api/connectivity/${encodeURIComponent(stableConnectivityId("route", "route:test-one"))}/forget`,
    { runtimeDir: fixture.runtimeDir },
    true
  );
  assert.equal(routeForget.status, 403);
});

test("connectivity and empty traffic history stay read-only", async () => {
  const emptyRuntime = join(fixture.root, "empty-runtime");
  await mkdir(emptyRuntime);
  const response = await fetch(`${fixture.baseUrl}/api/connectivity?runtimeDir=${encodeURIComponent(emptyRuntime)}`, {
    headers: { cookie: fixture.analystCookie }
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await json(response)).connections, []);
  await assert.rejects(access(join(emptyRuntime, "state.sqlite")));
  await assert.rejects(access(join(emptyRuntime, "state.sqlite-wal")));
  await assert.rejects(access(join(emptyRuntime, "state.sqlite-shm")));

  const traffic = await fetch(`${fixture.baseUrl}/api/traffic/history?runtimeDir=${encodeURIComponent(emptyRuntime)}`, {
    headers: { cookie: fixture.analystCookie }
  });
  assert.equal(traffic.status, 200);
  assert.deepEqual((await json(traffic)).items, []);
  await assert.rejects(access(join(emptyRuntime, "traffic-proxy", "data", "traffic.sqlite")));
});

test("legacy Web connectivity creation is retired without creating a second owner", async () => {
  for (const path of ["/api/connectivity/tunnels", "/api/connectivity/sessions"]) {
    const response = await mutate(fixture.adminCookie, path, tunnelBody(), true);
    assert.equal(response.status, 410);
    assert.equal((await json(response)).error.code, "connectivity_definition_api_removed");
  }
  const store = new ConnectivityStore(join(fixture.runtimeDir, "state.sqlite"));
  assert.deepEqual(store.listDefinitions(), []);
  store.close();
});

test("connections combine route definitions with distinct network observations and real refs", async () => {
  const trafficDir = join(fixture.runtimeDir, "traffic", "flows", "task-one");
  await mkdir(trafficDir, { recursive: true });
  const firstObservation = {
    kind: "network_connection",
    network_ref: "net:socket-one",
    connection_ref: "connection:ssh-one",
    session_ref: "connection:ssh-one",
    route_ref: "route:test-one",
    event: "new",
    protocol: "tcp",
    source: { host: "192.168.1.20", port: 43120 },
    destination: { host: "172.31.0.20", port: 80 },
    observed_at: "2026-07-25T10:00:00Z",
    task_ref: "task:one",
    run_ref: "run:one",
    epoch_ref: "epoch:one"
  };
  const secondObservation = {
    ...firstObservation,
    network_ref: "net:socket-two",
    source: { host: "192.168.1.20", port: 43121 },
    destination: { host: "172.31.0.21", port: 443 },
    observed_at: "2026-07-25T10:00:01Z"
  };
  await writeFile(join(trafficDir, "epoch-one.net.jsonl"), `${JSON.stringify(firstObservation)}\n${JSON.stringify(secondObservation)}\n`);
  const runtimeStore = new RuntimeStore(join(fixture.runtimeDir, "state.sqlite"));
  runtimeStore.createEpoch({ epochId: "epoch:one", taskId: "task:one", attempt: 1 });
  runtimeStore.transitionEpoch({ epochId: "epoch:one", state: "closed", terminationReason: "executor_submitted" });
  runtimeStore.close();
  const store = new ConnectivityStore(join(fixture.runtimeDir, "state.sqlite"));
  const artifacts = new ArtifactStore(join(fixture.runtimeDir, "artifacts"), join(fixture.runtimeDir, "state.sqlite"));
  const credential = await artifacts.write({
    taskId: "task:one",
    kind: "text",
    mediaType: "text/plain",
    data: "ops:route-password\n"
  });
  artifacts.close();
  store.upsertDefinition({
    kind: "route",
    externalId: "route:test-one",
    desiredState: "running",
    status: "live",
    hostRef: "host:dmz",
    processRef: "connector:test-one",
    credentialRef: credential.artifactRef,
    definition: {
      runtimeManaged: true,
      transport: "ssh",
      pivotHostRef: "host:dmz",
      dialAddress: "10.0.0.5",
      targetCidrs: ["172.31.0.0/24"],
      connectionRef: "connection:ssh-one",
      connectorRef: "connector:test-one",
      dialPort: 22,
      dialUser: "ops",
      ownerTaskId: "task:one"
    }
  });
  store.upsertDefinition({
    kind: "session",
    externalId: "connection:ssh-one",
    desiredState: "running",
    status: "live",
    sessionType: "shell",
    hostRef: "host:dmz",
    processRef: "connector:test-one",
    definition: {
      runtimeManaged: true,
      transport: "ssh",
      routeRef: "route:test-one",
      dialAddress: "10.0.0.5"
    }
  });
  store.close();

  const response = await authenticatedGet(fixture.analystCookie, "/api/connectivity");
  assert.equal(response.status, 200);
  const connections = (await json(response)).connections as Array<Record<string, unknown>>;
  assert.deepEqual((await json(await authenticatedGet(fixture.adminCookie, "/api/connectivity"))).runtimeControl, {
    active: false,
    mode: "read_only"
  });
  const route = connections.find((item) => item.kind === "route" && item.externalId === "route:test-one");
  assert(route);
  assert.equal(route.direction, "10.0.0.5 → 172.31.0.0/24");
  assert.equal(route.routeRef, "route:test-one");
  assert.equal(route.connectionRef, "connection:ssh-one");
  assert.equal(route.managed, true);
  assert.equal(route.available, false);
  assert.equal(route.graphUrl, undefined);
  assert.equal(route.actions, undefined);
  assert.equal(route.credentialRef, undefined);
  const managedConnection = connections.find((item) => item.layer === "definition" && item.externalId === "connection:ssh-one");
  assert(managedConnection);
  assert.equal(managedConnection.kind, "connection");
  assert.equal(managedConnection.connectionRef, "connection:ssh-one");
  assert.equal(managedConnection.sessionRef, undefined);
  assert.equal(
    managedConnection.graphUrl,
    `?runtimeDir=${encodeURIComponent(fixture.runtimeDir)}&view=operation&nodeId=${encodeURIComponent("shell-session:connection%3Assh-one")}`
  );
  assert.equal(connections.some((item) => item.kind === "session"), false);
  const observation = connections.find((item) => item.id === "network:net:socket-one");
  assert(observation);
  assert.equal(observation.layer, "observation");
  assert.equal(observation.direction, "192.168.1.20:43120 → 172.31.0.20:80");
  assert.equal(observation.routeRef, "route:test-one");
  assert.equal(observation.connectionRef, "connection:ssh-one");
  assert.equal(observation.sessionRef, undefined);
  assert.equal(observation.observedState, "closed");
  assert.equal(observation.available, false);
  assert.equal(connections.filter((item) => item.layer === "observation" && item.kind === "connection" && item.connectionRef === "connection:ssh-one").length, 2);

  const adminConnections = (await json(await authenticatedGet(fixture.adminCookie, "/api/connectivity"))).connections as Array<Record<string, unknown>>;
  assert.equal(adminConnections.find((item) => item.externalId === "route:test-one")?.credentialRef, credential.artifactRef);
  assert.deepEqual(adminConnections.find((item) => item.externalId === "route:test-one")?.actions, ["status", "stop", "reconnect", "forget"]);
});

test("connections skip one unreadable network observation", async () => {
  const trafficDir = join(fixture.runtimeDir, "traffic", "flows", "task-unreadable");
  await mkdir(trafficDir, { recursive: true });
  await writeFile(join(trafficDir, "readable.net.jsonl"), `${JSON.stringify({
    kind: "network_connection",
    network_ref: "net:readable",
    event: "new",
    protocol: "tcp",
    source: { host: "127.0.0.1", port: 40100 },
    destination: { host: "127.0.0.1", port: 8080 },
    observed_at: "2026-08-31T00:00:00Z"
  })}\n`);
  const unreadable = join(trafficDir, "unreadable.net.jsonl");
  await writeFile(unreadable, "unreadable\n");
  await chmod(unreadable, 0o000);

  const response = await authenticatedGet(fixture.analystCookie, "/api/connectivity");

  assert.equal(response.status, 200);
  const connections = (await json(response)).connections as Array<Record<string, unknown>>;
  assert(connections.some((item) => item.externalId === "net:readable"));
});

test("historical actions return 409 without touching Docker when another process owns the runtime", async () => {
  const runtimeDir = join(fixture.root, "externally-owned-runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "execution.jsonl"), "");
  const store = new ConnectivityStore(join(runtimeDir, "state.sqlite"));
  store.upsertDefinition({
    kind: "route",
    externalId: "route:externally-owned",
    desiredState: "running",
    status: "live",
    hostRef: "host:dmz",
    definition: {
      runtimeManaged: true,
      transport: "ssh",
      pivotHostRef: "host:dmz",
      targetCidrs: ["172.31.0.0/24"],
      connectorRef: "connector:externally-owned",
      ownerTaskId: "task:external"
    }
  });
  store.close();
  const leaseDir = join(runtimeDir, ".connectivity-runtime-owner");
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(join(leaseDir, "owner.json"), JSON.stringify({
    version: 1,
    token: "external-owner",
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  }));
  const dockerBefore = await readFile(fixture.dockerLog, "utf8");
  const response = await mutate(
    fixture.adminCookie,
    `/api/connectivity/${encodeURIComponent(stableConnectivityId("route", "route:externally-owned"))}/status`,
    { runtimeDir },
    true
  );

  assert.equal(response.status, 409);
  assert.equal((await json(response)).error.code, "connectivity_runtime_owned");
  assert.equal(await readFile(fixture.dockerLog, "utf8"), dockerBefore);
  assert.equal(JSON.parse(await readFile(join(leaseDir, "owner.json"), "utf8")).token, "external-owner");
});

test("active Runtime lease maps an unhealthy flow index to stable 503 without revival", async () => {
  const runtimeDir = join(fixture.root, "active-index-unavailable");
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows", "task-one"), { recursive: true });
  await writeFile(join(trafficRoot, "flows", "task-one", "epoch-one.mitm"), "captured");
  const token = "c".repeat(64);
  const descriptor = { url: "http://127.0.0.1:1", token };
  await writeFile(join(trafficRoot, "index.token"), token);
  await writeFile(join(trafficRoot, "index.json"), JSON.stringify(descriptor));
  const leaseDir = join(runtimeDir, ".connectivity-runtime-owner");
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(join(leaseDir, "owner.json"), JSON.stringify({
    version: 1,
    token: "active-runtime-owner",
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  }));
  const dockerBefore = await readFile(fixture.dockerLog, "utf8");

  const response = await fetch(
    `${fixture.baseUrl}/api/traffic/history?runtimeDir=${encodeURIComponent(runtimeDir)}`,
    { headers: { cookie: fixture.analystCookie } }
  );

  assert.equal(response.status, 503);
  assert.equal((await json(response)).error.code, "traffic_index_unavailable");
  assert.equal(await readFile(fixture.dockerLog, "utf8"), dockerBefore);
  assert.deepEqual(JSON.parse(await readFile(join(trafficRoot, "index.json"), "utf8")), descriptor);
});

test("historical route actions lazily reuse one runtime and preserve the route identity through reconnect", async () => {
  const id = stableConnectivityId("route", "route:test-one");
  const analystStatus = await mutate(
    fixture.analystCookie,
    `/api/connectivity/${encodeURIComponent(id)}/status`,
    { runtimeDir: fixture.runtimeDir },
    true
  );
  const analystStatusBody = await json(analystStatus);
  assert.equal(analystStatus.status, 403, JSON.stringify(analystStatusBody));
  assert.equal(analystStatusBody.error.code, "authorization_forbidden");
  for (const [action, expectedState] of [
    ["status", "live"],
    ["stop", "stale"],
    ["reconnect", "live"],
    ["forget", "closed"]
  ] as const) {
    const response = await mutate(
      fixture.adminCookie,
      `/api/connectivity/${encodeURIComponent(id)}/${action}`,
      { runtimeDir: fixture.runtimeDir },
      true
    );
    assert.equal(response.status, 200, action);
    const body = await json(response);
    assert.equal(body.routeRef, "route:test-one");
    assert.equal(body.observedState, expectedState);
    if (action === "status") {
      const refreshed = await json(await authenticatedGet(fixture.adminCookie, "/api/connectivity"));
      assert.deepEqual(refreshed.runtimeControl, { active: true, mode: "historical" });
    }
  }
  const dockerCommands = (await readFile(fixture.dockerLog, "utf8")).trim().split("\n");
  const runCommands = dockerCommands.filter((command) => command.startsWith("run "));
  assert.equal(runCommands.length, 1);
  assert.equal(runCommands.some((command) => /luanniao\.role=connector/.test(command)), true);
  assert.equal(runCommands.some((command) => /luanniao\.role=index/.test(command)), false);
  assert.equal(runCommands.some((command) => /luanniao\.role=history-index/.test(command)), false);
  const store = new ConnectivityStore(join(fixture.runtimeDir, "state.sqlite"));
  const route = store.getDefinition(id);
  store.close();
  assert.equal(route, undefined);
});

test("opaque mitm flows stay HTTP typed and routed replay fails closed until the route is live", async () => {
  const runtimeDir = join(fixture.root, "mitm-runtime");
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows", "task-one"), { recursive: true });
  await writeFile(join(trafficRoot, "flows", "task-one", "epoch-one.mitm"), "captured");
  await writeFile(join(runtimeDir, "execution.jsonl"), "");
  await writeFile(join(runtimeDir, "graph-deltas.jsonl"), "");
  const token = "b".repeat(64);
  const httpFlowRef = "task:one:flow/http";
  const tcpFlowRef = "task:one:flow/tcp";
  const indexServer = createHttpServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return sendIndex(response, { status: "ok" });
    if (request.method === "POST") return sendIndex(response, { error: "index_is_read_only" }, 405);
    if (url.pathname === "/history") {
      const replayOf = url.searchParams.get("replay_of");
      const epochRef = url.searchParams.get("epoch_ref") ?? "";
      return sendIndex(response, {
        records: replayOf ? [{ ...flowRecord("web-replay:one", "http"), mode: "replay", replay_of: replayOf, epoch_ref: epochRef }] : [flowRecord(httpFlowRef, "http")],
        has_more: false
      });
    }
    const suffix = decodeURIComponent(url.pathname.slice("/history/".length));
    const body = suffix.endsWith("/body");
    const flowRef = body ? suffix.slice(0, -"/body".length) : suffix;
    if (body) return sendIndex(response, { exchange_id: flowRef, side: url.searchParams.get("side"), body_ref: `${flowRef}:request`, encoding: "base64", data: "dGVzdA==", bytes: 4, truncated: false });
    if (flowRef === httpFlowRef) return sendIndex(response, { record: flowRecord(httpFlowRef, "http") });
    if (flowRef === tcpFlowRef) return sendIndex(response, { record: flowRecord(tcpFlowRef, "tcp") });
    return sendIndex(response, { error: "not_found" }, 404);
  });
  await new Promise<void>((resolveListen) => indexServer.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = indexServer.address();
    assert(address && typeof address === "object");
    await writeFile(join(trafficRoot, "index.token"), token);
    await writeFile(join(trafficRoot, "index.json"), JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token }));
    const runtimeArtifacts = new ArtifactStore(join(runtimeDir, "artifacts"), join(runtimeDir, "state.sqlite"));
    const credential = await runtimeArtifacts.write({
      taskId: "task:one",
      kind: "text",
      mediaType: "text/plain",
      data: "ops:route-password\n"
    });
    runtimeArtifacts.close();
    const store = new ConnectivityStore(join(runtimeDir, "state.sqlite"));
    store.upsertDefinition({
      kind: "session", externalId: "connection:ssh-one", desiredState: "stopped", status: "stale",
      sessionType: "shell", hostRef: "host:dmz", definition: { transport: "ssh", routeOwned: true }
    });
    store.upsertDefinition({
      kind: "route", externalId: "route:test-one", desiredState: "stopped", status: "stale", hostRef: "host:dmz",
      processRef: "connector:test-one", credentialRef: credential.artifactRef,
      definition: {
        runtimeManaged: true,
        transport: "ssh",
        pivotHostRef: "host:dmz",
        targetCidrs: ["172.31.0.0/24"],
        connectionRef: "connection:ssh-one",
        connectorRef: "connector:test-one",
        dialAddress: "192.0.2.10",
        dialPort: 22,
        dialUser: "ops",
        ownerTaskId: "task:one"
      }
    });
    store.close();

    const detail = await fetch(`${fixture.baseUrl}/api/traffic/history/${encodeURIComponent(httpFlowRef)}?runtimeDir=${encodeURIComponent(runtimeDir)}`, { headers: { cookie: fixture.analystCookie } });
    const detailBody = await json(detail);
    assert.equal(detail.status, 200, JSON.stringify(detailBody));
    assert.equal(detailBody.kind, "http");
    const body = await fetch(`${fixture.baseUrl}/api/traffic/history/${encodeURIComponent(httpFlowRef)}/body?runtimeDir=${encodeURIComponent(runtimeDir)}&side=request`, { headers: { cookie: fixture.analystCookie } });
    assert.equal(body.status, 200);
    assert.equal((await json(body)).exchange_id, httpFlowRef);

    const mismatchedConnection = await mutate(fixture.adminCookie, `/api/traffic/history/${encodeURIComponent(httpFlowRef)}/replay`, {
      runtimeDir,
      session_ref: "connection:other"
    }, true);
    assert.equal(mismatchedConnection.status, 400);
    assert.equal((await json(mismatchedConnection)).error.code, "traffic_replay_connection_mismatch");

    const stoppedReplay = await mutate(fixture.adminCookie, `/api/traffic/history/${encodeURIComponent(httpFlowRef)}/replay`, { runtimeDir }, true);
    assert.equal(stoppedReplay.status, 409);
    assert.equal((await json(stoppedReplay)).error.code, "traffic_replay_route_reconnect_required");

    const routeOnlyStore = new ConnectivityStore(join(runtimeDir, "state.sqlite"));
    routeOnlyStore.upsertDefinition({ kind: "route", externalId: "route:test-one", desiredState: "running", status: "live" });
    routeOnlyStore.close();
    const missingConnectionReplay = await mutate(fixture.adminCookie, `/api/traffic/history/${encodeURIComponent(httpFlowRef)}/replay`, { runtimeDir }, true);
    assert.equal(missingConnectionReplay.status, 409);
    assert.equal((await json(missingConnectionReplay)).error.code, "traffic_replay_route_reconnect_required");

    const liveStore = new ConnectivityStore(join(runtimeDir, "state.sqlite"));
    liveStore.upsertDefinition({ kind: "session", externalId: "connection:ssh-one", desiredState: "running", status: "live" });
    liveStore.close();
    const routeId = stableConnectivityId("route", "route:test-one");
    const reconnected = await mutate(
      fixture.adminCookie,
      `/api/connectivity/${encodeURIComponent(routeId)}/reconnect`,
      { runtimeDir },
      true
    );
    assert.equal(reconnected.status, 200);
    assert.equal((await json(reconnected)).observedState, "live");
    await writeFile(join(trafficRoot, "index.json"), JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token,
      network: "luanniao-net-0123456789abcdef"
    }));
    const replayed = await mutate(fixture.adminCookie, `/api/traffic/history/${encodeURIComponent(httpFlowRef)}/replay`, {
      runtimeDir,
      task_ref: "task:override",
      run_ref: "run:override",
      url: "http://172.31.0.20/replayed",
      headers: [
        { name: "Host", value: "virtual.internal", ordinal: 0 },
        { name: "Content-Length", value: "999", ordinal: 1 },
        { name: "Connection", value: "X-Hop", ordinal: 2 },
        { name: "X-Hop", value: "secret", ordinal: 3 },
        { name: "X-End-To-End", value: "kept", ordinal: 4 }
      ],
      body: { encoding: "base64", data: "dGVzdA==" }
    }, true);
    const replayedBody = await json(replayed);
    assert.equal(replayed.status, 200, JSON.stringify({
      replayedBody,
      dockerLog: await readFile(fixture.dockerLog, "utf8")
    }));
    assert.deepEqual(replayedBody, { exchangeId: "web-replay:one", replayOf: httpFlowRef, status: 200 });
    const replayInput = JSON.parse(await readFile(join(fixture.root, "replay-input.json"), "utf8")) as Record<string, unknown>;
    const replayContext = replayInput.context as Record<string, unknown>;
    assert.match(String(replayContext.attribution), /^web-user:.+:admin$/);
    assert.deepEqual({ ...replayInput, context: { ...replayContext, attribution: "web-user:test:admin" } }, {
      method: "GET",
      url: "http://172.31.0.20/replayed",
      headers: [
        { name: "Host", value: "virtual.internal" },
        { name: "X-End-To-End", value: "kept" }
      ],
      body: "dGVzdA==",
      context: {
        replayOf: httpFlowRef,
        runtimeRef: "run:one",
        taskRef: "task:one",
        runRef: "run:one",
        routeRef: "route:test-one",
        connectionRef: "connection:ssh-one",
        attribution: "web-user:test:admin"
      },
      targetCidrs: ["172.31.0.0/24"]
    });
    const dockerLog = await readFile(fixture.dockerLog, "utf8");
    assert.match(dockerLog, /exec -i --user 1000:1000 luanniao-replay-gateway-/);
    assert.match(dockerLog, /gatewayctl epoch\.begin/);
    assert.match(dockerLog, /\.mitm/);
    assert.match(dockerLog, /\.net\.jsonl/);

    const tcpReplay = await mutate(fixture.adminCookie, `/api/traffic/history/${encodeURIComponent(tcpFlowRef)}/replay`, { runtimeDir }, true);
    assert.equal(tcpReplay.status, 409);
    assert.equal((await json(tcpReplay)).error.code, "traffic_replay_source_not_replayable");
  } finally {
    indexServer.closeAllConnections();
    await new Promise<void>((resolveClose) => indexServer.close(() => resolveClose()));
  }
});

test("replay refreshes the flow client after the historical index hands ownership to the runtime", async () => {
  const runtimeDir = join(fixture.root, "mitm-handoff-runtime");
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows", "task-handoff"), { recursive: true });
  await writeFile(join(trafficRoot, "flows", "task-handoff", "epoch-one.mitm"), "captured");
  const token = "c".repeat(64);
  const historyIndexAddress = fixture.historyIndexServer.address();
  assert(historyIndexAddress && typeof historyIndexAddress === "object");
  await writeFile(join(trafficRoot, "index.token"), token);
  await writeFile(join(trafficRoot, "index.json"), JSON.stringify({
    url: `http://127.0.0.1:${historyIndexAddress.port}`,
    token
  }));
  await writeFile(join(runtimeDir, "execution.jsonl"), "");
  await writeFile(join(runtimeDir, "graph-deltas.jsonl"), "");
  const historyRequestCount = fixture.historyIndexRequests.length;

  const replayed = await mutate(
    fixture.adminCookie,
    `/api/traffic/history/${encodeURIComponent("task:handoff:flow/http")}/replay`,
    { runtimeDir },
    true
  );
  const replayedBody = await json(replayed);
  assert.equal(replayed.status, 200, JSON.stringify({
    replayedBody,
    dockerLog: await readFile(fixture.dockerLog, "utf8")
  }));
  assert.deepEqual(replayedBody, {
    exchangeId: "web-replay:handoff",
    replayOf: "task:handoff:flow/http",
    status: 200
  });
  const runtimeIndexAddress = fixture.indexServer.address();
  assert(runtimeIndexAddress && typeof runtimeIndexAddress === "object");
  const runtimeDescriptor = JSON.parse(await readFile(join(trafficRoot, "index.json"), "utf8")) as Record<string, unknown>;
  assert.equal(runtimeDescriptor.url, `http://127.0.0.1:${runtimeIndexAddress.port}`);
  assert.notEqual(runtimeDescriptor.url, `http://127.0.0.1:${historyIndexAddress.port}`);
  assert.equal(runtimeDescriptor.token, token);
  assert.equal(fixture.historyIndexRequests.length, historyRequestCount);
});

test("missing opaque replay flow returns 404 without starting a network runtime", async () => {
  const runtimeDir = join(fixture.root, "missing-mitm-runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "execution.jsonl"), "");
  await writeFile(join(runtimeDir, "graph-deltas.jsonl"), "");
  const dockerBefore = await readFile(fixture.dockerLog, "utf8");

  const response = await mutate(
    fixture.adminCookie,
    `/api/traffic/history/${encodeURIComponent("task:missing:flow/http")}/replay`,
    { runtimeDir },
    true
  );

  assert.equal(response.status, 404);
  assert.equal((await json(response)).error.code, "traffic_flow_not_found");
  assert.equal(await readFile(fixture.dockerLog, "utf8"), dockerBefore);
});

test("retired connectivity APIs return a stable error without echoing submitted secrets", async () => {
  const response = await mutate(fixture.adminCookie, "/api/connectivity/tunnels", {
    ...tunnelBody(),
    password: "VERY_SECRET"
  }, true);
  assert.equal(response.status, 410);
  const text = await response.text();
  assert.match(text, /connectivity_definition_api_removed/);
  assert.doesNotMatch(text, /VERY_SECRET/);
});

function tunnelBody(): Record<string, unknown> {
  return {
    runtimeDir: fixture.runtimeDir,
    externalId: "web-tunnel-test",
    fromHostRef: "host:local",
    toHostRef: "host:target",
    host: "target.example",
    user: "operator",
    credentialRef: "credential:ssh:test",
    desiredState: "stopped",
    forwards: [{ mode: "local", bindHost: "127.0.0.1", bindPort: 18080, targetHost: "127.0.0.1", targetPort: 8080 }]
  };
}

function flowRecord(flowRef: string, kind: "http" | "tcp", routed = true): Record<string, unknown> {
  return {
    id: flowRef,
    kind,
    method: kind === "http" ? "GET" : "TCP",
    url: kind === "http" ? "http://172.31.0.20/flag.html" : "tcp://172.31.0.20:22",
    host: kind === "http" ? "172.31.0.20" : "172.31.0.20:22",
    scheme: kind,
    protocol: kind === "http" ? "HTTP/1.1" : "TCP",
    mode: kind === "http" ? "mitm" : "passthrough",
    status: 200,
    started_at: "2026-07-25T10:00:00Z",
    completed_at: "2026-07-25T10:00:01Z",
    duration_ms: 1000,
    request_observed_bytes: kind === "http" ? 0 : 4,
    response_observed_bytes: 0,
    request_captured_bytes: kind === "http" ? 0 : 4,
    response_captured_bytes: 0,
    request_capture_state: kind === "http" ? "none" : "captured",
    response_capture_state: "none",
    request_truncated: false,
    response_truncated: false,
    headers_truncated: false,
    quota_pressure: false,
    evicted_exchanges: 0,
    request_headers: [],
    route_ref: kind === "http" && routed ? "route:test-one" : "",
    session_ref: "",
    connection_ref: kind === "http" && routed ? "connection:ssh-one" : "",
    task_ref: "task:one",
    run_ref: "run:one"
  };
}

function handoffFlowRecord(): Record<string, unknown> {
  return {
    ...flowRecord("task:handoff:flow/http", "http", false),
    request_observed_bytes: 4,
    request_captured_bytes: 4,
    request_capture_state: "captured",
    request_body_ref: "task:handoff:flow/http:request"
  };
}

function sendIndex(response: import("node:http").ServerResponse, value: Record<string, unknown>, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function authenticatedGet(cookie: string, pathname: string): Promise<Response> {
  return fetch(`${fixture.baseUrl}${pathname}?runtimeDir=${encodeURIComponent(fixture.runtimeDir)}`, {
    headers: { cookie }
  });
}

async function mutate(cookie: string, pathname: string, body: Record<string, unknown>, csrf: boolean): Promise<Response> {
  let requestCookie = cookie;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrf) {
    const csrfResponse = await fetch(`${fixture.baseUrl}/api/auth/csrf`, { headers: { cookie } });
    assert.equal(csrfResponse.status, 200);
    const token = (await json(csrfResponse)).csrfToken as string;
    const csrfCookie = csrfResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert(csrfCookie);
    requestCookie = `${cookie}; ${csrfCookie}`;
    headers["x-csrf-token"] = token;
  }
  headers.cookie = requestCookie;
  return fetch(`${fixture.baseUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp("/tmp/ln-connectivity-");
  const runtimeDir = join(root, "runtime-a");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "execution.jsonl"), "");
  await writeFile(join(runtimeDir, "graph-deltas.jsonl"), "");
  const store = new ConnectivityStore(join(runtimeDir, "state.sqlite"));
  store.close();
  const graph = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "graph-deltas.jsonl"));
  graph.upsertDelta({
    sourceEventIds: [],
    nodes: [
      { id: "host:local", graphKind: "operation", type: "Host", label: "Local", properties: {} },
      { id: "host:target", graphKind: "operation", type: "Host", label: "Target", properties: {} }
    ],
    edges: []
  });
  graph.close();

  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-456" });
  auth.close();

  const historyIndexRequests: string[] = [];
  const historyIndexServer = createHttpServer((request, response) => {
    historyIndexRequests.push(request.url ?? "/");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return sendIndex(response, { status: "ok" });
    if (url.pathname === "/history") {
      return sendIndex(response, {
        records: url.searchParams.has("replay_of")
          ? []
          : [flowRecord("task:one:flow/http", "http"), handoffFlowRecord()],
        has_more: false
      });
    }
    const suffix = decodeURIComponent(url.pathname.slice("/history/".length));
    const body = suffix.endsWith("/body");
    const flowRef = body ? suffix.slice(0, -"/body".length) : suffix;
    if (body) return sendIndex(response, { exchange_id: flowRef, side: url.searchParams.get("side"), body_ref: `${flowRef}:request`, encoding: "base64", data: "dGVzdA==", bytes: 4, truncated: false });
    if (flowRef === "task:one:flow/http") return sendIndex(response, { record: flowRecord(flowRef, "http") });
    if (flowRef === "task:handoff:flow/http") return sendIndex(response, { record: handoffFlowRecord() });
    return sendIndex(response, { error: "not_found" }, 404);
  });
  await new Promise<void>((resolveListen) => historyIndexServer.listen(0, "127.0.0.1", resolveListen));
  const historyIndexAddress = historyIndexServer.address();
  assert(historyIndexAddress && typeof historyIndexAddress === "object");

  const indexServer = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return sendIndex(response, { status: "ok" });
    if (url.pathname === "/history") {
      const replayOf = url.searchParams.get("replay_of");
      const epochRef = url.searchParams.get("epoch_ref") ?? "";
      return sendIndex(response, {
        records: replayOf
          ? [{
              ...flowRecord(replayOf === "task:handoff:flow/http" ? "web-replay:handoff" : "web-replay:one", "http", replayOf !== "task:handoff:flow/http"),
              mode: "replay",
              replay_of: replayOf,
              epoch_ref: epochRef
            }]
          : [flowRecord("task:one:flow/http", "http"), handoffFlowRecord()],
        has_more: false
      });
    }
    const suffix = decodeURIComponent(url.pathname.slice("/history/".length));
    const body = suffix.endsWith("/body");
    const flowRef = body ? suffix.slice(0, -"/body".length) : suffix;
    if (body) return sendIndex(response, { exchange_id: flowRef, side: url.searchParams.get("side"), body_ref: `${flowRef}:request`, encoding: "base64", data: "dGVzdA==", bytes: 4, truncated: false });
    if (flowRef === "task:one:flow/http") return sendIndex(response, { record: flowRecord(flowRef, "http") });
    if (flowRef === "task:one:flow/tcp") return sendIndex(response, { record: flowRecord(flowRef, "tcp") });
    if (flowRef === "task:handoff:flow/http") return sendIndex(response, { record: handoffFlowRecord() });
    return sendIndex(response, { error: "not_found" }, 404);
  });
  await new Promise<void>((resolveListen) => indexServer.listen(0, "127.0.0.1", resolveListen));
  const indexAddress = indexServer.address();
  assert(indexAddress && typeof indexAddress === "object");
  const fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin);
  const fakeDocker = join(fakeBin, "docker");
  const dockerLog = join(root, "docker.log");
  const replayInput = join(root, "replay-input.json");
  await writeFile(dockerLog, "");
  await writeFile(fakeDocker, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  network)
    case "$2" in
      inspect)
        case "$*" in
          *IPAM.Config*luanniao-net-*) printf '172.28.0.0/16\\n'; exit 0 ;;
          *luanniao-net-0123456789abcdef*) printf '172.28.0.0/16\\n'; exit 0 ;;
          *luanniao-replay-task-*) printf 'true|replay-task-network|172.29.0.0/16|true\\n'; exit 0 ;;
          *) exit 1 ;;
        esac ;;
      *) exit 0 ;;
    esac ;;
  inspect)
    case "$*" in
      *NetworkSettings.Networks*) printf '172.28.0.2\\n'; exit 0 ;;
      *luanniao-history-index-*)
        case "$*" in
          *State.Running*) exit 1 ;;
          *) printf 'true|history-index\\n'; exit 0 ;;
        esac ;;
      *) exit 1 ;;
    esac ;;
  exec)
    case "$*" in
      *gatewayctl*) printf '{"ok":true}\\n' ;;
      *replay_client.py*) cat > "$FAKE_DOCKER_REPLAY_INPUT"; printf '{"ok":true,"status":200}\\n' ;;
    esac ;;
  port)
    case "$2" in
      luanniao-history-index-*) printf '127.0.0.1:%s\\n' "$FAKE_DOCKER_HISTORY_INDEX_PORT" ;;
      *) printf '127.0.0.1:%s\\n' "$FAKE_DOCKER_INDEX_PORT" ;;
    esac ;;
  *) exit 0 ;;
esac
`);
  await chmod(fakeDocker, 0o755);

  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--runtime-dir", root,
    "--auth-db", join(root, "auth.sqlite")
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_INDEX_PORT: String(indexAddress.port),
      FAKE_DOCKER_HISTORY_INDEX_PORT: String(historyIndexAddress.port),
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_REPLAY_INPUT: replayInput
    }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(child, baseUrl);
  return {
    baseUrl,
    root,
    runtimeDir,
    adminCookie: `luanniao_session=${encodeURIComponent(admin.token)}`,
    analystCookie: `luanniao_session=${encodeURIComponent(analyst.token)}`,
    process: child,
    indexServer,
    historyIndexServer,
    historyIndexRequests,
    dockerLog
  };
}

async function destroyFixture(value: Fixture): Promise<void> {
  if (value.process.exitCode === null && value.process.signalCode === null) {
    value.process.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      value.process.once("exit", () => resolveExit());
      setTimeout(resolveExit, 3_000).unref();
    });
  }
  value.indexServer.closeAllConnections();
  await new Promise<void>((resolveClose) => value.indexServer.close(() => resolveClose()));
  value.historyIndexServer.closeAllConnections();
  await new Promise<void>((resolveClose) => value.historyIndexServer.close(() => resolveClose()));
  await rm(value.root, { recursive: true, force: true });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitForServer(child: ChildProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`web server exited early (${child.exitCode}): ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/csrf`);
      if (response.status === 200) return;
    } catch {
      // Server has not started listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`timed out waiting for web server: ${stderr}`);
}
