# Recon / Internet-Information-Gathering Capability Inventory — LuaN1aoAgent

Read-only inventory. No file in the repo was modified. All line numbers are from the working tree at
`/home/kuri/Codes/LuaN1aoAgent` (`src/**` TypeScript, `network-image/**` Python/Go, `templates/**`).

---

## 1. SCOPE MODEL

### 1.1 Where scope lives

| File | Lines | Role |
|---|---|---|
| `src/scope.ts` | 204 | The entire matching/normalisation kernel. |
| `src/scope-documents/scope-document-types.ts` | 37 | `ScopeTextFragment`, `ScopeCandidate`, `ParsedScopeDocument`. |
| `src/scope-documents/scope-document-formats.ts` | 339 | Office/PDF/CSV/JSON text extraction + hard limits. |
| `src/scope-documents/scope-candidate-extractor.ts` | 67 | Rule-based domain/CIDR regex extraction. |
| `src/scope-documents/scope-document-resolver.ts` | 157 | LLM-assisted candidate extraction + grounding validation. |
| `src/scope-documents/scope-document-service.ts` | 82 | parse/confirm orchestration, persistence. |
| `src/scope-documents/scope-document-store.ts` | 64 | Filesystem store, UUID + path-escape guards. |
| `src/cli-scope-documents.ts` | 32 | CLI entry: merges document scopes + `--scope`. |

### 1.2 The authorised scope representation

`src/scope.ts:11-19`

```ts
export type AuthorizedScope = {
  cidrs: string[];
  domains: string[];
};

export type NormalizedScopeEntry = {
  kind: "cidr" | "domain";
  value: string;
};
```

Exactly two kinds. There is **no** third bucket for ports, URLs, organisations, ASNs, certificate
identities, or emails. `ScopeResolution` (`src/scope.ts:7-9`) is a CIDR-only legacy shape.

There is also a single sentinel for the CTF case, `src/scope.ts:5`:

```ts
export const UNRESTRICTED_CTF_SCOPE = "0.0.0.0/0";
```

and `defaultScopeForTask` (`src/scope.ts:21-23`) returns it only for `taskType === "ctf"`.

### 1.3 `parseAuthorizedScope` — exact semantics

`src/scope.ts:68-87`:

```ts
export function parseAuthorizedScope(values: string | string[]): AuthorizedScope {
  const parts = Array.isArray(values) ? values : values.split(/[\s,，;；]+/u);
  const cidrs: string[] = [];
  const domains: string[] = [];
  for (const raw of parts.map((value) => value.trim()).filter(Boolean)) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(raw)) {
      cidrs.push(normalizeIpv4Cidr(raw));
    } else {
      domains.push(normalizeDomainPattern(raw));
    }
  }
  const normalized = {
    cidrs: [...new Set(cidrs)].sort(compareCidrs),
    domains: [...new Set(domains)].sort()
  };
  if (normalized.cidrs.length === 0 && normalized.domains.length === 0) {
    throw new Error("Authorized scope must contain at least one IPv4 address, CIDR, or domain");
  }
  return normalized;
}
```

Key facts:
- Accepts `string | string[]`. A bare string is split on whitespace, `,`, full-width `，`, `;`, `；` (note: **newlines are whitespace, so multi-line scope strings work**).
- Classification is a bare-IPv4 regex test; **everything that is not IPv4/CIDR is treated as a domain** and then validated by `normalizeDomainPattern`.
- Deduped + sorted (CIDRs numerically, domains lexicographically) so the result is canonical — this matters because FOFA fingerprints the scope (see §2.3).
- Throws if both lists end up empty. It is a *fail-closed* parser used at CLI, controller, and gateway boundaries (`src/controller.ts:840`, `:3350`, `src/connectivity/network-sandbox-manager.ts:403`).

`normalizeScope` (`src/scope.ts:55-58`) flattens back to a comma-joined string: `[...cidrs, ...domains].join(",")`.

`normalizeScopeEntry` (`src/scope.ts:60-66`) is the single-entry variant used by document extraction and by the AI candidate validator.

### 1.4 Domain matching — **suffix match, plus one wildcard form**

This is the function you asked for verbatim, `src/scope.ts:25-36`:

```ts
export function authorizedScopeContainsDomain(scope: AuthorizedScope, input: string): boolean {
  const candidate = normalizeDomainCandidate(input);
  if (!candidate) {
    return false;
  }
  return scope.domains.some((pattern) => {
    if (pattern.startsWith("*.")) {
      return candidate.endsWith(`.${pattern.slice(2)}`);
    }
    return candidate === pattern || candidate.endsWith(`.${pattern}`);
  });
}
```

Semantics, precisely:

| Scope entry | Candidate `example.com` | Candidate `a.example.com` | Candidate `x.a.example.com` | Candidate `notexample.com` | Candidate `example.com.evil.tld` |
|---|---|---|---|---|---|
| `example.com` | ✅ exact | ✅ suffix | ✅ suffix | ❌ | ❌ |
| `*.example.com` | ❌ (root excluded) | ✅ | ✅ | ❌ | ❌ |

So: a plain entry grants the apex **and all subdomains at any depth**; a `*.` entry grants subdomains **but not the apex**. Both are anchored at a `.` boundary, so suffix-confusion (`notexample.com`) is not matched.

Normalisation of the *pattern*, `src/scope.ts:102-117`: strips a leading `*.` (remembered as a flag), strips one trailing dot, lowercases, rejects if the remainder is empty / contains `*`, `:`, `/`; applies `domainToASCII` (IDN/punycode); requires length ≤ 253 **and at least one dot** (so a bare `localhost` or `intranet` is rejected as a scope entry); validates each label against `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`; rejects an all-numeric TLD. Returns `` `*.${domain}` `` when the wildcard flag was set.

Normalisation of the *candidate*, `src/scope.ts:119-133`: same validation but **returns `undefined` instead of throwing**, and additionally rejects anything containing whitespace. So a malformed candidate simply fails to match rather than raising.

Consequence for a recon agent: `authorizedScopeContainsDomain` returns `false` (never throws) for input like `1.2.3.4` — the last label is numeric — so callers must route IPs through `authorizedScopeContainsIp` separately. Nothing in the codebase does "domain → resolve → check resulting IP against CIDRs"; see §3.6 and §10.

### 1.5 CIDR matching

`src/scope.ts:38-53`:

```ts
export function authorizedScopeContainsIp(scope: AuthorizedScope, input: string): boolean {
  const candidate = parseIpv4Number(input);
  if (candidate === undefined) {
    return false;
  }
  return scope.cidrs.some((cidr) => {
    const [networkInput, prefixInput] = cidr.split("/");
    const network = parseIpv4Number(networkInput);
    const prefixLength = Number(prefixInput);
    if (network === undefined || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
      return false;
    }
    const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    return ((candidate & mask) >>> 0) === ((network & mask) >>> 0);
  });
}
```

- IPv4 only. `parseIpv4Number` (`src/scope.ts:194-204`) requires exactly 4 parts of 1–3 digits each, each ≤ 255, and rejects anything else (so IPv6 and hostnames return `undefined` → no match).
- A bare address is stored as `/32` by `normalizeIpv4Cidr` (`src/scope.ts:159-181`), which also **masks the address to the network** (`network = address & mask`) — so `10.0.0.5/24` is stored canonically as `10.0.0.0/24`.
- Prefix must be 0–32 or the entry is skipped (never throws).
- `0.0.0.0/0` matches everything, which is what `UNRESTRICTED_CTF_SCOPE` relies on.

### 1.6 Scope documents

`resolveCliScopeDocuments` (`src/cli-scope-documents.ts:9-32`) reads each file, parses it via `ScopeDocumentService`, then emits
`normalizeScope([...document.normalizedScope, ...(manualScope ? [manualScope] : [])])`. Documents and manual scope are unioned, then re-canonicalised.

`ScopeDocumentService.parse` (`src/scope-documents/scope-document-service.ts:22-55`) runs **two independent extractors and merges them**:
1. rule-based `extractScopeCandidates` (`scope-candidate-extractor.ts:12-28`), regexes at `:4-5`
2. optional AI resolver, whose output is filtered by `kind` and merged via `mergeCandidates` (`:76-82`)

then throws `no_scope_candidates` if both are empty (`:42-44`), and persists source+result+fragments (`:53`).

The AI path is **grounded by construction** — `validateAiScopeCandidates` (`scope-document-resolver.ts:107-152`) requires the model to return a `fragmentIndex`, re-runs the rule extractor on that fragment, and rejects the candidate as `ai_candidate_not_grounded` unless the normalised value literally appears in that fragment (`:129-137`). A separate CLI guard, `normalizeInferredScopeCidrs` (`src/scope.ts:135-149`), refuses any AI/auto-inferred CIDR that is not literally present in `--goal`:

```ts
throw new Error(`AI-inferred scope ${cidr} is not explicitly present in --goal`);
```

Limits (`scope-document-formats.ts:6-14`): 5 MiB input, 20 MiB expanded, 10 000 fragments, 2 MiB text, JSON depth 32 / 20 000 nodes, 500 PDF pages. Supported extensions: `.txt .md .csv .json .docx .xlsx .pdf` (`:29-51`).

The `DOMAIN` regex at `scope-candidate-extractor.ts:5` **already recognises a leading `*.`**, so a wildcard scope entry can be extracted from a document; `isUrlOrEmailContext` (`:57-62`) discards matches preceded by `@` or `http(s)://` or followed by `/`.

### 1.7 Derived / discovered assets — the answer is **no separate class exists**

Grepping `derivedRefs`, `classify`, `out_of_scope` across `src/**` gives a very short list:

- `derivedRefs` appears only in the FOFA path: `fofa-types.ts:58`, `fofa-scope-policy.ts:30,32,38,59,63`, `fofa-server.ts:30,80,92,104,119`, `mcp/fofa-runtime.ts:326`, `mcp/credential-runtime.ts:40`, `mcp/credential-server.ts:16`, `src/controller.ts:3211`.
- `classify` (scope sense) exists **only** as `FofaScopePolicy.classify` (`fofa-scope-policy.ts:44`).
- There is **no `out_of_scope` string anywhere in the repo.**

The two-level model is therefore:

| Level | Type | Carried by | Effect |
|---|---|---|---|
| `in_scope` | `FofaClassification` | `fofa-types.ts:28` | `active_testing_allowed: true` |
| `candidate_only` | `FofaClassification` | `fofa-types.ts:28` | `active_testing_allowed: false`, `validationStatus: "pending"` in the graph |

And it is enforced **only for FOFA-sourced records**. The classification function itself, `fofa-scope-policy.ts:111-115`:

```ts
function classification(inScope: boolean): Pick<FofaRecord, "classification" | "active_testing_allowed"> {
  return inScope
    ? { classification: "in_scope", active_testing_allowed: true }
    : { classification: "candidate_only", active_testing_allowed: false };
}
```

`derivedRefs` is the escape hatch: an opaque per-run set of previously-trusted identities that a FOFA query or `fofa_host_aggregate` call may anchor on **without** the identity being in `AuthorizedScope`. In the current runtime it is **always constructed empty** — `mcp/fofa-runtime.ts:320-328` returns `derivedRefs: []`, and `src/controller.ts:3211` does the same for credentials. The MCP schema allows up to 128 entries (`fofa-server.ts:30`) and the policy honours them (`fofa-scope-policy.ts:38,63`), but nothing in the shipped runtime ever populates them. (The FOFA test suite exercises the policy with a non-empty set — `test/fofa-scope-policy.test.ts`, "accepts trusted opaque derived references but not free-form identities" — so the capability is tested but unwired.)

Everything a recon agent *discovers* that is not literally in `AuthorizedScope` is therefore represented in the graph, not in the scope object: `fofa-topology.ts:24-26` tags candidate hosts with `classification: "candidate_only"`, `validationStatus: "pending"`, `active_testing_allowed: false`, and draws a `candidate_for` edge back to the anchor; `:46-51` does the same for CNAME aliases (`has_alias`). `WebEndpoint` nodes inherit the same flags (`:42`).

---

## 2. FOFA INTEGRATION

### 2.1 File-by-file

| File | Lines | Purpose |
|---|---|---|
| `src/fofa/fofa-types.ts` | 90 | Error codes, `FOFA_FIELDS`, `FofaRecord`, trusted context, I/O shapes. |
| `src/fofa/fofa-config.ts` | 154 | Env parsing, defaults, clamps, child-env allowlist, secret redaction. |
| `src/fofa/fofa-query.ts` | 247 | Hand-written tokenizer + recursive-descent parser for the FOFA query language, plus OR-branch distribution. |
| `src/fofa/fofa-scope-policy.ts` | 122 | Query/host authorisation + result classification + scope fingerprint. |
| `src/fofa/fofa-client.ts` | 282 | HTTP client for the 5 official endpoints, retry/backoff, error-code mapping. |
| `src/fofa/shenxd-adapter.ts` | 34 | Alternate provider request shape + per-tool provider capability gate. |
| `src/fofa/fofa-topology.ts` | 59 | `FofaRecord[]` → graph nodes/edges. |
| `src/mcp/fofa-server.ts` | 214 | stdio MCP server (child process) that owns the API key and the policy. |
| `src/mcp/fofa-runtime.ts` | 523 | Parent-side MCP client, cursors, **quota enforcement**, restart policy. |
| `src/tools/fofa-mcp-tools.ts` | 168 | The 5 Pi tools the Executor actually sees; artifact + topology + byte-bounded summary. |

### 2.2 `fofa-scope-policy.ts` — how a query is proven scope-anchored

The anchor field allowlist, `fofa-scope-policy.ts:10-17`:

```ts
const ANCHOR_FIELDS = new Set([
  "ip",
  "host",
  "domain",
  "cert",
  "certs_subject_cn",
  "cname_domain"
]);
```

Note `cert` and `certs_subject_cn` **are** anchors (certificate-derived pivoting is explicitly authorised-by-anchor), whereas `icp` is not (the test "recognizes URL and certificate anchors but not ICP associations" pins this).

Branch validation, `fofa-scope-policy.ts:30-35`:

```ts
  validateQuery(query: string, derivedRefs: ReadonlySet<string> = new Set()): void {
    const branches = disjunctiveBranches(parseFofaQuery(query));
    if (branches.some((branch) => !branch.some((node) => this.isAuthorizedAnchor(node, derivedRefs)))) {
      throw scopeRejected();
    }
  }
```

The rule is per **OR branch**: the query is distributed into disjunctive normal form by `disjunctiveBranches` (`fofa-query.ts:38-55`), and *every* branch must contain at least one positive authorised equality. This defeats the classic widening `domain="in-scope.com" || domain="anything-else.com"`.

`isAuthorizedAnchor`, `fofa-scope-policy.ts:59-64`:

```ts
  private isAuthorizedAnchor(node: FofaQueryNode, derivedRefs: ReadonlySet<string>): boolean {
    if (node.kind !== "comparison" || !ANCHOR_FIELDS.has(node.field) || !isPositiveEquality(node)) {
      return false;
    }
    return derivedRefs.has(node.value) || this.identityIsAuthorized(node.value);
  }
```

with positivity defined by double negation, `:78-80`:

```ts
function isPositiveEquality(node: Extract<FofaQueryNode, { kind: "comparison" }>): boolean {
  return node.operator === "=" ? !node.negated : node.negated;
}
```

