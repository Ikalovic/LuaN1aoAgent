import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { ensureTrafficProxySocketDir, trafficProxyRuntimeIdentity } from "../src/connectivity/traffic-proxy-runtime.js";
import { ArtifactStore } from "../src/stores/artifact-store.js";
import { ConnectivityStore } from "../src/stores/connectivity-store.js";
import { WebAuthService } from "../src/web-auth.js";
import { hasCapability } from "../src/web-security.js";

type ControlRequest = {
  version: number;
  id: string;
  command: string;
  [key: string]: unknown;
};

type HeldReplay = { request: ControlRequest; socket: Socket };

type Fixture = {
  baseUrl: string;
  root: string;
  runtimeDir: string;
  adminCookie: string;
  analystCookie: string;
  csrfHeaders: Record<string, string>;
  managedRouteId: string;
  requests: ControlRequest[];
  failNextReplay: (message: string, errorCode: string) => void;
  holdReplays: () => void;
  heldReplayCount: () => number;
  releaseReplays: () => void;
  process: ChildProcess;
  controlServer: Server;
  indexServer: Server;
};

let fixture: Fixture;

function replayFetch(cookie: string, exchangeId: number, body: Record<string, unknown>, method = "POST"): Promise<Response> {
  return fetch(`${fixture.baseUrl}/api/traffic/history/${encodeURIComponent(`legacy:${exchangeId}`)}/replay?runtimeDir=${encodeURIComponent("/ignored/query/runtime")}`, {
    method,
    headers: {
      cookie,
      ...fixture.csrfHeaders,
      "content-type": "application/json"
    },
    body: method === "POST" ? JSON.stringify(body) : undefined
  });
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test.before(async () => {
  fixture = await createFixture();
});

test.after(async () => {
  if (fixture) await destroyFixture(fixture);
});

test("traffic replay capability is admin-only and route is POST-only", async () => {
  const auth = new WebAuthService(join(fixture.root, "auth.sqlite"));
  const admin = (await auth.login({ username: "admin", password: "admin-password-123" })).user;
  const analyst = (await auth.login({ username: "analyst", password: "analyst-password-456" })).user;
  assert.equal(hasCapability(admin, "traffic:replay"), true);
  assert.equal(hasCapability(analyst, "traffic:replay"), false);
  assert.equal(hasCapability(analyst, "traffic:read-sensitive"), true);

  const denied = await replayFetch(fixture.analystCookie, 42, { runtimeDir: fixture.runtimeDir });
  assert.equal(denied.status, 403);
  assert.equal((await responseJson(denied)).error.code, "authorization_forbidden");

  const get = await replayFetch(fixture.adminCookie, 42, { runtimeDir: fixture.runtimeDir }, "GET");
  assert.equal(get.status, 405);
  assert.equal((await responseJson(get)).error.code, "method_not_allowed");

  const numericFlowRef = await fetch(`${fixture.baseUrl}/api/traffic/history/42/replay`, {
    method: "POST",
    headers: {
      cookie: fixture.adminCookie,
      ...fixture.csrfHeaders,
      "content-type": "application/json"
    },
    body: JSON.stringify({ runtimeDir: fixture.runtimeDir })
  });
  assert.equal(numericFlowRef.status, 400);
  assert.equal((await responseJson(numericFlowRef)).error.code, "invalid_request");
});

test("admin replay preserves non-managed cli-run attribution and safe audit", async () => {
  const before = fixture.requests.length;
  const secrets = {
    url: "https://example.test/replay?token=URL_SECRET",
    header: "HEADER_SECRET",
    body: Buffer.from("BODY_SECRET").toString("base64")
  };
  const response = await replayFetch(fixture.adminCookie, 42, {
    runtimeDir: fixture.runtimeDir,
    method: "PATCH",
    url: secrets.url,
    headers: [
      { name: "X-Repeat", value: "one" },
      { name: "X-Repeat", value: secrets.header, ordinal: 7 }
    ],
    body: { encoding: "base64", data: secrets.body },
    route_ref: "cli-run",
    session_ref: "run:source",
    task_ref: "task-7",
    run_ref: "run-8"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { exchangeId: "legacy:1001", replayOf: "legacy:42", status: 204 });

  const replay = fixture.requests.slice(before).find((request) => request.command === "replay");
  assert(replay);
  const replayFields = withoutEnvelope(replay);
  const replayContext = replayFields.context as Record<string, unknown>;
  assert.match(String(replayContext.attribution), /^web-user:.+:admin$/);
  const { attribution: _attribution, ...contextWithoutAttribution } = replayContext;
  assert.deepEqual({ ...replayFields, context: contextWithoutAttribution }, {
    command: "replay",
    exchange_id: 42,
    method: "PATCH",
    url: secrets.url,
    headers: [
      { name: "X-Repeat", value: "one", ordinal: 0 },
      { name: "X-Repeat", value: secrets.header, ordinal: 7 }
    ],
    body: { encoding: "base64", data: secrets.body },
    route_ref: "cli-run",
    session_ref: "run:source",
    context: {
      runtime_ref: trafficProxyRuntimeIdentity(fixture.runtimeDir).runtimeRef,
      task_ref: "task:source",
      run_ref: "run:source",
      route_ref: "cli-run",
      session_ref: "run:source"
    }
  });

  const audit = await readFile(join(fixture.runtimeDir, "execution.jsonl"), "utf8");
  assert.match(audit, /traffic_replay_requested/);
  assert.match(audit, /traffic_replay_succeeded/);
  assert.doesNotMatch(audit, /URL_SECRET|HEADER_SECRET|BODY_SECRET/);
  assert.doesNotMatch(audit, new RegExp(escapeRegExp(secrets.body)));
});

test("routed legacy replay fails closed without calling Go replay", async () => {
  const before = fixture.requests.length;
  const response = await replayFetch(fixture.adminCookie, 310, { runtimeDir: fixture.runtimeDir });
  assert.equal(response.status, 409);
  assert.equal((await responseJson(response)).error.code, "traffic_replay_routed_legacy_unsupported");
  const requests = fixture.requests.slice(before);
  assert(requests.some((request) => request.command === "history_get"));
  assert.equal(requests.some((request) => request.command === "replay"), false);
});

test("routed legacy replay remains disabled after the same historical route is live", async () => {
  const reconnect = await fetch(`${fixture.baseUrl}/api/connectivity/${encodeURIComponent(fixture.managedRouteId)}/reconnect`, {
    method: "POST",
    headers: {
      cookie: fixture.adminCookie,
      ...fixture.csrfHeaders,
      "content-type": "application/json"
    },
    body: JSON.stringify({ runtimeDir: fixture.runtimeDir })
  });
  assert.equal(reconnect.status, 200, JSON.stringify(await responseJson(reconnect.clone())));
  await rm(join(fixture.runtimeDir, "traffic", "index.token"), { force: true });

  const before = fixture.requests.length;
  const response = await replayFetch(fixture.adminCookie, 311, { runtimeDir: fixture.runtimeDir });
  assert.equal(response.status, 409);
  assert.equal((await responseJson(response)).error.code, "traffic_replay_routed_legacy_unsupported");
  assert.equal(fixture.requests.slice(before).some((request) => request.command === "replay"), false);
});

test("replay rejects unknown keys, wrong types, invalid base64, and runtimeDir outside JSON body", async () => {
  const invalidBodies = [
    { runtimeDir: fixture.runtimeDir, actor: "forged" },
    { runtimeDir: fixture.runtimeDir, runtime_ref: "forged" },
    { runtimeDir: fixture.runtimeDir, headers: [{ name: "X-Test", value: "ok", secret: true }] },
    { runtimeDir: fixture.runtimeDir, headers: "not-an-array" },
    { runtimeDir: fixture.runtimeDir, body: { encoding: "base64", data: "%%%" } },
    { runtimeDir: fixture.runtimeDir, body: { encoding: "utf8", data: "test" } },
    { runtimeDir: fixture.runtimeDir, method: 7 }
  ];
  for (const body of invalidBodies) {
    const response = await replayFetch(fixture.adminCookie, 42, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await responseJson(response)).error.code, "invalid_request");
  }

  const queryOnly = await replayFetch(fixture.adminCookie, 42, {});
  assert.equal(queryOnly.status, 400);
  assert.equal((await responseJson(queryOnly)).error.code, "invalid_request");

  const oversized = await replayFetch(fixture.adminCookie, 42, {
    runtimeDir: fixture.runtimeDir,
    body: { encoding: "base64", data: "A".repeat(1_400_000) }
  });
  assert.equal(oversized.status, 400);
  assert.equal((await responseJson(oversized)).error.code, "invalid_request");

});

test("sidecar replay failures have stable mapping and sanitized failed result", async () => {
  const secret = "UPSTREAM_SECRET https://secret.invalid Authorization: bearer-secret";
  fixture.failNextReplay(secret, "source_not_replayable");
  const response = await replayFetch(fixture.adminCookie, 77, {
    runtimeDir: fixture.runtimeDir,
    url: "https://request-secret.invalid/path",
    headers: [{ name: "Authorization", value: "request-secret" }]
  });
  assert.equal(response.status, 409);
  const body = await responseJson(response);
  assert.deepEqual(body, {
    error: { code: "traffic_replay_source_not_replayable", message: "原始流量记录不可 replay" },
    errorCode: "source_not_replayable",
    exchangeId: "legacy:1002",
    replayOf: "legacy:77"
  });
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /UPSTREAM_SECRET|secret\.invalid|bearer-secret|request-secret/);

  const audit = await readFile(join(fixture.runtimeDir, "execution.jsonl"), "utf8");
  assert.match(audit, /traffic_replay_failed/);
  assert.match(audit, /source_not_replayable/);
  assert.doesNotMatch(audit, /UPSTREAM_SECRET|request-secret\.invalid|bearer-secret|Authorization/);
});

