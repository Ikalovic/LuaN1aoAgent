import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebAuthService } from "../src/web-auth.js";

type ServerHarness = {
  baseUrl: string;
  root: string;
  adminCookie: string;
  analystCookie: string;
  csrfToken: string;
  csrfCookie: string;
  child: ChildProcess;
};

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

async function waitForServer(child: ChildProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
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

async function startServer(env: Record<string, string> = {}): Promise<ServerHarness> {
  const root = await mkdtemp(join(process.env.TEMP || "/tmp", "lnw-approvals-"));
  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-456" });
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
    env: { ...process.env, ...env }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(child, baseUrl);
  const csrf = await fetch(`${baseUrl}/api/auth/csrf`);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  // The CSRF token is double-submitted: the server compares the header against
  // the luanniao_csrf cookie it set, so requests must carry both.
  const csrfCookie = (csrf.headers.get("set-cookie") ?? "")
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("luanniao_csrf=")) ?? "";
  return {
    baseUrl,
    root,
    adminCookie: `luanniao_session=${encodeURIComponent(admin.token)}`,
    analystCookie: `luanniao_session=${encodeURIComponent(analyst.token)}`,
    csrfToken,
    csrfCookie,
    child
  };
}

async function stopServer(value: ServerHarness): Promise<void> {
  if (value.child.exitCode === null && value.child.signalCode === null) {
    value.child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      value.child.once("exit", () => resolveExit());
      setTimeout(resolveExit, 3_000).unref();
    });
  }
  await rm(value.root, { recursive: true, force: true });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test("approvals API gates by capability and reports the resolved mode", async (t) => {
  const server = await startServer();
  t.after(async () => stopServer(server));

  const anonymous = await fetch(`${server.baseUrl}/api/approvals`);
  assert.equal(anonymous.status, 401);
  assert.equal((await json(anonymous)).error.code, "unauthorized");

  const analyst = await fetch(`${server.baseUrl}/api/approvals`, {
    headers: { cookie: server.analystCookie }
  });
  assert.equal(analyst.status, 403);
  assert.equal((await json(analyst)).error.code, "authorization_forbidden");

  const admin = await fetch(`${server.baseUrl}/api/approvals`, {
    headers: { cookie: server.adminCookie }
  });
  assert.equal(admin.status, 200);
  const body = await json(admin);
  assert.equal(body.mode, "auto");
  assert.deepEqual(body.approvals, []);
  assert.equal(typeof body.loadedAt, "string");
});

test("approvals API honors APPROVAL_MODE from the environment", async (t) => {
  const server = await startServer({ APPROVAL_MODE: "strict" });
  t.after(async () => stopServer(server));

  const response = await fetch(`${server.baseUrl}/api/approvals`, {
    headers: { cookie: server.adminCookie }
  });
  assert.equal(response.status, 200);
  assert.equal((await json(response)).mode, "strict");
});

test("deciding a missing approval returns approval_not_found", async (t) => {
  const server = await startServer();
  t.after(async () => stopServer(server));

  const response = await fetch(`${server.baseUrl}/api/approvals/missing-id`, {
    method: "POST",
    headers: {
      cookie: `${server.adminCookie}; ${server.csrfCookie}`,
      "X-CSRF-Token": server.csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ decision: "approve" })
  });
  assert.equal(response.status, 404);
  assert.equal((await json(response)).error.code, "approval_not_found");
});

test("deciding with an invalid decision payload is rejected", async (t) => {
  const server = await startServer();
  t.after(async () => stopServer(server));

  const response = await fetch(`${server.baseUrl}/api/approvals/missing-id`, {
    method: "POST",
    headers: {
      cookie: `${server.adminCookie}; ${server.csrfCookie}`,
      "X-CSRF-Token": server.csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ decision: "maybe" })
  });
  assert.equal(response.status, 400);
  assert.equal((await json(response)).error.code, "invalid_request");
});

test("analyst cannot decide approval requests", async (t) => {
  const server = await startServer();
  t.after(async () => stopServer(server));

  const response = await fetch(`${server.baseUrl}/api/approvals/missing-id`, {
    method: "POST",
    headers: {
      cookie: `${server.analystCookie}; ${server.csrfCookie}`,
      "X-CSRF-Token": server.csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ decision: "approve" })
  });
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error.code, "authorization_forbidden");
});

test("admin can switch the approval mode at runtime", async (t) => {
  const server = await startServer();
  t.after(async () => stopServer(server));

  const switchResponse = await fetch(`${server.baseUrl}/api/approvals/mode`, {
    method: "POST",
    headers: {
      cookie: `${server.adminCookie}; ${server.csrfCookie}`,
      "X-CSRF-Token": server.csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ mode: "strict" })
  });
  assert.equal(switchResponse.status, 200);
  assert.deepEqual(await json(switchResponse), { ok: true, mode: "strict" });

  const listResponse = await fetch(`${server.baseUrl}/api/approvals`, {
    headers: { cookie: server.adminCookie }
  });
  assert.equal(listResponse.status, 200);
  assert.equal((await json(listResponse)).mode, "strict");
});

test("switching to an invalid approval mode is rejected", async (t) => {
  const server = await startServer();
  t.after(async () => stopServer(server));

  for (const payload of [{ mode: "maybe" }, { mode: 42 }, {}]) {
    const response = await fetch(`${server.baseUrl}/api/approvals/mode`, {
      method: "POST",
      headers: {
        cookie: `${server.adminCookie}; ${server.csrfCookie}`,
        "X-CSRF-Token": server.csrfToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, "invalid_request");
  }

  // The failed switches must not change the mode.
  const listResponse = await fetch(`${server.baseUrl}/api/approvals`, {
    headers: { cookie: server.adminCookie }
  });
  assert.equal((await json(listResponse)).mode, "auto");
});

test("analyst cannot switch the approval mode", async (t) => {
  const server = await startServer();
  t.after(async () => stopServer(server));

  const response = await fetch(`${server.baseUrl}/api/approvals/mode`, {
    method: "POST",
    headers: {
      cookie: `${server.analystCookie}; ${server.csrfCookie}`,
      "X-CSRF-Token": server.csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ mode: "off" })
  });
  assert.equal(response.status, 403);
  assert.equal((await json(response)).error.code, "authorization_forbidden");
});