So `!=` and `not` are normalised such that only an effectively-affirming comparison counts. `identityIsAuthorized` (`:66-75`) parses the value (`parseIdentity`, `:82-103`: unwraps `http(s)://` URLs to their hostname, recognises bare IPv4, rejects values containing `:`/`/`/`@`, strips trailing dots) and dispatches to `authorizedScopeContainsIp` or `authorizedScopeContainsDomain` from §1.

`validateHost` (`:37-42`) is the same test for `fofa_host_aggregate`'s single host argument.

`fingerprint()` (`:22-28`) is a SHA-256 over the sorted `{cidrs, domains}` — this is what binds an MCP call to the run that created it, and what invalidates cursors if scope changes.

`classify()`, `fofa-scope-policy.ts:44-57` verbatim:

```ts
  classify(identity: { host?: string; domain?: string; ip?: string }):
    Pick<FofaRecord, "classification" | "active_testing_allowed"> {
    const namedIdentity = identity.host?.trim() || identity.domain?.trim();
    if (namedIdentity) {
      const normalized = parseIdentity(namedIdentity);
      const allowed = normalized?.kind === "domain"
        ? authorizedScopeContainsDomain(this.scope, normalized.value)
        : normalized?.kind === "ip"
          ? authorizedScopeContainsIp(this.scope, normalized.value)
          : false;
      return classification(allowed);
    }
    return classification(Boolean(identity.ip && authorizedScopeContainsIp(this.scope, identity.ip)));
  }
```

Two subtleties worth carrying into a design:
1. `host` **wins over** `domain` when both are present (short-circuit `||` on line 46). If a row's `host` field is a URL or a hostname that fails `parseIdentity`, the row is `candidate_only` even if `domain` would have matched.
2. When a named identity exists, `ip` is **never consulted**. So a row whose `host` is an out-of-scope vhost but whose `ip` is inside the authorised CIDR is labelled `candidate_only`, and vice versa a row whose `host` is in-scope is `in_scope` regardless of `ip`.

Rejection error, `:117-122`, is the single message `"FOFA request requires a positive authorized asset anchor in every OR branch"` under code `fofa_scope_rejected`.

Query parser limits (`fofa-query.ts:17-20`): 4 096 bytes, 512 tokens, 32 nesting levels; anything else is `fofa_query_invalid` with the message `"FOFA query contains unsupported or trailing syntax"`. The tokenizer accepts `!=`, `&&`, `||`, `=`, `!`, `(`, `)`, double-quoted strings with `\` escapes, and identifiers matching `[A-Za-z_][A-Za-z0-9_.-]*` (`:149-197`). **There is no `~=`/`*=` fuzzy operator**, which matters: FOFA's own wildcard syntax cannot be expressed.

### 2.3 `fofa-config.ts` — env vars, defaults, clamps

`loadFofaConfig(env)` (`:19-60`). **The integration is entirely disabled unless `FOFA_API_KEY` is set** (`:20-23` returns `undefined`).

| Env var | Required | Default | Validation |
|---|---|---|---|
| `FOFA_API_KEY` | **yes** (else feature off) | — | non-empty after trim |
| `FOFA_PROVIDER` | no | `official` | must be `official` or `shenxd`, else throw (`:104-110`) |
| `FOFA_API_BASE_URL` / `FOFA_BASE_URL` | only when `shenxd` | `https://fofa.info` (`:13`) | must parse as URL; must be `https:` unless test-loopback or opted-in shenxd HTTP |
| `FOFA_ALLOW_INSECURE_HTTP` | no | unset | `=== "1"` exactly (`:26`) |
| `FOFA_EMAIL` | no | `undefined` | trimmed |
| `FOFA_MAX_RESULTS_PER_CALL` | no | `100` (`:14`) | positive integer, else default; then `Math.min(requested, maxResultsPerTask)` (`:52`) |
| `FOFA_MAX_RESULTS_PER_TASK` | no | `1000` (`:15`) | positive integer, else default |
| `FOFA_MAX_AGGREGATIONS_PER_TASK` | no | `20` (`:16`) | positive integer, else default |
| `FOFA_REQUEST_TIMEOUT_MS` | no | `15000` (`:17`) | positive integer, else default |

`positiveInteger` (`:144-150`) silently falls back rather than throwing, and rejects non-`^\d+$` strings, non-safe integers, and `0`.

URL policy (`normalizeBaseUrl`, `:112-138`): rejects credentials, query strings and fragments outright; permits `http:` only when `NODE_ENV === "test"` **and** the host is loopback (`localhost`/`127.0.0.1`/`[::1]`, `:140-142`), or when `provider === "shenxd"` **and** `FOFA_ALLOW_INSECURE_HTTP=1`. The two failure messages are `"FOFA_ALLOW_INSECURE_HTTP=1 is required for a remote Shenxd HTTP endpoint"` and `"FOFA_API_BASE_URL must use HTTPS except for test loopback URLs"`.

`fofaChildEnvironment` (`:62-87`) is an **allowlist**, not a copy: it forwards only `PATH, SystemRoot, WINDIR, ComSpec, PATHEXT, NODE_ENV` from the host (`:67`) and then injects the FOFA vars explicitly. The API key therefore cannot leak into the MCP child via inheritance, and no unrelated host secrets reach the child.

`redactFofaSecret` (`:89-102`) scrubs `key=`/`email=` query params plus the raw **and** percent-encoded forms of the key and email, longest-first. It is applied on every error string (`fofa-client.ts:203`), on stderr from the child (`fofa-runtime.ts:382`), and on close reasons (`:377`).

### 2.4 `fofa-client.ts` — endpoints and behaviour

| Method | Line | Endpoint |
|---|---|---|
| `accountInfo` | `:43-48` | `GET /api/v1/info/my` |
| `search` | `:50-56` | `GET /api/v1/search/all` (official) — or the Shenxd base URL verbatim |
| `searchNext` | `:58-63` | `GET /api/v1/search/next` |
| `stats` | `:65-68` | `GET /api/v1/search/stats` |
| `hostAggregate` | `:70-74` | `GET /api/v1/host/{host}` |

Query encoding (`:207-219`): `qbase64` (base64 of the raw query), `fields` (comma-joined), `size`, plus `full` for search. `key` and (optional) `email` are appended in `request` (`:84-87`).

Retry (`:19`, `:91-114`): exactly two retries with delays `[250, 500]` ms, only for errors flagged `retryable`. Timeout is per attempt (`:122-125`) and maps to `fofa_timeout` retryable (`:168-170`). HTTP mapping: `401/403` → `fofa_auth_failed` (non-retryable), `429` → `fofa_rate_limited` (retryable), `≥500` → `fofa_provider_error` (retryable), invalid JSON/non-object → `fofa_response_invalid`.

`providerError` (`:178-190`) does regex-based classification of the provider's own `errmsg` into `fofa_auth_failed` / `fofa_points_insufficient` / `fofa_plan_unsupported` / `fofa_provider_error`, matching both English and Chinese terms (`点数`, `积分`, `套餐`, `权限`, `会员`, `认证`, `密钥`, `无效`, `已过期`).

`parseSearchResult` (`:221-237`) is strict: every row must be an array whose length **equals** the requested field count and whose cells are all scalars, else `fofa_response_invalid` — a defence against provider field reordering. It reads `consumed_fpoint` **or** `consumed_fpoints` (`:235`). `stripProviderControl` (`:239-242`) removes `error`, `errmsg`, `key`, `email` from stats/host payloads.

`accountInfo` filters the response through `ACCOUNT_CAPABILITY_FIELDS` (`:20-29`) — only `fofa_point, fcoin, isvip, vip_level, remain_free_point, remain_api_query, remain_api_data, search_api` survive, so raw account data never reaches the model.

### 2.5 `shenxd-adapter.ts` — what it is for

Shenxd is a **third-party FOFA reseller/proxy**. The adapter exists because that provider exposes a different HTTP shape: `buildShenxdSearchRequest` (`:9-22`) returns `endpoint: config.baseUrl` (the configured URL *is* the endpoint, rather than a path appended to a base) and drops the vendor-specific `next`/stats/host routes entirely.

The capability gate, `shenxd-adapter.ts:24-34`:

```ts
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
```

So under `shenxd`, exactly one of the five tools works: `fofa_search`. `fofa_account_info`, `fofa_search_next`, `fofa_stats`, `fofa_host_aggregate` all throw `fofa_plan_unsupported`. It is called in **two** places to fail fast in both directions: parent-side in `fofa-runtime.ts:115` (before any quota reservation), and child-side in `fofa-server.ts:69,90,102,117`.

### 2.6 `fofa-types.ts` — error codes and `FOFA_FIELDS`

Error codes (`:3-15`), all 12 verbatim:

```
fofa_not_configured | fofa_scope_rejected | fofa_query_invalid | fofa_quota_exhausted
fofa_auth_failed | fofa_points_insufficient | fofa_plan_unsupported | fofa_rate_limited
fofa_timeout | fofa_provider_error | fofa_response_invalid | fofa_mcp_unavailable
```

`FofaError` (`:17-26`) carries `code`, `message`, `retryable` (default `false`). Note `fofa_not_configured` is declared but the config loader returns `undefined` instead of throwing it, and `fofa_quota_exhausted` is declared here while the actual quota rejection is raised by the runtime store (see §2.8).

`FOFA_FIELDS`, `fofa-types.ts:37-45` — **40 fields**, the complete list:

```
ip, port, protocol, country, country_name, region, city,
longitude, latitude, as_number, as_organization, host, domain,
os, server, icp, title, jarm, header, banner, base_protocol,
link, certs_issuer_org, certs_issuer_cn, certs_subject_org,
certs_subject_cn, tls_ja3s, tls_version, product, product_category,
version, lastupdatetime, cname, icon_hash, certs_valid,
cname_domain, body, icon, fid, structinfo
```

`as const`, so it is the single source of truth for both the TypeBox enum in the Pi tool (`fofa-mcp-tools.ts:9`) and the Zod enum in the MCP server (`fofa-server.ts:33`). Note there is **no** `cert` field in this list even though `cert` is an anchor field in the policy — `cert` is a query-only field, not a returned one.

Other shapes: `FofaRecord` (`:47-51`), `FofaTrustedContext` (`:53-59`), `FofaOperationResult` (`:61-71`), the per-tool inputs (`:73-82`), and `FofaRawSearchResult` (`:84-90`).

### 2.7 What the Executor/Planner actually get — `src/tools/fofa-mcp-tools.ts`

`createExecutorFofaTools(runtime, artifactStore, taskRef)` (`:12-88`) returns **exactly five Pi tools**:

| Tool | Args (`typebox`) | Defaults | Notes |
|---|---|---|---|
| `fofa_account_info` | `{}`, `additionalProperties: false` | — | no args at all |
| `fofa_search` | `query` 1–4096; `fields` 1–40 unique; `limit` int 1–100 optional; `full` bool optional | `limit:100`, `full:false` | `:35-45` |
| `fofa_search_next` | `cursor` 1–256; `limit` int 1–100 optional | `limit:100` | the cursor is opaque, Runtime-owned |
| `fofa_stats` | `query` 1–4096; `fields` 1–40; `limit` int 1–100 optional | `limit:100` | `:64-72` |
| `fofa_host_aggregate` | `host` 1–2048; `detail` bool optional | `detail:false` | `:78-85` |

Every one is `additionalProperties: false`, and note the tool schema caps `limit` at **100** while the runtime's `boundedLimit` caps at `config.maxResultsPerCall` (`fofa-runtime.ts:498-503`) — so the effective per-call ceiling is `min(100, maxResultsPerCall)`.

The tool descriptions are the only scope guidance the model sees: `fofa_search`'s description (`:34`) reads `"Search FOFA for authorized Scope assets. Every OR branch must retain a positive authorized anchor. Associated旁站 are candidate-only and cannot be actively tested."` and `fofa_host_aggregate`'s (`:77`) reads `"Inspect FOFA aggregation for an authorized host or a trusted derived asset reference."`

`presentResult` (`:90-143`) is where results become safe model input:
- the **full** payload (all records, cursor, quota) is written to an `ArtifactStore` artifact with media type `application/vnd.luanniao.fofa+json` (`:100-106`);
- records are converted to graph topology via `normalizeFofaTopology` (`:108`);
- only previews are shown: at most **25** `in_scope` records and **10** `candidate_only` records (`:109-110`);
- counts, quota, cursor, artifactRef, `candidatePolicy` and an explicit `warning` string are attached (`:111-129`);
- the whole summary is then shrunk by `boundPreview` (`:145-163`) until it fits `MAX_MODEL_BYTES = 12_000` (`:8`), dropping candidate preview → in-scope preview → `dataPreview` → `topology` in that order, and finally throwing if it still does not fit;
- `boundedDataPreview` (`:165-168`) caps stats/host data at 2 000 chars.

The `warning` at `:128` is verbatim: `"candidate_only records are discovery leads; active_testing_allowed:false and they do not expand Scope"`.

The MCP child server (`src/mcp/fofa-server.ts`) registers the same five under `createFofaMcpServer` (`:61-125`). Its input schemas are stricter than the Pi layer: `_runtime` is a `.strict()` object validated at `:22-31` (including `scopeFingerprint` matching `/^[a-f0-9]{64}$/` and `derivedRefs` ≤ 128), and `fieldsSchema` (`:33-36`) additionally enforces uniqueness. `validateContext` (`:158-164`) recomputes the policy fingerprint and throws `fofa_scope_rejected` on mismatch — so a caller cannot smuggle in a different scope. The `_runtime` object is injected **parent-side**, never exposed to the model: `fofa-runtime.ts:143` merges it in as `{ ...prepared.arguments, _runtime: this.trustedContext(taskRef) }`, and `trustedContext` (`:320-328`) fills `runRef`, `taskRef`, `scope`, `scopeFingerprint`, `derivedRefs: []`.

### 2.8 Where quotas are enforced

**Quotas are enforced exclusively in the parent process, in `src/mcp/fofa-runtime.ts`** — the child server has no counters.

Quota kinds are `"results" | "aggregations"`. Reservation happens in `call`, `fofa-runtime.ts:126-138`:

```ts
    const prepared = this.prepareCall(taskRef, toolName, args);
    const startedAt = this.now();
    let reservation: { kind: "results" | "aggregations"; amount: number } | undefined;
    if (prepared.quotaKind) {
      reservation = { kind: prepared.quotaKind, amount: prepared.quotaAmount };
      this.options.runtimeStore.reserveFofaQuota({
        taskId: taskRef,
        kind: reservation.kind,
        amount: reservation.amount,
        limit: reservation.kind === "results"
          ? this.options.config.maxResultsPerTask
          : this.options.config.maxAggregationsPerTask
      });
    }
```

and the mapping is set in `prepareCall` (`:260-318`):

| Tool | Quota kind | Amount |
|---|---|---|
| `fofa_account_info` | none | 0 (`:269-271`) |
| `fofa_host_aggregate` | `aggregations` | **1** (`:272-278`) |
| `fofa_stats` | `aggregations` | **1** (`:279-289`) |
| `fofa_search` | `results` | the bounded `limit` (`:290-302`) |
| `fofa_search_next` | `results` | the bounded `limit` (`:304-317`) |

