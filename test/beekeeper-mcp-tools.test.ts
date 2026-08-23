import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BeekeeperCredentialQueryResult } from "../src/beekeeper/beekeeper-types.js";
import { createExecutorBeekeeperTools } from "../src/tools/beekeeper-mcp-tools.js";

test("Beekeeper Pi bridge exposes three plaintext credential tools", async () => {
  const calls: Array<{ taskRef: string; toolName: string; args: Record<string, unknown> }> = [];
  const runtime = {
    call: async (
      taskRef: string,
      toolName: string,
      args: Record<string, unknown>
    ): Promise<BeekeeperCredentialQueryResult> => {
      calls.push({ taskRef, toolName, args });
      return {
        domain: "example.com",
        include_invalid: false,
        limit: 1,
        total_returned: 1,
        has_more: false,
        next_cursor: null,
        items: [{
          id: 1,
          domain: "example.com",
          account: "alice",
          password: "alice-pass",
          source: "unit",
          is_valid: true,
          created_at: null
        }]
      };
    }
  };

  const tools = createExecutorBeekeeperTools(runtime, "task:creds");
  assert.deepEqual(tools.map((tool: ToolDefinition<any, any, any>) => tool.name).sort(), [
    "mark_credential_invalid",
    "query_credentials",
    "store_credential"
  ]);
  assert.match(tools.map((tool: ToolDefinition<any, any, any>) => tool.description).join("\n"), /stop after/i);
  assert.match(tools.map((tool: ToolDefinition<any, any, any>) => tool.description).join("\n"), /explicit authentication rejection/i);

  const query = tools.find((tool: ToolDefinition<any, any, any>) => tool.name === "query_credentials")!;
  const output = await query.execute("call:1", {
    domain: "example.com",
    limit: 1
  }, new AbortController().signal, () => undefined, {} as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  assert.match(text, /alice-pass/);
  assert.equal(calls[0].taskRef, "task:creds");
  assert.deepEqual(calls[0].args, {
    domain: "example.com",
    cursor: undefined,
    include_invalid: false,
    limit: 1
  });
});
