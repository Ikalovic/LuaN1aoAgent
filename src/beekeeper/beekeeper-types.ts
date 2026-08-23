export type BeekeeperToolName =
  | "query_credentials"
  | "store_credential"
  | "mark_credential_invalid";

export type BeekeeperCredential = {
  id: number;
  domain: string;
  account: string;
  password: string;
  source: string;
  is_valid: boolean;
  created_at: string | null;
};

export type BeekeeperCredentialQueryResult = {
  domain: string | null;
  include_invalid: boolean;
  limit: number;
  total_returned: number;
  has_more: boolean;
  next_cursor: string | null;
  items: BeekeeperCredential[];
};

export type BeekeeperToolResult =
  | BeekeeperCredentialQueryResult
  | {
    status: "created" | "already_exists";
    credential_id: number;
    domain: string;
    is_valid: boolean;
  }
  | {
    status: "invalidated" | "already_invalid" | "not_found";
    credential_id: number;
    is_valid?: boolean;
    reason?: string | null;
  };