So the budget model is three-tiered, and this is the precise answer to "per-call? per-run? points budget?":

1. **Per call, by request size** — the reservation is for the *requested* number of results, up to `maxResultsPerCall` (default 100). `boundedLimit` (`:498-503`) rejects non-positive-integers with `fofa_query_invalid` and clamps to the max; the Pi schema already caps at 100.
2. **Per task, by result count** — `reserveFofaQuota` receives `limit: config.maxResultsPerTask` (default **1 000**) for `results`, and `limit: config.maxAggregationsPerTask` (default **20**) for `aggregations`. The store is keyed by `taskId`, so this is a per-Task budget, and (per the test "resume keeps SQLite quota and rejects a prior process cursor") it is persisted in SQLite and survives a process restart within the same run.
3. **Actual consumption, refunded by real usage** — after a successful call, the runtime checks `full.returned` is a safe integer in `[0, reservation.amount]` and releases the unused remainder (`:149-161`). A `fofa_response_invalid` is raised if the child reports a count *larger* than reserved, so an over-returning provider cannot overspend the budget.
4. **Refund on definite pre-dispatch failure** — `:172-183` releases the full reservation only when the error carries `preDispatch === true` (tested by `isDefinitelyPreDispatch`, `:513-515`). A transport failure mid-call is **not** refunded, because consumption is unknown.
5. **Provider-side points (F-points) are tracked, not budgeted** — `consumedFpoints` is read from the response (`fofa-client.ts:235`) and surfaced to the model, but nothing enforces a ceiling on it. The only points-related handling is the error passthrough `fofa_points_insufficient`. There is **no configurable F-points budget** — that is a genuine gap.
6. **Cursor TTL is a separate shared limit** — `CURSOR_TTL_MS = 30 * 60 * 1_000` (`:26`), and cursors are invalidated on task ownership/scope/fingerprint mismatch (`resolveCursor`, `:349-365`) and explicitly by `invalidateTask` (`:204-210`).

The tool set is also verified at startup: `startInternal` (`:219-240`) calls `listTools()` and requires an exact set match against `EXPECTED_FOFA_TOOLS` (`:19-25`), else `fofa_mcp_unavailable`. Transport failure sets `needsRestart` and allows **exactly one** restart (`restartUsed`, `:246-256`); the failed call is never replayed.

Every call emits execution-log event `fofa_mcp_call` with `toolName`, `durationMs`, `status` (`succeeded` / `failed_before_dispatch` / `cancelled` / `failed` / `transport_failed`), `returned`, `quota`, and `errorCode` (`:392-409`).

---

## 3. CONNECTIVITY / NETWORK EGRESS

### 3.1 What network the executor container is on

Built in `src/executor-sandbox-docker.ts:150-177` (`createDockerRunArgs`). The network-relevant part:

```
157:    "--network", input.network.networkName,
158:    "--dns", input.network.dnsAddress,
```
plus, from the fixed prefix at `:150-156`: `--read-only`, a 512 MB `tmpfs` `/tmp`, `--pids-limit 512`, `--memory 4g`, `--cpus 2`, `--user 1000`.

`input.network` is a `TaskGateway` (`network-sandbox-manager.ts:44-57`) whose `networkName` is a **per-Task** Docker network (`luanniao-task-<digest>`, `:391-394`) and whose `dnsAddress === gatewayAddress` (`:357`, `:521`, `:558`). So:

- the executor is attached to **one dedicated task network whose only other member is that Task's Gateway container** — there is no route to any other task network, and the control network is explicitly firewalled off;
- `--dns` points at the Gateway, and `/etc/resolv.conf` is bind-mounted with `nameserver <gateway>` + `options ndots:0` (`executor-sandbox-docker.ts:251-254`);
- Docker's embedded resolver `127.0.0.11` is **blocked** inside the container netns (`executor-sandbox-docker.ts:466-469`):
  ```
  iptables -t raw -I OUTPUT -d 127.0.0.11 -p udp --dport 53 -j DROP
  iptables -t raw -I OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j DROP
  ```
  and the default route is replaced to point at the Gateway (`:461`), with the gateway IP explicitly ACCEPTed and the task subnet REJECTed as a direct destination (`:462-465`).

**Net effect: every packet, including every DNS query, must traverse the Gateway.** The Gateway is the single choke point. It runs with `--cap-add NET_ADMIN, NET_RAW, SETUID, SETGID`, a TUN device, `NET_ADMIN` firewall rules, and `--security-opt no-new-privileges` (`network-sandbox-manager.ts:422-426`).

### 3.2 Is public internet egress possible? Under what condition?

**Yes — conditionally, and the condition is the authorised scope itself.**

Inside the Gateway, `configure_gateway_firewall` (`network-image/index_server.py:870-971`) installs the scope guard:

- If `LUANNIAO_AUTHORIZED_DOMAINS` is non-empty (`:890-912`): an nftables set `SCOPE_NFT_SET` with a `timeout` flag is created, the forward chain has `policy accept`, and rules ACCEPT `task_network → @SCOPE_NFT_SET` and `task_network → each_authorized_cidr`, then **REJECT everything else from the task network** (`:909-912`).
- If there are no authorised domains (`:913-919`): an iptables `SCOPE_GUARD_CHAIN` RETURNs the authorised CIDRs and REJECTs the rest, and it is jumped to from FORWARD (`:956-959`).
- In both cases `:969-971` adds `-t nat -A POSTROUTING -s <task_network> -j MASQUERADE`, so authorised destinations are genuinely routed to the outside world.

The `SCOPE_NFT_SET` starts empty and is **populated at runtime by DNS answers** for authorised domains:

```python
# network-image/index_server.py:974-981
def authorize_domain_address(address: str, ttl: int) -> None:
    try:
        subprocess.run([
            "nft", "add", "element", "ip", SCOPE_NFT_TABLE, SCOPE_NFT_SET,
            "{", address, "timeout", f"{ttl}s", "}"
        ], check=True)
    except subprocess.CalledProcessError as error:
        raise OSError(f"failed to authorize DNS address {address}") from error
```

So the effective rule is: **an outbound destination IP becomes reachable for a bounded time (the DNS TTL, clamped to 1–300 s) exactly if it was an A-record answer for a name inside the authorised scope.** Traffic that skips DNS cannot reach anything outside the authorised CIDRs.

The scope is handed to the Gateway by `network-sandbox-manager.ts:438-439`:
```
      "--env", `LUANNIAO_AUTHORIZED_CIDRS=${authorizedScope.cidrs.join(",")}`,
      "--env", `LUANNIAO_AUTHORIZED_DOMAINS=${authorizedScope.domains.join(",")}`,
```
after `parseAuthorizedScope` at `:403`, which throws if no scope was configured (`:400-401`: `"Authorized scope must be configured before creating a task Gateway"`).

Two important consequences for a recon specialist:

1. **A pure-CIDR scope (`0.0.0.0/0`, the CTF default from `src/scope.ts:5`) grants unrestricted public internet egress**, because `SCOPE_GUARD_CHAIN` RETURNs `0.0.0.0/0` before the REJECT. This is the one explicit unlock.
2. **With only domains in scope, egress follows those domains' A records.** Note the guard is **IPv4-only** — `configure_gateway_firewall` throws if any authorised network has `version != 4` (`:878-879`), the task container disables IPv6 via sysctl (`network-sandbox-manager.ts:416-417`), and `ScopeDnsProxy` only extracts `record_type == 1` A records (`network-image/scope_dns.py:115`). Outbound IPv6 is not a bypass, it is absent.

Additionally, the Go data plane re-checks scope independently. `network-image/gateway-tun/route_proxy.go:144` refuses a destination `outside authorized scope`, and `main.go:41-43` takes `--deny-cidrs` (task + control network) and `--allow-cidrs` (`LUANNIAO_AUTHORIZED_CIDRS`) plus `--allow-domain-resolved` (set only when authorised domains exist, `index_server.py:374-375`). The direct-egress path goes through an authenticated **host broker** (`--direct-broker` / `--direct-broker-token`), i.e. the Gateway does not originate raw sockets to the internet itself for the direct path — it asks the host to. That broker is `src/connectivity/host-egress-broker.ts`, which denies `127.0.0.0/8`, link-local `169.254/16`, multicast/`≥224`, `0.0.0.0` and `255.255.255.255` (`:141-147`) — so the container can never use the gateway to reach the host's own loopback.

HTTP/HTTPS additionally pass through a TLS-terminating content proxy: the Gateway mints a CA (`/traffic/ca/mitmproxy-ca-cert.pem`), and the executor container is given it via `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` (`executor-sandbox-docker.ts:191-194`). This is why `ignoreCertificateErrors: true` is set for the in-container browser (`:423`). The system prompt tells the agent the environment facts verbatim (`executor-environment.ts:53`): `"网络：独立任务网络以 Gateway 为唯一出口；HTTP/HTTPS 透明内容代理，其他协议只做路由与连接元数据审计；不要设置代理环境变量；IPv6 已禁用"`.

### 3.3 What the connectivity tools let an agent do

`src/tools/connectivity-tools.ts:12-71` exposes **four** tools, all bound to group `connectivity`:

| Tool | Args (lines) | Purpose |
|---|---|---|
| `route_open` | `connector: "ssh"\|"chisel"`; `pivotHostRef` 1–256; `dialAddress?` 1–255; `targetCidrs: string[1..32]` each 3–64; `credentialRef?` 1–256; `bootstrapConnectionRef?` 1–256; `options?: { port?: 1..65535, user?: 1..128 }` (`:21-32`) | create a Runtime-managed pivot |
| `route_status` | `routeRef?` 1–256 (`:41-43`) | inspect one or list all |
| `route_stop` | `routeRef` 1–256 (`:52-54`) | stop, preserving the ref |
| `route_reconnect` | `routeRef` 1–256 (`:63-65`) | restore in place |

So yes — **tunnel and pivot, but not proxy.** The description at `:20` is explicit that the process-wide transparent proxy is operator-owned: `"The process-wide transparent proxy is configured by the operator before Agent execution and cannot be created or replaced with this tool."` and the test name "route_open reserves the process-wide SOCKS5 proxy for operator configuration" confirms the intent. `route-manager.ts:185` enforces it: `if (input.connector !== "socks5") throw new Error("Transparent proxy requires a SOCKS5 connector")` — i.e. the agent-facing `route_open` schema exposes only `ssh` and `chisel`, while `RouteConnector` internally has three values (`route-manager.ts:15`).

Gating, concretely:

- **Group gating.** All four are in group `connectivity`; a Specialist that lists `connectivity` in `disableGroups` loses all four at once (`specialists/tools.ts:59-76`). The shipped `recon-lite` template does exactly that (see §8.3).
- **Runtime presence gating.** `controller.ts:3169` binds them only if `this.connectivityRuntime` exists; `createTaskConnectivityTools` (`:3141-3151`) returns `[]` when it does not.
- **Ownership gating.** The owner task id is closed over at construction (`connectivity-tools.ts:14`, `:34`), so one Task cannot manipulate another Task's routes.
- **Input validation** in `route-manager.ts:1006-1032`: connector must be one of the three; `pivotHostRef` required and must **not** be a Docker infrastructure alias — `isDockerInfrastructureAlias` (`:1042-1044`) rejects `host.docker.internal` / `gateway.docker.internal`; `dialAddress` must be non-empty, ≤ 255 chars, no whitespace/NUL; `targetCidrs` must be 1–1024 valid IPv4 CIDRs with prefix 0–32; connector port 1–65535; and per-connector: **SSH and SOCKS5 require `dialAddress` + `options.user` + `credentialRef`** (`:1021-1028`), **Chisel requires `bootstrapConnectionRef`** (`:1029-1031`) and additionally `LUANNIAO_CHISEL_PUBLIC_HOST` reachable from the pivot (`:83`, `:537`).
- **Credential gating.** `route-manager.ts:689-691` loads the artifact referenced by `credentialRef` and rejects if missing or `> 1 MiB`; the SSH path stages a key file (`:486`) and verifies the command channel before declaring success (`:498`). The system prompt adds the semantic rule (`prompts.ts:123`): the credential artifact must contain *only* the password or private key, with descriptive evidence in a separate artifact.
- **The agent may also build its own tunnels in bash** — `prompts.ts:123` says so explicitly and warns they get no recoverable Runtime reference.

`src/tools/network-diagnostics-tools.ts:10-35` exposes **two** tools, group `network_diagnostics`:

| Tool | Args | Semantics |
|---|---|---|
| `network_status` | `{}` (`:19`) | Returns `TaskNetworkHealth`: `status` ∈ `healthy\|scope_blocked\|gateway_unreachable\|broker_unreachable\|target_timeout\|icmp_proxy_unsupported`, plus `tcpDataPlane`, `broker`, `icmp`, `checkedAt`, `detail` (`network-sandbox-manager.ts:72-80`) |
| `icmp_echo` | `target` 1–253; `timeoutMs?` 250–3000 (`:26-29`) | **exactly one** scope-controlled ICMP echo |

`icmp_echo`'s description (`:25`) carries three doctrines verbatim: `"Send exactly one scope-controlled IPv4 ICMP Echo from Gateway. ICMP silence does not prove the host is down. ICMP through a matching SOCKS5 route is unsupported and is never bypassed."` The implementation is in the Gateway: `index_server.py:499-513` validates the target, resolves it via `_authorized_icmp_address`, and returns `scope_blocked` if unauthorised, `icmp_proxy_unsupported` if the address is route-backed, and `infrastructure_failure` with `detail: "rate_limited"` if the token bucket is empty. So ICMP is **rate-limited and scope-gated**, and the tool is methodologically constrained to a single probe — it is a liveness check, not a ping sweep.

Both diagnostics tools are gated the same way as connectivity: bound only when `this.connectivityRuntime` exists (`controller.ts:3170-3172`).

The agent-facing complement to these tools is the environment-facts block injected into the Executor prompt, `src/executor-environment.ts:38-75`, which renders the verified network facts plus the probed tool list (`EXECUTOR_TOOL_PROBE_LIST`, `:25-30`) so the agent does not rediscover its own sandbox. The list includes `dig` and `whois` and `nmap` — but note that what the agent actually gets is the intersection with the image label (see §10).

### 3.4 `network-image/index_server.py` around `allow_unmatched`

The construction, `index_server.py:1081-1086`:

```python
    dns = ScopeDnsProxy(
        task_address,
        _authorized_domains(),
        authorize_domain_address,
        allow_unmatched=bool(os.environ.get("LUANNIAO_AUTHORIZED_CIDRS", "").strip()),
    )
```

`_authorized_domains()` (`:381-388`) splits `LUANNIAO_AUTHORIZED_DOMAINS` on commas and trims.

**What makes DNS for an out-of-scope name fail or succeed** is therefore a one-line coupling to `LUANNIAO_AUTHORIZED_CIDRS`, and the resolution logic is `network-image/scope_dns.py:43-60`:

```python
    def resolve(self, request: bytes, tcp: bool = False) -> bytes:
        try:
            question, _ = dns_question(request)
        except ValueError:
            return dns_error_response(request, 1)
        matched_domain = domain_allowed(question, self.domains)
        if not matched_domain and not self.allow_unmatched:
            return dns_error_response(request, 5)
        try:
            response = forward_dns(request, self.upstream, tcp)
            if len(response) < 2 or response[:2] != request[:2]:
                raise ValueError("DNS response transaction ID mismatch")
            if matched_domain:
                for address, ttl in answer_ipv4_addresses(response):
                    self.authorize_address(address, max(1, min(ttl, 300)))
            return response
        except (OSError, ValueError):
            return dns_error_response(request, 2)
```

