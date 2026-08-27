import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ExecutionLog } from "../stores/execution-log.js";
import type { CredentialToolName } from "./credential-server.js";

const EXPECTED_TOOLS: CredentialToolName[] = [
  "credential_query",
  "credential_read",
  "credential_store",
  "credential_invalidate",
  "credential_list_by_role"
];

export type CredentialMcpClientConnection = {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  close(): Promise<void>;
};

export type CredentialMcpClientFactory = (input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  onStderr: (line: string) => void;
}) => Promise<CredentialMcpClientConnection>;

export type CredentialMcpRuntimeOptions = {
  artifactStoreRoot: string;
  artifactStoreDb?: string;
  executionLog: ExecutionLog;
  clientFactory?: CredentialMcpClientFactory;
  now?: () => number;
};

export class CredentialMcpRuntime {
  readonly enabled = true;
  private readonly clientFactory: CredentialMcpClientFactory;
  private readonly now: () => number;
  private client?: CredentialMcpClientConnection;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: CredentialMcpRuntimeOptions) {
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.now = options.now ?? Date.now;
  }

  configure(): Promise<void> {
    return this.start();
  }

  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Credential MCP Runtime is closed"));
    }
    if (this.client) {
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
    toolName: CredentialToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    await this.start();
    const client = this.client;
    if (!client) {
      throw new Error("Credential MCP client is unavailable");
    }
    const startedAt = this.now();
    try {
      const response = await client.callTool({ name: toolName, arguments: args }, signal);
      const result = parseToolResponse(response);
      if (response.isError) {
        throw new Error(typeof result === "string" ? result : JSON.stringify(result));
      }
      void this.appendMetric(taskRef, toolName, startedAt, { status: "succeeded" });
      return result;
    } catch (error) {
      void this.appendMetric(taskRef, toolName, startedAt, {
        status: signal?.aborted ? "cancelled" : "failed",
        errorCode: "credential_provider_error"
      });
      throw error instanceof Error ? error : new Error("Credential MCP call failed");
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
    const args = [fileURLToPath(new URL("./credential-server.js", import.meta.url))];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CREDENTIAL_STORE_ROOT: this.options.artifactStoreRoot
    };
    if (this.options.artifactStoreDb) {
      env.CREDENTIAL_STORE_DB = this.options.artifactStoreDb;
    }
    const connection = await this.clientFactory({
      command,
      args,
      env,
      onStderr: (line) => this.recordStderr(line)
    });
    try {
      const listed = await connection.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_TOOLS].sort())) {
        throw new Error("Credential MCP exposed an unexpected tool set");
      }
      this.client = connection;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  private async closeInternal(reason: string): Promise<void> {
    this.closed = true;
    const connection = this.client;
    this.client = undefined;
    await connection?.close();
    void this.options.executionLog.append({
      role: "runtime",
      eventType: "credential_mcp_closed",
      summary: "Credential MCP Runtime closed",
      payload: { reason: reason.slice(0, 512) }
    }).catch(() => undefined);
  }

  private recordStderr(line: string): void {
    const message = line.replace(/[\r\n]+/g, " ").slice(0, 2_048);
    if (!message) return;
    void this.options.executionLog.append({
      role: "runtime",
      eventType: "credential_mcp_stderr",
      summary: "Credential MCP child diagnostic",
      payload: { message }
    }).catch(() => undefined);
  }

  private async appendMetric(
    taskRef: string,
    toolName: CredentialToolName,
    startedAt: number,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.options.executionLog.append({
      taskId: taskRef,
      role: "runtime",
      eventType: "credential_mcp_call",
      summary: `Credential MCP ${toolName}`,
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
}): Promise<CredentialMcpClientConnection> {
  const env = Object.fromEntries(
    Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args,
    env,
    stderr: "pipe",
    cwd: process.cwd()
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
  const client = new Client({ name: "luanniao-credential-runtime", version: "1.0.0" });
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
}): unknown {
  if (response.content.length !== 1 || response.content[0].type !== "text"
    || typeof response.content[0].text !== "string") {
    throw new Error("Credential MCP returned an invalid content envelope");
  }
  try {
    return JSON.parse(response.content[0].text);
  } catch {
    if (response.content[0].text) {
      return response.content[0].text;
    }
    throw new Error("Credential MCP returned invalid JSON");
  }
}
