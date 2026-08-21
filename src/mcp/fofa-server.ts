import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { FofaClient } from "../fofa/fofa-client.js";
import {
  loadFofaConfig,
  redactFofaSecret,
  type FofaConfig
} from "../fofa/fofa-config.js";
import { FofaScopePolicy } from "../fofa/fofa-scope-policy.js";
import { assertFofaProviderSupportsTool } from "../fofa/shenxd-adapter.js";
import {
  FOFA_FIELDS,
  FofaError,
  type FofaOperationResult,
  type FofaRecord,
  type FofaTrustedContext
} from "../fofa/fofa-types.js";

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

const fieldsSchema = z.array(z.enum(FOFA_FIELDS))
  .min(1)
  .max(FOFA_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length, "FOFA fields must be unique");

const searchSchema = z.object({
  _runtime: trustedContextSchema,
  query: z.string().min(1).max(4_096),
  fields: fieldsSchema,
  size: z.number().int().positive(),
  full: z.boolean().default(false)
}).strict();

const nextSchema = searchSchema.extend({ next: z.string().min(1).max(4_096) }).strict();

const statsSchema = z.object({
  _runtime: trustedContextSchema,
  query: z.string().min(1).max(4_096),
  fields: fieldsSchema,
  size: z.number().int().positive()
}).strict();

const hostSchema = z.object({
  _runtime: trustedContextSchema,
  host: z.string().min(1).max(2_048),
  detail: z.boolean().default(false)
}).strict();

export function createFofaMcpServer(config: FofaConfig): McpServer {
  const client = new FofaClient(config);
  const server = new McpServer({ name: "luanniao-fofa", version: "1.0.0" });

  server.registerTool("fofa_account_info", {
    description: "Return a redacted FOFA account capability and points summary.",
    inputSchema: z.object({ _runtime: trustedContextSchema }).strict()
  }, async ({ _runtime }) => runTool(config, async () => {
    assertFofaProviderSupportsTool(config, "fofa_account_info");
    validateContext(_runtime);
    const data = await client.accountInfo();
    return { operation: "account_info", data, returned: 0 };
  }));

  server.registerTool("fofa_search", {
    description: "Search FOFA with a Scope-anchored query.",
    inputSchema: searchSchema
  }, async ({ _runtime, query, fields, size, full }) => runTool(config, async () => {
    const policy = validateContext(_runtime);
    policy.validateQuery(query, new Set(_runtime.derivedRefs));
    const boundedSize = Math.min(size, config.maxResultsPerCall);
    const raw = await client.search({ query, fields, size: boundedSize, full });
    return normalizeSearch("search", query, fields, raw, policy);
  }));

  server.registerTool("fofa_search_next", {
    description: "Continue a Scope-anchored FOFA search with a provider continuation token.",
    inputSchema: nextSchema
  }, async ({ _runtime, query, fields, size, full, next }) => runTool(config, async () => {
    assertFofaProviderSupportsTool(config, "fofa_search_next");
    const policy = validateContext(_runtime);
    policy.validateQuery(query, new Set(_runtime.derivedRefs));
    const boundedSize = Math.min(size, config.maxResultsPerCall);
    const raw = await client.searchNext({ query, fields, size: boundedSize, full, next });
    return normalizeSearch("search_next", query, fields, raw, policy);
  }));

  server.registerTool("fofa_stats", {
    description: "Aggregate FOFA statistics for a Scope-anchored query.",
    inputSchema: statsSchema
  }, async ({ _runtime, query, fields, size }) => runTool(config, async () => {
    assertFofaProviderSupportsTool(config, "fofa_stats");
    const policy = validateContext(_runtime);
    policy.validateQuery(query, new Set(_runtime.derivedRefs));
    const data = await client.stats({
      query,
      fields,
      size: Math.min(size, config.maxResultsPerCall)
    });
    return { operation: "stats", query, fields, data, returned: 0 };
  }));

  server.registerTool("fofa_host_aggregate", {
    description: "Return FOFA host aggregation for an authorized host or trusted derived reference.",
    inputSchema: hostSchema
  }, async ({ _runtime, host, detail }) => runTool(config, async () => {
    assertFofaProviderSupportsTool(config, "fofa_host_aggregate");
    const policy = validateContext(_runtime);
    policy.validateHost(host, new Set(_runtime.derivedRefs));
    const data = await client.hostAggregate({ host, detail });
    return { operation: "host_aggregate", data, returned: 0 };
  }));

  return server;
}

async function runTool(
  config: FofaConfig,
  operation: () => Promise<FofaOperationResult>
): Promise<{
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}> {
  try {
    const result = await operation();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    const normalized = error instanceof FofaError
      ? new FofaError(error.code, redactFofaSecret(error.message, config), error.retryable)
      : new FofaError(
          "fofa_provider_error",
          redactFofaSecret(error instanceof Error ? error.message : "FOFA operation failed", config)
        );
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable
        })
      }]
    };
  }
}

function validateContext(context: FofaTrustedContext): FofaScopePolicy {
  const policy = new FofaScopePolicy(context.scope);
  if (policy.fingerprint() !== context.scopeFingerprint) {
    throw new FofaError("fofa_scope_rejected", "FOFA trusted Scope fingerprint does not match");
  }
  return policy;
}

function normalizeSearch(
  operation: "search" | "search_next",
  query: string,
  fields: string[],
  raw: Awaited<ReturnType<FofaClient["search"]>>,
  policy: FofaScopePolicy
): FofaOperationResult {
  const records: FofaRecord[] = raw.results.map((row) => {
    const recordFields = Object.fromEntries(fields.map((field, index) => [field, row[index]]));
    const identity = {
      host: scalarString(recordFields.host),
      domain: scalarString(recordFields.domain),
      ip: scalarString(recordFields.ip)
    };
    return { fields: recordFields, ...policy.classify(identity) };
  });
  return {
    operation,
    query,
    fields,
    records,
    returned: records.length,
    total: raw.total,
    consumedFpoints: raw.consumedFpoints,
    nextProviderToken: raw.next
  };
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

async function main(): Promise<void> {
  const config = loadFofaConfig(process.env);
  if (!config) {
    process.stderr.write("FOFA MCP is not configured\n");
    process.exitCode = 1;
    return;
  }
  const server = createFofaMcpServer(config);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write("FOFA MCP startup failed\n");
    process.exitCode = 1;
  });
}
