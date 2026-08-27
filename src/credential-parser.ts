export interface CredentialExtraction {
  kind: string;
  name: string;
  value: string;
  hostRef?: string;
}

export interface CredentialParserContext {
  hostRef?: string;
  scopeRef: string;
}

const COOKIE_PATTERN = /(?:^|[\r\n])\s*[Cc]ookie:\s*([^\r\n]+)/g;
const SET_COOKIE_PATTERN = /(?:^|[\r\n])\s*[Ss]et-[Cc]ookie:\s*([^\r\n]+)/g;
const AUTHORIZATION_PATTERN = /(?:^|[\r\n])\s*[Aa]uthorization:\s*(Bearer|Basic|Digest|NTLM)\s+([^\r\n]+)/g;
const JSON_TOKEN_PATTERN = /"(?:token|access_token|refresh_token|api_key|apikey|api_secret|secret|password|passwd)"\s*:\s*"([^"]{4,})"/g;
const SSH_PRIVATE_KEY_PATTERN = /-----BEGIN[\s\w]+PRIVATE KEY-----[\s\S]*?-----END[\s\w]+PRIVATE KEY-----/g;
const GENERIC_KEY_VALUE_PATTERN = /(?:api_key|apikey|access_token|secret_key|auth_token|bearer)\s*[=:]\s*["']?([A-Za-z0-9_\-./+=]{8,})["']?/gi;

export function extractCredentialsFromOutput(
  output: string,
  context: CredentialParserContext
): CredentialExtraction[] {
  const results: CredentialExtraction[] = [];
  const seen = new Set<string>();

  const addResult = (kind: string, name: string, value: string): void => {
    const dedupeKey = `${kind}:${name}:${value}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    results.push({
      kind,
      name,
      value,
      ...(context.hostRef ? { hostRef: context.hostRef } : {})
    });
  };

  extractCookies(output, addResult);
  extractSetCookies(output, addResult);
  extractAuthorization(output, addResult);
  extractJsonTokens(output, addResult);
  extractSshKeys(output, addResult);
  extractGenericKeyValues(output, addResult);

  return results;
}

function extractCookies(
  output: string,
  add: (kind: string, name: string, value: string) => void
): void {
  let match: RegExpExecArray | null;
  COOKIE_PATTERN.lastIndex = 0;
  while ((match = COOKIE_PATTERN.exec(output)) !== null) {
    const raw = match[1];
    for (const pair of raw.split(";")) {
      const trimmed = pair.trim();
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (name && value) add("cookie", name, value);
    }
  }
}

function extractSetCookies(
  output: string,
  add: (kind: string, name: string, value: string) => void
): void {
  let match: RegExpExecArray | null;
  SET_COOKIE_PATTERN.lastIndex = 0;
  while ((match = SET_COOKIE_PATTERN.exec(output)) !== null) {
    const raw = match[1];
    const semi = raw.indexOf(";");
    const nameValue = semi >= 0 ? raw.slice(0, semi) : raw;
    const eq = nameValue.indexOf("=");
    if (eq <= 0) continue;
    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1).trim();
    if (name && value) add("cookie", name, value);
  }
}

function extractAuthorization(
  output: string,
  add: (kind: string, name: string, value: string) => void
): void {
  let match: RegExpExecArray | null;
  AUTHORIZATION_PATTERN.lastIndex = 0;
  while ((match = AUTHORIZATION_PATTERN.exec(output)) !== null) {
    const scheme = match[1];
    const token = match[2].trim();
    if (token) add("token", scheme, token);
  }
}

function extractJsonTokens(
  output: string,
  add: (kind: string, name: string, value: string) => void
): void {
  let match: RegExpExecArray | null;
  JSON_TOKEN_PATTERN.lastIndex = 0;
  while ((match = JSON_TOKEN_PATTERN.exec(output)) !== null) {
    const fullMatch = match[0];
    const value = match[1];
    const nameMatch = /^"([^"]+)"/.exec(fullMatch);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    add("json_field", fieldName, value);
  }
}

function extractSshKeys(
  output: string,
  add: (kind: string, name: string, value: string) => void
): void {
  let match: RegExpExecArray | null;
  SSH_PRIVATE_KEY_PATTERN.lastIndex = 0;
  while ((match = SSH_PRIVATE_KEY_PATTERN.exec(output)) !== null) {
    const keyBlock = match[0];
    const headerMatch = /-----BEGIN\s+([\w\s]+)PRIVATE KEY-----/.exec(keyBlock);
    const keyType = headerMatch ? headerMatch[1].trim() : "SSH";
    add("private_key", `${keyType}_PRIVATE_KEY`, keyBlock);
  }
}

function extractGenericKeyValues(
  output: string,
  add: (kind: string, name: string, value: string) => void
): void {
  let match: RegExpExecArray | null;
  GENERIC_KEY_VALUE_PATTERN.lastIndex = 0;
  while ((match = GENERIC_KEY_VALUE_PATTERN.exec(output)) !== null) {
    const fullMatch = match[0];
    const value = match[1];
    const nameMatch = /^([A-Za-z0-9_]+)/.exec(fullMatch);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    add("env_or_config", fieldName, value);
  }
}
