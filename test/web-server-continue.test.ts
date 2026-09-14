import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

  // The sessions listing exposes continuation prerequisites for the UI.
  const sessions = await fetch(`${baseUrl}/api/sessions?rootDir=${encodeURIComponent(root)}`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(sessions.status, 200);
  const sessionsBody = await json(sessions);
  const prior = (sessionsBody.sessions as Array<Record<string, unknown>>)
    .find((session) => session.name === "prior-pentest");
  assert.ok(prior, "seeded session listed");
  assert.equal(prior.scopeSummary, "api.example,10.0.0.0/24");
  // The continued run reopened the Root Goal, so the live status is open.
  assert.equal(prior.rootGoalStatus, "open");
  assert.equal(prior.taskType, "pentest");
  assert.equal(prior.running, true);
});
