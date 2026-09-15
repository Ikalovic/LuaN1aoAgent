import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ExecutionLog } from "../src/stores/execution-log.js";
import { SQLiteGraphStore } from "../src/stores/graph-store.js";
import { RuntimeStore } from "../src/stores/runtime-store.js";
import { WebAuthService } from "../src/web-auth.js";

type ServerHarness = {
  baseUrl: string;
  root: string;
  adminCookie: string;
  csrf: string;
  child: ChildProcess;
};

type SeededRuntime = {
  goal: string;
  scopeSummary?: string;
  taskType?: "ctf" | "pentest";
  rootGoalStatus?: string;
};

async function seedRuntime(runtimeDir: string, seed: SeededRuntime): Promise<void> {
  await mkdir(runtimeDir, { recursive: true });
  const graphStore = new SQLiteGraphStore(join(runtimeDir, "state.sqlite"), join(runtimeDir, "graph-deltas.jsonl"));
  graphStore.upsertDelta({
    sourceEventIds: [],
    nodes: [
      {
        id: "goal:root",
        graphKind: "task",
        type: "Goal",
        label: seed.goal,
        properties: { status: seed.rootGoalStatus ?? "completed" }
      },
      {
        id: "scope:root",
        graphKind: "task",
        type: "Scope",
        label: "Authorized scope",
        properties: seed.scopeSummary ? { summary: seed.scopeSummary } : {}
      }
    ],
    edges: [{ from: "goal:root", to: "scope:root", type: "within_scope" }]
  });
  graphStore.close();
  if (seed.taskType) {
    const log = new ExecutionLog(join(runtimeDir, "execution.jsonl"), join(runtimeDir, "state.sqlite"));
    await log.append({
      role: "runtime",
      eventType: "run_started",
      summary: seed.goal,
      payload: {
        userGoal: seed.goal,
        scopeSummary: seed.scopeSummary ?? "",
        taskType: seed.taskType
      }
    });
    log.close();
  }
  const store = new RuntimeStore(join(runtimeDir, "state.sqlite"));
  store.close();
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function startHangingLlmServer(): Promise<{ port: number; server: Server; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // Never respond: keeps any started continuation run active.
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      resolveListen({ port: (server.address() as AddressInfo).port, server, sockets });
    });
  });
}

function dockerDaemonAvailable(): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const probe = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    probe.once("error", () => resolveAvailability(false));
    probe.once("exit", (code) => resolveAvailability(code === 0));
  });
}

function networkImageAvailable(): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const probe = spawn("docker", ["image", "inspect", "luanniao-network:latest"], { stdio: "ignore" });
    probe.once("error", () => resolveAvailability(false));
    probe.once("exit", (code) => resolveAvailability(code === 0));
  });
}

async function waitForServer(child: ChildProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`web server exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/csrf`);
      if (response.status === 200) return;
    } catch {
      // Server has not started listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("timed out waiting for the web server");
}

