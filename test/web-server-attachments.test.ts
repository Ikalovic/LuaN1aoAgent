import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/stores/artifact-store.js";
import { ExecutionLog } from "../src/stores/execution-log.js";
import { WebAuthService } from "../src/web-auth.js";

/**
 * Attachment uploads are an operator-mutate capability that ends in bytes the
 * Executor will run inside its sandbox, so the checks here are mostly about the
 * boundary: who may upload, what shape a file may have, and that the bytes land
 * in the run's ArtifactStore exactly once, under the run's own identity.
 */

type Harness = {
  baseUrl: string;
  root: string;
  adminCookie: string;
  analystCookie: string;
  csrf: string;
  child: ChildProcess;
  cleanup: () => Promise<void>;
};

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

/**
 * The run itself must not be allowed to finish during the test: its first
 * Planner call is held open so the assertions run against a live, started run.
 */
async function startHangingLlmServer(): Promise<{ port: number; server: Server; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.on("data", () => undefined);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { port: address.port, server, sockets };
}

async function waitForServer(child: ChildProcess, baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`web server exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 401 || response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("timed out waiting for the web server");
}

async function createHarness(t: { after: (fn: () => Promise<void>) => void }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "lnw-attachments-"));
  const auth = new WebAuthService(join(root, "auth.sqlite"));
  const admin = await auth.register({ username: "admin", displayName: "Admin", password: "admin-password-123" });
  const analyst = await auth.register({ username: "analyst", displayName: "Analyst", password: "analyst-password-456" });
  auth.close();

  const hangingLlm = await startHangingLlmServer();
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
  const cleanup = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        setTimeout(resolveExit, 3_000).unref();
      });
    }
    for (const socket of hangingLlm.sockets) socket.destroy();
    await new Promise<void>((resolveClose) => hangingLlm.server.close(() => resolveClose()));
  };
  t.after(async () => {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const csrf = "attachments-csrf";
  await waitForServer(child, baseUrl);
  return {
    baseUrl,
    root,
    adminCookie: `luanniao_session=${encodeURIComponent(admin.token)}`,
    analystCookie: `luanniao_session=${encodeURIComponent(analyst.token)}`,
    csrf,
    child,
    cleanup
  };
}

function upload(harness: Harness, cookie: string, fileName: string, content: Buffer | string): Promise<Response> {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return fetch(`${harness.baseUrl}/api/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${cookie}; luanniao_csrf=${harness.csrf}`,
      "x-csrf-token": harness.csrf
    },
    body: JSON.stringify({ fileName, contentBase64: data.toString("base64") })
  });
}

function startRun(harness: Harness, cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${cookie}; luanniao_csrf=${harness.csrf}`,
      "x-csrf-token": harness.csrf
    },
    body: JSON.stringify(body)
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function stage(harness: Harness, fileName: string, content: string): Promise<string> {
  const response = await upload(harness, harness.adminCookie, fileName, content);
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await json(response)).attachment.attachmentId as string;
}

