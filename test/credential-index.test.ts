import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/stores/artifact-store.js";

function createStore(): ArtifactStore {
  const runtimeDir = mkdtempSync(join(tmpdir(), "luanniao-cred-"));
  return new ArtifactStore(join(runtimeDir, "artifacts"));
}

test("writeCredential with extended parameters populates credential_index", async () => {
  const store = createStore();
  const record = await store.writeCredential({
    data: "session-cookie-value",
    scopeRef: "scope:target-1",
    kind: "cookie",
    hostRef: "192.168.1.1",
    label: "admin session",
    username: "admin",
    role: "web_admin",
    source: "auto_output"
  });

  const results = await store.listCredentials("scope:target-1");
  assert.equal(results.length, 1);
  const entry = results[0];
  assert.equal(entry.artifactRef, record.artifactRef);
  assert.equal(entry.scopeRef, "scope:target-1");
  assert.equal(entry.kind, "cookie");
  assert.equal(entry.hostRef, "192.168.1.1");
  assert.equal(entry.label, "admin session");
  assert.equal(entry.username, "admin");
  assert.equal(entry.role, "web_admin");
  assert.equal(entry.source, "auto_output");
  assert.equal(entry.valid, true);
  store.close();
});

test("writeCredential without scopeRef does not insert into credential_index", async () => {
  const store = createStore();
  await store.writeCredential({ data: "bare-secret-value" });

  // listCredentials requires a scopeRef; an unknown scope should return empty
  const results = await store.listCredentials("scope:any");
  assert.equal(results.length, 0);
  store.close();
});

test("listCredentials filters by scopeRef", async () => {
  const store = createStore();
  await store.writeCredential({ data: "cred-a", scopeRef: "scope:A", kind: "token" });
  await store.writeCredential({ data: "cred-b", scopeRef: "scope:B", kind: "token" });
  await store.writeCredential({ data: "cred-a2", scopeRef: "scope:A", kind: "api_key" });

  const scopeA = await store.listCredentials("scope:A");
  assert.equal(scopeA.length, 2);
  const scopeB = await store.listCredentials("scope:B");
  assert.equal(scopeB.length, 1);
  store.close();
});

test("listCredentials filters by hostRef", async () => {
  const store = createStore();
  await store.writeCredential({ data: "host1-cred", scopeRef: "scope:1", kind: "token", hostRef: "10.0.0.1" });
  await store.writeCredential({ data: "host2-cred", scopeRef: "scope:1", kind: "token", hostRef: "10.0.0.2" });

  const filtered = await store.listCredentials("scope:1", { hostRef: "10.0.0.1" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].hostRef, "10.0.0.1");
  store.close();
});

test("listCredentials filters by kind", async () => {
  const store = createStore();
  await store.writeCredential({ data: "tok-value", scopeRef: "scope:k", kind: "token" });
  await store.writeCredential({ data: "key-value", scopeRef: "scope:k", kind: "api_key" });

  const tokens = await store.listCredentials("scope:k", { kind: "token" });
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].kind, "token");
  store.close();
});

test("listCredentials filters by role", async () => {
  const store = createStore();
  await store.writeCredential({ data: "admin-cred", scopeRef: "scope:r", kind: "password", role: "admin" });
  await store.writeCredential({ data: "user-cred", scopeRef: "scope:r", kind: "password", role: "user" });

  const adminCreds = await store.listCredentials("scope:r", { role: "admin" });
  assert.equal(adminCreds.length, 1);
  assert.equal(adminCreds[0].role, "admin");
  store.close();
});

test("listCredentials validOnly returns only valid credentials", async () => {
  const store = createStore();
  const valid = await store.writeCredential({ data: "valid-cred", scopeRef: "scope:v", kind: "token" });
  const invalidated = await store.writeCredential({ data: "invalid-cred", scopeRef: "scope:v", kind: "token" });
  await store.invalidateCredential(invalidated.artifactRef);

  const validOnly = await store.listCredentials("scope:v", { validOnly: true });
  assert.equal(validOnly.length, 1);
  assert.equal(validOnly[0].artifactRef, valid.artifactRef);

  const all = await store.listCredentials("scope:v");
  assert.equal(all.length, 2);
  store.close();
});

test("readCredential returns the stored credential value", async () => {
  const store = createStore();
  const secret = "my-secret-token-xyz";
  const record = await store.writeCredential({ data: secret, scopeRef: "scope:read" });

  const value = await store.readCredential(record.artifactRef);
  assert.equal(value, secret);
  store.close();
});

test("invalidateCredential marks credential as invalid", async () => {
  const store = createStore();
  const record = await store.writeCredential({ data: "to-invalidate", scopeRef: "scope:inv", kind: "token" });

  await store.invalidateCredential(record.artifactRef);

  const validOnly = await store.listCredentials("scope:inv", { validOnly: true });
  assert.equal(validOnly.length, 0);

  const all = await store.listCredentials("scope:inv");
  assert.equal(all.length, 1);
  assert.equal(all[0].valid, false);
  store.close();
});

test("touchCredential updates lastUsedAt", async () => {
  const store = createStore();
  const record = await store.writeCredential({ data: "touch-cred", scopeRef: "scope:touch" });

  // Initially lastUsedAt should be undefined
  const before = await store.listCredentials("scope:touch");
  assert.equal(before[0].lastUsedAt, undefined);

  await store.touchCredential(record.artifactRef);

  const after = await store.listCredentials("scope:touch");
  assert.ok(after[0].lastUsedAt);
  assert.match(after[0].lastUsedAt!, /^\d{4}-\d{2}-\d{2}T/);
  store.close();
});

test("logCredentialAccess and listCredentialAccessLog round-trip", async () => {
  const store = createStore();
  const record = await store.writeCredential({ data: "audit-cred", scopeRef: "scope:audit" });

  await store.logCredentialAccess({
    credentialRef: record.artifactRef,
    taskId: "task:test",
    action: "read",
    actor: "executor:1",
    details: "used in HTTP request"
  });

  const logs = await store.listCredentialAccessLog(record.artifactRef);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].credentialRef, record.artifactRef);
  assert.equal(logs[0].taskId, "task:test");
  assert.equal(logs[0].action, "read");
  assert.equal(logs[0].actor, "executor:1");
  assert.equal(logs[0].details, "used in HTTP request");
  store.close();
});

test("listCredentialAccessLog filters by credentialRef", async () => {
  const store = createStore();
  const cred1 = await store.writeCredential({ data: "cred-1-value", scopeRef: "scope:log" });
  const cred2 = await store.writeCredential({ data: "cred-2-value", scopeRef: "scope:log" });

  await store.logCredentialAccess({ credentialRef: cred1.artifactRef, action: "read", actor: "agent" });
  await store.logCredentialAccess({ credentialRef: cred2.artifactRef, action: "use", actor: "agent" });
  await store.logCredentialAccess({ credentialRef: cred1.artifactRef, action: "inject", actor: "agent" });

  const cred1Logs = await store.listCredentialAccessLog(cred1.artifactRef);
  assert.equal(cred1Logs.length, 2);
  assert.equal(cred1Logs[0].action, "read");
  assert.equal(cred1Logs[1].action, "inject");

  const cred2Logs = await store.listCredentialAccessLog(cred2.artifactRef);
  assert.equal(cred2Logs.length, 1);
  assert.equal(cred2Logs[0].action, "use");

  const allLogs = await store.listCredentialAccessLog();
  assert.equal(allLogs.length, 3);
  store.close();
});
