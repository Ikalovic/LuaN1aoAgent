import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createExecutorCredentialTools } from "../src/tools/credential-tools.js";

/**
 * These tests validate the TypeBox parameter schemas exposed by the
 * Executor credential tools without starting a real MCP Server.
 */

function createTools() {
  const mockRuntime = {
    call: async (_taskRef: string, _toolName: string, _args: Record<string, unknown>) => {
      return { operation: "mock" };
    }
  };
  return createExecutorCredentialTools(mockRuntime, "task:test");
}

test("credential_query requires scopeRef", () => {
  const tools = createTools();
  const queryTool = tools.find((t) => t.name === "credential_query");
  assert.ok(queryTool, "credential_query tool should exist");

  // Missing scopeRef should fail
  assert.equal(Check(queryTool.parameters, {}), false);
  // Empty scopeRef should fail (minLength: 1)
  assert.equal(Check(queryTool.parameters, { scopeRef: "" }), false);
  // Valid scopeRef should pass
  assert.equal(Check(queryTool.parameters, { scopeRef: "scope:target-1" }), true);
  // Optional filters should be accepted
  assert.equal(Check(queryTool.parameters, {
    scopeRef: "scope:target-1",
    hostRef: "10.0.0.1",
    kind: "token",
    role: "admin",
    includeInvalid: true
  }), true);
});

test("credential_read requires artifactRef", () => {
  const tools = createTools();
  const readTool = tools.find((t) => t.name === "credential_read");
  assert.ok(readTool, "credential_read tool should exist");

  // Missing artifactRef should fail
  assert.equal(Check(readTool.parameters, {}), false);
  // Empty artifactRef should fail
  assert.equal(Check(readTool.parameters, { artifactRef: "" }), false);
  // Valid artifactRef should pass
  assert.equal(Check(readTool.parameters, { artifactRef: "artifact:abc-123" }), true);
  // Optional taskId should be accepted
  assert.equal(Check(readTool.parameters, { artifactRef: "artifact:abc-123", taskId: "task:1" }), true);
});

test("credential_store requires kind, value, and scopeRef", () => {
  const tools = createTools();
  const storeTool = tools.find((t) => t.name === "credential_store");
  assert.ok(storeTool, "credential_store tool should exist");

  // Missing all required fields
  assert.equal(Check(storeTool.parameters, {}), false);
  // Missing value and scopeRef
  assert.equal(Check(storeTool.parameters, { kind: "token" }), false);
  // Missing scopeRef
  assert.equal(Check(storeTool.parameters, { kind: "token", value: "secret" }), false);
  // Missing kind
  assert.equal(Check(storeTool.parameters, { value: "secret", scopeRef: "scope:1" }), false);
  // All required fields present
  assert.equal(Check(storeTool.parameters, {
    kind: "token",
    value: "secret-value",
    scopeRef: "scope:target"
  }), true);
  // With all optional fields
  assert.equal(Check(storeTool.parameters, {
    kind: "cookie",
    value: "session=abc",
    scopeRef: "scope:target",
    hostRef: "10.0.0.1",
    label: "admin session",
    username: "admin",
    role: "web_admin",
    source: "auto_output"
  }), true);
});

test("credential_invalidate requires artifactRef", () => {
  const tools = createTools();
  const invalidateTool = tools.find((t) => t.name === "credential_invalidate");
  assert.ok(invalidateTool, "credential_invalidate tool should exist");

  // Missing artifactRef should fail
  assert.equal(Check(invalidateTool.parameters, {}), false);
  // Empty artifactRef should fail
  assert.equal(Check(invalidateTool.parameters, { artifactRef: "" }), false);
  // Valid artifactRef should pass
  assert.equal(Check(invalidateTool.parameters, { artifactRef: "artifact:abc-123" }), true);
  // Optional reason should be accepted
  assert.equal(Check(invalidateTool.parameters, {
    artifactRef: "artifact:abc-123",
    reason: "expired token"
  }), true);
});

test("credential_list_by_role requires scopeRef and role", () => {
  const tools = createTools();
  const listByRoleTool = tools.find((t) => t.name === "credential_list_by_role");
  assert.ok(listByRoleTool, "credential_list_by_role tool should exist");

  // Missing both required fields
  assert.equal(Check(listByRoleTool.parameters, {}), false);
  // Missing role
  assert.equal(Check(listByRoleTool.parameters, { scopeRef: "scope:1" }), false);
  // Missing scopeRef
  assert.equal(Check(listByRoleTool.parameters, { role: "admin" }), false);
  // Both required fields present
  assert.equal(Check(listByRoleTool.parameters, {
    scopeRef: "scope:target",
    role: "admin"
  }), true);
});

test("credential tools reject additional properties", () => {
  const tools = createTools();
  const queryTool = tools.find((t) => t.name === "credential_query");
  assert.ok(queryTool);

  // Extra properties should be rejected (additionalProperties: false)
  assert.equal(Check(queryTool.parameters, {
    scopeRef: "scope:target",
    extra: true
  }), false);
});

test("credential_store value must not be empty", () => {
  const tools = createTools();
  const storeTool = tools.find((t) => t.name === "credential_store");
  assert.ok(storeTool);

  // Empty value should fail (minLength: 1)
  assert.equal(Check(storeTool.parameters, {
    kind: "token",
    value: "",
    scopeRef: "scope:1"
  }), false);
});