async function postRun(
  baseUrl: string,
  cookie: string,
  csrf: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${cookie}; luanniao_csrf=${csrf}`,
      "x-csrf-token": csrf
    },
    body: JSON.stringify(body)
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test("POST /api/runs continues an existing runtime with stored identity defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lnw-continue-"));
  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  auth.close();

  const priorPentest = join(root, "sessions", "prior-pentest");
  const priorCtf = join(root, "sessions", "prior-ctf");
  const priorNoScope = join(root, "sessions", "prior-no-scope");
  await seedRuntime(priorPentest, {
    goal: "渗透既有目标",
    scopeSummary: "api.example,10.0.0.0/24",
    taskType: "pentest",
    rootGoalStatus: "completed"
  });
  await seedRuntime(priorCtf, {
    goal: "完成 CTF 挑战",
    taskType: "ctf",
    rootGoalStatus: "blocked"
  });
  await seedRuntime(priorNoScope, {
    goal: "无授权范围的历史渗透",
    rootGoalStatus: "completed"
  });

  const hangingLlm = await startHangingLlmServer();
  t.after(async () => {
    for (const socket of hangingLlm.sockets) socket.destroy();
    await new Promise<void>((resolveClose) => hangingLlm.server.close(() => resolveClose()));
  });

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
      EXECUTOR_SANDBOX_MODE: "workspace",
      LLM_API_BASE_URL: `http://127.0.0.1:${hangingLlm.port}/v1`,
      LLM_API_KEY: "test-key",
      LLM_DEFAULT_MODEL: "test-model"
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        setTimeout(resolveExit, 3_000).unref();
      });
    }
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "continue-csrf";
  const adminCookie = `luanniao_session=${encodeURIComponent(admin.token)}`;
  await waitForServer(child, baseUrl);

  // CSRF validation runs before authentication for mutating routes (existing order).
  const unauthenticated = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runtimeDir: priorPentest })
  });
  assert.equal(unauthenticated.status, 403);
  assert.equal((await json(unauthenticated)).error.code, "csrf_token_missing");

  // Stored goal/scope are carried over; the response marks the run as continued.
  const continued = await postRun(baseUrl, adminCookie, csrf, { runtimeDir: priorPentest });
  assert.equal(continued.status, 201);
  const continuedBody = await json(continued);
  assert.equal(continuedBody.continued, true);
  assert.equal(continuedBody.goal, "渗透既有目标");
  assert.equal(continuedBody.scope, "api.example,10.0.0.0/24");
  assert.equal(continuedBody.taskType, "pentest");

  // A second continuation of the same runtime conflicts while the run is active.
  const conflict = await postRun(baseUrl, adminCookie, csrf, { runtimeDir: priorPentest });
  assert.equal(conflict.status, 409);
  assert.equal((await json(conflict)).error.code, "run_already_active");

  // Body-provided goal/scope/taskType override the stored identity.
  const overridden = await postRun(baseUrl, adminCookie, csrf, {
    runtimeDir: priorCtf,
    goal: "换一个目标继续",
    scope: "manual.example",
    taskType: "pentest"
  });
  assert.equal(overridden.status, 201);
  const overriddenBody = await json(overridden);
  assert.equal(overriddenBody.continued, true);
  assert.equal(overriddenBody.goal, "换一个目标继续");
  assert.equal(overriddenBody.scope, "manual.example");
  assert.equal(overriddenBody.taskType, "pentest");

  // A pentest continuation without any stored or provided scope is rejected.
  const noScope = await postRun(baseUrl, adminCookie, csrf, { runtimeDir: priorNoScope });
  assert.equal(noScope.status, 400);
  assert.equal((await json(noScope)).error.code, "invalid_request");

  // Unknown and out-of-root runtime dirs keep their existing error semantics.
  const missing = await postRun(baseUrl, adminCookie, csrf, { runtimeDir: join(root, "sessions", "missing") });
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).error.code, "runtime_path_not_found");
  const outside = await postRun(baseUrl, adminCookie, csrf, { runtimeDir: join(tmpdir(), "outside-root") });
  assert.equal(outside.status, 403);
  assert.equal((await json(outside)).error.code, "runtime_path_outside_root");

  // The sessions listing exposes continuation prerequisites for the UI. The
  // continued run reopens the Root Goal asynchronously, so poll the live status
  // instead of depending on how quickly the child process reaches it.
  const sessionsDeadline = Date.now() + 5_000;
  let prior: Record<string, unknown> | undefined;
  for (;;) {
    const sessions = await fetch(`${baseUrl}/api/sessions?rootDir=${encodeURIComponent(root)}`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(sessions.status, 200);
    const sessionsBody = await json(sessions);
    prior = (sessionsBody.sessions as Array<Record<string, unknown>>)
      .find((session) => session.name === "prior-pentest");
    if (prior?.rootGoalStatus === "open" || Date.now() >= sessionsDeadline) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.ok(prior, "seeded session listed");
  assert.equal(prior.scopeSummary, "api.example,10.0.0.0/24");
  // The continued run reopened the Root Goal, so the live status is open.
  assert.equal(prior.rootGoalStatus, "open");
  assert.equal(prior.taskType, "pentest");
  assert.equal(prior.running, true);
});

