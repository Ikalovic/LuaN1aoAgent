import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AuthorizedScope } from "../scope.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import type { RuntimeStore } from "../stores/runtime-store.js";
import { fofaChildEnvironment, redactFofaSecret, type FofaConfig } from "../fofa/fofa-config.js";
import { FofaScopePolicy } from "../fofa/fofa-scope-policy.js";
import { assertFofaProviderSupportsTool } from "../fofa/shenxd-adapter.js";
import {
  FofaError,
  type FofaErrorCode,
  type FofaOperationResult,
  type FofaToolName,
  type FofaTrustedContext
} from "../fofa/fofa-types.js";

const EXPECTED_TOOLS: FofaToolName[] = [
  "fofa_account_info",
  "fofa_host_aggregate",
  "fofa_search",
  "fofa_search_next",
  "fofa_stats"
];
const CURSOR_TTL_MS = 30 * 60 * 1_000;

export type FofaMcpCallResult = {
  operation: FofaOperationResult["operation"];
  full: FofaOperationResult;
  cursor?: string;
  quota: { resultsConsumed: number; aggregationsConsumed: number };
};

export type FofaMcpClientConnection = {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  close(): Promise<void>;
};

export type FofaMcpClientFactory = (input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  onStderr: (line: string) => void;
}) => Promise<FofaMcpClientConnection>;

export type FofaMcpRuntimeOptions = {
  runRef: string;
  scope: AuthorizedScope;
  config: FofaConfig;
  runtimeStore: RuntimeStore;
  executionLog: ExecutionLog;
  clientFactory?: FofaMcpClientFactory;
  now?: () => number;
};

type CursorEntry = {
  runRef: string;
  taskRef: string;
  scopeFingerprint: string;
  query: string;
  fields: string[];
  full: boolean;
  providerToken: string;
  expiresAt: number;
};

export class FofaMcpRuntime {
  readonly enabled = true;
  private readonly policy: FofaScopePolicy;
  private readonly clientFactory: FofaMcpClientFactory;
  private readonly now: () => number;
  private readonly cursors = new Map<string, CursorEntry>();
  private client?: FofaMcpClientConnection;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;
  private needsRestart = false;
  private restartUsed = false;

