import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/stores/artifact-store.js";
import { WebAuthService } from "../src/web-auth.js";

type Fixture = {
  baseUrl: string;
  root: string;
  runtimeA: string;
  runtimeEmpty: string;
  adminCookie: string;
  analystCookie: string;
  csrfToken: string;
  csrfCookie: string;
  process: ChildProcess;
  seededRef: string;
  seededValue: string;
};

let fixture: Fixture;

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function runtimeQuery(runtimeDir: string): string {
  return `?runtimeDir=${encodeURIComponent(runtimeDir)}`;
}

function authedFetch(cookie: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${fixture.baseUrl}${pathname}`, {
    ...init,
    headers: { cookie: `${cookie}; ${fixture.csrfCookie}`, ...(init.headers as Record<string, string> | undefined ?? {}) }
  });
}

function adminFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  return authedFetch(fixture.adminCookie, pathname, init);
}

function adminMutation(pathname: string, method: string, body?: unknown): Promise<Response> {
  return adminFetch(pathname, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": fixture.csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test.before(async () => {
  fixture = await createFixture();
});

test.after(async () => {
  if (fixture) await destroyFixture(fixture);
});

test("credential APIs require authentication and the admin credential capability", async () => {
  const anonymous = await fetch(`${fixture.baseUrl}/api/credentials${runtimeQuery(fixture.runtimeA)}`);
  assert.equal(anonymous.status, 401);

  const analystGet = await authedFetch(fixture.analystCookie, `/api/credentials${runtimeQuery(fixture.runtimeA)}`);
  assert.equal(analystGet.status, 403);
  assert.equal((await json(analystGet)).error.code, "authorization_forbidden");

  const analystPost = await authedFetch(fixture.analystCookie, `/api/credentials${runtimeQuery(fixture.runtimeA)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": fixture.csrfToken },
    body: JSON.stringify({ kind: "token", value: "x", scopeRef: "run:x" })
  });
  assert.equal(analystPost.status, 403);

  const analystDelete = await authedFetch(fixture.analystCookie, `/api/credentials/${encodeURIComponent(fixture.seededRef)}${runtimeQuery(fixture.runtimeA)}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": fixture.csrfToken }
  });
  assert.equal(analystDelete.status, 403);
});

test("GET /api/credentials lists seeded records with scopes and flat empty runtimes", async () => {
  const response = await adminFetch(`/api/credentials${runtimeQuery(fixture.runtimeA)}`);
  assert.equal(response.status, 200);
  const view = await json(response);
  assert.equal(view.available, true);
  assert.equal(view.records.length, 1);
  assert.deepEqual(view.scopes, ["run:seed-1"]);
  const record = view.records[0];
  assert.equal(record.artifactRef, fixture.seededRef);
  assert.equal(record.kind, "cookie");
  assert.equal(record.hostRef, "portal.example");
  assert.equal(record.label, "portal session");
  assert.equal(record.username, "admin");
  assert.equal(record.role, "web_admin");
  assert.equal(record.source, "manual");
  assert.equal(record.valid, true);

  const empty = await adminFetch(`/api/credentials${runtimeQuery(fixture.runtimeEmpty)}`);
  assert.equal(empty.status, 200);
  const emptyView = await json(empty);
  assert.equal(emptyView.available, false);
  assert.deepEqual(emptyView.records, []);

  const outside = await adminFetch(`/api/credentials${runtimeQuery(join(fixture.root, "..", "lnwc-outside"))}`);
  assert.equal(outside.status, 403);
  assert.equal((await json(outside)).error.code, "runtime_path_outside_root");

  const missing = await adminFetch(`/api/credentials${runtimeQuery(join(fixture.root, "runtime-missing"))}`);
  assert.equal(missing.status, 404);
});

test("POST /api/credentials stores a manual credential and reveal records an audit entry", async () => {
  const created = await adminMutation(`/api/credentials${runtimeQuery(fixture.runtimeA)}`, "POST", {
    kind: "token",
    value: "fresh-token-123",
    scopeRef: "run:web",
    hostRef: "10.0.0.5",
    label: "web api token",
    username: "svc",
    role: "api"
  });
  assert.equal(created.status, 200);
  const createdBody = await json(created);
  assert.equal(createdBody.ok, true);
  const artifactRef = String(createdBody.record.artifactRef);
  assert.match(artifactRef, /^artifact:[\w-]+$/);
  assert.equal(createdBody.record.source, "manual");

  const list = await json(await adminFetch(`/api/credentials${runtimeQuery(fixture.runtimeA)}`));
  assert.equal(list.records.length, 2);
  assert.deepEqual(list.scopes, ["run:seed-1", "run:web"]);

  const reveal = await adminMutation(`/api/credentials/${encodeURIComponent(artifactRef)}/reveal${runtimeQuery(fixture.runtimeA)}`, "POST");
  assert.equal(reveal.status, 200);
  assert.equal((await json(reveal)).value, "fresh-token-123");

  const store = new ArtifactStore(join(fixture.runtimeA, "artifacts"), join(fixture.runtimeA, "state.sqlite"));
  try {
    const logs = await store.listCredentialAccessLog(artifactRef);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].action, "store");
    assert.equal(logs[1].action, "read");
    assert.equal(logs[1].actor, "web:admin");
    assert.ok(store.getCredentialIndex(artifactRef)?.lastUsedAt);
  } finally {
    store.close();
  }
});

test("POST /api/credentials rejects invalid payloads and CSRF-less mutations", async () => {
  const noCsrf = await adminFetch(`/api/credentials${runtimeQuery(fixture.runtimeA)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "token", value: "x", scopeRef: "run:x" })
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await json(noCsrf)).error.code, "csrf_token_missing");

  for (const body of [
    { kind: "not-a-kind", value: "x", scopeRef: "run:x" },
    { kind: "token", value: "", scopeRef: "run:x" },
    { kind: "token", value: "x", scopeRef: "" },
    { kind: "token", value: "x", scopeRef: "run:x", hostRef: 42 },
    { kind: "token", value: "x", scopeRef: "run:x", unexpected: "field" }
  ]) {
    const response = await adminMutation(`/api/credentials${runtimeQuery(fixture.runtimeA)}`, "POST", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await json(response)).error.code, "invalid_request");
  }

  const emptyRuntime = await adminMutation(`/api/credentials${runtimeQuery(fixture.runtimeEmpty)}`, "POST", {
    kind: "token",
    value: "x",
    scopeRef: "run:x"
  });
  assert.equal(emptyRuntime.status, 404);
  assert.equal((await json(emptyRuntime)).error.code, "credential_store_unavailable");

  const missingRef = await adminMutation(`/api/credentials/artifact:00000000-0000-4000-8000-000000000000/invalidate${runtimeQuery(fixture.runtimeA)}`, "POST");
  assert.equal(missingRef.status, 404);
  assert.equal((await json(missingRef)).error.code, "credential_not_found");

  const badRef = await adminMutation(`/api/credentials/not-a-ref/invalidate${runtimeQuery(fixture.runtimeA)}`, "POST");
  assert.equal(badRef.status, 400);
});