test("POST /api/runs maps an occupied runtime ownership lease to 409", async (t) => {
  if (!await dockerDaemonAvailable()) {
    t.skip("Docker daemon unavailable; docker-mode bootstrap cannot reach the lease check");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "lnw-lease-conflict-"));
  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  auth.close();

  const prior = join(root, "sessions", "prior-lease");
  await seedRuntime(prior, {
    goal: "续跑冲突场景",
    scopeSummary: "api.example",
    taskType: "pentest",
    rootGoalStatus: "completed"
  });
  const leaseDir = join(prior, ".connectivity-runtime-owner");
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(join(leaseDir, "owner.json"), JSON.stringify({
    version: 1,
    token: "external-owner",
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  }));

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
      EXECUTOR_SANDBOX_MODE: "docker",
      LLM_API_BASE_URL: "http://127.0.0.1:1/v1",
      LLM_API_KEY: "test-key",
      LLM_DEFAULT_MODEL: "test-model"
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        setTimeout(resolveExit, 3_000).unref();
      });
    }
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "lease-conflict-csrf";
  const adminCookie = `luanniao_session=${encodeURIComponent(admin.token)}`;
  await waitForServer(child, baseUrl);

  // The lease belongs to another owner (this test process), so the docker
  // bootstrap's acquire() fails. It must surface as a typed conflict instead
  // of a generic 500 while the external owner keeps the lease.
  const conflict = await postRun(baseUrl, adminCookie, csrf, { runtimeDir: prior });
  assert.equal(conflict.status, 409);
  assert.equal((await json(conflict)).error.code, "connectivity_runtime_owned");
  assert.equal(
    JSON.parse(await readFile(join(leaseDir, "owner.json"), "utf8")).token,
    "external-owner"
  );
});

test("POST /api/runs releases this process's flow index lease before continuing", async (t) => {
  if (!await dockerDaemonAvailable() || !await networkImageAvailable()) {
    t.skip("Docker daemon or luanniao-network image unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "lnw-index-takeover-"));
  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  auth.close();

  const prior = join(root, "sessions", "prior-takeover");
  await seedRuntime(prior, {
    goal: "索引占用后继续运行",
    scopeSummary: "api.example",
    taskType: "pentest",
    rootGoalStatus: "completed"
  });
  const trafficRoot = join(prior, "traffic");
  await mkdir(join(trafficRoot, "flows", "task-one"), { recursive: true });
  await writeFile(join(trafficRoot, "flows", "task-one", "epoch-one.mitm"), "captured");
  await writeFile(join(trafficRoot, "index.token"), "c".repeat(64));

  const hangingLlm = await startHangingLlmServer();
  t.after(async () => {
    for (const socket of hangingLlm.sockets) socket.destroy();
    await new Promise<void>((resolveClose) => hangingLlm.server.close(() => resolveClose()));
  });

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
      EXECUTOR_SANDBOX_MODE: "docker",
      LLM_API_BASE_URL: `http://127.0.0.1:${hangingLlm.port}/v1`,
      LLM_API_KEY: "test-key",
      LLM_DEFAULT_MODEL: "test-model"
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        setTimeout(resolveExit, 3_000).unref();
      });
    }
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "index-takeover-csrf";
  const adminCookie = `luanniao_session=${encodeURIComponent(admin.token)}`;
  await waitForServer(child, baseUrl);

  // Reading traffic history revives the mitm flow index, which takes the
  // runtime ownership lease inside the Web process.
  const history = await fetch(
    `${baseUrl}/api/traffic/history?runtimeDir=${encodeURIComponent(prior)}`,
    { headers: { cookie: adminCookie } }
  );
  const leasePath = join(prior, ".connectivity-runtime-owner", "owner.json");
  if (history.status !== 200) {
    if (!existsSync(leasePath)) {
      t.skip(`flow index revival unavailable in this environment (${history.status})`);
      return;
    }
  }
  assert.ok(existsSync(leasePath), "flow index owner holds the runtime lease");
  const viewerToken = JSON.parse(await readFile(leasePath, "utf8")).token as string;

  // The continuation must take over the lease from the read-only viewer
  // instead of failing with a conflict.
  const continued = await postRun(baseUrl, adminCookie, csrf, { runtimeDir: prior });
  assert.equal(continued.status, 201);
  const continuedBody = await json(continued);
  assert.equal(continuedBody.continued, true);
  assert.equal(continuedBody.goal, "索引占用后继续运行");
  const takeover = JSON.parse(await readFile(leasePath, "utf8"));
  assert.equal(takeover.pid, child.pid);
  assert.notEqual(takeover.token, viewerToken);
});