test("global replay limiter rejects the fifth concurrent request with a stable 429", async () => {
  fixture.holdReplays();
  const pending = Array.from({ length: 4 }, (_, index) => replayFetch(fixture.adminCookie, 200 + index, {
    runtimeDir: fixture.runtimeDir
  }));
  await waitFor(() => fixture.heldReplayCount() === 4);

  const limited = await replayFetch(fixture.adminCookie, 299, { runtimeDir: fixture.runtimeDir });
  assert.equal(limited.status, 429);
  const limitedBody = await responseJson(limited);
  assert.equal(limitedBody.error.code, "traffic_replay_limit_exceeded");
  assert.equal(limitedBody.errorCode, "traffic_replay_limit_exceeded");

  fixture.releaseReplays();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((response) => response.status), [200, 200, 200, 200]);
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp("/tmp/lnr-");
  const runtimeDir = join(root, "runtime-a");
  await mkdir(join(runtimeDir, "traffic-proxy"), { recursive: true });
  const runtimeIdentity = trafficProxyRuntimeIdentity(runtimeDir);
  await writeFile(join(runtimeDir, "execution.jsonl"), "");
  await writeFile(join(runtimeDir, "graph-deltas.jsonl"), "");
  const artifactStore = new ArtifactStore(join(runtimeDir, "artifacts"), join(runtimeDir, "state.sqlite"));
  const credential = await artifactStore.write({
    taskId: "task:route-owner",
    kind: "text",
    mediaType: "text/plain",
    data: "route-password"
  });
  artifactStore.close();
  const connectivityStore = new ConnectivityStore(join(runtimeDir, "state.sqlite"));
  const managedRoute = connectivityStore.upsertDefinition({
    kind: "route",
    externalId: "route:managed",
    desiredState: "running",
    status: "live",
    hostRef: "host:dmz",
    processRef: "connector:managed",
    credentialRef: credential.artifactRef,
    definition: {
      runtimeManaged: true,
      transport: "ssh",
      pivotHostRef: "host:dmz",
      dialAddress: "192.0.2.10",
      targetCidrs: ["172.31.0.0/24"],
      connectorRef: "connector:managed",
      connectionRef: "connection:managed",
      dialPort: 22,
      dialUser: "ops",
      ownerTaskId: "task:route-owner"
    }
  });
  connectivityStore.close();

  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-456" });

  const requests: ControlRequest[] = [];
  let failure: { message: string; errorCode: string } | undefined;
  let holding = false;
  const held: HeldReplay[] = [];
  const controlServer = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as ControlRequest;
      requests.push(request);
      if (request.command === "hello") {
        sendControlResult(socket, request, {
          protocol: "luanniao-traffic-proxy",
          version: 1,
          runtime_ref: runtimeIdentity.runtimeRef,
          proxy: "127.0.0.1:12345"
        });
        return;
      }
      if (request.command === "history_get") {
        sendControlResult(socket, request, sourceExchange(Number(request.exchange_id), runtimeIdentity.runtimeRef));
        return;
      }
      if (request.command !== "replay") {
        sendControlResult(socket, request, {});
        return;
      }
      if (failure) {
        const current = failure;
        failure = undefined;
        socket.end(JSON.stringify({
          version: 1,
          id: request.id,
          ok: false,
          error: current.message,
          error_code: current.errorCode,
          result: {
            exchange_id: 1002,
            replay_of: request.exchange_id,
            status: 0,
            error_code: current.errorCode
          }
        }) + "\n");
        return;
      }
      if (holding) {
        held.push({ request, socket });
        return;
      }
      sendReplaySuccess(socket, request, 1001);
    });
  });
  await ensureTrafficProxySocketDir(runtimeIdentity.socketDir);
  const socketPath = runtimeIdentity.controlSocket;
  await new Promise<void>((resolveListen, rejectListen) => {
    controlServer.once("error", rejectListen);
    controlServer.listen(socketPath, resolveListen);
  });

  const indexServer = createServer((socket) => {
    socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    indexServer.once("error", rejectListen);
    indexServer.listen(0, "127.0.0.1", resolveListen);
  });
  const indexAddress = indexServer.address();
  assert(indexAddress && typeof indexAddress === "object");
  const binDir = join(root, "bin");
  await mkdir(binDir);
  const dockerPath = join(binDir, "docker");
  await writeFile(dockerPath, `#!/bin/sh
case "$1" in
  network)
    case "$2" in
      inspect) exit 1 ;;
      *) exit 0 ;;
    esac
    ;;
  inspect)
    case "$*" in
      *IPAddress*) echo "172.18.0.2"; exit 0 ;;
    esac
    exit 1
    ;;
  port)
    echo "127.0.0.1:$FAKE_INDEX_PORT"
    exit 0
    ;;
  *) exit 0 ;;
esac
`);
  await chmod(dockerPath, 0o700);

  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--runtime-dir", root,
    "--auth-db", join(root, "auth.sqlite")
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FAKE_INDEX_PORT: String(indexAddress.port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(child, baseUrl);
  const csrfToken = "replay-test-csrf-token";
  return {
    baseUrl,
    root,
    runtimeDir,
    adminCookie: `luanniao_session=${encodeURIComponent(admin.token)}; luanniao_csrf=${csrfToken}`,
    analystCookie: `luanniao_session=${encodeURIComponent(analyst.token)}; luanniao_csrf=${csrfToken}`,
    csrfHeaders: { "x-csrf-token": csrfToken },
    managedRouteId: managedRoute.id,
    requests,
    failNextReplay: (message, errorCode) => { failure = { message, errorCode }; },
    holdReplays: () => { holding = true; },
    heldReplayCount: () => held.length,
    releaseReplays: () => {
      holding = false;
      held.splice(0).forEach(({ request, socket }, index) => sendReplaySuccess(socket, request, 1100 + index));
    },
    process: child,
    controlServer,
    indexServer
  };
}