Behaviour matrix:

| `LUANNIAO_AUTHORIZED_CIDRS` | `LUANNIAO_AUTHORIZED_DOMAINS` | Name queried | DNS result | Subsequent TCP reachability |
|---|---|---|---|---|
| non-empty (e.g. `0.0.0.0/0`) | anything | any name | **resolved** (forwarded upstream) | governed by the CIDR guard, i.e. wide open for `0.0.0.0/0` |
| empty | non-empty | authorised name | resolved, and every A-record IP is installed into `SCOPE_NFT_SET` with `timeout = clamp(ttl, 1, 300)` | reachable |
| empty | non-empty | anything else | **NXDOMAIN (rcode 5)** (`scope_dns.py:49-50`) | never reachable — no IP to dial |
| empty | empty | any name | NXDOMAIN | gateway startup already refused (`index_server.py:878-879`) |

That single boolean is why the CIDR-only and domain-only modes behave so differently, and it is the crux of "can a recon agent resolve arbitrary names": **only if the authorised scope contains at least one CIDR.** In domain-only scope the resolver is a whitelist forwarder — and note that a whitelisted *wildcard* (`*.example.com`) matches subdomains but not the apex (`domain_allowed`, `scope_dns.py:63-72`, which mirrors `authorizedScopeContainsDomain` exactly).

Two more details worth designing around:
- `matched_domain` is computed from the *question*, and only A records are harvested (`answer_ipv4_addresses`, `:96-118`, `record_type == 1 and record_class == 1 and length == 4`). CNAME chains are followed by the upstream resolver, and the A records in the final answer are what get authorised — so a CNAME to an out-of-scope CDN does authorise that CDN's IP for the TTL. That is a deliberate, bounded, DNS-derived authorisation, not a leak.
- Malformed questions get rcode 1 (FORMERR) and upstream failures get rcode 2 (SERVFAIL) (`:47`, `:60`), which are distinguishable from the rcode 5 scope denial — a recon agent can therefore tell "blocked by scope" apart from "resolver broken".

`allow_unmatched` writes **nothing** to the nft set: `authorize_address` is called only under `if matched_domain`. Unmatched names resolve to real public IPs that the firewall will still reject unless they fall inside an authorised CIDR.

### 3.5 Other connectivity modules (context for reuse)

`src/connectivity/` contains 13 files. The ones a recon specialist might interact with:

| File | Lines | Relevance |
|---|---|---|
| `network-sandbox-manager.ts` | 1303 | Gateway/task-network lifecycle, `icmpEcho` (`:637-656`), `taskNetworkHealth` (`:605`), route snapshot/replace (`:658-676`). |
| `route-manager.ts` | 1091 | SSH/Chisel/SOCKS5 route lifecycle; `validateRouteInput` (`:1006-1032`). |
| `connectivity-runtime.ts` | 498 | Facade: `openRoute`, `executorRouteStatus`, `executorStopRoute`, `executorReconnectRoute`. |
| `traffic-proxy-manager.ts` / `-registry.ts` / `-runtime.ts` / `traffic-proxy-client.ts` | 282 / 81 / 69 / 276 | Operator-owned transparent proxy: history, replay, credential hints. |
| `replay-gateway-runtime.ts` | 394 | Gateway-side replay through the captured-flow index. |
| `mitm-flow-client.ts` | 395 | Reads captured flows from the traffic index. |
| `credential-extractor.ts` | 103 | Pulls credential hints out of captured traffic. |
| `host-egress-broker.ts` | 148 | Authenticated host-side TCP broker (deny list at `:141-147`). |
| `runtime-owner-lease.ts` / `connectivity-runtime-registry.ts` | 352 / 221 | Single-owner leases so two runtimes cannot both drive the data plane. |

### 3.6 What is *not* gated by scope in the connectivity layer

Worth flagging for the design: the four route tools take an arbitrary `targetCidrs` list (1–1024 valid IPv4 CIDRs) and **`validateRouteInput` never compares them to `AuthorizedScope`**. Scope confinement for routes is enforced downstream by the Gateway data plane (`route_proxy.go:144`, `FAILED: destination outside authorized scope`) rather than at the tool boundary. So a route can be *declared* to a wider CIDR than the run scope; the failure only appears when traffic is actually dialled. For a recon specialist that will open routes to discovered ranges, that is an asymmetry to be aware of.

---

## 4. BROWSER

### 4.1 Where the browser runs

**Inside the executor container.** `src/executor-sandbox-docker.ts:390-424` defines the runtime the Executor actually uses:

```ts
    browserRuntime: {
      chromePath: "/usr/bin/chromium",
      createProfile: async () => `/tmp/luanniao-chrome-${randomUUID()}`,
      removeProfile: async (profileDir) => {
        if (!profileDir.startsWith("/tmp/luanniao-chrome-")) {
          throw new Error(`Refusing to remove unexpected browser profile: ${profileDir}`);
        }
        await execInContainer(`rm -rf -- ${shellQuote(profileDir)}`, { timeoutMs: 10_000 });
      },
      execChrome: async (chromePath, args, timeoutMs, signal) => {
        const execId = randomUUID().replaceAll("-", "").slice(0, 12);
        const pidFile = `/tmp/.luanniao-browser-${execId}.pid`;
        const command = [chromePath, ...args].map(shellQuote).join(" ");
        const wrapped = `setsid ${command} & pid=$!; echo $pid > ${pidFile}; wait $pid`;
        ...
      },
      disableChromeSandbox: true,
      ignoreCertificateErrors: true
    } satisfies BrowserProcessRuntime,
```

It is pinned to `sandbox.browserRuntime` in `src/agents.ts:275`, and the host fallback is **disabled**:

```ts
    { group: "browser", tool: createBrowserRenderTool({ runtime: input.sandbox.browserRuntime, allowHostFallback: false }) },
```

`allowHostFallback: false` makes `renderWithChrome` skip `createHostBrowserRuntime` entirely (`browser-tools.ts:150-151`) and return an error if no runtime was supplied (`:152-158`). The host path (`createHostBrowserRuntime`, `:199-211`, which resolves Chrome from `LUANNIAO_CHROME_PATH`/`CHROME_PATH`/platform defaults and honours `HTTP(S)_PROXY`) exists only for the standalone `workspace` sandbox mode, where `browserRuntime` is set at `executor-sandbox.ts:150`.

Consequences of running in-container: the browser inherits the executor's network boundary (§3), so it can only reach what the Gateway permits, and it does **not** see the operator's transparent proxy env vars — the test "buildChromeArgs supports Docker isolation without injecting a proxy" pins that (`runtime.proxy` is undefined for the Docker runtime). The in-container browser *does* trust the Gateway's MITM CA because `ignoreCertificateErrors: true` is passed (`:423` → `--ignore-certificate-errors` at `browser-tools.ts:111`).

### 4.2 What it can do

Exactly **one** tool, `browser_render` (`browser-tools.ts:45-73`), bound to group `browser`:

| Arg | Type | Bounds |
|---|---|---|
| `url` | string | 8–2048 chars (`:56`) |
| `waitMs` | optional int | 500–30000 (`:57`) |
| `maxChars` | optional int | 1000–100000 (`:58`) |

Returns (`renderWithChrome`, `:185-193`): `success`, `url`, `waitMs`, `domChars`, `truncated`, `chromeTerminated`, and `dom` (the first `maxChars` characters of stdout).

It is **`--dump-dom` only**. `buildChromeArgs` (`:88-115`) verbatim:

```ts
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--mute-audio",
    `--user-data-dir=${input.profileDir}`,
    `--virtual-time-budget=${input.waitMs}`,
    "--dump-dom"
  ];
```

So the answer to "JS render, screenshot, cookies, auth":

| Capability | Supported? | Evidence |
|---|---|---|
| JavaScript execution / post-JS DOM | ✅ | `--headless=new` + `--virtual-time-budget=<waitMs>` then `--dump-dom` |
| Screenshot | ❌ | no `--screenshot`; no image is ever captured or returned |
| Cookies / session persistence | ❌ | profile is a fresh `mkdtemp` per call, destroyed in a `finally` (`:161`, `:194-196`); no cookie is read or written |
| Authentication | ❌ | no credential input, no login flow, no storage-state import/export |
| Request/response inspection | ❌ | only stdout DOM; stderr is used solely for the error string |
| Console logs / dialogs | ❌ | explicitly disclaimed in the description: `"Browser dialogs and console output are not proof; use an observable DOM mutation as the confirmation signal."` (`:52`) |
| Downloads, PDF, tracing, HAR | ❌ | none |

The "wait" is a fixed virtual-time budget, not a wait-for-condition, so there is no `waitForSelector`/`waitForNetworkIdle`.

### 4.3 Limits

| Limit | Value | Line |
|---|---|---|
| Scheme | only `http:` / `https:` — `validateBrowserUrl` (`:75-86`) rejects everything else before Chrome starts | `:82-84` |
| Default wait | 8 000 ms | `:9` |
| Max wait | 30 000 ms | `:10` |
| Process kill deadline | `waitMs + CHROME_TIMEOUT_GRACE_MS`, where grace = 10 000 ms | `:13`, `:174` |
| Default DOM chars | 20 000 | `:11` |
| Max DOM chars | 100 000 | `:12` |
| Empty-DOM condition | fails with `chrome produced no DOM (exit …)` and the first 500 chars of stderr | `:178-184` |
| Kill mechanism | in-container `setsid` + process-group `TERM` then `KILL` after 2 s | `executor-sandbox-docker.ts:403-414` |
| Profile safety | `/tmp/luanniao-chrome-<uuid>` prefix re-checked before `rm -rf` | `executor-sandbox-docker.ts:394-396` |

### 4.4 Is it scope-gated?

**Not at the tool boundary.** `validateBrowserUrl` checks only the scheme, and there is no call to `authorizedScopeContainsDomain` / `authorizedScopeContainsIp` anywhere in `browser-tools.ts`. Containment is purely **topological**: because Chrome runs inside the executor container, its traffic is subject to the Gateway firewall and scope DNS of §3. In a domain-only scope, resolving an out-of-scope host fails with NXDOMAIN; in a CIDR-only scope with `0.0.0.0/0`, the browser can reach the whole internet.

This is a different model from `web_fetch`, which *does* enforce a host-level check in the tool itself (see §5). A recon specialist that needs "browse only in-scope assets" semantics must add the check, because the browser tool will happily render any URL the network layer allows.

---

## 5. RESEARCH TOOLS

`src/tools/research-tools.ts` (741 lines). Group `research`, assembled by `createExecutorResearchTools()` in `src/agents.ts:112-118` and bound at `src/agents.ts:274`.

### 5.1 Public API surface

| Export | Line | Signature |
|---|---|---|
| `createWebFetchTool` | `:53` | `(deps?: ResearchToolDependencies) => ToolDefinition` |
| `createWebSearchTool` | `:76` | same |
| `createVulnerabilitySearchTool` | `:97` | same |
| `fetchPublicReference` | `:119` | `(rawUrl, options) => Promise<Record<string, unknown>>` |
| `searchPublicWeb` | `:178` | `(query, maxResults, deps) => Promise<Record<string, unknown>>` |
| `searchVulnerabilities` | `:228` | `(query, maxResults, deps) => Promise<Record<string, unknown>>` |
| `ResearchFetch` | `:19` | `(input, init?) => Promise<Response>` |
| `ResearchToolDependencies` | `:21-25` | `{ fetch?, resolveHostname?, env? }` |

### 5.2 Tool names, args, return shapes

**`web_fetch`** (`:55-73`)
- args: `url` 8–2048; `maxChars?` 1000–50000 (`:62-65`)
- returns: `{ success, requestedUrl, finalUrl, status, contentType, title, content, truncated, byteLength, sourceKind: "public_research_reference" }` (`:164-175`)
- bounds: `DEFAULT_FETCH_BYTES = 512 * 1024` (`:12`), `DEFAULT_FETCH_CHARS = 12_000` (`:13`), `MAX_REDIRECTS = 5` (`:15`), `REQUEST_TIMEOUT_MS = 20_000` (`:16`), redirects followed **manually** so each hop is re-validated (`:140-151`)
- HTML is converted to Markdown via `Readability` → fallback selector sweep → `Turndown` + GFM (`htmlToReadableMarkdown`, `:444-476`)

**`web_search`** (`:78-94`)
- args: `query` 2–500; `maxResults?` 1–10, default 5 (`:86-87`)
- returns `{ success, query, backend, results: WebSearchResult[], error? }` where `WebSearchResult = { title, url, snippet, source }` (`:27-32`)
- backend chain (`searchPublicWeb`, `:178-226`): Brave (if keyed) → DuckDuckGo HTML → Bing HTML, first non-empty wins; failures accumulate into `error`. `backend` reports e.g. `"duckduckgo_html+bing_html"` when Brave is unkeyed (`:222`).

**`vulnerability_search`** (`:99-117`)
- args: `query` 2–500; `maxResults?` 1–10, default **8** (`:110-111`)
- returns (`searchVulnerabilities`, `:275-294`): `success`, `query`, `resultClass` ∈ `direct_hit|family_hit|source_failure|no_public_hit`, `negativeSignalStrength` (`"weak"` only for `no_public_hit`), `sourceCoverage: { nvd, webSearch }`, `vulnerabilities: VulnerabilityRecord[]`, `publicReferences`, `followupQueries`, `applicability: { product, version, status }`, `evidenceSummary`, `recommendedNextSteps`
- NVD query via `https://services.nvd.nist.gov/rest/json/cves/2.0` (`:316`), `cveId=` when the query contains a CVE id else `keywordSearch=`, capped at 20 (`:304-306`)
- up to **3** generated follow-up queries are run through `searchPublicWeb` (`:240`), each capped at `min(maxResults, 5)`, filtered by `publicReferenceRelevance` against `VULNERABILITY_SIGNAL_RE` (`:17`)

### 5.3 Every env var it reads

Exactly **three**, all optional, all read from `dependencies.env ?? process.env`:

| Env var | Line | Effect |
|---|---|---|
| `BRAVE_SEARCH_API_KEY` | `:184` | if set, Brave Search is the first backend |
| `BRAVE_API_KEY` | `:184` | fallback name for the same key |
| `NVD_API_KEY` | `:311` | sent as the `apiKey` header to NVD (higher rate limit); absent → anonymous |

No proxy env vars are read here (`HTTP_PROXY`/`HTTPS_PROXY` are only consulted by the *host* browser runtime, `browser-tools.ts:209`, which the Docker Executor never uses).

### 5.4 Host-level egress restriction (important asymmetry)

`validatePublicUrl` (`:470-499`) enforces that `web_fetch` targets are **public** and resolves the hostname *before* fetching:

```ts
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error("web_fetch resolved to a non-public address; use bash for authorized target requests");
  }
```

