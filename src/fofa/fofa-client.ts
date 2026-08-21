import type { FofaConfig } from "./fofa-config.js";
import { redactFofaSecret } from "./fofa-config.js";
import {
  FofaError,
  type FofaErrorCode,
  type FofaHostInput,
  type FofaNextInput,
  type FofaRawSearchResult,
  type FofaSearchInput,
  type FofaStatsInput
} from "./fofa-types.js";

type FofaClientDependencies = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

const RETRY_DELAYS_MS = [250, 500] as const;
const ACCOUNT_CAPABILITY_FIELDS = new Set([
  "fofa_point",
  "fcoin",
  "isvip",
  "vip_level",
  "remain_free_point",
  "remain_api_query",
  "remain_api_data",
  "search_api"
]);

export class FofaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    readonly config: FofaConfig,
    dependencies: FofaClientDependencies = {}
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.sleepImpl = dependencies.sleep ?? cancellableSleep;
  }

  async accountInfo(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const data = await this.request("/api/v1/info/my", new URLSearchParams(), signal);
    return Object.fromEntries(
      Object.entries(data).filter(([key]) => ACCOUNT_CAPABILITY_FIELDS.has(key))
    );
  }

  async search(input: FofaSearchInput, signal?: AbortSignal): Promise<FofaRawSearchResult> {
    const data = await this.request("/api/v1/search/all", searchParameters(input), signal);
    return parseSearchResult(data, input.fields.length);
  }

  async searchNext(input: FofaNextInput, signal?: AbortSignal): Promise<FofaRawSearchResult> {
    const parameters = searchParameters(input);
    parameters.set("next", input.next);
    const data = await this.request("/api/v1/search/next", parameters, signal);
    return parseSearchResult(data, input.fields.length);
  }

  async stats(input: FofaStatsInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const parameters = queryParameters(input.query, input.fields, input.size);
    return stripProviderControl(await this.request("/api/v1/search/stats", parameters, signal));
  }

  async hostAggregate(input: FofaHostInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const parameters = new URLSearchParams({ detail: String(input.detail) });
    const path = `/api/v1/host/${encodeURIComponent(input.host)}`;
    return stripProviderControl(await this.request(path, parameters, signal));
  }

  private async request(
    path: string,
    parameters: URLSearchParams,
    callerSignal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (callerSignal?.aborted) {
      throw sanitizedAbortReason(callerSignal.reason, this.config);
    }
    parameters.set("key", this.config.apiKey);
    if (this.config.email) {
      parameters.set("email", this.config.email);
    }
    const url = new URL(path, `${this.config.baseUrl}/`);
    url.search = parameters.toString();

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.requestAttempt(url, callerSignal);
      } catch (error) {
        if (callerSignal?.aborted) {
          throw sanitizedAbortReason(callerSignal.reason, this.config);
        }
        const normalized = this.normalizeError(error);
        if (!normalized.retryable || attempt === RETRY_DELAYS_MS.length) {
          throw normalized;
        }
        try {
          await this.sleepImpl(RETRY_DELAYS_MS[attempt], callerSignal);
        } catch (sleepError) {
          if (callerSignal?.aborted) {
            throw sanitizedAbortReason(callerSignal.reason, this.config);
          }
          throw this.normalizeError(sleepError);
        }
        if (callerSignal?.aborted) {
          throw sanitizedAbortReason(callerSignal.reason, this.config);
        }
      }
    }
    throw this.error("fofa_provider_error", "FOFA request failed", true);
  }

  private async requestAttempt(url: URL, callerSignal?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new DOMException("FOFA request timed out", "TimeoutError")),
      this.config.requestTimeoutMs
    );

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        throw this.error("fofa_auth_failed", "FOFA authentication failed");
      }
      if (response.status === 429) {
        throw this.error("fofa_rate_limited", "FOFA rate limit reached", true);
      }
      if (response.status >= 500) {
        throw this.error("fofa_provider_error", `FOFA service returned HTTP ${response.status}`, true);
      }
      if (!response.ok) {
        throw this.error("fofa_provider_error", `FOFA service returned HTTP ${response.status}`);
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw this.error("fofa_response_invalid", "FOFA returned invalid JSON");
      }
      if (!isRecord(value)) {
        throw this.error("fofa_response_invalid", "FOFA returned a non-object response");
      }
      if (value.error === true) {
        throw this.providerError(typeof value.errmsg === "string" ? value.errmsg : "FOFA rejected the request");
      }
      return value;
    } catch (error) {
      if (callerSignal?.aborted) {
        throw sanitizedAbortReason(callerSignal.reason, this.config);
      }
      if (controller.signal.aborted) {
        throw this.error("fofa_timeout", "FOFA request timed out", true);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private providerError(message: string): FofaError {
    const normalized = message.toLowerCase();
    if (/auth|invalid.{0,20}(?:key|email)|(?:key|email).{0,20}invalid|认证|密钥/.test(normalized)) {
      return this.error("fofa_auth_failed", message);
    }
    if (/f-?points?|fpoints?|not enough.{0,20}point|insufficient.{0,20}point|点数|积分/.test(normalized)) {
      return this.error("fofa_points_insufficient", message);
    }
    if (/vip|privilege|permission|\bplan\b|套餐|权限|会员/.test(normalized)) {
      return this.error("fofa_plan_unsupported", message);
    }
    return this.error("fofa_provider_error", message);
  }

  private normalizeError(error: unknown): FofaError {
    if (error instanceof FofaError) {
      return this.error(error.code, error.message, error.retryable);
    }
    return this.error(
      "fofa_provider_error",
      error instanceof Error ? error.message : "FOFA request failed"
    );
  }

  private error(code: FofaErrorCode, message: string, retryable = false): FofaError {
    return new FofaError(code, redactFofaSecret(message, this.config), retryable);
  }
}

function queryParameters(query: string, fields: string[], size: number): URLSearchParams {
  return new URLSearchParams({
    qbase64: Buffer.from(query, "utf8").toString("base64"),
    fields: fields.join(","),
    size: String(size)
  });
}

function searchParameters(input: FofaSearchInput): URLSearchParams {
  const parameters = queryParameters(input.query, input.fields, input.size);
  parameters.set("full", String(input.full));
  return parameters;
}

function parseSearchResult(data: Record<string, unknown>, fieldCount: number): FofaRawSearchResult {
  if (!Array.isArray(data.results)) {
    throw new FofaError("fofa_response_invalid", "FOFA search response has no result rows");
  }
  const results: FofaRawSearchResult["results"] = [];
  for (const row of data.results) {
    if (!Array.isArray(row) || row.length !== fieldCount || !row.every(isFofaScalar)) {
      throw new FofaError("fofa_response_invalid", "FOFA search result row does not match requested fields");
    }
    results.push(row);
  }
  const size = optionalFiniteNumber(data.size) ?? results.length;
  const total = optionalFiniteNumber(data.total);
  const next = typeof data.next === "string" && data.next ? data.next : undefined;
  const consumedFpoints = optionalFiniteNumber(data.consumed_fpoint ?? data.consumed_fpoints);
  return { results, size, total, next, consumedFpoints };
}

function stripProviderControl(data: Record<string, unknown>): Record<string, unknown> {
  const { error: _error, errmsg: _errmsg, key: _key, email: _email, ...result } = data;
  return result;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFofaScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cancellableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function sanitizedAbortReason(reason: unknown, config: FofaConfig): Error {
  const message = redactFofaSecret(reason instanceof Error ? reason.message : String(reason ?? "cancelled"), config);
  if (reason instanceof DOMException) {
    return new DOMException(message, reason.name);
  }
  const error = new Error(message);
  error.name = reason instanceof Error ? reason.name : "AbortError";
  return error;
}
