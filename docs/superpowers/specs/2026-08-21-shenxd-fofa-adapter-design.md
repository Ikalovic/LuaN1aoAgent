# Shenxd FOFA Adapter Design

## Goal

Add a minimal optional adapter that lets the existing FOFA MCP `fofa_search` tool use a Shenxd-compatible PHP proxy endpoint without weakening the existing Scope, quota, Artifact, role-isolation, or credential-redaction boundaries.

## Scope

The adapter supports only `fofa_search`. The existing MCP server continues to expose its stable five-tool surface, but `fofa_account_info`, `fofa_search_next`, `fofa_stats`, and `fofa_host_aggregate` return the stable `fofa_plan_unsupported` error while this provider is selected.

No generic provider framework, local reverse proxy, browser-login automation, or third-party response caching is added.

## Configuration

The adapter is selected only when all of the following host environment variables are present:

```env
FOFA_PROVIDER=shenxd
FOFA_API_BASE_URL=http://map.shenxd.top/fofa/test_fofa/fofa1_api.php
FOFA_ALLOW_INSECURE_HTTP=1
FOFA_API_KEY=<card value>
FOFA_EMAIL=<configured email when required>
```

`FOFA_PROVIDER` defaults to `official`. Official behavior remains unchanged. A remote HTTP URL remains rejected unless the provider is `shenxd` and `FOFA_ALLOW_INSECURE_HTTP` is exactly `1`. Loopback HTTP remains available under `NODE_ENV=test` for mock tests.

The card value and email are never stored in source code, documentation, Git, Executor context, Task Artifacts, or ordinary runtime events.

## Request Mapping

For `fofa_search`, the adapter sends one GET request directly to the complete PHP endpoint. It uses the existing client inputs and maps them to:

- `qbase64`: UTF-8 FOFA query encoded as Base64.
- `email`: configured provider email when present.
- `key`: configured card value.
- `fields`: comma-separated allowlisted fields.
- `size`: Runtime-bounded result count.
- `full`: `true` or `false` for compatibility when requested.

The official provider continues to use `/api/v1/search/all` and all existing official endpoints.

## Response Mapping

The adapter accepts the same successful search shape already validated by `FofaClient`: an object containing `results`, with optional `size`, `total`, `next`, and consumed-point metadata. Each row must still match the requested field count.

Third-party error shapes using either `errmsg` or `message` are normalized. Messages indicating an invalid or expired API card map to `fofa_auth_failed`. Other provider errors remain redacted and cross MCP only as stable error codes and bounded messages.

## Security Boundaries

All existing protections remain authoritative:

- Every search branch must contain a positive authorized Scope anchor.
- Subdomains may be `in_scope`; unrelated co-hosted assets remain `candidate_only` with `active_testing_allowed:false`.
- Candidate results do not widen Scope.
- RuntimeStore atomically enforces per-call and per-Task quotas.
- The full result is written to a Task Artifact while the model receives a bounded summary.
- Only dynamic Task Executors receive the FOFA tools.
- Credential and authenticated URL values are redacted from errors and stderr.

Because this provider uses cleartext HTTP, activation requires the explicit insecure-transport opt-in. Documentation must warn that the service and network intermediaries can observe the card and query targets.

## Failure Behavior

- Missing opt-in for a remote HTTP endpoint: configuration rejection before any request.
- Unsupported tool under `shenxd`: `fofa_plan_unsupported`, no network request and no aggregation quota consumption.
- Invalid or expired card: `fofa_auth_failed`, with no credential reflection.
- Malformed response: `fofa_response_invalid`.
- Timeout or transient HTTP failure: retain the existing bounded retry behavior.
- Cancellation: propagate the caller AbortSignal without replaying the cancelled call.

## Testing

Mock-backed tests must verify:

1. Provider selection and explicit HTTP opt-in.
2. Direct PHP endpoint parameter mapping without an appended official path.
3. Successful search response validation.
4. `message`-based invalid-card errors map to `fofa_auth_failed` without leaking credentials.
5. The four unsupported operations fail before network access.
6. Official-provider behavior and the existing FOFA MCP suites remain unchanged.

After mock and full regression suites pass, one opt-in live request with `size=1` may be executed through a no-proxy connection. The live credential is supplied through process stdin/environment only and is never committed.

## Acceptance Criteria

- `fofa_search` works against the configured Shenxd PHP endpoint.
- Existing Scope, candidate-only, quota, Artifact, role, cursor, and redaction guarantees remain intact.
- The four unsupported tools return a stable error without contacting the provider.
- Official FOFA remains the default and passes all existing tests unchanged.
- Remote cleartext HTTP cannot be enabled accidentally.
- No real card value or email appears in tracked files or test output.

