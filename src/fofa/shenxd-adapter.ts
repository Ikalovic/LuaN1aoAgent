import type { FofaConfig } from "./fofa-config.js";
import { FofaError, type FofaSearchInput, type FofaToolName } from "./fofa-types.js";

export type ShenxdSearchRequest = {
  endpoint: string;
  parameters: URLSearchParams;
};

export function buildShenxdSearchRequest(
  config: FofaConfig,
  input: FofaSearchInput
): ShenxdSearchRequest {
  return {
    endpoint: config.baseUrl,
    parameters: new URLSearchParams({
      qbase64: Buffer.from(input.query, "utf8").toString("base64"),
      fields: input.fields.join(","),
      size: String(input.size),
      full: String(input.full)
    })
  };
}

export function assertFofaProviderSupportsTool(
  config: Pick<FofaConfig, "provider">,
  toolName: FofaToolName
): void {
  if (config.provider === "shenxd" && toolName !== "fofa_search") {
    throw new FofaError(
      "fofa_plan_unsupported",
      `FOFA provider shenxd does not support ${toolName}`
    );
  }
}
