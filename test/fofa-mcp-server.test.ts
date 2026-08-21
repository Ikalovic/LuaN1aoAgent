import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { FofaScopePolicy } from "../src/fofa/fofa-scope-policy.js";
import { parseAuthorizedScope } from "../src/scope.js";

test("FOFA stdio MCP server exposes five Scope-aware tools without leaking credentials", async () => {
  const requests: URL[] = [];
  const mock = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/search/all") {
      response.end(JSON.stringify({
        error: false,
        size: 2,
        total: 2,
        next: "provider-page-2",
        results: [
          ["198.51.100.2", "a.example.com"],
          ["192.0.2.8", "other.test"]
        ]
      }));
      return;
    }
    response.end(JSON.stringify({ error: false, fofa_point: 10 }));
  });
  await new Promise<void>((resolveListen) => mock.listen(0, "127.0.0.1", resolveListen));
  const address = mock.address();
  assert.ok(address && typeof address === "object");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/mcp/fofa-server.js")],
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      FOFA_API_KEY: "sentinel-secret",
      FOFA_API_BASE_URL: `http://127.0.0.1:${address.port}`
    },
    stderr: "pipe",
    cwd: process.cwd()
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "fofa-test", version: "1.0.0" });
  let childPid: number | null = null;

  try {
    await client.connect(transport);
    childPid = transport.pid;
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "fofa_account_info",
      "fofa_host_aggregate",
      "fofa_search",
      "fofa_search_next",
      "fofa_stats"
    ]);

    const missingContext = await client.callTool({
      name: "fofa_search",
      arguments: { query: 'domain="example.com"', fields: ["ip"], size: 1, full: false }
    });
    assert.equal(missingContext.isError, true);

    const scope = parseAuthorizedScope("example.com,192.0.2.0/24");
    const runtime = {
      runRef: "run:test",
      taskRef: "task:test",
      scope,
      scopeFingerprint: new FofaScopePolicy(scope).fingerprint(),
      derivedRefs: []
    };
    const result = await client.callTool({
      name: "fofa_search",
      arguments: {
        _runtime: runtime,
        query: 'domain="example.com"',
        fields: ["ip", "host"],
        size: 2,
        full: false
      }
    });
    assert.equal(result.isError, undefined);
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    const payload = JSON.parse(text.text) as {
      operation: string;
      nextProviderToken?: string;
      records: Array<{ classification: string; active_testing_allowed: boolean }>;
    };
    assert.equal(payload.operation, "search");
    assert.equal(payload.nextProviderToken, "provider-page-2");
    assert.deepEqual(payload.records.map((record) => [record.classification, record.active_testing_allowed]), [
      ["in_scope", true],
      ["candidate_only", false]
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("key"), "sentinel-secret");
    assert.doesNotMatch(text.text, /sentinel-secret/);
    assert.doesNotMatch(stderr, /sentinel-secret/);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolveClose, reject) => mock.close((error) => error ? reject(error) : resolveClose()));
  }
  assert.ok(childPid);
  assert.throws(
    () => process.kill(childPid!, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH"
  );
});
