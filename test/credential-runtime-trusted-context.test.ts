import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CredentialMcpRuntime,
  EXPECTED_CREDENTIAL_TOOLS,
  type CredentialMcpClientConnection
} from "../src/mcp/credential-runtime.js";
import { ExecutionLog } from "../src/stores/execution-log.js";

/**
 * The credential MCP server declares a strict schema whose `_runtime` field is
 * runtime-owned. Forwarding caller arguments verbatim made every credential
 * call fail validation with `_runtime: expected object, received undefined`,
 * which silently broke the hit-credential handoff of every Agent that stores
 * what it found — the brute-force Specialist most visibly, because storing the
 * hit is part of its contract.
 */
test("credential calls carry the runtime-owned trusted context", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "credential-runtime-"));
  const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"));
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const runtime = new CredentialMcpRuntime({
    artifactStoreRoot: join(runtimeDir, "artifacts"),
    executionLog,
    trustedContext: (taskRef) => ({
      runRef: "run:test",
      scope: { cidrs: ["10.0.0.0/8"], domains: ["example.test"] },
      scopeFingerprint: "a".repeat(64),
      derivedRefs: []
    }),
    clientFactory: async (): Promise<CredentialMcpClientConnection> => ({
      listTools: async () => ({
        tools: EXPECTED_CREDENTIAL_TOOLS.map((name) => ({ name }))
      }),
      callTool: async (input) => {
        calls.push(input);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
      close: async () => undefined
    })
  });

  await runtime.call("task:one", "credential_store", {
    kind: "ssh_password",
    value: "letmein",
    scopeRef: "scope:root",
    username: "svcuser"
  });

  assert.equal(calls.length, 1);
  const context = calls[0]!.arguments._runtime as Record<string, unknown>;
  assert.ok(context, "_runtime must be injected by the runtime");
  assert.equal(context.runRef, "run:test");
  assert.equal(context.taskRef, "task:one");
  assert.deepEqual(context.scope, { cidrs: ["10.0.0.0/8"], domains: ["example.test"] });
  assert.match(String(context.scopeFingerprint), /^[a-f0-9]{64}$/);
  assert.deepEqual(context.derivedRefs, []);
  // The caller's own fields survive untouched.
  assert.equal(calls[0]!.arguments.username, "svcuser");
  assert.equal(calls[0]!.arguments.kind, "ssh_password");

  // A caller cannot forge the context: the runtime value wins.
  calls.length = 0;
  await runtime.call("task:two", "credential_query", {
    scopeRef: "scope:root",
    _runtime: { runRef: "run:attacker", taskRef: "task:attacker" }
  });
  const forged = calls[0]!.arguments._runtime as Record<string, unknown>;
  assert.equal(forged.runRef, "run:test");
  assert.equal(forged.taskRef, "task:two");

  // Failures are reported as provider errors instead of escaping raw.
  await runtime.close("test");
});