`isPublicIpAddress` (`:513-...`) rejects loopback, RFC1918, CGNAT `100.64/10`, link-local, `192.0.0.0/24`, `192.0.2.0/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `≥224`, plus IPv6 loopback/ULA/link-local and IPv4-mapped forms. `localhost`, `*.localhost` and `*.local` are rejected by name (`:487-489`).

So the research tools run **on the host process**, outbound to the public internet, and are deliberately **forbidden from touching the target**. The tool description says it plainly (`:59`): `"use bash for authorized target-side requests."` This is the exact opposite of the browser tool, which is in-container and target-capable but unscoped. A recon specialist needs both, for different jobs, and must not confuse them.

---

## 6. SKILLS SUBSYSTEM

### 6.1 Discovery

`SkillRegistry` (`src/skills/skill-registry.ts:36-135`) is constructed with `rootDir`, defaulting its state file to `<dirname(rootDir)>/skills-state.json` (`:40`).

`scan()` (`:44-95`):
1. missing root → empty snapshot, not an error (`:45-48`);
2. `realpathSync` the root (`:49`);
3. `findEscapingSymlinks` walks the tree and flags any symlink whose realpath leaves the root (`:50`, `:137-153`);
4. actual parsing is delegated to the Pi SDK's `loadSkillsFromDir({ dir: root, source: "project" })` (`:51`), with SDK diagnostics remapped to `skill_name_collision` / `skill_invalid` (`:52-57`);
5. each skill's realpath is re-checked against the root → `skill_path_outside_root` (`:62-71`);
6. duplicate names → `skill_name_collision` (`:72-75`);
7. validity = `validSkillName(name) && description.trim() !== ""` (`:77`), where `validSkillName` is `name.length > 0 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/` (`:161-163`);
8. enablement comes from the state file, default enabled (`:85`).

`resolveSelection` (`:112-123`) is the filter used for pinned/allowlist modes: requested ∧ valid ∧ enabled ∧ `modelInvocable` ∧ allowlisted ∧ not denylisted.

### 6.2 Directories searched

| Layer | Path | Evidence |
|---|---|---|
| Project (this repo) | `<cwd>/.agents/skills` | `src/agents.ts:77-80` (`projectSkillsDirs`); present here as `.agents/skills/` with 5 skills |
| User-level, injected into the sandbox | `~/.agents/skills`, `~/.codex/skills`, `~/.pi/agent/skills` | `src/executor-sandbox-docker.ts:267-272`, filtered by `existsSync` |
| Pi SDK defaults | `<agentDir>/skills` (user) and `<cwd>/<CONFIG_DIR_NAME>/skills` (project) | `node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:330-331` via `DefaultResourceLoader` (`src/agents.ts:611-632`) |
| Templates (not live) | `templates/skills/<name>/SKILL.md` | shipped for copying; `templates/skills/` holds `credential-stuffing`, `default-credentials`, `password-attack`, `web-login-bruteforce` |

The Docker sandbox binds every discovered root **at its real host path, read-only** (`executor-sandbox-docker.ts:173-175`), and those roots are added to the container's readable-path allowlist (`:326`, `:446`). So a skill body can be `read` by the in-container agent at its host path, and relative links inside a skill resolve correctly.

### 6.3 Parsing — `SKILL.md` format and validation rules

Parsing is done by the Pi SDK, not by this repo. `loadSkillFromFile` (`skills.js:198-249`) calls `parseFrontmatter` (`dist/utils/frontmatter.js`), which uses the `yaml` package:

- content must start with `---`; frontmatter ends at the first `\n---`; otherwise the whole file is body and frontmatter is `{}`;
- `name` falls back to the **parent directory name** when absent (`skills.js:207`);
- `description` is **mandatory** — if missing or blank the skill is dropped entirely with `skill: null` (`:216-218`);
- `"disable-model-invocation" === true` sets `disableModelInvocation` (`:228`);
- unknown keys are preserved in the index signature (`SkillFrontmatter` has `[key: string]: unknown`), so `license`, `compatibility`, `allowed-tools`, `metadata` are accepted and ignored.

Hard validation rules:

| Rule | Limit | Source |
|---|---|---|
| name pattern | `/^[a-z0-9-]+$/`, ≤ 64 chars, no leading/trailing hyphen, no `--` | `skills.js:7`, `:50-63` |
| description | required, ≤ 1024 chars | `skills.js:9`, `:68-77` |
| severity | name/description problems are **warnings**, the skill still loads; only a missing description drops it | `skills.js:212-218` |

Discovery rules (`skills.js:121-195`): a directory containing `SKILL.md` is a skill root and is not recursed into; otherwise direct `.md` children of the root are loaded; subdirectories are recursed. Hidden dirs and `node_modules` are skipped, and `.gitignore`/`.ignore`/`.fdignore` are honoured.

### 6.4 Injection into a prompt

**Only metadata is injected — never the body.** `formatSkillsForPrompt` (`skills.js:257-278`) emits:

```
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>…</name>
    <description>…</description>
    <location>/abs/path/SKILL.md</location>
  </skill>
</available_skills>
```

with XML escaping, and skips `disableModelInvocation` skills. This is exactly the same three-field shape as the session skill catalogue shown to this session. The agent must issue a `read` on `<location>` to get the body — which is why skills can be long without inflating the system prompt.

Selection *before* injection is LLM-driven: `selectSkillsForTask` (`src/skills/skill-selector.ts:50-92`) pre-filters `eligible` by valid/enabled/modelInvocable/allow/deny (`:65-69`), short-circuits to `[]` when nothing is eligible (`:70`), then runs a dedicated agent session with the metadata only (`:105-108`) and a structured `skill_selection_submit` tool (30 s idle / 60 s hard timeout, `:112-113`). `validateSkillSelection` (`:16-48`) re-checks every returned name against the registry and caps the count at **16** (`:29`), recording rejections as `unknown_skill` / `invalid_skill` / `disabled_skill` / `model_invocation_disabled` / `skill_not_allowed` / `skill_denied`. Reasons are truncated to 500 chars (`:45`).

Per-specialist restriction happens **before** the model sees candidates (comment at `:60-62`), driven by `SpecialistSkillPolicy` (`specialists/types.ts:52-58`): `mode` ∈ `auto | allowlist | pinned | off`, with `allow[]` and `pinned[]`.

### 6.5 Size / line limit on a skill

**There is no size or line limit on a skill file in either layer.** Grepping the SDK's `skills.js` finds only `MAX_NAME_LENGTH = 64` and `MAX_DESCRIPTION_LENGTH = 1024`; there is no body cap, no truncation, and no total-lines check. This repo's `skill-registry.ts` adds no cap either. The only structural constraint is the sandbox's generic file-read limit (`DEFAULT_MAX_BYTES` from the Pi read tool) when the agent actually reads the file.

Evidence that long skills are the intended pattern: `.agents/skills/ctf-web/SKILL.md` is 152 lines and the skill directory contains **21 sibling `.md` files** (`server-side.md`, `auth-jwt.md`, `web3.md`, …) that the body links to as progressive-disclosure detail. Sizes in this repo: `ctf-web` 152, `web-login-bruteforce` 158, `credential-stuffing` 128, `password-attack` 98, `default-credentials` 85.

### 6.6 `templates/skills/password-attack/SKILL.md` — literal frontmatter and section conventions

**Important correction to the brief:** `templates/skills/ctf-web/SKILL.md` does **not** exist. `templates/skills/` contains exactly four skills:

```
templates/skills/credential-stuffing/SKILL.md
templates/skills/default-credentials/SKILL.md
templates/skills/password-attack/SKILL.md
templates/skills/web-login-bruteforce/SKILL.md
```

(`ctf-web` exists only as a live skill at `.agents/skills/ctf-web/`.) Per the instruction I read `password-attack`.

Literal frontmatter block, `templates/skills/password-attack/SKILL.md:1-9`:

```yaml
---
name: password-attack
description: Methodology for controlled credential guessing against an authentication surface — building a failure-signal baseline, choosing between password spraying, single-account exhaustion and credential reuse, detecting lockout/rate-limit/CAPTCHA boundaries, and verifying and handing off a hit. Use when the task is to obtain valid credentials for a known authentication entry point (web login, SSH, FTP, database, SMB, or an offline hash). Do not use it for attack-surface discovery (a login endpoint must already be identified or be identifiable from the supplied material), for exploiting authentication logic flaws that need no guessing, or for social engineering.
license: MIT
compatibility: Requires a filesystem-based agent with bash, curl, and Python 3. The executor image ships nmap with NSE brute scripts, curl, python3 (stdlib only), openssh-client with sshpass, and chromium; it does not ship hydra, medusa, ncrack, patator, ffuf, gobuster, hashcat or john.
allowed-tools: Bash Read Write Edit Glob Grep
metadata:
  user-invocable: "false"
---
```

Schema actually used, and where each field is consumed:

| Field | Consumed by | Type |
|---|---|---|
| `name` | SDK `skills.js:207`; must equal the directory name in practice, and must pass `^[a-z0-9]+(-[a-z0-9]+)*$` per `skill-registry.ts:162` | string, ≤ 64 |
| `description` | **required** by `skills.js:216-218`; this is the *entire* basis for model selection | string, ≤ 1024 |
| `license` | nothing — free-form metadata | string |
| `compatibility` | nothing — free-form; used here as an **environment-contract statement** (what the image does and does not ship) | string |
| `allowed-tools` | nothing at runtime — advisory space-separated tool list | string |
| `metadata.user-invocable` | nothing at runtime in this repo | quoted string `"false"` |

Note the last one is a **string** `"false"`, not a boolean — so it does not even feed the SDK's `disableModelInvocation` check, which requires the separate top-level key `disable-model-invocation` to be the boolean `true` (`skills.js:228`).

Section conventions (the de-facto house style, consistent across all four templates):

1. `# <Chinese title>` — the only H1.
2. A one-paragraph scope note that explicitly names **sibling skills** for delegated concerns — e.g. `:13`: *"这份技能只讲"怎么把猜测做得可信"，具体协议的实现细节见 `web-login-bruteforce`，凭据来源见 `default-credentials` 与 `credential-stuffing`。"*
3. `## 一、…` … `## N、…` — numbered Chinese-numeral H2 sections in methodology order (here: 先确认认证面 → 失败信号基线 → 三种策略 → …).
4. **Fenced bash blocks with real commands** containing a literal `TARGET` / `PORT` placeholder, each accompanied by a Chinese comment stating what the command proves — e.g. `:21-28`.
5. Tables for trade-offs (`| 策略 | 形态 | 适用 | 代价 |`, `:55-59`) and ranked signal lists with explicit reliability ordering (`:41-49`).
6. Bold (`**…**`) for the single most important invariant in a section.
7. Cross-references to sibling skills by their slug in backticks.
8. Ends with a `## 十、配套技能` index of related skills.

### 6.7 What a recon skill would need to declare

Given §6.3: `name` matching the directory, a **long discriminating `description`** (it is the only thing the selector sees, so it must carry both the "use when" and the "do not use when"), and optionally `compatibility` to state the real tool inventory — because, as the next section shows, the executor image's actual contents are narrower than the probe list suggests.

---

## 7. SPECIALIST SDK SURFACE

### 7.1 `defineSpecialist` — the complete field set

`defineSpecialist(definition: SpecialistAgentDefinition)` (`src/specialists/sdk.ts:36-48`) validates eagerly and throws `SpecialistDefinitionError` (carrying the diagnostics array) on any problem. It returns a shallow copy with a cloned `budget`. `validateSpecialistDefinition` (`:51-119`) is the non-throwing variant, used for manifests and project modules.

The complete accepted shape is `SpecialistAgentDefinition` (`src/specialists/types.ts:232-257`) plus the factory:

| Field | Type | Required | Validation (file:line) |
|---|---|---|---|
| `id` | `string` | **yes** | `isSpecialistId`: length 1–64 and `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`; failure `specialist_id_invalid` and **returns immediately** (`sdk.ts:61-64`; pattern `types.ts:367-371`) |
| `name` | `string` | **yes** | non-empty after trim (`sdk.ts:66-68`) |
| `description` | `string` | **yes** | non-empty after trim (`sdk.ts:69-71`); this is what the Planner catalog shows |
| `whenToUse` | `string?` | no | must be a string if present (`sdk.ts:72-74`) |
| `version` | `string?` | no | must be a string if present (`sdk.ts:75-77`) |
| `prompt` | `{ mode: "extend" \| "replace"; content: string }` | **yes** | object required; `mode` must be exactly `"extend"` or `"replace"`; `content` must be a string (`sdk.ts:78-88`). `extend` = `EXECUTOR_SYSTEM_PROMPT` + Specialist section; `replace` = author content only (`types.ts:238`). Both modes still get `SPECIALIST_RUNTIME_CONTRACT` appended (`prompt.ts:63`) |
| `tools` | `SpecialistToolPolicy?` | no | object; `disableGroups` must be an array of **known** group names (`sdk.ts:162-172`); `allow` and `deny` must be arrays of strings (`sdk.ts:173-177`) |
| `createTools` | `(ctx: SpecialistToolContext) => ToolDefinition[]` | no | must be a function (`sdk.ts:94-96`); output re-validated by `validateSpecialistTools` (`specialists/tools.ts:130-170`) — each item needs non-empty `name` and a function `execute`, names colliding with existing tools or repeating are dropped with `specialist_tool_collision`, factory throws become `specialist_tool_factory_failed` |
| `skills` | `SpecialistSkillPolicy?` | no | object; `mode` ∈ `auto\|allowlist\|pinned\|off`; `mode=pinned` requires non-empty `pinned[]`; `mode=allowlist` requires non-empty `allow[]` (`sdk.ts:181-203`) |
| `budget` | `SpecialistBudgetProfile` | **yes** | **four** numeric bounds, all mandatory (`sdk.ts:121-149`): `defaultMaxTurns` int 1–`SPECIALIST_MAX_TURNS_CEILING`, `maxTurnsCeiling` int 1–ceiling, `epochTurnSlice` int 1–ceiling, `epochTimeShare` number in `(0, 1]` (min `Number.EPSILON`); plus `defaultMaxTurns ≤ maxTurnsCeiling`. `SPECIALIST_MAX_TURNS_CEILING = 40` (`types.ts:365`). Default profile `{12, 40, 20, 0.5}` (`types.ts:358-363`) |
| `model` | `SpecialistModelProfile?` | no | `model.model` string; `model.thinkingLevel` ∈ `SPECIALIST_THINKING_LEVELS` = `off, minimal, low, medium, high, xhigh` (`sdk.ts:21`, `:102-105`); `model.contextWindow` positive finite number (`:106-109`) |
| `concurrency` | `{ maxParallelTasks?: number }?` | no | if present, must be an integer **1–16** (`sdk.ts:111-117`) |
| `optionsMode` | `"planner" \| "user"?` | no | must be one of `SPECIALIST_OPTIONS_MODES` (`sdk.ts:205-215`; values `types.ts:88`) |
| `options` | `SpecialistOptionSpecMap?` | no | see below |

`options` validation (`sdk.ts:217-272`):

