import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebAuthService } from "../src/web-auth.js";

test("Web API lists and toggles optional project skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-skills-"));
  const project = join(root, "project");
  const runtime = join(project, ".agent-runtime");
  await mkdir(join(project, ".agents", "skills", "recon-subdomain"), { recursive: true });
  await writeFile(join(project, ".agents", "skills", "recon-subdomain", "SKILL.md"),
    "---\nname: recon-subdomain\ndescription: Enumerate authorized subdomains\n---\n");
  const auth = new WebAuthService(join(runtime, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  auth.close();
  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"), "--runtime-dir", runtime, "--auth-db", join(runtime, "auth.sqlite"), "--port", String(port)
  ], { cwd: project, stdio: "ignore" });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "skill-csrf";
  const cookie = `luanniao_session=${encodeURIComponent(admin.token)}; luanniao_csrf=${csrf}`;
  try {
    await waitForServer(child, baseUrl);
    const listed = await fetch(`${baseUrl}/api/skills`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { skills: Array<{ name: string }> }).skills.map((skill) => skill.name), ["recon-subdomain"]);

    const toggled = await fetch(`${baseUrl}/api/skills/recon-subdomain/state`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(toggled.status, 200);
    assert.equal((await toggled.json() as { enabled: boolean }).enabled, false);
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
