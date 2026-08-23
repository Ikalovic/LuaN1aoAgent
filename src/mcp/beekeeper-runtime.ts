import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { beekeeperChildEnvironment, type BeekeeperConfig } from "../beekeeper/beekeeper-config.js";
import type { BeekeeperToolName, BeekeeperToolResult } from "../beekeeper/beekeeper-types.js";
import type { ExecutionLog } from "../stores/execution-log.js";

const EXPECTED_TOOLS: BeekeeperToolName[] = [
  "query_credentials",
  "store_credential",
  "mark_credential_invalid"
];

export type BeekeeperMcpClientConnection = {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  close(): Promise<void>;
};

export type BeekeeperMcpClientFactory = (input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  onStderr: (line: string) => void;
}) => Promise<BeekeeperMcpClientConnection>;

export type BeekeeperMcpRuntimeOptions = {
  config: BeekeeperConfig;
  executionLog: ExecutionLog;
  clientFactory?: BeekeeperMcpClientFactory;
  now?: () => number;
};

export class BeekeeperMcpRuntime {
  readonly enabled = true;
  private readonly clientFactory: BeekeeperMcpClientFactory;
  private readonly now: () => number;
  private client?: BeekeeperMcpClientConnection;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: BeekeeperMcpRuntimeOptions) {
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.now = options.now ?? Date.now;
  }

  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Beekeeper MCP Runtime is closed"));
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
    toolName: BeekeeperToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<BeekeeperToolResult> {
    await this.start();
    const client = this.client;
    if (!client) {
      throw new Error("Beekeeper MCP client is unavailable");
    }
    const startedAt = this.now();
    const timeout = AbortSignal.timeout(this.options.config.requestTimeoutMs);
    const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await client.callTool({ name: toolName, arguments: args }, callSignal);
      const result = parseToolResponse(response);
      if (response.isError) {
        throw new Error(typeof result === "string" ? result : JSON.stringify(result));
      }
      void this.appendMetric(taskRef, toolName, startedAt, { status: "succeeded" });
      return result as BeekeeperToolResult;
    } catch (error) {
      void this.appendMetric(taskRef, toolName, startedAt, {
        status: callSignal.aborted ? "timeout" : "failed",
        errorCode: "beekeeper_provider_error"
      });
      throw error instanceof Error ? error : new Error("Beekeeper MCP call failed");
    }
  }

  close(reason = "runtime_close"): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal(reason);
    }
    return this.closePromise;
  }

  private async startInternal(): Promise<void> {
    const connection = await this.clientFactory({
      command: this.options.config.pythonCommand,
      args: [this.options.config.entryPoint],
      env: beekeeperChildEnvironment(this.options.config, process.env),
      onStderr: (line) => this.recordStderr(line)
    });
    try {
      const listed = await connection.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_TOOLS].sort())) {
        throw new Error("Beekeeper MCP exposed an unexpected tool set");
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
      eventType: "beekeeper_mcp_closed",
      summary: "Beekeeper MCP Runtime closed",
      payload: { reason: this.redactDiagnostics(reason).slice(0, 512) }
    }).catch(() => undefined);
  }

  private recordStderr(line: string): void {
    const message = this.redactDiagnostics(line.replace(/[\r\n]+/g, " ")).slice(0, 2_048);
    if (!message) return;
    void this.options.executionLog.append({
      role: "runtime",
      eventType: "beekeeper_mcp_stderr",
      summary: "Beekeeper MCP child diagnostic",
      payload: { message }
    }).catch(() => undefined);
  }

  private redactDiagnostics(value: string): string {
    let redacted = value;
    if (this.options.config.databaseUrl) {
      redacted = redacted.split(this.options.config.databaseUrl).join("[REDACTED]");
      try {
        const parsed = new URL(this.options.config.databaseUrl);
        if (parsed.password) {
          const withoutPassword = new URL(parsed.toString());
          withoutPassword.password = "[REDACTED]";
          redacted = redacted.split(parsed.toString()).join(withoutPassword.toString());
        }
      } catch {}
    }
    return redacted;
  }

  private async appendMetric(
    taskRef: string,
    toolName: BeekeeperToolName,
    startedAt: number,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.options.executionLog.append({
      taskId: taskRef,
      role: "runtime",
      eventType: "beekeeper_mcp_call",
      summary: `Beekeeper MCP ${toolName}`,
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
}): Promise<BeekeeperMcpClientConnection> {
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
  const client = new Client({ name: "luanniao-beekeeper-runtime", version: "1.0.0" });
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
    throw new Error("Beekeeper MCP returned an invalid content envelope");
  }
  try {
    return JSON.parse(response.content[0].text);
  } catch {
    if (response.content[0].text) {
      return response.content[0].text;
    }
    throw new Error("Beekeeper MCP returned invalid JSON");
  }
}
