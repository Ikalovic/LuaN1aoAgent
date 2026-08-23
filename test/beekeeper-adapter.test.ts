import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("Beekeeper adapter exposes bounded plaintext credential tools", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "beekeeper-adapter-"));
  const databasePath = join(runtimeDir, "beekeeper.db");
  const transport = new StdioClientTransport({
    command: resolve(".beekeeper-mcp-venv/bin/python"),
    args: [resolve("scripts/beekeeper-mcp-adapter.py")],
    env: {
      PATH: process.env.PATH ?? "",
      BEEKEEPER_ROOT: resolve("vendor/Beekeeper"),
      BEEKEEPER_DATABASE_URL: `sqlite:///${databasePath}`,
      BEEKEEPER_MCP_MAX_PAGE_SIZE: "2"
    },
    stderr: "pipe",
    cwd: process.cwd()
  });
  const client = new Client({ name: "beekeeper-adapter-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "mark_credential_invalid",
      "query_credentials",
      "store_credential"
    ]);

    assert.deepEqual(await call(client, "store_credential", {
      domain: "Example.COM",
      account: "alice",
      password: "alice-pass",
      source: "unit"
    }), {
      status: "created",
      credential_id: 1,
      domain: "example.com",
      is_valid: true
    });
    assert.deepEqual(await call(client, "store_credential", {
      domain: "example.com",
      account: "alice",
      password: "alice-pass",
      source: "duplicate"
    }), {
      status: "already_exists",
      credential_id: 1,
      domain: "example.com",
      is_valid: true
    });
    await call(client, "store_credential", {
      domain: "example.com",
      account: "bob",
      password: "bob-pass",
      source: "unit"
    });
    await call(client, "store_credential", {
      domain: "other.test",
      account: "carol",
      password: "carol-pass",
      source: "unit"
    });

    const firstPage = await call(client, "query_credentials", { limit: 1 });
    assert.equal(firstPage.limit, 1);
    assert.equal(firstPage.has_more, true);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0].domain, "example.com");
    assert.equal(firstPage.items[0].account, "alice");
    assert.equal(firstPage.items[0].password, "alice-pass");
    assert.ok(firstPage.next_cursor);

    const secondPage = await call(client, "query_credentials", {
      cursor: firstPage.next_cursor,
      limit: 10
    });
    assert.equal(secondPage.limit, 2);
    assert.deepEqual(secondPage.items.map((item: { account: string }) => item.account), ["bob", "carol"]);

    const filtered = await call(client, "query_credentials", {
      domain: "example.com",
      limit: 1
    });
    assert.equal(filtered.total_returned, 1);
    assert.deepEqual(filtered.items.map((item: { account: string }) => item.account), ["alice"]);
    assert.ok(filtered.next_cursor);
    await assert.rejects(
      () => call(client, "query_credentials", { domain: "other.test", cursor: filtered.next_cursor }),
      /cursor.*does not match/i
    );

    assert.deepEqual(await call(client, "mark_credential_invalid", {
      credential_id: 1,
      reason: "login rejected"
    }), {
      status: "invalidated",
      credential_id: 1,
      is_valid: false,
      reason: "login rejected"
    });
    assert.equal((await call(client, "query_credentials", { domain: "example.com" })).total_returned, 1);
    assert.equal((await call(client, "query_credentials", {
      domain: "example.com",
      include_invalid: true
    })).total_returned, 2);
    assert.equal((await call(client, "mark_credential_invalid", { credential_id: 1 })).status, "already_invalid");
  } finally {
    await client.close().catch(() => undefined);
  }
});

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const errorText = result.content.find((item) => item.type === "text")?.text ?? "tool failed";
    throw new Error(errorText);
  }
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && text.type === "text");
  return JSON.parse(text.text);
}
