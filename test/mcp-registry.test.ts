import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXPECTED_BEEKEEPER_TOOLS } from "../src/mcp/beekeeper-runtime.js";
import { EXPECTED_CREDENTIAL_TOOLS } from "../src/mcp/credential-runtime.js";
import { EXPECTED_FOFA_TOOLS } from "../src/mcp/fofa-runtime.js";
import { McpRegistry } from "../src/mcp/mcp-registry.js";

test("McpRegistry reports the built-in catalog with default enabled state", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-registry-"));
  const registry = new McpRegistry({ cwd, environment: {} });
  const snapshot = registry.scan();

  assert.deepEqual(snapshot.servers.map((server) => server.name), ["credential", "fofa", "beekeeper"]);
  const credential = snapshot.servers[0];
  assert.equal(credential.configured, true);
  assert.equal(credential.enabled, true);
  assert.deepEqual(credential.tools, [...EXPECTED_CREDENTIAL_TOOLS].sort());
  const fofa = snapshot.servers[1];
  assert.equal(fofa.configured, false);
  assert.equal(fofa.enabled, true);
  assert.deepEqual(fofa.tools, [...EXPECTED_FOFA_TOOLS].sort());
  const beekeeper = snapshot.servers[2];
  assert.equal(beekeeper.configured, false);
  assert.deepEqual(beekeeper.tools, [...EXPECTED_BEEKEEPER_TOOLS].sort());
  assert.deepEqual(
    snapshot.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.serverName]).sort(),
    [["mcp_not_configured", "beekeeper"], ["mcp_not_configured", "fofa"]]
  );
  assert.equal(registry.isEnabled("fofa"), true);
});

test("McpRegistry detects configured and malformed server environments", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-registry-config-"));
  const configured = new McpRegistry({
    cwd,
    environment: {
      FOFA_API_KEY: "sentinel-secret",
      FOFA_API_BASE_URL: "https://fofa.example",
      BEEKEEPER_MCP_ENABLED: "1"
    }
  });
  const snapshot = configured.scan();
  assert.equal(snapshot.servers.find((server) => server.name === "fofa")?.configured, true);
  assert.equal(snapshot.servers.find((server) => server.name === "beekeeper")?.configured, true);
  assert.deepEqual(snapshot.diagnostics, []);
  assert.ok(!JSON.stringify(snapshot).includes("sentinel-secret"));

  const malformed = new McpRegistry({
    cwd,
    environment: {
      FOFA_API_KEY: "sentinel-secret",
      FOFA_API_BASE_URL: "http://remote.example",
      BEEKEEPER_MCP_ENABLED: "1",
      BEEKEEPER_ROOT: "relative"
    }
  }).scan();
  assert.equal(malformed.servers.find((server) => server.name === "fofa")?.configured, false);
  assert.equal(malformed.servers.find((server) => server.name === "beekeeper")?.configured, false);
  assert.deepEqual(
    malformed.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.serverName]).sort(),
    [["mcp_configuration_invalid", "beekeeper"], ["mcp_configuration_invalid", "fofa"]]
  );
  assert.ok(!JSON.stringify(malformed).includes("sentinel-secret"));
});

test("McpRegistry persists operator state and rejects unknown servers", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-registry-state-"));
  const statePath = join(cwd, ".agents", "mcp-state.json");
  const registry = new McpRegistry({ cwd, environment: {} });

  assert.equal(registry.scan().servers.every((server) => server.enabled), true);
  registry.setEnabled("fofa", false);
  assert.equal(registry.isEnabled("fofa"), false);
  assert.equal(registry.isEnabled("credential"), true);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { fofa: false });
  assert.equal(registry.scan().servers.find((server) => server.name === "fofa")?.enabled, false);
  assert.throws(() => registry.setEnabled("unknown", true), /Unknown MCP server: unknown/);

  const reopened = new McpRegistry({ cwd, environment: {} });
  assert.equal(reopened.isEnabled("fofa"), false);
  assert.equal(reopened.isEnabled("beekeeper"), true);
});