  constructor(private readonly options: FofaMcpRuntimeOptions) {
    this.policy = new FofaScopePolicy(options.scope);
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.now = options.now ?? Date.now;
  }

  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(unavailable("FOFA MCP Runtime is closed"));
    }
    if (this.client && !this.needsRestart) {
      return Promise.resolve();
    }
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  async call(
    taskRef: string,
    toolName: FofaToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<FofaMcpCallResult> {
    if (signal?.aborted) {
      throw signal.reason;
    }
    assertFofaProviderSupportsTool(this.options.config, toolName);
    await this.ensureClientForCall();
    if (signal?.aborted) {
      throw signal.reason;
    }
    const client = this.client;
    if (!client) {
      throw unavailable("FOFA MCP client is unavailable");
    }

    const prepared = this.prepareCall(taskRef, toolName, args);
    const startedAt = this.now();
    let reservation: { kind: "results" | "aggregations"; amount: number } | undefined;
    if (prepared.quotaKind) {
      reservation = { kind: prepared.quotaKind, amount: prepared.quotaAmount };
      this.options.runtimeStore.reserveFofaQuota({
        taskId: taskRef,
        kind: reservation.kind,
        amount: reservation.amount,
        limit: reservation.kind === "results"
          ? this.options.config.maxResultsPerTask
          : this.options.config.maxAggregationsPerTask
      });
    }

    try {
      const response = await client.callTool({
        name: toolName,
        arguments: { ...prepared.arguments, _runtime: this.trustedContext(taskRef) }
      }, signal);
      const full = parseToolResponse(response);
      if (response.isError) {
        throw errorFromPayload(full);
      }
      if (reservation?.kind === "results") {
        if (!Number.isSafeInteger(full.returned) || full.returned < 0 || full.returned > reservation.amount) {
          throw new FofaError("fofa_response_invalid", "FOFA MCP returned an invalid result count");
        }
        const unused = reservation.amount - full.returned;
        if (unused > 0) {
          this.options.runtimeStore.releaseFofaQuota({
            taskId: taskRef,
            kind: "results",
            amount: unused
          });
        }
      }

      const cursor = this.captureCursor(taskRef, full, prepared.arguments.full === true);
      const { nextProviderToken: _providerToken, ...publicFull } = full;
      const quota = this.options.runtimeStore.getFofaQuota(taskRef);
      void this.appendMetric(taskRef, toolName, startedAt, {
        status: "succeeded",
        returned: full.returned,
        quota
      });
      return { operation: full.operation, full: publicFull, cursor, quota };
    } catch (error) {
      if (isDefinitelyPreDispatch(error) && reservation) {
        this.options.runtimeStore.releaseFofaQuota({
          taskId: taskRef,
          kind: reservation.kind,
          amount: reservation.amount
        });
        void this.appendMetric(taskRef, toolName, startedAt, {
          status: "failed_before_dispatch"
        });
        throw error;
      }
      if (signal?.aborted) {
        void this.appendMetric(taskRef, toolName, startedAt, { status: "cancelled" });
        throw signal.reason;
      }
      if (error instanceof FofaError) {
        void this.appendMetric(taskRef, toolName, startedAt, {
          status: "failed",
          errorCode: error.code
        });
        throw error;
      }
      this.needsRestart = true;
      void this.appendMetric(taskRef, toolName, startedAt, {
        status: "transport_failed",
        errorCode: "fofa_mcp_unavailable"
      });
      throw unavailable("fofa_mcp_unavailable: FOFA MCP transport closed during the call");
    }
  }

  invalidateTask(taskRef: string): void {
    for (const [cursor, entry] of this.cursors) {
      if (entry.taskRef === taskRef) {
        this.cursors.delete(cursor);
      }
    }
  }

  close(reason = "runtime_close"): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal(reason);
    }
    return this.closePromise;
  }

  private async startInternal(): Promise<void> {
    const command = process.execPath;
    const args = [fileURLToPath(new URL("./fofa-server.js", import.meta.url))];
    const connection = await this.clientFactory({
      command,
      args,
      env: fofaChildEnvironment(this.options.config, process.env),
      onStderr: (line) => this.recordStderr(line)
    });
    try {
      const listed = await connection.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_TOOLS].sort())) {
        throw unavailable("FOFA MCP exposed an unexpected tool set");
      }
      this.client = connection;
      this.needsRestart = false;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error instanceof FofaError ? error : unavailable("FOFA MCP failed to initialize");
    }
  }

  private async ensureClientForCall(): Promise<void> {
    if (this.closed) {
      throw unavailable("FOFA MCP Runtime is closed");
    }
    if (this.needsRestart) {
      if (this.restartUsed) {
        throw unavailable("FOFA MCP restart budget exhausted");
      }
      this.restartUsed = true;
      const stale = this.client;
      this.client = undefined;
      this.needsRestart = false;
      this.cursors.clear();
      await stale?.close().catch(() => undefined);
    }
    await this.start();
  }

  private prepareCall(
    taskRef: string,
    toolName: FofaToolName,
    args: Record<string, unknown>
  ): {
    arguments: Record<string, unknown>;
    quotaKind?: "results" | "aggregations";
    quotaAmount: number;
  } {
    if (toolName === "fofa_account_info") {
      return { arguments: {}, quotaAmount: 0 };
    }
    if (toolName === "fofa_host_aggregate") {
      return {
        arguments: { host: requiredString(args.host, "host"), detail: optionalBoolean(args.detail, false) },
        quotaKind: "aggregations",
        quotaAmount: 1
      };
    }
    if (toolName === "fofa_stats") {
      return {
        arguments: {
          query: requiredString(args.query, "query"),
          fields: requiredFields(args.fields),
          size: boundedLimit(args.limit, this.options.config.maxResultsPerCall)
        },
        quotaKind: "aggregations",
        quotaAmount: 1
      };
    }
    if (toolName === "fofa_search") {
      const limit = boundedLimit(args.limit, this.options.config.maxResultsPerCall);
      return {
        arguments: {
          query: requiredString(args.query, "query"),
          fields: requiredFields(args.fields),
          size: limit,
          full: optionalBoolean(args.full, false)
        },
        quotaKind: "results",
        quotaAmount: limit
      };
    }

    const cursor = requiredString(args.cursor, "cursor");
    const entry = this.resolveCursor(cursor, taskRef);
    const limit = boundedLimit(args.limit, this.options.config.maxResultsPerCall);
    return {
      arguments: {
        query: entry.query,
        fields: entry.fields,
        size: limit,
        full: entry.full,
        next: entry.providerToken
      },
      quotaKind: "results",
      quotaAmount: limit
    };
  }

  private trustedContext(taskRef: string): FofaTrustedContext {
    return {
      runRef: this.options.runRef,
      taskRef,
      scope: this.options.scope,
      scopeFingerprint: this.policy.fingerprint(),
      derivedRefs: []
    };
  }

  private captureCursor(taskRef: string, full: FofaOperationResult, fullSearch: boolean): string | undefined {
    if (!full.nextProviderToken || !full.query || !full.fields
      || (full.operation !== "search" && full.operation !== "search_next")) {
      return undefined;
    }
    const cursor = `cursor:${randomUUID()}`;
    this.cursors.set(cursor, {
      runRef: this.options.runRef,
      taskRef,
      scopeFingerprint: this.policy.fingerprint(),
      query: full.query,
      fields: [...full.fields],
      full: fullSearch,
      providerToken: full.nextProviderToken,
      expiresAt: this.now() + CURSOR_TTL_MS
    });
    return cursor;
  }

  private resolveCursor(cursor: string, taskRef: string): CursorEntry {
    const entry = this.cursors.get(cursor);
    if (!entry) {
      throw new FofaError("fofa_query_invalid", "FOFA cursor is unknown");
    }
    if (entry.expiresAt <= this.now()) {
      this.cursors.delete(cursor);
      throw new FofaError("fofa_query_invalid", "FOFA cursor has expired");
    }
    if (entry.taskRef !== taskRef) {
      throw new FofaError("fofa_scope_rejected", "FOFA cursor belongs to a different Task");
    }
    if (entry.runRef !== this.options.runRef || entry.scopeFingerprint !== this.policy.fingerprint()) {
      throw new FofaError("fofa_scope_rejected", "FOFA cursor ownership does not match this Run Scope");
    }
    return entry;
  }

  private async closeInternal(reason: string): Promise<void> {
    this.closed = true;
    this.cursors.clear();
    const connection = this.client;
    this.client = undefined;
    await connection?.close();
    void this.options.executionLog.append({
      role: "runtime",
      eventType: "fofa_mcp_closed",
      summary: "FOFA MCP Runtime closed",
      payload: { reason: redactFofaSecret(reason, this.options.config).slice(0, 512) }
    }).catch(() => undefined);
  }

  private recordStderr(line: string): void {
    const message = redactFofaSecret(line.replace(/[\r\n]+/g, " "), this.options.config).slice(0, 2_048);
    if (!message) return;
    void this.options.executionLog.append({
      role: "runtime",
      eventType: "fofa_mcp_stderr",
      summary: "FOFA MCP child diagnostic",
      payload: { message }
    }).catch(() => undefined);
  }

  private async appendMetric(
    taskRef: string,
    toolName: FofaToolName,
    startedAt: number,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.options.executionLog.append({
      taskId: taskRef,
      role: "runtime",
      eventType: "fofa_mcp_call",
      summary: `FOFA MCP ${toolName}`,
      payload: {
        toolName,
        durationMs: Math.max(0, this.now() - startedAt),
        ...payload
      } as never
    }).catch(() => undefined);
  }
}

