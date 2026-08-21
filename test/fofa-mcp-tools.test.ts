import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExecutorFofaTools } from "../src/tools/fofa-mcp-tools.js";
import type { FofaMcpCallResult } from "../src/mcp/fofa-runtime.js";
import { ArtifactStore } from "../src/stores/artifact-store.js";

test("FOFA Pi bridge hides private MCP context and writes a Task Artifact", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "fofa-tools-"));
  const artifacts = new ArtifactStore(join(runtimeDir, "artifacts"));
  let lastTaskRef = "";
  const runtime = {
    call: async (taskRef: string): Promise<FofaMcpCallResult> => {
      lastTaskRef = taskRef;
      return searchResult(2);
    }
  };
  const tools = createExecutorFofaTools(runtime, artifacts, "task:scope");
  assert.deepEqual(tools.map((tool: ToolDefinition<any, any, any>) => tool.name).sort(), [
    "fofa_account_info", "fofa_host_aggregate", "fofa_search", "fofa_search_next", "fofa_stats"
  ]);
  assert.doesNotMatch(JSON.stringify(tools.map((tool: ToolDefinition<any, any, any>) => tool.parameters)), /_runtime|taskRef|scopeFingerprint/);
  const search = tools.find((tool: ToolDefinition<any, any, any>) => tool.name === "fofa_search")!;
  const output = await search.execute("call:1", {
    query: 'domain="example.com"', fields: ["host", "ip", "port"], limit: 100, full: false
  }, new AbortController().signal, () => undefined, {} as never);
  assert.equal(lastTaskRef, "task:scope");
  assert.doesNotMatch(JSON.stringify(output), /sentinel-secret|nextProviderToken/);
  const listed = await artifacts.list({ taskId: "task:scope" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].mediaType, "application/vnd.luanniao.fofa+json");
  artifacts.close();
});

test("FOFA Pi bridge bounds model text while Artifact retains every record", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "fofa-tools-large-"));
  const artifacts = new ArtifactStore(join(runtimeDir, "artifacts"));
  const runtime = { call: async (): Promise<FofaMcpCallResult> => searchResult(100, "x".repeat(4_000)) };
  const search = createExecutorFofaTools(runtime, artifacts, "task:large")
    .find((tool: ToolDefinition<any, any, any>) => tool.name === "fofa_search")!;
  const output = await search.execute("call:large", {
    query: 'domain="example.com"', fields: ["host", "ip", "port"], limit: 100, full: false
  }, new AbortController().signal, () => undefined, {} as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  assert.ok(Buffer.byteLength(text, "utf8") <= 12_000);
  assert.match(text, /candidate_only records are discovery leads/);
  const [artifact] = await artifacts.list({ taskId: "task:large" });
  const stored = JSON.parse(readFileSync(artifact.path, "utf8")) as { records: unknown[] };
  assert.equal(stored.records.length, 100);
  assert.ok(text.includes('"active_testing_allowed": false'));
  artifacts.close();
});

function searchResult(count: number, padding = ""): FofaMcpCallResult {
  return {
    operation: "search",
    full: {
      operation: "search",
      query: 'domain="example.com"',
      fields: ["host", "ip", "port"],
      returned: count,
      total: count,
      records: Array.from({ length: count }, (_, index) => ({
        fields: { host: index % 2 ? "other.test" : `a${index}.example.com`, ip: "192.0.2.8", port: 443, padding },
        classification: index % 2 ? "candidate_only" : "in_scope",
        active_testing_allowed: index % 2 === 0
      }))
    },
    cursor: "cursor:opaque",
    quota: { resultsConsumed: count, aggregationsConsumed: 0 }
  };
}
