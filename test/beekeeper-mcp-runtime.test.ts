import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BeekeeperConfig } from "../src/beekeeper/beekeeper-config.js";
import type { BeekeeperCredentialQueryResult } from "../src/beekeeper/beekeeper-types.js";
import {
  BeekeeperMcpRuntime,
  type BeekeeperMcpClientConnection,
  type BeekeeperMcpClientFactory
} from "../src/mcp/beekeeper-runtime.js";
import { ExecutionLog } from "../src/stores/execution-log.js";

const config: BeekeeperConfig = {
  root: "/repo/vendor/Beekeeper",
  pythonCommand: "/repo/.beekeeper-mcp-venv/bin/python",
  entryPoint: "/repo/scripts/beekeeper-mcp-adapter.py",
  maxPageSize: 50,
  requestTimeoutMs: 50
};

test("Beekeeper Runtime validates tool set and returns plaintext JSON payloads", async () => {
  const fixture = runtimeFixture();
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const runtime = fixture.create(async () => fakeConnection(async (input) => {
    calls.push(input);
    return success({
      total_returned: 1,
      next_cursor: "cursor:next",
      items: [{ id: 1, domain: "example.com", account: "alice", password: "alice-pass", is_valid: true }]
    });
  }));

  const result = await runtime.call("task:a", "query_credentials", {
    domain: "example.com",
    limit: 1
  }) as BeekeeperCredentialQueryResult;
  assert.equal(calls[0].name, "query_credentials");
  assert.deepEqual(calls[0].arguments, { domain: "example.com", limit: 1 });
  assert.equal(result.total_returned, 1);
  assert.equal(result.items[0].password, "alice-pass");
  await fixture.close(runtime);

  const lines = readFileSync(fixture.log.filePath, "utf8").trim().split("\n").filter(Boolean);
  assert.match(lines.join("\n"), /beekeeper_mcp_call/);
  assert.doesNotMatch(lines.join("\n"), /alice-pass/);
});

test("Beekeeper Runtime rejects unexpected tool sets and maps provider errors", async () => {
  const fixture = runtimeFixture();
  const badRuntime = fixture.create(async () => fakeConnection(
    async () => success({}),
    ["query_credentials", "store_credential"]
  ));
  await assert.rejects(() => badRuntime.start(), /unexpected tool set/);

  const errorRuntime = fixture.create(async () => fakeConnection(async () => ({
    content: [{ type: "text", text: "provider rejected" }],
    isError: true
  })));
  await assert.rejects(
    () => errorRuntime.call("task:a", "query_credentials", {}),
    /provider rejected/
  );
  await fixture.closeStores();
});

test("Beekeeper Runtime aborts calls after the configured timeout", async () => {
  const fixture = runtimeFixture();
  const runtime = fixture.create(async () => fakeConnection(async (_input, signal) => {
    await new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      setTimeout(resolve, 1_000);
    });
    return success({});
  }));

  await assert.rejects(
    () => runtime.call("task:a", "query_credentials", {}),
    /timeout|aborted|Beekeeper MCP/i
  );
  await fixture.close(runtime);
});

test("Beekeeper Runtime redacts configured database URLs from diagnostics", async () => {
  const fixture = runtimeFixture({
    ...config,
    databaseUrl: "postgresql://user:secret-password@db.example/beekeeper"
  });
  const runtime = fixture.create(async (input) => {
    input.onStderr("failed to connect postgresql://user:secret-password@db.example/beekeeper");
    return fakeConnection(async () => success({}));
  });

  await runtime.start();
  await fixture.close(runtime);
  const logText = readFileSync(fixture.log.filePath, "utf8");
  assert.doesNotMatch(logText, /secret-password/);
  assert.match(logText, /\[REDACTED\]/);
});

function runtimeFixture(configOverride: BeekeeperConfig = config): {
  log: ExecutionLog;
  create: (factory: BeekeeperMcpClientFactory) => BeekeeperMcpRuntime;
  close: (runtime: BeekeeperMcpRuntime) => Promise<void>;
  closeStores: () => Promise<void>;
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), "beekeeper-runtime-"));
  const log = new ExecutionLog(join(runtimeDir, "execution.jsonl"), join(runtimeDir, "events.sqlite"));
  const closeStores = async () => {
    await log.drain();
    log.close();
  };
  return {
    log,
    create: (clientFactory) => new BeekeeperMcpRuntime({
      config: configOverride,
      executionLog: log,
      clientFactory
    }),
    close: async (runtime) => {
      await runtime.close();
      await closeStores();
    },
    closeStores
  };
}

function fakeConnection(
  call: (
    input: { name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>,
  tools = ["query_credentials", "store_credential", "mark_credential_invalid"],
  onClose: () => void = () => undefined
): BeekeeperMcpClientConnection {
  return {
    listTools: async () => ({ tools: tools.map((name) => ({ name })) }),
    callTool: call,
    close: async () => { onClose(); }
  };
}

function success(payload: Record<string, unknown>): {
  content: Array<{ type: string; text?: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
