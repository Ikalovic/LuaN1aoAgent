import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebAuthService } from "../src/web-auth.js";

/**
 * The capability surface — which Specialists, Skills and MCP servers exist, and
 * what their pinned parameters are — is an administrative decision. An analyst
 * keeps the operational mutations it needs to run an engagement, but must not be
 * able to rewrite the capability surface through the API, which is where the
 * previous `operator:mutate` gate let it through even though the UI hid it.
 */
test("only an admin may rewrite the capability surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-capability-authz-"));
  const project = join(root, "project");
  const runtime = join(project, ".agent-runtime");
  await mkdir(join(project, ".agents", "skills", "recon-subdomain"), { recursive: true });
  await writeFile(join(project, ".agents", "skills", "recon-subdomain", "SKILL.md"),
    "---\nname: recon-subdomain\ndescription: Enumerate authorized subdomains\n---\n");
  const auth = new WebAuthService(join(runtime, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-456" });
  auth.close();
  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"), "--runtime-dir", runtime, "--auth-db", join(runtime, "auth.sqlite"), "--port", String(port)
  ], { cwd: project, stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "capability-csrf";
  const asAdmin = `luanniao_session=${encodeURIComponent(admin.token)}; luanniao_csrf=${csrf}`;
  const asAnalyst = `luanniao_session=${encodeURIComponent(analyst.token)}; luanniao_csrf=${csrf}`;
  const mutation = (cookie: string, path: string, method: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    body: JSON.stringify(body)
  });
  try {
    await waitForServer(child, baseUrl);

    // Reading the capability surface stays available to every authenticated user.
    for (const path of ["/api/agents", "/api/skills", "/api/mcp"]) {
      const read = await fetch(`${baseUrl}${path}`, { headers: { cookie: asAnalyst } });
      assert.equal(read.status, 200, `${path} must stay readable for an analyst`);
    }

    const capabilityWrites: Array<[string, string, unknown]> = [
      ["/api/agents/bruteforce/state", "POST", { enabled: false }],
      ["/api/agents/bruteforce/options", "PUT", { threads: 2 }],
      ["/api/agents/bruteforce/options-mode", "POST", { mode: "user" }],
      ["/api/skills/recon-subdomain/state", "POST", { enabled: false }],
      ["/api/mcp/credential/state", "POST", { enabled: false }]
    ];
    for (const [path, method, body] of capabilityWrites) {
      const denied = await mutation(asAnalyst, path, method, body);
      assert.equal(denied.status, 403, `${method} ${path} must reject an analyst`);
      assert.equal((await denied.json() as { error: { code: string } }).error.code, "authorization_forbidden");
    }

    // The same routes still work for an admin, so the gate is the role and not
    // the route itself being broken.
    const allowed = await mutation(asAdmin, "/api/agents/bruteforce/options-mode", "POST", { mode: "user" });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { optionsMode: string }).optionsMode, "user");
    const restored = await mutation(asAdmin, "/api/agents/bruteforce/options-mode", "POST", { mode: null });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json() as { optionsMode: string }).optionsMode, "planner");
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("web server exited");
    try { if ((await fetch(`${baseUrl}/api/auth/csrf`)).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("web server did not become ready");
}
