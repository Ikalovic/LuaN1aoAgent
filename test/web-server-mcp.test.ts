import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebAuthService } from "../src/web-auth.js";

test("Web API lists MCP servers and persists operator toggles", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-mcp-"));
  const project = join(root, "project");
  const runtime = join(project, ".agent-runtime");
  await mkdir(runtime, { recursive: true });
  const auth = new WebAuthService(join(runtime, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  auth.close();
  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"), "--runtime-dir", runtime, "--auth-db", join(runtime, "auth.sqlite"), "--port", String(port)
  ], { cwd: project, stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "mcp-csrf";
  const cookie = `luanniao_session=${encodeURIComponent(admin.token)}; luanniao_csrf=${csrf}`;
  try {
    await waitForServer(child, baseUrl);

    const listed = await fetch(`${baseUrl}/api/mcp`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const snapshot = await listed.json() as {
      servers: Array<{ name: string; configured: boolean; enabled: boolean; tools: string[] }>;
      diagnostics: Array<{ code: string; serverName?: string }>;
    };
    assert.deepEqual(snapshot.servers.map((server) => server.name), ["credential", "fofa", "beekeeper"]);
    assert.equal(snapshot.servers[0].configured, true);
    assert.equal(snapshot.servers[1].configured, false);
    assert.equal(snapshot.servers[1].enabled, true);
    assert.ok(snapshot.servers[0].tools.includes("credential_query"));
    assert.deepEqual(
      snapshot.diagnostics.filter((diagnostic) => diagnostic.code === "mcp_not_configured").map((diagnostic) => diagnostic.serverName).sort(),
      ["beekeeper", "fofa"]
    );

    const toggled = await fetch(`${baseUrl}/api/mcp/credential/state`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(toggled.status, 200);
    assert.equal((await toggled.json() as { enabled: boolean }).enabled, false);
    const persisted = JSON.parse(await readFile(join(project, ".agents", "mcp-state.json"), "utf8"));
    assert.deepEqual(persisted, { credential: false });

    const unknown = await fetch(`${baseUrl}/api/mcp/no-such-server/state`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json() as { error: { code: string } }).error.code, "mcp_not_found");

    const invalid = await fetch(`${baseUrl}/api/mcp/credential/state`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ enabled: "yes" })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: { code: string } }).error.code, "invalid_request");
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
