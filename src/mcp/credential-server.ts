import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { ArtifactStore } from "../stores/artifact-store.js";

const trustedContextSchema = z.object({
  runRef: z.string().min(1).max(256),
  taskRef: z.string().min(1).max(256),
  scope: z.object({
    cidrs: z.array(z.string()).max(256),
    domains: z.array(z.string()).max(256)
  }).strict(),
  scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  derivedRefs: z.array(z.string().min(1).max(256)).max(128)
}).strict();

const credentialQuerySchema = z.object({
  _runtime: trustedContextSchema,
  scopeRef: z.string().min(1).max(256),
  hostRef: z.string().min(1).max(2_048).optional(),
  kind: z.string().min(1).max(64).optional(),
  role: z.string().min(1).max(256).optional(),
  includeInvalid: z.boolean().default(false)
}).strict();

const credentialReadSchema = z.object({
  _runtime: trustedContextSchema,
  artifactRef: z.string().min(1).max(256),
  taskId: z.string().min(1).max(256).optional()
}).strict();

const credentialStoreSchema = z.object({
  _runtime: trustedContextSchema,
  kind: z.string().min(1).max(64),
  value: z.string().min(1).max(1_048_576),
  scopeRef: z.string().min(1).max(256),
  hostRef: z.string().min(1).max(2_048).optional(),
  label: z.string().min(0).max(512).optional(),
  username: z.string().min(1).max(512).optional(),
  role: z.string().min(1).max(256).optional(),
  source: z.string().min(1).max(64).default("manual")
}).strict();

const credentialInvalidateSchema = z.object({
  _runtime: trustedContextSchema,
  artifactRef: z.string().min(1).max(256),
  reason: z.string().min(0).max(1_024).optional()
}).strict();

const credentialListByRoleSchema = z.object({
  _runtime: trustedContextSchema,
  scopeRef: z.string().min(1).max(256),
  role: z.string().min(1).max(256)
}).strict();

export type CredentialToolName =
  | "credential_query"
  | "credential_read"
  | "credential_store"
  | "credential_invalidate"
  | "credential_list_by_role";

export function createCredentialMcpServer(artifactStore: ArtifactStore): McpServer {
  const server = new McpServer({ name: "luanniao-credential", version: "1.0.0" });

  server.registerTool("credential_query", {
    description: "Query credential metadata by scope/host/kind/role. Does NOT return credential values.",
    inputSchema: credentialQuerySchema
  }, async ({ _runtime, scopeRef, hostRef, kind, role, includeInvalid }) => runTool(async () => {
    validateContext(_runtime);
    const records = await artifactStore.listCredentials(scopeRef, {
      hostRef,
      kind,
      role,
      validOnly: !includeInvalid
    });
    return {
      operation: "query",
      scopeRef,
      records: records.map((r) => ({
        artifactRef: r.artifactRef,
        kind: r.kind,
        hostRef: r.hostRef,
        label: r.label,
        username: r.username,
        role: r.role,
        source: r.source,
        valid: r.valid,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt
      })),
      returned: records.length
    };
  }));

  server.registerTool("credential_read", {
    description: "Read credential value. Automatically records audit log.",
    inputSchema: credentialReadSchema
  }, async ({ _runtime, artifactRef, taskId }) => runTool(async () => {
    validateContext(_runtime);
    const value = await artifactStore.readCredential(artifactRef);
    await artifactStore.touchCredential(artifactRef);
    await artifactStore.logCredentialAccess({
      credentialRef: artifactRef,
      taskId: taskId ?? _runtime.taskRef,
      action: "read",
      actor: `task:${_runtime.taskRef}`
    });
    return {
      operation: "read",
      artifactRef,
      value
    };
  }));

  server.registerTool("credential_store", {
    description: "Store a new credential. Records audit log.",
    inputSchema: credentialStoreSchema
  }, async ({ _runtime, kind, value, scopeRef, hostRef, label, username, role, source }) => runTool(async () => {
    validateContext(_runtime);
    const record = await artifactStore.writeCredential({
      data: value,
      scopeRef,
      kind,
      hostRef,
      label,
      username,
      role,
      source
    });
    await artifactStore.logCredentialAccess({
      credentialRef: record.artifactRef,
      taskId: _runtime.taskRef,
      action: "store",
      actor: `task:${_runtime.taskRef}`,
      details: `kind=${kind} source=${source}`
    });
    return {
      operation: "store",
      artifactRef: record.artifactRef,
      kind,
      scopeRef,
      createdAt: record.createdAt
    };
  }));

  server.registerTool("credential_invalidate", {
    description: "Mark a credential as invalid. Records audit log.",
    inputSchema: credentialInvalidateSchema
  }, async ({ _runtime, artifactRef, reason }) => runTool(async () => {
    validateContext(_runtime);
    await artifactStore.invalidateCredential(artifactRef);
    await artifactStore.logCredentialAccess({
      credentialRef: artifactRef,
      taskId: _runtime.taskRef,
      action: "invalidate",
      actor: `task:${_runtime.taskRef}`,
      details: reason
    });
    return {
      operation: "invalidate",
      artifactRef,
      reason: reason ?? null
    };
  }));

  server.registerTool("credential_list_by_role", {
    description: "List credential metadata by role for multi-path penetration orchestration. Does NOT return values.",
    inputSchema: credentialListByRoleSchema
  }, async ({ _runtime, scopeRef, role }) => runTool(async () => {
    validateContext(_runtime);
    const records = await artifactStore.listCredentials(scopeRef, { role, validOnly: true });
    return {
      operation: "list_by_role",
      scopeRef,
      role,
      records: records.map((r) => ({
        artifactRef: r.artifactRef,
        kind: r.kind,
        hostRef: r.hostRef,
        label: r.label,
        username: r.username,
        source: r.source,
        valid: r.valid,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt
      })),
      returned: records.length
    };
  }));

  return server;
}

async function runTool(
  operation: () => Promise<Record<string, unknown>>
): Promise<{
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}> {
  try {
    const result = await operation();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Credential MCP tool failed";
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({ code: "credential_error", message })
      }]
    };
  }
}

function validateContext(context: z.infer<typeof trustedContextSchema>): void {
  // Basic context validation — ensure runRef and taskRef are present
  if (!context.runRef || !context.taskRef) {
    throw new Error("Credential MCP trusted context is missing required fields");
  }
}

async function main(): Promise<void> {
  const rootDir = process.env.CREDENTIAL_STORE_ROOT;
  const databasePath = process.env.CREDENTIAL_STORE_DB;
  if (!rootDir) {
    process.stderr.write("Credential MCP is not configured: CREDENTIAL_STORE_ROOT is required\n");
    process.exitCode = 1;
    return;
  }
  const artifactStore = new ArtifactStore(rootDir, databasePath);
  const server = createCredentialMcpServer(artifactStore);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write("Credential MCP startup failed\n");
    process.exitCode = 1;
  });
}
