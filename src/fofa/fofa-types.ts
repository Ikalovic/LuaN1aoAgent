import type { AuthorizedScope } from "../scope.js";

export type FofaErrorCode =
  | "fofa_not_configured"
  | "fofa_scope_rejected"
  | "fofa_query_invalid"
  | "fofa_quota_exhausted"
  | "fofa_auth_failed"
  | "fofa_points_insufficient"
  | "fofa_plan_unsupported"
  | "fofa_rate_limited"
  | "fofa_timeout"
  | "fofa_provider_error"
  | "fofa_response_invalid"
  | "fofa_mcp_unavailable";

export class FofaError extends Error {
  constructor(
    readonly code: FofaErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "FofaError";
  }
}

export type FofaClassification = "in_scope" | "candidate_only";

export type FofaToolName =
  | "fofa_account_info"
  | "fofa_search"
  | "fofa_search_next"
  | "fofa_stats"
  | "fofa_host_aggregate";

export const FOFA_FIELDS = [
  "ip", "port", "protocol", "country", "country_name", "region", "city",
  "longitude", "latitude", "as_number", "as_organization", "host", "domain",
  "os", "server", "icp", "title", "jarm", "header", "banner", "base_protocol",
  "link", "certs_issuer_org", "certs_issuer_cn", "certs_subject_org",
  "certs_subject_cn", "tls_ja3s", "tls_version", "product", "product_category",
  "version", "lastupdatetime", "cname", "icon_hash", "certs_valid",
  "cname_domain", "body", "icon", "fid", "structinfo"
] as const;

export type FofaRecord = {
  fields: Record<string, string | number | boolean | null>;
  classification: FofaClassification;
  active_testing_allowed: boolean;
};

export type FofaTrustedContext = {
  runRef: string;
  taskRef: string;
  scope: AuthorizedScope;
  scopeFingerprint: string;
  derivedRefs: string[];
};

export type FofaOperationResult = {
  operation: "account_info" | "search" | "search_next" | "stats" | "host_aggregate";
  query?: string;
  fields?: string[];
  records?: FofaRecord[];
  data?: Record<string, unknown>;
  returned: number;
  total?: number;
  consumedFpoints?: number;
  nextProviderToken?: string;
};

export type FofaSearchInput = {
  query: string;
  fields: string[];
  size: number;
  full: boolean;
};

export type FofaNextInput = FofaSearchInput & { next: string };
export type FofaStatsInput = { query: string; fields: string[]; size: number };
export type FofaHostInput = { host: string; detail: boolean };

export type FofaRawSearchResult = {
  results: Array<Array<string | number | boolean | null>>;
  size: number;
  total?: number;
  next?: string;
  consumedFpoints?: number;
};