function sourceExchange(exchangeId: number, runtimeRef: string): Record<string, unknown> {
  const managed = exchangeId === 310 || exchangeId === 311;
  const attributedDirect = exchangeId === 42;
  return {
    id: exchangeId,
    runtime_ref: runtimeRef,
    task_ref: managed ? "task:route-owner" : "task:source",
    run_ref: "run:source",
    route_ref: managed ? "route:managed" : attributedDirect ? "cli-run" : "",
    session_ref: managed ? "connection:managed" : attributedDirect ? "run:source" : ""
  };
}

function sendReplaySuccess(socket: Socket, request: ControlRequest, exchangeId: number): void {
  sendControlResult(socket, request, { exchange_id: exchangeId, replay_of: request.exchange_id, status: 204 });
}

function sendControlResult(socket: Socket, request: ControlRequest, result: unknown): void {
  socket.end(JSON.stringify({ version: 1, id: request.id, ok: true, result }) + "\n");
}

async function destroyFixture(value: Fixture): Promise<void> {
  if (value.process.exitCode === null && value.process.signalCode === null) {
    const exited = new Promise<void>((resolveExit) => {
      value.process.once("exit", () => resolveExit());
      setTimeout(resolveExit, 3_000).unref();
    });
    value.process.kill("SIGTERM");
    await exited;
  }
  await new Promise<void>((resolveClose) => value.controlServer.close(() => resolveClose()));
  await new Promise<void>((resolveClose) => value.indexServer.close(() => resolveClose()));
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("timed out waiting for held replay requests");
}

function withoutEnvelope(request: ControlRequest): Record<string, unknown> {
  const { version: _version, id: _id, ...fields } = request;
  return fields;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
