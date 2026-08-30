import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { WebAuthService } from "../src/web-auth.js";

test("Web API parses, reads, and requires exact confirmation of scope documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-scope-documents-"));
  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  auth.close();
  const port = await reservePort();
  const child = spawn(process.execPath, [
    resolve("dist/src/web-server.js"),
    "--runtime-dir", root,
    "--auth-db", join(root, "auth.sqlite"),
    "--port", String(port)
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      EXECUTOR_SANDBOX_MODE: "workspace",
      LLM_API_BASE_URL: "http://127.0.0.1:1/v1",
      LLM_API_KEY: "test-key",
      LLM_DEFAULT_MODEL: "test-model"
    }
  });
  let serverStderr = "";
  child.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "scope-document-csrf";
  const cookie = `luanniao_session=${encodeURIComponent(admin.token)}; luanniao_csrf=${csrf}`;
  try {
    await waitForServer(child, baseUrl);
    const unauthenticated = await fetch(`${baseUrl}/api/scope-documents/missing`);
    assert.equal(unauthenticated.status, 401);

    const invalidBase64 = await postDocument(baseUrl, cookie, csrf, {
      fileName: "scope.txt",
      contentBase64: "not base64!",
      useAi: false
    });
    assert.equal(invalidBase64.status, 400);
    assert.equal((await invalidBase64.json() as { error: { code: string } }).error.code, "invalid_document_base64");

    const unsupported = await postDocument(baseUrl, cookie, csrf, {
      fileName: "scope.exe",
      contentBase64: Buffer.from("api.example").toString("base64"),
      useAi: false
    });
    assert.equal(unsupported.status, 415);
    assert.equal((await unsupported.json() as { error: { code: string } }).error.code, "unsupported_document_type");

    const tooLarge = await postDocument(baseUrl, cookie, csrf, {
      fileName: "scope.txt",
      contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61).toString("base64"),
      useAi: false
    });
    const tooLargeBody = await tooLarge.json() as { error: { code: string; message: string } };
    assert.equal(tooLarge.status, 413, `${JSON.stringify(tooLargeBody)}\n${serverStderr}`);
    assert.equal(tooLargeBody.error.code, "document_too_large");

    const uploaded = await fetch(`${baseUrl}/api/scope-documents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf
      },
      body: JSON.stringify({
        fileName: "scope.txt",
        contentBase64: Buffer.from("api.example\n10.0.0.1").toString("base64"),
        useAi: false
      })
    });
    assert.equal(uploaded.status, 201);
    const parsed = await uploaded.json() as { documentId: string; normalizedScope: string };
    assert.equal(parsed.normalizedScope, "10.0.0.1/32,api.example");

    const read = await fetch(`${baseUrl}/api/scope-documents/${parsed.documentId}`, { headers: { cookie } });
    assert.equal(read.status, 200);
    assert.equal((await read.json() as { normalizedScope: string }).normalizedScope, parsed.normalizedScope);

    const emptyPentest = await postRun(baseUrl, cookie, csrf, {
      goal: "执行渗透测试",
      scope: "",
      taskType: "pentest"
    });
    assert.equal(emptyPentest.status, 400);

    const emptyCtf = await postRun(baseUrl, cookie, csrf, {
      goal: "完成 CTF 挑战",
      scope: "",
      taskType: "ctf",
      maxRunTimeMs: 60_000
    });
    assert.equal(emptyCtf.status, 201);
    const ctfRun = await emptyCtf.json() as { runtimeDir: string; scope: string };
    assert.equal(ctfRun.scope, "0.0.0.0/0");

    const stopped = await fetch(`${baseUrl}/api/runs/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf
      },
      body: JSON.stringify({ runtimeDir: ctfRun.runtimeDir })
    });
    assert.equal(stopped.status, 200);

    const mismatch = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf
      },
      body: JSON.stringify({
        goal: "测试已授权资产",
        scope: "",
        scopeDocumentId: parsed.documentId,
        confirmedDocumentScope: "0.0.0.0/0",
        taskType: "pentest"
      })
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json() as { error: { code: string } }).error.code, "scope_confirmation_mismatch");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      child.once("exit", () => resolveExit());
      setTimeout(resolveExit, 3_000).unref();
    });
    await rm(root, { recursive: true, force: true });
  }
});

function postDocument(
  baseUrl: string,
  cookie: string,
  csrf: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${baseUrl}/api/scope-documents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": csrf
    },
    body: JSON.stringify(body)
  });
}

function postRun(
  baseUrl: string,
  cookie: string,
  csrf: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": csrf
    },
    body: JSON.stringify(body)
  });
}

async function reservePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForServer(child: ChildProcess, baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`web server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/csrf`);
      if (response.ok) return;
    } catch {
      // Server has not bound yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("web server did not become ready");
}