test("invalidate marks a credential invalid and DELETE removes index, file and audit", async () => {
  const created = await adminMutation(`/api/credentials${runtimeQuery(fixture.runtimeA)}`, "POST", {
    kind: "password",
    value: "disposable-password",
    scopeRef: "run:cleanup",
    label: "cleanup target"
  });
  const artifactRef = String((await json(created)).record.artifactRef);

  const invalidated = await adminMutation(`/api/credentials/${encodeURIComponent(artifactRef)}/invalidate${runtimeQuery(fixture.runtimeA)}`, "POST");
  assert.equal(invalidated.status, 200);
  const afterInvalidate = await json(await adminFetch(`/api/credentials${runtimeQuery(fixture.runtimeA)}`));
  const invalidRecord = afterInvalidate.records.find((item: Record<string, any>) => item.artifactRef === artifactRef);
  assert.equal(invalidRecord.valid, false);

  const store = new ArtifactStore(join(fixture.runtimeA, "artifacts"), join(fixture.runtimeA, "state.sqlite"));
  let credentialPath: string | undefined;
  try {
    credentialPath = (await store.get(artifactRef))?.path;
  } finally {
    store.close();
  }
  assert.ok(credentialPath);
  assert.equal(existsSync(credentialPath!), true);

  const deleted = await adminMutation(`/api/credentials/${encodeURIComponent(artifactRef)}${runtimeQuery(fixture.runtimeA)}`, "DELETE");
  assert.equal(deleted.status, 200);
  assert.equal((await json(deleted)).ok, true);
  assert.equal(existsSync(credentialPath!), false);

  const afterDelete = await json(await adminFetch(`/api/credentials${runtimeQuery(fixture.runtimeA)}`));
  assert.equal(afterDelete.records.some((item: Record<string, any>) => item.artifactRef === artifactRef), false);

  const storeAfter = new ArtifactStore(join(fixture.runtimeA, "artifacts"), join(fixture.runtimeA, "state.sqlite"));
  try {
    const logs = await storeAfter.listCredentialAccessLog(artifactRef);
    assert.equal(logs.at(-1)?.action, "delete");
    assert.equal(logs.at(-1)?.actor, "web:admin");
    assert.equal(storeAfter.getCredentialIndex(artifactRef), undefined);
  } finally {
    storeAfter.close();
  }

  const secondDelete = await adminMutation(`/api/credentials/${encodeURIComponent(artifactRef)}${runtimeQuery(fixture.runtimeA)}`, "DELETE");
  assert.equal(secondDelete.status, 404);
  assert.equal((await json(secondDelete)).error.code, "credential_not_found");
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp("/tmp/lnwc-");
  const runtimeA = join(root, "runtime-a");
  const runtimeEmpty = join(root, "runtime-empty");
  await mkdir(runtimeA, { recursive: true });
  await mkdir(runtimeEmpty, { recursive: true });

  const seededValue = "seeded-session-cookie";
  const store = new ArtifactStore(join(runtimeA, "artifacts"), join(runtimeA, "state.sqlite"));
  const seeded = await store.writeCredential({
    data: seededValue,
    scopeRef: "run:seed-1",
    kind: "cookie",
    hostRef: "portal.example",
    label: "portal session",
    username: "admin",
    role: "web_admin",
    source: "manual"
  });
  store.close();

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
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(child, baseUrl);

  const csrf = await fetch(`${baseUrl}/api/auth/csrf`);
  const { csrfToken } = await csrf.json() as { csrfToken: string };
  const csrfCookie = (csrf.headers.get("set-cookie") ?? "")
    .split(/,\s*/)
    .map((part) => part.split(";")[0])
    .find((part) => part.startsWith("luanniao_csrf=")) ?? "";

  return {
    baseUrl,
    root,
    runtimeA,
    runtimeEmpty,
    adminCookie: `luanniao_session=${encodeURIComponent(admin.token)}`,
    analystCookie: `luanniao_session=${encodeURIComponent(analyst.token)}`,
    csrfToken,
    csrfCookie,
    process: child,
    seededRef: seeded.artifactRef,
    seededValue
  };
}

async function destroyFixture(value: Fixture): Promise<void> {
  if (value.process && value.process.exitCode === null && value.process.signalCode === null) {
    value.process.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      value.process.once("exit", () => resolveExit());
      setTimeout(resolveExit, 3_000).unref();
    });
  }
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
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
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
