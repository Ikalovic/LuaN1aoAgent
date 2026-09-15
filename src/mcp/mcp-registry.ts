import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadBeekeeperConfig } from "../beekeeper/beekeeper-config.js";
import { loadFofaConfig } from "../fofa/fofa-config.js";
import { EXPECTED_BEEKEEPER_TOOLS } from "./beekeeper-runtime.js";
import { EXPECTED_CREDENTIAL_TOOLS } from "./credential-runtime.js";
import { EXPECTED_FOFA_TOOLS } from "./fofa-runtime.js";

export type RegisteredMcpServer = {
  name: string;
  description: string;
  tools: string[];
  configured: boolean;
  enabled: boolean;
};

export type McpRegistryDiagnostic = {
  code: string;
  message: string;
  serverName?: string;
};

export type McpRegistrySnapshot = {
  scannedAt: string;
  servers: RegisteredMcpServer[];
  diagnostics: McpRegistryDiagnostic[];
};

export type McpRegistryOptions = {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  statePath?: string;
};

const EPOCH = new Date(0).toISOString();

export class McpRegistry {
  private current: McpRegistrySnapshot = { scannedAt: EPOCH, servers: [], diagnostics: [] };
  private readonly cwd: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly statePath: string;

  constructor(options: McpRegistryOptions) {
    this.cwd = options.cwd;
    this.environment = options.environment ?? process.env;
    this.statePath = options.statePath ?? join(options.cwd, ".agents", "mcp-state.json");
  }

  scan(): McpRegistrySnapshot {
    const enabledState = this.readState();
    const diagnostics: McpRegistryDiagnostic[] = [];
    const fofaConfigured = this.detectConfigured(
      "fofa",
      () => loadFofaConfig(this.environment),
      "FOFA MCP requires FOFA_API_KEY.",
      diagnostics
    );
    const beekeeperConfigured = this.detectConfigured(
      "beekeeper",
      () => loadBeekeeperConfig(this.environment, this.cwd),
      "Beekeeper MCP requires BEEKEEPER_MCP_ENABLED=1.",
      diagnostics
    );
    const servers: RegisteredMcpServer[] = [
      {
        name: "credential",
        description: "Built-in credential store over the encrypted artifact database.",
        tools: [...EXPECTED_CREDENTIAL_TOOLS].sort(),
        configured: true,
        enabled: enabledState.credential !== false
      },
      {
        name: "fofa",
        description: "FOFA attack-surface search with scope-aware query quotas.",
        tools: [...EXPECTED_FOFA_TOOLS].sort(),
        configured: fofaConfigured,
        enabled: enabledState.fofa !== false
      },
      {
        name: "beekeeper",
        description: "Beekeeper external credential database lookup.",
        tools: [...EXPECTED_BEEKEEPER_TOOLS].sort(),
        configured: beekeeperConfigured,
        enabled: enabledState.beekeeper !== false
      }
    ];
    this.current = { scannedAt: new Date().toISOString(), servers, diagnostics };
    return this.current;
  }

  snapshot(): McpRegistrySnapshot {
    return this.current.scannedAt === EPOCH ? this.scan() : this.current;
  }

  setEnabled(name: string, enabled: boolean): void {
    const snapshot = this.scan();
    if (!snapshot.servers.some((server) => server.name === name)) throw new Error(`Unknown MCP server: ${name}`);
    const state = this.readState();
    state[name] = enabled;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.statePath);
    this.scan();
  }

  isEnabled(name: string): boolean {
    return this.readState()[name] !== false;
  }

  private detectConfigured(
    name: string,
    load: () => unknown,
    missingMessage: string,
    diagnostics: McpRegistryDiagnostic[]
  ): boolean {
    try {
      if (load() !== undefined) return true;
      diagnostics.push({ code: "mcp_not_configured", message: missingMessage, serverName: name });
      return false;
    } catch (error) {
      diagnostics.push({
        code: "mcp_configuration_invalid",
        message: error instanceof Error ? error.message : String(error),
        serverName: name
      });
      return false;
    }
  }

  private readState(): Record<string, boolean> {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
        : {};
    } catch {
      return {};
    }
  }
}