- must be an object keyed by option name; ≤ `SPECIALIST_MAX_OPTIONS = 32` entries (`sdk.ts:23`, `:228-230`);
- each key must match `/^[A-Za-z0-9_-]+$/` (`:232-235`);
- each spec must be an object with `type` ∈ `SPECIALIST_OPTION_TYPES = string, text, number, boolean, enum, string-list` (`sdk.ts:22`, `:241-244`);
- `title` required, non-empty (`:245-247`);
- `type: "enum"` additionally requires `options: [{value: string, label: string}]`, non-empty (`:248-256`);
- `authority`, if present, ∈ `SPECIALIST_OPTION_AUTHORITIES = author, planner, user` (`types.ts:72`, `sdk.ts:261-265`);
- **`authority: "planner"` is only legal when the option is genuinely boundable** (`:266-269`), per `isPlannerTunable` (`types.ts:164-168`): a `number` **with a `maximum`**, or a `string-list` **with a non-empty `default`**. Otherwise the definition is rejected with the message *"cannot use authority \"planner\": it requires a number with a maximum, or a string-list with a non-empty default to narrow"*. The rationale comment is at `sdk.ts:257-260`.

Per-type option fields (`types.ts:99-151`): `string` → `pattern?`, `maxLength?`, `placeholder?`; `text` → `maxLength?`, `placeholder?`; `number` → `minimum?`, `maximum?`, `integer?` (defaults to integer-required, `sdk.ts:354`); `boolean` → nothing extra; `enum` → `options`; `string-list` → `maxItems?`. All types also accept `title`, `description?`, `default?`, `authority?`. Runtime coercion of a supplied value is `normalizeOptionValue` (`sdk.ts:335-373`) — note `text` ignores `pattern`, and `string-list` validates only element type + `maxItems` (no per-item pattern/length).

`SpecialistToolContext` (the `createTools` argument, `types.ts:218-230`): `taskId`, `specialistId`, `options`, `cwd`, `workspaceDir?`, `artifactStore`, `executionLog?`, `enabledGroups`, `disabledGroups`.

Also exported for module authors: `SPECIALIST_MODULE_API` (`sdk.ts:385-392`) = `{ Type, defineTool, defineSpecialist, defineSpecialistTool, toolGroups: SPECIALIST_TOOL_GROUPS, defaultBudget: DEFAULT_SPECIALIST_BUDGET }`, and `defineSpecialistTool` (`:376-378`).

### 7.2 `SPECIALIST_TOOL_GROUPS` and the definitive group → tool-name mapping

The 11 groups, verbatim from `src/specialists/types.ts:10-22`:

```ts
export const SPECIALIST_TOOL_GROUPS = [
  "sandbox",
  "research",
  "browser",
  "artifact",
  "evidence",
  "connectivity",
  "network_diagnostics",
  "fofa",
  "beekeeper",
  "credentials",
  "submit"
] as const;
```

`submit` is `PROTECTED_SPECIALIST_TOOL_GROUP` (`types.ts:27`) and can never be disabled — attempting it yields diagnostic `specialist_tool_group_protected` (`tools.ts:42-48`), as does denying `task_result_submit` by name (`tools.ts:93-98`).

Assembly happens at exactly two call sites: `executorToolBindings` (`src/agents.ts:265-300`) and `createTaskRuntimeToolBindings` (`src/controller.ts:3163-3188`). The full mapping:

| Group | Tool names | Source |
|---|---|---|
| `sandbox` | `read`, `bash`, `grep`, `find`, `ls` | `agents.ts:273` → `sandbox.createTools()`; Docker list at `executor-sandbox-docker.ts:561-...` (read, bash, docker-grep, find, ls); host list at `executor-sandbox.ts:164-215`. Pi builtin names confirmed at `node_modules/.../core/tools/index.js:17` |
| `research` | `web_fetch`, `web_search`, `vulnerability_search` | `agents.ts:274` → `createExecutorResearchTools()`, `agents.ts:112-118`; names at `research-tools.ts:55`, `:78`, `:99` |
| `browser` | `browser_render` | `agents.ts:275`; name at `browser-tools.ts:47` |
| `artifact` | `artifact_read`, `artifact_write` | `agents.ts:277-296` (two bindings); names at `src/tools/pi-tools.ts:1113`, `:1260` |
| `evidence` | `evidence_list`, `evidence_read` | `controller.ts:3183-3186` **and** `agents.ts:156-159` (standalone runtime); names at `pi-tools.ts:946`, `:988` |
| `connectivity` | `route_open`, `route_status`, `route_stop`, `route_reconnect` | `controller.ts:3169` → `createTaskConnectivityTools` (`:3141-3151`); names at `connectivity-tools.ts:18`, `:38`, `:49`, `:60` |
| `network_diagnostics` | `network_status`, `icmp_echo` | `controller.ts:3170-3172`; names at `network-diagnostics-tools.ts:16`, `:23` |
| `fofa` | `fofa_account_info`, `fofa_search`, `fofa_search_next`, `fofa_stats`, `fofa_host_aggregate`, **`validate_candidate_asset`** | `controller.ts:3173-3176` — two bindings, the second being `createTopologyValidationTool()`; names at `fofa-mcp-tools.ts:25,32,48,61,75` and `topology-validation-tool.ts:9`. **Yes: `validate_candidate_asset` is in group `fofa`, not a group of its own.** |
| `beekeeper` | `query_credentials`, `store_credential`, `mark_credential_invalid` | `controller.ts:3177-3179`; names at `beekeeper-mcp-tools.ts:18`, `:35`, `:52` |
| `credentials` | `credential_query`, `credential_read`, `credential_store`, `credential_invalidate`, `credential_list_by_role` | `controller.ts:3180-3182`; names at `credential-tools.ts:18`, `:37`, `:50`, `:75`, `:88` |
| `submit` | `task_result_submit` | `agents.ts:298`; name at `pi-tools.ts:268`. Protected. |

Group totals: 5 + 3 + 1 + 2 + 2 + 4 + 2 + 6 + 3 + 5 + 1 = **34 tools** for a `general` Specialist with every runtime enabled.

Conditional availability (a group can be present in the enum but empty at runtime):
- `connectivity`, `network_diagnostics`, `fofa`, `beekeeper`, `credentials` are all bound **only if** the corresponding runtime was constructed. `controller.ts:3169` (`this.connectivityRuntime`), `:3170` (same), `:3173` (`this.fofaRuntime`), `:3177` (`this.beekeeperRuntime`), `:3180` (`this.credentialMcpRuntime`). FOFA additionally requires `FOFA_API_KEY` (§2.3) and a machine-readable scope (test "Controller skips FOFA when the Agent scope has no machine-readable asset").
- `createTaskRuntimeToolBindings` is injected as `additionalToolBindings` at `controller.ts:3543` and `:3620`, and spliced in at `agents.ts:297` *before* the `submit` binding.

The selection algorithm is **subtractive and cannot widen**: `applySpecialistToolPolicy` (`specialists/tools.ts:28-106`) drops disabled groups first, then applies the `deny` list, then the `allow` list, with `submit` exempt from all three (`:60-73`). Unknown allow/deny entries produce `specialist_tool_name_unknown` diagnostics (`:77-92`). Order of the returned group lists is normalised to `SPECIALIST_TOOL_GROUPS` order (`:101-102`).

### 7.3 Currently registered builtin specialists

`src/specialists/builtin/index.ts:9-14`:

```ts
export function builtinSpecialists(): SpecialistAgentDefinition[] {
  return [generalSpecialist, bruteforceSpecialist];
}
```

**Exactly two.**

| id | File | Lines | Purpose (one line) |
|---|---|---|---|
| `general` | `src/specialists/builtin/general.ts` | 22 | The default fallback: full tool surface, empty prompt extension, `skills: { mode: "auto" }`, `DEFAULT_SPECIALIST_BUDGET`. Named `"通用 Executor"`. It is the only entry in `REQUIRED_SPECIALIST_IDS` (`index.ts:14`) and is **excluded from the Planner catalog** (`controller.ts:4283`). |
| `bruteforce` | `src/specialists/builtin/bruteforce.ts` | 190 | Material-driven credential attack: identifies the auth surface from any material (raw HTTP request, curl command, login URL, partial credentials, hash, banner), runs controlled guessing, and produces hit credentials + failure boundaries + lockout risk. |

`bruteforce`'s declared envelope, for reference when writing a sibling recon specialist:

```
:104-109  tools: { disableGroups: ["fofa", "beekeeper", "network_diagnostics"] }
:110-113  skills: { mode: "allowlist", allow: ["password-attack","web-login-bruteforce","default-credentials","credential-stuffing"] }
:114-119  budget: { defaultMaxTurns: 18, maxTurnsCeiling: 30, epochTurnSlice: 14, epochTimeShare: 0.7 }
:120-122  concurrency: { maxParallelTasks: 1 }
:127      optionsMode: "planner"
:128-189  options: material(text,user) materialRef(string,user) knownCredentials(text,user)
                   threads(number,1-8,default 4) maxAttemptsPerAccount(number,1-100,default 20)
                   maxTotalAttempts(number,1-2000,default 200) stopOnLockout(boolean, authority:"author")
```

Note it disables **`fofa`** — so the only shipped non-general specialist deliberately gives up external attack-surface search. That is a strong signal that external recon has no owner today.

`templates/specialists/` ships two **project-level** (not builtin) examples: `example-module/` (`index.mjs` + `specialist.json`) and `recon-lite/` (`specialist.json` + `prompt.md`). Project specialists are discovered from `<cwd>/.agents/specialists/<id>/` (`registry.ts:417-453`, requiring `specialist.json` whose `id` must equal the directory name, `:486-493`). `.agents/specialists/` does **not** exist in this repo, so neither template is loaded.

---

## 8. PLANNER VISIBILITY

### 8.1 The data path

1. `specialistRegistry.catalog()` (`src/specialists/registry.ts:241-267`) filters to `enabled && valid && introspected` (`:245`) and projects each into a `SpecialistCatalogEntry` (`:253-265`): `id`, `name`, `description`, optional `whenToUse`, `budget`, `skillMode`, `disabledToolGroups`, optional `maxParallelTasks`, optional `tunableOptions`.
2. `Controller.plannerSpecialistCatalog()` (`src/controller.ts:4281-4293`) calls it and **filters out `general`**, returning `[]` and logging `specialist_catalog_failed` on error.
3. It is passed into `renderPlannerInput({ ...input, plannerDecisionView, specialistCatalog, ... })` at `src/controller.ts:3977` / `:3987`.
4. Rendered in `src/prompts.ts:285-287`:

```ts
  const specialistCatalog = input.specialistCatalog && input.specialistCatalog.length > 0
    ? `<available_specialists format="compact-json">\n${stableCompactJson(input.specialistCatalog)}\n</available_specialists>\n\n`
    : "";
```

and interpolated at `:288` as `${fixedContext}${specialistCatalog}${continuationContext}<planner_state …`.

**So `available_specialists` is emitted only when at least one non-`general` specialist exists.** With today's two builtins, the block renders exactly one entry (`bruteforce`) — and `general` is reachable only by *omitting* the `specialist` field.

### 8.2 What exactly is rendered

The literal keys of each entry, i.e. what the Planner sees per specialist:

```
id, name, description, whenToUse?, budget{defaultMaxTurns,maxTurnsCeiling,epochTurnSlice,epochTimeShare},
skillMode, disabledToolGroups[], maxParallelTasks?, tunableOptions?
```

and each `tunableOptions` element (`types.ts:201-212`):

```
key, type("number"|"string-list"), title, description?, minimum?, maximum?, allowed?, current?, hint
```

Crucially: **no prompt text, no option specs beyond the boundary, no enabled-tool list** — only `disabledToolGroups` (the comment at `types.ts:314` says "no option specs, no prompt text"). The `hint` is the machine-readable instruction for filling the value (`types.ts:210-211`).

`tunableOptions` is computed by `plannerTunableOptions(resolved.policies)` from `resolveSpecialistOptions` (`registry.ts:250-252`), and only options with **effective `planner` authority** appear (`types.ts:196-199`: *"Only `planner` authority options appear here: the author's capability decisions and the operator's own parameters stay out of the Planner's writable view."*).

The write path is validated twice. In `planner-commands.ts:213-214` the `specialist` and `specialistOptions` fields are normalised (`normalizeSpecialistId` requires `isSpecialistId`; `normalizeSpecialistOptions` requires an object of string/number/boolean/string-array, `:232-245`). Then `src/controller.ts:4245-4277` re-checks against the live catalog and **rejects the whole decision** rather than silently dropping keys:

```ts
      const allowed = new Set(
        (catalog.find((entry) => entry.id === id)?.tunableOptions ?? []).map((option) => option.key)
      );
      const rejected = [...keys].filter((key) => !allowed.has(key));
      if (rejected.length > 0) {
        problems.push(
          `${id} does not accept Task-level option(s) ${rejected.join(", ")}; `
          + `its tunable options are ${[...allowed].join(", ") || "none"}`
        );
      }
```

That surfaces to the Planner as a repair cycle naming the available ids. This is why `prompts.ts:50-51` instructs the Planner to use only published keys.

### 8.3 What the Planner prompt says about specialists

`src/prompts.ts:43-52`, verbatim (`# Specialist Selection`):

> - available_specialists 列出当前可用的专精 Agent（id、用途、适用边界、默认预算、被裁剪的工具组、并发上限）。创建 Task 时用 create_tasks 的 specialist 字段指定拥有者；省略表示 general（通用 Executor）。
> - 选择依据是 Task 的因果工作流本身，不是技术阶段或关键词。只有某个 Agent 的 whenToUse 明显覆盖该 Task 的主要工作、且它的工具与预算更适合时才指定；不确定时省略，不要为了"看起来更专业"而指派。
> - 只能使用 available_specialists 中出现的 id。未知、已禁用或无效的 id 会被 Runtime 拒绝，浪费一个决策周期。
> - Agent 的预算字段是默认值与上限，不是承诺：你可以给出更小的 budget.maxTurns，但会被该 Agent 的 maxTurnsCeiling 收窄；不会因为换了 Agent 就突破运行级预算。
> - Task 的拥有者创建后固定。需要换 Agent 时，按 Task Semantics 完成或归档当前 Task，创建后继 Task 承载新工作流。
> - 被裁剪的工具组表示该 Agent 看不到这些工具。不要给需要信息搜集能力的 Task 指定工具面被裁剪到无法完成它的 Agent。
> - available_specialists 中该 Agent 的 tunableOptions 列出**本 Task 可以指定**的参数：只有这些 key 能出现在 create_tasks 的 specialistOptions 中，其它 key 属于 Agent 作者固定的能力边界或运行前已确定的配置，会出现被拒绝并浪费一个决策周期。
> - specialistOptions 的取值必须落在 tunableOptions 给出的边界内；越界值会被 Runtime 收窄并记录诊断，所以宁可保守取值。省略某个 key 表示采用当前生效值，这通常是正确选择——只在目标特征明确要求更小强度（例如服务脆弱、锁定策略严格）时才收窄。
> - 不要用 specialistOptions 表达任务目标或目标资产：目标、材料与 scope 通过 goal、targetRefs、successCriteria 与 dependsOnTaskRefs 表达。

Line 49 (`被裁剪的工具组…信息搜集能力…`) is the only place in the Planner prompt that uses the phrase 信息搜集 in the context of **specialist selection** — and it is phrased as a *warning*, not as an instruction to plan recon.

### 8.4 What the Planner prompt says about reconnaissance / information gathering today

This is the crux, so here is every relevant passage verbatim, with line numbers.