async function defaultClientFactory(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  onStderr: (line: string) => void;
}): Promise<FofaMcpClientConnection> {
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args,
    env,
    stderr: "pipe"
  });
  let stderrBuffer = "";
  transport.stderr?.on("data", (chunk) => {
    stderrBuffer += String(chunk);
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) input.onStderr(line);
  });
  transport.stderr?.on("end", () => {
    if (stderrBuffer) input.onStderr(stderrBuffer);
  });
  const client = new Client({ name: "luanniao-fofa-runtime", version: "1.0.0" });
  await client.connect(transport);
  return {
    listTools: async () => {
      const result = await client.listTools();
      return { tools: result.tools.map((tool) => ({ name: tool.name })) };
    },
    callTool: async (request, signal) => {
      const result = await client.callTool(request, { signal });
      return {
        content: result.content.map((item) => ({
          type: item.type,
          text: item.type === "text" ? item.text : undefined
        })),
        isError: result.isError
      };
    },
    close: async () => client.close()
  };
}

function parseToolResponse(response: {
  content: Array<{ type: string; text?: string }>;
}): FofaOperationResult {
  if (response.content.length !== 1 || response.content[0].type !== "text"
    || typeof response.content[0].text !== "string") {
    throw new FofaError("fofa_response_invalid", "FOFA MCP returned an invalid content envelope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content[0].text);
  } catch {
    throw new FofaError("fofa_response_invalid", "FOFA MCP returned invalid JSON");
  }
  if (!isRecord(parsed)) {
    throw new FofaError("fofa_response_invalid", "FOFA MCP returned a non-object payload");
  }
  return parsed as FofaOperationResult;
}

function errorFromPayload(payload: FofaOperationResult): FofaError {
  const raw = payload as unknown as Record<string, unknown>;
  const code = typeof raw.code === "string" ? raw.code as FofaErrorCode : "fofa_provider_error";
  const message = typeof raw.message === "string" ? raw.message : "FOFA MCP tool failed";
  return new FofaError(code, message, raw.retryable === true);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FofaError("fofa_query_invalid", `FOFA ${name} must be a non-empty string`);
  }
  return value;
}

function requiredFields(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((field) => typeof field === "string")) {
    throw new FofaError("fofa_query_invalid", "FOFA fields must be a non-empty string array");
  }
  return [...value];
}

function boundedLimit(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new FofaError("fofa_query_invalid", "FOFA limit must be a positive integer");
  }
  return Math.min(Number(value), maximum);
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new FofaError("fofa_query_invalid", "FOFA boolean argument is invalid");
  }
  return value;
}

function isDefinitelyPreDispatch(error: unknown): boolean {
  return isRecord(error) && error.preDispatch === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(message: string): FofaError {
  return new FofaError("fofa_mcp_unavailable", message, true);
}
