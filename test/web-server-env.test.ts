import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebAuthService } from "../src/web-auth.js";

test("Web API exposes admin-only .env management and refreshes MCP configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-env-"));
  const project = join(root, "project");
  const runtime = join(project, ".agent-runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(project, ".env"), "FOFA_EMAIL=ops@example.com\n");
  const auth = new WebAuthService(join(runtime, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-123" });
  auth.close();
  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"), "--runtime-dir", runtime, "--auth-db", join(runtime, "auth.sqlite"), "--port", String(port)
  ], { cwd: project, stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "env-csrf";
  const adminCookie = `luanniao_session=${encodeURIComponent(admin.token)}; luanniao_csrf=${csrf}`;
  const analystCookie = `luanniao_session=${encodeURIComponent(analyst.token)}; luanniao_csrf=${csrf}`;
  const mutate = (cookie: string, body: unknown): Promise<Response> => fetch(`${baseUrl}/api/env`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    body: JSON.stringify(body)
  });
  try {
    await waitForServer(child, baseUrl);

    const beforeMcp = await (await fetch(`${baseUrl}/api/mcp`, { headers: { cookie: adminCookie } })).json() as {
      servers: Array<{ name: string; configured: boolean }>;
    };
    assert.equal(beforeMcp.servers.find((server) => server.name === "fofa")!.configured, false);

    const initial = await fetch(`${baseUrl}/api/env`, { headers: { cookie: adminCookie } });
    assert.equal(initial.status, 200);
    const initialView = await initial.json() as { entries: Array<Record<string, unknown>>; path: string };
    assert.equal(initialView.path, join(project, ".env"));
    assert.deepEqual(initialView.entries, [{ key: "FOFA_EMAIL", sensitive: false, value: "ops@example.com" }]);

    const analystRead = await fetch(`${baseUrl}/api/env`, { headers: { cookie: analystCookie } });
    assert.equal(analystRead.status, 403);
    assert.equal(((await analystRead.json()) as { error: { code: string } }).error.code, "authorization_forbidden");

    const update = await mutate(adminCookie, { set: { FOFA_API_KEY: "testkey-abcdefgh" } });
    assert.equal(update.status, 200);
    const updated = await update.json() as { entries: Array<{ key: string; sensitive: boolean; preview?: string; value?: string }> };
    const keyEntry = updated.entries.find((entry) => entry.key === "FOFA_API_KEY")!;
    assert.equal(keyEntry.sensitive, true);
    assert.equal(keyEntry.preview, "••••efgh");
    assert.equal(keyEntry.value, undefined);
    assert.equal(await readFile(join(project, ".env"), "utf8"), "FOFA_EMAIL=ops@example.com\nFOFA_API_KEY=testkey-abcdefgh\n");

    // The running server refreshed process.env, so the registry scan flips fofa to configured.
    const afterMcp = await (await fetch(`${baseUrl}/api/mcp`, { headers: { cookie: adminCookie } })).json() as {
      servers: Array<{ name: string; configured: boolean }>;
      diagnostics: Array<{ serverName?: string }>;
    };
    assert.equal(afterMcp.servers.find((server) => server.name === "fofa")!.configured, true);
    assert.equal(afterMcp.diagnostics.some((diagnostic) => diagnostic.serverName === "fofa"), false);

    const analystWrite = await mutate(analystCookie, { remove: ["FOFA_EMAIL"] });
    assert.equal(analystWrite.status, 403);

    const removal = await mutate(adminCookie, { remove: ["FOFA_EMAIL"] });
    assert.equal(removal.status, 200);
    assert.equal(await readFile(join(project, ".env"), "utf8"), "FOFA_API_KEY=testkey-abcdefgh\n");

    const protectedKey = await mutate(adminCookie, { set: { PATH: "/tmp/evil" } });
    assert.equal(protectedKey.status, 400);
    assert.equal(((await protectedKey.json()) as { error: { code: string } }).error.code, "invalid_request");

    const unknownField = await mutate(adminCookie, { set: {}, extra: true });
    assert.equal(unknownField.status, 400);
  } finally {
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
    await rm(root, { recursive: true, force: true });
  }
});

async function reservePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForServer(child: ChildProcess, baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error("web server exited");
    try { if ((await fetch(`${baseUrl}/api/auth/csrf`)).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("web server did not become ready");
}