test("attachments require an operator-mutate capability and a valid body", async (t) => {
  const harness = await createHarness(t);

  // The CSRF check precedes authentication for mutations, matching every other route.
  const noCsrf = await fetch(`${harness.baseUrl}/api/attachments`, { method: "POST" });
  assert.equal(noCsrf.status, 403);
  assert.equal((await json(noCsrf)).error.code, "csrf_token_missing");

  const unauthenticated = await fetch(`${harness.baseUrl}/api/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `luanniao_csrf=${harness.csrf}`,
      "x-csrf-token": harness.csrf
    },
    body: JSON.stringify({ fileName: "a.txt", contentBase64: "eA==" })
  });
  assert.equal(unauthenticated.status, 401);

  // `analyst` holds operator:mutate by design: starting a run is already theirs,
  // and uploading is a prerequisite of starting one with material. Uploading
  // must therefore not require a capability that starting a run does not.
  const analyst = await upload(harness, harness.analystCookie, "a.txt", "x");
  assert.equal(analyst.status, 201);
  const analystStarted = await startRun(harness, harness.analystCookie, {
    goal: "分析员启动的任务",
    scope: "",
    taskType: "ctf",
    attachmentIds: [(await json(analyst)).attachment.attachmentId]
  });
  assert.equal(analystStarted.status, 201, "the same role that may start a run may attach to it");

  const badBase64 = await fetch(`${harness.baseUrl}/api/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${harness.adminCookie}; luanniao_csrf=${harness.csrf}`,
      "x-csrf-token": harness.csrf
    },
    body: JSON.stringify({ fileName: "a.txt", contentBase64: "not base64!!" })
  });
  assert.equal(badBase64.status, 400);
  assert.equal((await json(badBase64)).error.code, "invalid_attachment_base64");

  const empty = await upload(harness, harness.adminCookie, "a.txt", "");
  assert.equal(empty.status, 400);
  assert.equal((await json(empty)).error.code, "invalid_attachment_empty");

  const pathName = await upload(harness, harness.adminCookie, "../escape.txt", "x");
  assert.equal(pathName.status, 400);
  assert.equal((await json(pathName)).error.code, "invalid_attachment_name");

  const unknownKey = await fetch(`${harness.baseUrl}/api/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${harness.adminCookie}; luanniao_csrf=${harness.csrf}`,
      "x-csrf-token": harness.csrf
    },
    body: JSON.stringify({ fileName: "a.txt", contentBase64: "eA==", mediaType: "image/png" })
  });
  assert.equal(unknownKey.status, 400, "the client must not be able to declare a media type");
});

test("a staged attachment can be discarded before the run starts", async (t) => {
  const harness = await createHarness(t);
  const attachmentId = await stage(harness, "scratch.txt", "scratch");

  const discarded = await fetch(`${harness.baseUrl}/api/attachments/${attachmentId}`, {
    method: "DELETE",
    headers: { cookie: `${harness.adminCookie}; luanniao_csrf=${harness.csrf}`, "x-csrf-token": harness.csrf }
  });
  assert.equal(discarded.status, 200);
  assert.equal((await json(discarded)).discarded, true);

  // Discarding twice is not an error: another tab may have removed it first.
  const again = await fetch(`${harness.baseUrl}/api/attachments/${attachmentId}`, {
    method: "DELETE",
    headers: { cookie: `${harness.adminCookie}; luanniao_csrf=${harness.csrf}`, "x-csrf-token": harness.csrf }
  });
  assert.equal(again.status, 200);
  assert.equal((await json(again)).discarded, false);

  // Starting with the discarded id must fail loudly rather than silently drop it.
  const started = await startRun(harness, harness.adminCookie, {
    goal: "使用已删除附件",
    scope: "",
    taskType: "ctf",
    attachmentIds: [attachmentId]
  });
  assert.equal(started.status, 400);
  assert.equal((await json(started)).error.code, "attachment_not_found");
});

test("a started run persists attachments as artifacts the agents can read", async (t) => {
  const harness = await createHarness(t);
  const payload = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]);
  const upload200 = await upload(harness, harness.adminCookie, "chall.elf", payload);
  const stored = (await json(upload200)).attachment as { attachmentId: string; sha256: string; mediaType: string };
  assert.equal(stored.mediaType, "application/x-elf");
  const second = await stage(harness, "notes.txt", "vendor advisory");

  const started = await startRun(harness, harness.adminCookie, {
    goal: "分析 CTF 题目附件",
    scope: "",
    taskType: "ctf",
    attachmentIds: [stored.attachmentId, second]
  });
  assert.equal(started.status, 201, JSON.stringify(await started.clone().json()));
  const run = await json(started);
  const attachments = run.attachments as Array<{ artifactRef: string; fileName: string; sha256: string; byteLength: number }>;
  assert.equal(attachments.length, 2);
  assert.deepEqual(attachments.map((item) => item.fileName), ["chall.elf", "notes.txt"]);
  assert.equal(attachments[0]!.sha256, stored.sha256);
  assert.equal(attachments[0]!.byteLength, payload.byteLength);

  const reported = run.runtimeDir as string;
  const runtimeDir = isAbsolute(reported) ? reported : resolve(process.cwd(), reported);
  const store = new ArtifactStore(join(runtimeDir, "artifacts"), join(runtimeDir, "state.sqlite"));
  const records = await store.list();
  const persisted = records.find((record) => record.artifactRef === attachments[0]!.artifactRef);
  assert.ok(persisted, "the attachment must exist as an artifact of the run");
  assert.equal(persisted!.kind, "attachment");
  assert.equal(persisted!.mediaType, "application/x-elf");
  // The bytes must be byte-identical: a CTF binary that survives a UTF-8 round
  // trip is not the same binary.
  assert.deepEqual(await readFile(persisted!.path), payload);
  const text = records.find((record) => record.artifactRef === attachments[1]!.artifactRef);
  assert.equal(text!.kind, "attachment");
  assert.equal(await readFile(text!.path, "utf8"), "vendor advisory");
  store.close();

  // The run records what the operator handed over, before any planning happens.
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"), join(runtimeDir, "state.sqlite"));
  const events = await executionLog.readAll();
  const provided = events.find((event) => event.eventType === "attachments_provided");
  assert.ok(provided, "the run must record an attachments_provided event");
  const recorded = (provided!.payload as { attachments: Array<{ fileName: string }> }).attachments;
  assert.deepEqual(recorded.map((item) => item.fileName), ["chall.elf", "notes.txt"]);
  // The accepted HTTP response precedes asynchronous runtime initialization.
  let runStarted = events.find((event) => event.eventType === "run_started");
  for (let attempt = 0; !runStarted && attempt < 100; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    runStarted = (await executionLog.readAll()).find((event) => event.eventType === "run_started");
  }
  assert.ok(runStarted, "the accepted run must finish initialization");
  assert.deepEqual(
    (runStarted!.payload as { attachments: Array<{ fileName: string }> }).attachments.map((item) => item.fileName),
    ["chall.elf", "notes.txt"]
  );
  executionLog.close();

  // Staged copies are released once the run owns the bytes.
  const stagingRoot = join(harness.root, "attachments");
  const leftover = await readFile(join(stagingRoot, stored.attachmentId, "meta.json"), "utf8").catch(() => undefined);
  assert.equal(leftover, undefined, "staging must not outlive a successful start");
});

test("a run refuses more attachment ids than the per-run limit", async (t) => {
  const harness = await createHarness(t);
  const ids = Array.from({ length: 13 }, (_, index) => `1111111${index}-1111-4111-8111-111111111111`);

  const started = await startRun(harness, harness.adminCookie, {
    goal: "附件过多",
    scope: "",
    taskType: "ctf",
    attachmentIds: ids
  });
  assert.equal(started.status, 400);
  assert.equal((await json(started)).error.code, "too_many_attachments");

  const malformed = await startRun(harness, harness.adminCookie, {
    goal: "附件字段类型错误",
    scope: "",
    taskType: "ctf",
    attachmentIds: "not-an-array"
  });
  assert.equal(malformed.status, 400);
  assert.equal((await json(malformed)).error.code, "invalid_request");
});