**a) Recon is explicitly *not* a Task boundary — `prompts.ts:16`:**

> 3. Task 是一条由同一个 Executor 持续拥有的因果工作流，不是侦察、验证、利用等技术阶段。初始知识不完整时可以创建宽但可判定的工作流目标；新事实揭示同一资产、状态或攻击链上的必要结果时，向原 Task 追加 objective。只有工作拥有独立结果所有权，能够与当前 Task 分开调度、停止、失败或重试时才创建新 Task。工具、payload、参数或技术阶段变化属于 Executor。

Reinforced by the negative example at `:76`:

> 错误：把"侦察转利用"当成新 Task，或完成一个仍为 partial 的 Task 后转移 Context。

and at `:88`:

> 错误：为同一攻击链中依赖共同登录态的侦察和利用分别创建并行 Task。

**b) The Planner is told *not* to do recon itself — `:11`:**

> Task Graph 是这些规划决定的持久表达，不是规划目的。你决定"接下来完成什么以及为什么"；Executor 决定"具体怎么完成"。你不重新调查目标，不设计或复核请求、payload、脚本和利用方法。

and `:14`:

> 默认只根据 Planner State 中的 Task definition、TaskOutcome、EpochOutcome、图摘要和运行状态决策。TaskOutcome 是 Executor 的主要规划交接；Projector 图是持久观察的语义解释，不要求你重演调查。

**c) The only *positive* recon instruction is for FOFA candidates — `:41`:**

> - FOFA topology 中 classification=candidate_only 且 validationStatus=pending 的子站、旁站、CNAME、证书关联主机必须先创建一次低风险验证 Task；验证仅限 DNS、HTTP、TLS、CNAME 和 redirect，不得直接漏洞扫描、目录枚举、登录或利用。验证结果由 Observer 以 evidenceRefs 更新现有 Operation Graph，不能扩大授权 Scope。

Note the **prohibitions** are explicit: no vulnerability scanning, no directory enumeration, no login, no exploitation on those assets. Only `DNS, HTTP, TLS, CNAME, redirect`.

**d) The only scope-expansion rule for discovered assets — `:40`:**

> - 网络观察中的地址不自动扩展授权。只有持久 Evidence、Session 或 Route 能证明资产由根入口派生且属于授权环境时，才能为其创建操作 Task。

**e) Open-set / exhaustiveness doctrine that bears directly on enumeration — `:20`:**

> 7. 数量、时间和有限尝试只表示投入边界，不证明开放候选空间穷尽。Root Goal 的"全部""所有""每个"按开放集合处理，除非持久材料给出可验证的封闭边界。

**f) Initial planning with no information — `:91-95`:**

```
<example name="initial-planning">
输入：只有 Root Goal、授权 Scope 和一个尚未理解的目标。
正确：创建一个入口认知 Task，先获得能够决定后续规划的目标状态。
错误：没有独立资产或证据就按漏洞类别批量创建猜测性 Task。
</example>
```

That `入口认知 Task` ("entry cognition Task") is the closest thing to a recon Task the Planner is told to create — and it is deliberately named as a *cognitive* task, not a reconnaissance phase.

**g) The Planner's knowledge limitation about vulnerabilities is stated at `:21`:**

> 8. 已确认产品或版本但漏洞情报覆盖为空时，可以规划研究与目标验证 Task；情报检索和适用性验证由 Executor 完成，检索命中本身不是目标漏洞事实。

**h) Executor-side recon guidance (which the Planner's decisions must be consistent with), `prompts.ts:104`:**

> 2. 优先复用 DEPENDENCY_OUTCOMES、图切片和当前 Session 中已经验证的 Session、Credential、Endpoint、漏洞原语与 artifact；除非有失效证据，不重新侦察同一入口。

**i) Executor-side network-scope doctrine, `:118` and `:120`:**

> - 不得使用授权范围外的公网主机作为网络正对照；它们会被 Scope Guard 有意阻断，超时或拒绝不能用于判断任务是否具备出网能力。

> - 只有 Runtime 明确报告 TCP 数据面健康，且对授权目标的实际 TCP 探测仍无响应时，才可把 filtered/timeout 记录为目标侧观察；否则应报告对应的结构化网络故障，不得归因于目标。

**Summary of the Planner's current belief about recon:** it treats reconnaissance as (1) *not a phase* and never a reason to create or split a Task, (2) something the Planner itself must not perform, (3) something the Executor does implicitly inside whatever causal workflow it owns, (4) for FOFA-discovered candidates only, a tightly-bounded five-check validation with enumeration and scanning explicitly forbidden, and (5) never a licence to widen the authorised scope. There is currently **no instruction anywhere in `PLANNER_SYSTEM_PROMPT` telling the Planner that an asset-discovery or attack-surface-expansion step might be needed at all** — the only mention of 信息搜集 is the warning at `:49` not to assign such a Task to a specialist whose tools were cut.

---

## 9. EXISTING RECON BEHAVIOUR

### 9.1 What the prompts tell an agent to do today

Searched `src/prompts.ts` and `src/specialists/builtin/*.ts` for 侦察/信息搜集/子域/subdomain/指纹/fingerprint/枚举/enumerate/DNS/whois/certificate.

**Subdomain enumeration: the string 子域 appears exactly once, and only as a prohibition — `prompts.ts:41`:**

> FOFA topology 中 classification=candidate_only 且 validationStatus=pending 的子站、旁站、CNAME、证书关联主机必须先创建一次低风险验证 Task；验证仅限 DNS、HTTP、TLS、CNAME 和 redirect，不得直接漏洞扫描、目录枚举、登录或利用。

**DNS resolution: three places, all framed as boundedly-scoped verification, never as enumeration.**

`prompts.ts:41` (above) is the Planner rule. `prompts.ts:128` is the Executor rule:

> - 若当前 Task 是 FOFA 候选资产验证，只使用 validate_candidate_asset 执行 DNS、HTTP、TLS、CNAME 或 redirect 的低风险检查；验证成功也不得把 active_testing_allowed 改为 true 或扩大授权范围。

`prompts.ts:600` is the Projector rule, which also **forbids** these signals from widening scope:

> DNS、HTTP、TLS、CNAME 或 redirect 验证事件只能补充 validationSignals、validated_by 和 validationStatus，不能扩大授权 Scope。

**Service fingerprinting: there is no instruction to fingerprint.** The closest is `prompts.ts:105`, which assumes a fingerprint already exists and routes it to vulnerability intelligence:

> 3. 当产品、框架、插件或版本已经由直接观察稳定识别，且漏洞情报能够明显缩小搜索空间、当前又没有更接近 successCriteria 的已验证路径时，使用 vulnerability_search 检索历史漏洞、受影响版本和利用前置条件，必要时用 web_fetch 读取最相关来源。公网结果只生成待验证 Hypothesis，必须回到目标侧验证适用性；检索空结果是弱反证，源失败不是负面证据。

**Searching public sources: two instructions, both vulnerability-intelligence-shaped, never asset-discovery-shaped.** `prompts.ts:105` above, and `prompts.ts:21`:

> 8. 已确认产品或版本但漏洞情报覆盖为空时，可以规划研究与目标验证 Task；情报检索和适用性验证由 Executor 完成，检索命中本身不是目标漏洞事实。

**The nearest thing to a recon methodology in the whole repo** is the *template* prompt `templates/specialists/recon-lite/prompt.md`, which is **not loaded** (no `.agents/specialists/` directory) and is only a scaffold. Verbatim:

```
# 使命
你只做信息搜集与资产确认，为后续任务建立可判定的基线；不做利用、不投递凭据、不改动目标状态。

# 方法
1. 先固定授权范围：只处理 Scope 中已确认的资产，观察到的新地址只作为候选记录，不自动扩大范围。
2. 由外向内建立层次：可达性 → 端口与服务 → 应用指纹与入口 → 目录/参数结构。每一层都要有可复核的判定信号。
3. 每一轮只回答一个问题，并保留输入、判定信号与结论；相同输入重复扫描不算进展。
4. 主动限制强度：扫描速率、并发与字典规模以"不造成可用性影响"为上限；遇到限流、封禁或服务异常立即降速并记录边界。
5. 产出资产清单、未确认候选与阻断点；不确定的结论标记为候选而不是事实。
6. 补充说明：{{options.scopeNote}}
```

Its manifest (`templates/specialists/recon-lite/specialist.json`) is the design template for exactly the agent you are considering — and note what it gives up:

```json
  "tools": { "disableGroups": ["fofa", "beekeeper", "credentials", "connectivity", "network_diagnostics"] },
  "skills": { "mode": "allowlist", "allow": ["port-scan", "subdomain-enum", "fingerprint"] },
  "budget": { "defaultMaxTurns": 6, "maxTurnsCeiling": 10, "epochTurnSlice": 5, "epochTimeShare": 0.15 },
  "concurrency": { "maxParallelTasks": 2 },
```

Three of its four allowlisted skills **do not exist** (`port-scan`, `subdomain-enum`, `fingerprint` are not in `.agents/skills/`, which holds only `credential-stuffing`, `ctf-web`, `default-credentials`, `password-attack`, `web-login-bruteforce`). The scaffold's own trailing HTML comment warns about exactly this, and `bruteforce.ts:98` names the omission outright: *"不适用于：完全没有目标线索（先做信息搜集）"* — the shipped bruteforce specialist explicitly disclaims recon as out of scope.

So: **the system today teaches agents to verify FOFA-discovered candidates with five bounded checks and nothing more. It never teaches subdomain enumeration, DNS record enumeration, service fingerprinting as a discovery step, or public-source asset search.**

### 9.2 Existing tests that assert recon behaviour

One line each. Format `<path>` — assertion focus.

**Scope**
- `test/scope.test.ts` — 8 cases: CTF default `0.0.0.0/0`; apex+subdomain inclusion; wildcard excludes the apex and malformed candidates fail closed; CIDR canonicalisation; exact/wildcard domain normalisation; malformed-domain rejection; literal-IP extraction from a natural-language goal; **rejection of AI scope widening or invention**.
- `test/cli-scope-documents.test.ts` — merging repeated CLI scope files with manual scope.
- `test/scope-document-extractor.test.ts` — rule-based domain/CIDR extraction from document fragments.
- `test/scope-document-formats.test.ts` — per-format text extraction and the size/page limits.
- `test/scope-document-resolver.test.ts` — 6 cases incl. **"accepts AI candidates only when grounded in the referenced fragment"**, **"document resolver prompt forbids inferred scope expansion"**, bounded fragment rendering, and graceful degradation to a diagnostic.

**FOFA**
- `test/fofa-scope-policy.test.ts` — 6 cases: **positive anchor required in every OR branch**; wildcard and IDN boundaries; trusted opaque derived refs accepted but free-form identities not; URL and certificate anchors recognised but ICP not; **unrelated co-hosts classified candidate-only**; scope fingerprint stability.
- `test/fofa-query.test.ts` — 4 cases: OR preservation, NOT/AND/OR precedence with escapes, OR-branch distribution and group negation push-down, fail-closed on unsupported/excessive syntax.
- `test/fofa-config.test.ts` — 6 cases: disabled without a key, per-call clamp to the task limit, explicit opt-in for shenxd HTTP, bounded defaults for invalid integers, HTTPS enforcement with test loopback, no host-secret leakage into child env or redacted text.
- `test/fofa-client.test.ts` — 7 cases: shenxd routed through the PHP adapter, shenxd expired-card normalisation without credential leakage, all official endpoints called with encoded bounded parameters, rows rejected when they mismatch requested fields, non-retryable error mapping without leakage, 429/5xx retried twice with bounded backoff, timeouts retried but caller cancellation not.
- `test/fofa-mcp-runtime.test.ts` — 7 cases: shenxd unsupported tools rejected before startup and quota; trusted task context injected with Runtime-owned cursors; **quotas persisted and released only on definite pre-dispatch failure**; cursor expiry and explicit invalidation; single restart with no replay; cancellation propagation and idempotent close; resume keeps SQLite quota and rejects a prior-process cursor.
- `test/fofa-mcp-server.test.ts` — one case: five scope-aware tools exposed without leaking credentials.
- `test/fofa-mcp-tools.test.ts` — 2 cases: private MCP context hidden while a Task artifact is written; model text bounded while the artifact retains every record.
- `test/fofa-topology.test.ts` — candidate side-site topology normalised with evidence.
- `test/controller-fofa.test.ts` — 5 cases: FOFA starts only after scope and is injected into Task Executor tools; normal tools retained when FOFA is missing/malformed; **skipped when the scope has no machine-readable asset**; close + terminal-state cursor invalidation; operator-disabled FOFA honoured.

**Connectivity / network**
- `test/connectivity-tools.test.ts` — 4 cases: four route-lifecycle tools with no `route_forget`; `route_open` binds the route to the current task and returns stable refs; **`route_open` reserves the process-wide SOCKS5 proxy for operator configuration**; lifecycle tools call the Runtime rather than mutating the store.
- `test/network-diagnostics-tools.test.ts` — one case: structured health plus controlled ICMP are exposed.
- `test/controller-connectivity-boundary.test.ts` — 12 cases around single-owner runtime, operator-owned transparent proxy over the normalised root scope, executor quiesce before gateway drain, and cleanup retry semantics.
- `test/network-sandbox-manager.test.ts` — 20+ cases incl. **"network sandbox separates domain rules from CIDRs in the Gateway boundary"** (the §3.2/§3.4 split), gateway capability minimality, route replacement rollback, ownership/adoption refusals.
- `test/host-egress-broker.test.ts` — broker handshake/token and denied-target behaviour.
- `test/route-manager.test.ts` — route lifecycle and validation.
- `network-image/test_scope_dns.py` — the DNS proxy itself, incl. explicit `allow_unmatched = False` at `:64`/`:75` and `True` at `:89` — i.e. the §3.4 behaviour is directly unit-tested.
- `network-image/test_index_server.py` (35 KB) — gateway firewall, `authorize_domain_address`, epoch/capture, `icmp_echo` scope blocking.
- `network-image/gateway-tun/route_proxy_test.go` — incl. `TestRouteDialerRejectsDirectDestinationOutsideAuthorizedScope`.

**Research / browser**
- `test/research-tools.test.ts` — 7 cases: bounded readable extraction; **private destinations and private redirects rejected**; Brave used when keyed; Bing fallback when DuckDuckGo is unavailable; vulnerability search combines NVD with public leads; non-vulnerability pages ignored; empty public coverage treated as weak negative evidence.
- `test/browser-tools.test.ts` — 7 cases: http/https only; bounded isolated headless profile; **Docker isolation without injecting a proxy**; explicit env override for the Chrome path; non-HTTP URLs rejected before launch; truncation reported with post-JavaScript DOM returned; failures surfaced instead of empty success.

**Skills / specialists**
- `test/skill-registry.test.ts` — 3 cases: missing root is an empty registry; discovery + escaping-symlink rejection + persisted enablement; `resolveSelection` applies validity/enablement/allowlist/denylist.
- `test/skill-selector.test.ts` — 3 cases: model selection validated against the registry; no model call when nothing is eligible; the submit tool is terminating and bounded.
- `test/controller-skills.test.ts` — one case: selected skill directories are resolved with fallback to none.
- `test/specialist-sdk.test.ts` — `defineSpecialist` validation, incl. the planner-authority constraints.
- `test/specialist-registry.test.ts` / `test/specialist-options.test.ts` / `test/controller-specialists.test.ts` — registry discovery/state, option authority clamping, and Task-level specialist resolution.
- `test/prompts.test.ts` — prompt rendering, incl. `available_specialists`.

