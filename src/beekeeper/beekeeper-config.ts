import { isAbsolute, resolve } from "node:path";

export type BeekeeperConfig = {
  root: string;
  pythonCommand: string;
  entryPoint: string;
  databaseUrl?: string;
  maxPageSize: number;
  requestTimeoutMs: number;
};

const DEFAULT_ROOT = "vendor/Beekeeper";
const DEFAULT_MAX_PAGE_SIZE = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function loadBeekeeperConfig(
  env: NodeJS.ProcessEnv,
  cwd: string
): BeekeeperConfig | undefined {
  if (env.BEEKEEPER_MCP_ENABLED !== "1") {
    return undefined;
  }

  const root = absolutePath(
    env.BEEKEEPER_ROOT?.trim() || resolve(cwd, DEFAULT_ROOT),
    "BEEKEEPER_ROOT"
  );
  const pythonCommand = absolutePath(
    env.BEEKEEPER_MCP_PYTHON?.trim() || resolve(cwd, ".beekeeper-mcp-venv/bin/python"),
    "BEEKEEPER_MCP_PYTHON"
  );
  const entryPoint = absolutePath(
    env.BEEKEEPER_MCP_ENTRYPOINT?.trim() || resolve(cwd, "scripts/beekeeper-mcp-adapter.py"),
    "BEEKEEPER_MCP_ENTRYPOINT"
  );
  const databaseUrl = env.BEEKEEPER_DATABASE_URL?.trim() || undefined;

  return {
    root,
    pythonCommand,
    entryPoint,
    databaseUrl,
    maxPageSize: positiveInteger(env.BEEKEEPER_MCP_MAX_PAGE_SIZE, DEFAULT_MAX_PAGE_SIZE),
    requestTimeoutMs: positiveInteger(env.BEEKEEPER_MCP_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
  };
}

export function beekeeperChildEnvironment(
  config: BeekeeperConfig,
  host: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "NODE_ENV"] as const) {
    if (host[key] !== undefined) {
      child[key] = host[key];
    }
  }

  child.BEEKEEPER_ROOT = config.root;
  child.PYTHONPATH = config.root;
  child.BEEKEEPER_MCP_MAX_PAGE_SIZE = String(config.maxPageSize);
  child.BEEKEEPER_MCP_TIMEOUT_MS = String(config.requestTimeoutMs);
  if (config.databaseUrl) {
    child.BEEKEEPER_DATABASE_URL = config.databaseUrl;
  }
  return child;
}

function absolutePath(value: string, name: string): string {
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
