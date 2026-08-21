export type FofaConfig = {
  apiKey: string;
  email?: string;
  baseUrl: string;
  maxResultsPerCall: number;
  maxResultsPerTask: number;
  maxAggregationsPerTask: number;
  requestTimeoutMs: number;
};

const DEFAULT_BASE_URL = "https://fofa.info";
const DEFAULT_MAX_RESULTS_PER_CALL = 100;
const DEFAULT_MAX_RESULTS_PER_TASK = 1_000;
const DEFAULT_MAX_AGGREGATIONS_PER_TASK = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function loadFofaConfig(env: NodeJS.ProcessEnv): FofaConfig | undefined {
  const apiKey = env.FOFA_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  const baseUrl = normalizeBaseUrl(env.FOFA_BASE_URL, env.NODE_ENV);
  const maxResultsPerTask = positiveInteger(
    env.FOFA_MAX_RESULTS_PER_TASK,
    DEFAULT_MAX_RESULTS_PER_TASK
  );
  const requestedPerCall = positiveInteger(
    env.FOFA_MAX_RESULTS_PER_CALL,
    DEFAULT_MAX_RESULTS_PER_CALL
  );

  return {
    apiKey,
    email: env.FOFA_EMAIL?.trim() || undefined,
    baseUrl,
    maxResultsPerCall: Math.min(requestedPerCall, maxResultsPerTask),
    maxResultsPerTask,
    maxAggregationsPerTask: positiveInteger(
      env.FOFA_MAX_AGGREGATIONS_PER_TASK,
      DEFAULT_MAX_AGGREGATIONS_PER_TASK
    ),
    requestTimeoutMs: positiveInteger(env.FOFA_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
  };
}

export function fofaChildEnvironment(
  config: FofaConfig,
  host: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "NODE_ENV"] as const) {
    if (host[key] !== undefined) {
      child[key] = host[key];
    }
  }

  child.FOFA_API_KEY = config.apiKey;
  if (config.email) {
    child.FOFA_EMAIL = config.email;
  }
  child.FOFA_BASE_URL = config.baseUrl;
  child.FOFA_MAX_RESULTS_PER_CALL = String(config.maxResultsPerCall);
  child.FOFA_MAX_RESULTS_PER_TASK = String(config.maxResultsPerTask);
  child.FOFA_MAX_AGGREGATIONS_PER_TASK = String(config.maxAggregationsPerTask);
  child.FOFA_REQUEST_TIMEOUT_MS = String(config.requestTimeoutMs);
  return child;
}

export function redactFofaSecret(
  value: string,
  config: Pick<FofaConfig, "apiKey" | "email">
): string {
  let redacted = value.replace(/([?&](?:key|email)=)[^&#\s]*/gi, "$1[REDACTED]");
  const secrets = [config.apiKey, config.email]
    .filter((secret): secret is string => Boolean(secret))
    .flatMap((secret) => [secret, encodeURIComponent(secret)])
    .sort((left, right) => right.length - left.length);
  for (const secret of new Set(secrets)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "gi"), "[REDACTED]");
  }
  return redacted;
}

function normalizeBaseUrl(value: string | undefined, nodeEnv: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value?.trim() || DEFAULT_BASE_URL);
  } catch {
    throw new Error("FOFA_BASE_URL must be a valid HTTPS URL");
  }
  const testLoopback = nodeEnv === "test" && url.protocol === "http:" && isLoopback(url.hostname);
  if (url.protocol !== "https:" && !testLoopback) {
    throw new Error("FOFA_BASE_URL must use HTTPS except for test loopback URLs");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("FOFA_BASE_URL must not contain credentials, query parameters, or fragments");
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
