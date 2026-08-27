import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CredentialToolName } from "../mcp/credential-server.js";
import type { CredentialMcpRuntime } from "../mcp/credential-runtime.js";

export function createExecutorCredentialTools(
  runtime: Pick<CredentialMcpRuntime, "call">,
  taskRef: string
) {
  const execute = async (
    toolName: CredentialToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => presentResult(await runtime.call(taskRef, toolName, args, signal));

  return [
    defineTool({
      name: "credential_query",
      label: "Query Credentials",
      description: "Query credential metadata by scope. Returns metadata only (no values). Supports filtering by host, kind, and role.",
      parameters: Type.Object({
        scopeRef: Type.String({ minLength: 1, maxLength: 256 }),
        hostRef: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        kind: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        role: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        includeInvalid: Type.Optional(Type.Boolean())
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("credential_query", {
        scopeRef: params.scopeRef,
        hostRef: params.hostRef,
        kind: params.kind,
        role: params.role,
        includeInvalid: params.includeInvalid ?? false
      }, signal)
    }),
    defineTool({
      name: "credential_read",
      label: "Read Credential",
      description: "Read a credential's value by artifact reference. Automatically records audit log and updates last-used timestamp.",
      parameters: Type.Object({
        artifactRef: Type.String({ minLength: 1, maxLength: 256 }),
        taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("credential_read", {
        artifactRef: params.artifactRef,
        taskId: params.taskId
      }, signal)
    }),
    defineTool({
      name: "credential_store",
      label: "Store Credential",
      description: "Store a new credential with metadata. Records audit log. The credential is associated with a scope for isolation.",
      parameters: Type.Object({
        kind: Type.String({ minLength: 1, maxLength: 64 }),
        value: Type.String({ minLength: 1, maxLength: 1048576 }),
        scopeRef: Type.String({ minLength: 1, maxLength: 256 }),
        hostRef: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        label: Type.Optional(Type.String({ maxLength: 512 })),
        username: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        role: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        source: Type.Optional(Type.String({ minLength: 1, maxLength: 64 }))
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("credential_store", {
        kind: params.kind,
        value: params.value,
        scopeRef: params.scopeRef,
        hostRef: params.hostRef,
        label: params.label,
        username: params.username,
        role: params.role,
        source: params.source ?? "manual"
      }, signal)
    }),
    defineTool({
      name: "credential_invalidate",
      label: "Invalidate Credential",
      description: "Mark a credential as invalid. Records audit log. Use when authentication is explicitly rejected.",
      parameters: Type.Object({
        artifactRef: Type.String({ minLength: 1, maxLength: 256 }),
        reason: Type.Optional(Type.String({ maxLength: 1024 }))
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("credential_invalidate", {
        artifactRef: params.artifactRef,
        reason: params.reason
      }, signal)
    }),
    defineTool({
      name: "credential_list_by_role",
      label: "List Credentials by Role",
      description: "List valid credential metadata by role for multi-path penetration orchestration. Returns metadata only (no values).",
      parameters: Type.Object({
        scopeRef: Type.String({ minLength: 1, maxLength: 256 }),
        role: Type.String({ minLength: 1, maxLength: 256 })
      }, { additionalProperties: false }),
      execute: async (_callId, params, signal) => execute("credential_list_by_role", {
        scopeRef: params.scopeRef,
        role: params.role
      }, signal)
    })
  ];
}

function presentResult(result: unknown) {
  const text = JSON.stringify(result, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    details: result
  };
}