**No test anywhere asserts subdomain enumeration, WHOIS/RDAP, certificate-transparency lookup, or a structured DNS-record tool — because none of those capabilities exists.**

---

## 10. GAPS

For each gap: the concrete missing capability, the closest existing thing, and precisely why the existing thing is insufficient.

### 10.1 No passive/active subdomain enumeration of any kind
- **Closest existing:** the `DOMAIN` regex in `src/scope-documents/scope-candidate-extractor.ts:5`, and `dig` in the executor image.
- **Insufficient because:** the extractor only reads *scope authorisation documents* the operator supplied — it never queries a source of truth. `dig` is a raw resolver, so enumerating with it means brute-forcing a wordlist, which needs a wordlist (not shipped) and produces one DNS lookup per candidate with no dedup, no wildcard-detection, and no record-type awareness. There is no brute-force, no certificate-transparency, no passive-DNS, and no permutation logic anywhere in `src/**`.
- **Also missing:** nothing in the codebase can *create* a scope entry from a discovery — `parseAuthorizedScope` is the only constructor and it is fed by CLI/goal/documents. So enumeration results can only ever become `candidate_only` graph nodes (`fofa-topology.ts:24-26`), never new scope.

### 10.2 No WHOIS / RDAP tool or module
- **Closest existing:** `whois` is in `EXECUTOR_TOOL_PROBE_LIST` (`executor-environment.ts`) and, as of 2026-09-17, installed in the executor image.
- **Insufficient because:** it is unstructured text, with no schema, no caching, no rate-limit handling, and no registrant-redaction awareness. *(Correction 2026-09-17: this note previously also claimed the image did not install `whois`, making the probe list a stale union that advertised a tool the container could not run. That mismatch is fixed — the image ships `whois`, and the build now asserts every advertised tool resolves on PATH, see §10.15.)*

### 10.3 No certificate-transparency tool, despite CT data already being an *authorisation anchor*
- **Closest existing:** `ANCHOR_FIELDS` includes `cert` and `certs_subject_cn` (`fofa-scope-policy.ts:10-17`), and `FOFA_FIELDS` includes `certs_issuer_org, certs_issuer_cn, certs_subject_org, certs_subject_cn, tls_ja3s, tls_version, certs_valid` (`fofa-types.ts:41-43`).
- **Insufficient because:** this is a *filter* over FOFA's own index, not a CT lookup. It can only find certificates FOFA already saw, requires an FOFA key and quota (§2.3, §2.8), and cannot answer "what hostnames appear in this certificate" or "what certificates exist for this org" from crt.sh/CT logs directly. There is no crt.sh, no `ct`, no `certspotter` integration anywhere in the repo.

### 10.4 No structured DNS-record tool (MX / TXT / NS / SOA / SRV / CAA / PTR)
- **Closest existing:** `validate_candidate_asset` with `checks: ["dns","cname"]` (`topology-validation-tool.ts:24-29`), which calls **only** `resolve4` and `resolveCname` from `node:dns/promises` (`:3`, `:25`, `:27`).
- **Insufficient because:** it is hard-wired to two record types, it is bound to the **`fofa` group** so it disappears when the FOFA runtime is absent (`controller.ts:3176`) or when a specialist disables `fofa`, it runs on the **host** (so it resolves the *operator's* DNS, not the sandbox's scope-DNS), and it returns a flat `{dns, cname, http, tls, redirect}` object with no record-type generality. `resolveMx`, `resolveTxt`, `resolveNs`, `resolveSoa`, `resolveSrv`, `resolvePtr`, `resolveAny` are never imported anywhere in `src/**`. The in-container alternative is `dig`, whose output is unstructured text the agent must parse itself.

### 10.5 No port/service scanner as a tool, and no fingerprinting helper
- **Closest existing:** `nmap` in the executor image (and in `EXECUTOR_TOOL_PROBE_LIST`), driven through the generic `bash` tool.
- **Insufficient because:** there is no structured wrapper — no result parsing, no rate/concurrency control at the tool layer, no scope pre-check (the agent can `nmap` any CIDR the network layer permits), no fingerprint→CVE handoff, and no deduplication against the graph. The agent must construct and parse nmap invocations itself every time. Related: `maskscan`/`masscan` is not in the image; `nmap` is the only scanner available. There is also **no `dnsx`/`httpx`/`gobuster`/`ffuf`** in the image, so directory- and host-enumeration paths have no fast tooling.

### 10.6 No third-party attack-surface search other than FOFA
- **Closest existing:** `src/fofa/**` (§2).
- **Insufficient because:** it is a single provider with a single credential (`FOFA_API_KEY`), and under `FOFA_PROVIDER=shenxd` only `fofa_search` survives (`shenxd-adapter.ts:28-33`). There is no Shodan, Censys, ZoomEye, Quake, Hunter, VirusTotal, or SecurityTrails adapter. The `fofa-*` modules are, however, an excellent template: types/config/client/policy/topology/MCP-server/runtime/tools is the exact layering a second provider would need, and `FofaClient` is dependency-injected (`fofa-client.ts:14-17, 35-41`) so it is straightforward to mirror.

### 10.7 No F-points (provider cost) budget
- **Closest existing:** `consumedFpoints` is parsed (`fofa-client.ts:235`) and surfaced (`fofa-mcp-tools.ts:117`), and `fofa_points_insufficient` is a mapped error (`fofa-types.ts:9`).
- **Insufficient because:** §2.8 — the runtime budgets *result counts* and *aggregation counts*, never points. A recon specialist that must run many expensive queries has no way to declare "do not spend more than N F-points", and the only feedback is a hard provider error after the spend.

### 10.8 No scope check inside the browser tool
- **Closest existing:** the Gateway firewall + scope DNS (§3.2, §3.4) and, on the research side, `validatePublicUrl` (§5.4).
- **Insufficient because:** §4.4 — `browser_render` accepts any http/https URL and relies entirely on the network layer. In `0.0.0.0/0` scope (the CTF default) there is no restriction at all. A recon specialist that browses discovered links needs a host-level check that the existing tool does not perform, and it needs the *complement* of `web_fetch`'s check (in-scope, not public-only).

### 10.9 No scope-aware "is this discovered asset in scope?" helper exposed to agents
- **Closest existing:** `authorizedScopeContainsDomain` / `authorizedScopeContainsIp` (`src/scope.ts:25`, `:38`).
- **Insufficient because:** both are pure functions with no tool wrapper, no graph awareness, and — critically — **no domain→IP resolution step**. A discovered hostname that is *not* an in-scope domain but *resolves into* an authorised CIDR cannot be tested by any existing helper: `authorizedScopeContainsDomain` fails on the name and nothing bridges name→address→CIDR. The Gateway does this implicitly (it authorises resolved IPs, §3.4), but no agent-visible function does, so an agent cannot reason about it or record the conclusion.

### 10.10 No recon-specific skills
- **Closest existing:** `.agents/skills/` holds `credential-stuffing`, `ctf-web`, `default-credentials`, `password-attack`, `web-login-bruteforce` — all offensive/post-access, all credential- or exploitation-focused.
- **Insufficient because:** §9.1 — nothing teaches enumeration methodology. The `recon-lite` template's allowlist (`port-scan`, `subdomain-enum`, `fingerprint`) refers to three skills that **do not exist**. The skill *format* is fully specified (§6.6), so this is authoring work, not a code change.

### 10.11 No registered recon specialist
- **Closest existing:** the unloaded `templates/specialists/recon-lite/` scaffold (§9.1).
- **Insufficient because:** `.agents/specialists/` does not exist, so the Planner's `available_specialists` block currently advertises **only `bruteforce`** (§8.1) — a specialist that explicitly disclaims recon in its own `whenToUse` (`bruteforce.ts:98`) and disables the `fofa` group (`:108`). The Planner therefore has no recon-capable owner to assign an asset-discovery Task to, while `prompts.ts:49` warns it not to assign such a Task to a tool-stripped Agent. Recon-lite as written would also be a poor fit: it disables `fofa`, `connectivity`, and `network_diagnostics` (`specialist.json` `tools.disableGroups`), which strips `validate_candidate_asset`, all route tools, `network_status`, and `icmp_echo`, leaving it with only `sandbox` + `research` + `browser` + `artifact` + `evidence` + `submit`.

### 10.12 No passive-source / archive lookup
- **Closest existing:** `web_search` / `web_fetch` (`research-tools.ts`) can reach public archives as *pages*.
- **Insufficient because:** there is no Wayback/Common Crawl/`urlscan.io`/`gau`/`waymore` integration, no URL-history extraction, and no JS-file harvesting. `web_fetch` is bounded to 12 000 chars of readable text by default (`research-tools.ts:13`) and returns Markdown, so it is the wrong shape for bulk URL harvesting.

### 10.13 ASN / netblock / BGP lookup
- **Closest existing:** `as_number` and `as_organization` are `FOFA_FIELDS` (`fofa-types.ts:39`).
- **Insufficient because:** these are *columns on FOFA records*, not a lookup by ASN or netblock. There is no prefix-to-ASN mapping, no "what netblocks does this org own" query, and no route/WHOIS-based netblock expansion. Combined with §1.7, a discovered netblock has no way to become authorised scope.

### 10.14 No screenshot / visual reconnaissance
- **Closest existing:** `browser_render` returns `--dump-dom` only (§4.2), and the image ships `imagemagick` + `tesseract`.
- **Insufficient because:** there is no `--screenshot` invocation and no image is returned to the model, so the OCR/ImageMagick capability in the image is unusable for visual fingerprinting without the agent hand-rolling it through `bash` and then having no way to view the result.

### 10.15 The tool-probe list advertised tools the image did not ship — **fixed 2026-09-17**
- **Evidence (as of the original survey):** `EXECUTOR_TOOL_PROBE_LIST` (`executor-environment.ts:25-30`) listed `whois, hydra, john, hashcat, gdb, objdump, sqlmap, go, npm, gcc, make, unzip, tar, pip, ncat, strings, file, xxd, base64, python`; the image label (`executor-image/Dockerfile`) advertised only `bash, chromium, curl, dig, git, imagemagick, ip, iptables, jq, nc, nmap, node, openssl, python3, tesseract, wget`.
- **Two distinct mechanisms, worth separating:** for **Docker** mode the facts block reads the *image label* (`inspectDockerImageFacts`) and requires `version ∈ {1,2} && uid === 1000 && rawSockets === false`; the probe list is used for the shell loop in **host** modes (`probeShellLoop`) and as the result filter in both. So in Docker the agent is told the truth, while the probe list was a stale union. The **image label remains the authority**; add a tool to the Dockerfile rather than to the probe list.
- **Fix:** the executor image now actually installs the credential-attack and inspection toolchain (`hydra`, `medusa`, `hashcat` with `ocl-icd-libopencl1` + `pocl-opencl-icd`, `sqlmap`, `ffuf`, `gobuster`, `dirb`, `crunch`, `gcc`, `make`, `binutils`, `xxd`, `unzip`, `whois`, `ncat`), the label is schema version 2 and also carries the shipped wordlist paths, and the **build fails** if any advertised tool is not on PATH or any advertised wordlist is missing. Two measured traps are encoded in the image: hashcat resolves its state directory through `getpwuid()` rather than `$HOME` (so the `agent` home is `/workspace/home`, the writable bind mount) and is inert without an ICD loader. `test/executor-image-contract.test.ts` keeps the label and the build assertion from drifting.
- **Consequence for recon (updated):** still no `dnsx`, no `httpx`, no `nikto`, no `whatweb`, no `wafw00f`, no `nuclei`, no `openssl s_client` wrapper (openssl is present but unwrapped), and no Python HTTP/JSON libraries beyond stdlib. As of 2026-09-17 there *is* `ffuf` / `gobuster` / `dirb` plus a bounded path wordlist; `nmap` + `dig` + `curl` + `python3` + `chromium` remain the core recon primitives. `john` is deliberately absent: Debian packages the non-jumbo build, which cannot read raw hashes and ships none of the `*2john` extractors.

### 10.16 No bounded enumeration-manifest or dedup support at the tool layer
- **Closest existing:** the *prompt* doctrine at `prompts.ts:114` requires the Executor to write "实际候选、每项输入和结果" into a workspace manifest, and `prompts.ts:20` / `:111` forbid treating a bounded attempt as an exhaustive result.
- **Insufficient because:** this is purely an instruction with no tooling — no manifest schema, no dedup helper, no graph-node dedup for discovered hosts (beyond `stableOperationIdentityId` in `fofa-topology.ts:23`), and no resume-from-manifest. A recon specialist that must run thousands of candidates needs this to be mechanical rather than prose.

---

## Appendix — Highest-value reuse points for a new internet-information-gathering specialist

Ranked by how much work they save, with the exact symbol to reuse.

1. **`FofaScopePolicy`** (`src/fofa/fofa-scope-policy.ts:19`) — the whole "prove this query/asset is scope-anchored, then classify every result" pattern, including the per-OR-branch anchor rule and the `in_scope` / `candidate_only` split. A second provider should reuse the class, not reimplement it.
2. **The FOFA layering** (types → config → client → policy → topology → MCP server → runtime → Pi tools) as the template for any new external intelligence provider, including the `fofaChildEnvironment` env allowlist (`fofa-config.ts:62-87`), `redactFofaSecret` (`:89-102`), and the trusted-context fingerprint handshake (`fofa-server.ts:158-164`).
3. **`normalizeFofaTopology`** (`src/fofa/fofa-topology.ts:8`) — the Host/Port/Service/WebEndpoint + `candidate_for`/`resolves_to`/`has_alias` projection with `validationStatus: "pending"` and `active_testing_allowed: false`.
4. **`validate_candidate_asset` / `validateCandidate`** (`src/tools/topology-validation-tool.ts:7`, `:20`) — the bounded five-check validation the Planner prompt already mandates at `prompts.ts:41`; extend it rather than adding a parallel tool.
5. **`createExecutorFofaTools`'s `presentResult`** (`src/tools/fofa-mcp-tools.ts:90`) — artifact-full / model-preview-split with a hard byte budget. Any tool returning many records should copy this.
6. **`boundedLimit` + `reserveFofaQuota`** (`src/mcp/fofa-runtime.ts:498`, `:130`) — the per-call/per-task reservation with real-usage refund.
7. **`authorizedScopeContainsDomain` / `authorizedScopeContainsIp`** (`src/scope.ts:25`, `:38`) — the matching kernel, already mirrored in Python at `network-image/scope_dns.py:63-72`; keep the three implementations in step.
8. **The skill format** (§6.6) and `SkillRegistry` (`src/skills/skill-registry.ts:36`) — a recon skill needs zero code, only a `SKILL.md`.
9. **`defineSpecialist`** (§7.1) and the `bruteforce` builtin as a working worked example of options, authority pinning, budget, and skill allowlisting.
10. **`templates/specialists/recon-lite/`** — the intended shape of the new specialist, but it needs its `disableGroups` reconsidered (§10.11) and its skill allowlist repointed at real skills (§10.10).
