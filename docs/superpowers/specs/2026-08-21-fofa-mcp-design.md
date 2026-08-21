# FOFA MCP Integration Design

## Status

Approved in conversation on 2026-08-21. This document defines the first implementation of FOFA access for LuaN1aoAgent Executors. It does not expose a general-purpose MCP service to external clients.

## Goals

- Give Executor agents access to FOFA through standard MCP tools.
- Support account information, bounded asset search, continuous pagination, statistical aggregation, and host aggregation.
- Keep FOFA credentials outside the model context and Executor sandbox.
- Enforce the Run's authorized Scope before requests and after results are received.
- Preserve useful results as evidence and Artifacts without flooding the model context.
- Prevent accidental FOFA point exhaustion with Runtime-owned per-call and per-Task quotas.

## Non-goals

- A reusable MCP server for Codex, Claude Desktop, or other external clients.
- A FOFA GUI, spreadsheet export, plugin runner, icon-hash calculator, nuclei integration, or httpx integration.
- Treating co-hosted domains or other discovered associations as automatically authorized targets.
- Allowing Planner, Supervisor, or Projector to invoke FOFA directly.
- Replacing the existing Scope checks on active network tools.

## Prior Art

[fofaEX 3.3.1](https://github.com/10cks/fofaEX/releases/tag/3.3.1) is useful prior art for FOFA field selection, paging, and response normalization. Its repository is MIT-licensed. The implementation will not copy its Swing UI or plugin system. It will also not reproduce its practice of constructing printable URLs containing the FOFA key.

The endpoint model is cross-checked against the official [fofa-py client](https://github.com/fofapro/fofa-py): account information uses `/api/v1/info/my`, bounded search uses `/api/v1/search/all`, continuous pagination uses `/api/v1/search/next`, statistics use `/api/v1/search/stats`, and host aggregation uses `/api/v1/host/{host}`.

The integration uses the stable v2 packages from the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): `@modelcontextprotocol/server` and `@modelcontextprotocol/client`.

## Architecture

The selected architecture is a host-side stdio MCP server with a Pi tool bridge.

```text
Executor Pi Session
  -> model-facing Pi ToolDefinition
  -> FofaToolBridge (trusted Task identity and Artifact handling)
  -> MCP client over stdio
  -> per-Run FofaMcpServer child process
  -> FofaScopePolicy request validation
  -> FOFA HTTPS API
  -> response normalization and classification
  -> MCP result
  -> bounded model result + full Artifact
```

### Components

#### FofaMcpServer

An independent Node.js stdio child process. It reads `FOFA_API_KEY` and optional `FOFA_EMAIL` from its process environment. Standard output is reserved exclusively for MCP protocol frames. Diagnostics go to standard error after secret redaction.

The server owns FOFA HTTP requests, response validation, stable error mapping, request retries, and Scope classification. It must never print a complete request URL because FOFA authentication may appear in query parameters.

Proposed entry point: `src/mcp/fofa-server.ts`.

#### FofaMcpRuntime

A host-side lifecycle owner created by `SecurityAgentController`. It lazily starts one server per Run after the authorized Scope is known, connects an MCP client over stdio, performs initialization and tool discovery, and closes the child during graceful shutdown.

It owns the authoritative per-Task quota ledger and opaque cursor registry. A child restart must not reset either. It may restart the child once after an unexpected exit; the call interrupted by the exit fails and is not silently replayed.

Proposed implementation: `src/mcp/fofa-runtime.ts`.

#### FofaToolBridge

The bridge converts discovered MCP tool schemas into the project's existing Pi `ToolDefinition` format. These tools are added only to Executor sessions.

Model-facing schemas omit trusted Runtime fields. On every call, the bridge injects the current `taskRef`, Run Scope identity, and quota reservation. The model cannot select another Task identity or provide an alternative Scope.

The MCP schemas contain a reserved `_runtime` object used only between the bridge and the internal server. The bridge removes this property from model-facing schemas and injects it after model argument validation. It contains the Task reference, immutable Scope snapshot/fingerprint, and trusted derived-reference identifiers. Calls lacking a valid internal context are rejected by the server.

The bridge strips the full MCP payload from the model-facing response, writes it through `ArtifactStore`, and returns a bounded summary plus the resulting `artifactRef`.

Proposed implementation: `src/tools/fofa-mcp-tools.ts`.

#### FofaScopePolicy

A pure, independently tested policy module. It parses the normalized authorized Scope, validates positive anchors in FOFA expressions, and classifies returned assets. It does not mutate the task graph or authorized Scope.

Proposed implementation: `src/fofa/fofa-scope-policy.ts`.

#### FofaClient

A small HTTP adapter for the supported official FOFA endpoints. It handles parameter encoding, response schemas, timeouts, redaction, and stable error conversion. It accepts an injectable transport so all default tests use a local mock server.

Proposed implementation: `src/fofa/fofa-client.ts`.

## MCP Tools

### `fofa_account_info`

Returns a redacted account capability summary needed to explain unavailable features or insufficient points. It always omits the API key, email, and unrelated account profile data.

### `fofa_search`

Inputs:

- `query`: FOFA query expression.
- `fields`: requested fields selected from an allowlist based on currently documented FOFA fields.
- `limit`: optional result count, clamped to 1-100 and defaulting to 100.
- `full`: optional boolean, default `false`; availability remains subject to the FOFA account.

The tool validates the query, reserves quota, calls bounded search, classifies results, and returns an opaque Runtime cursor when more results can be requested.

### `fofa_search_next`

Inputs:

- `cursor`: opaque cursor previously issued by this Run.
- `limit`: optional result count, clamped to the remaining per-call and per-Task quota.

The cursor is bound to the originating Run, Task, normalized query, fields, Scope fingerprint, and FOFA next-token state. The model cannot alter these values. Cursor state remains host-side and the opaque value contains no FOFA credential or raw provider token.

### `fofa_stats`

Inputs:

- `query`: Scope-anchored FOFA expression.
- `fields`: allowlisted aggregation fields.
- `size`: requested bucket count per field, clamped to 1-100 and defaulting to 10.

The request uses the FOFA statistics endpoint and counts against the per-Task aggregation-call budget.

### `fofa_host_aggregate`

Inputs:

- `host`: a domain or IP that passes Scope anchor validation or is a previously recorded candidate derived from an in-Scope anchor.
- `detail`: optional boolean, default `false`.

An in-Scope host may produce both `in_scope` and `candidate_only` associations. Supplying an arbitrary unrelated host is rejected before reaching FOFA.

## Scope Policy

### Request validation

Every search or aggregation request must contain at least one positive asset anchor. Valid anchors are:

- an IP address inside an explicitly authorized IP/CIDR;
- a domain equal to an authorized root domain;
- a subdomain of an authorized root domain;
- an asset previously confirmed by Runtime evidence to be in Scope;
- an opaque cursor or association reference originally derived from one of the above.

Queries containing only broad conditions such as product, country, organization, protocol, port, or title are rejected. A negative reference to an authorized asset does not satisfy the positive-anchor requirement. Boolean expressions must retain an authorized positive anchor on every disjunctive branch; an expression such as `domain="example.com" || country="CN"` is rejected because the second branch is unbounded.

The policy supports normal FOFA grouping, conjunction, disjunction, negation, quoted strings, and escaped values. If the expression cannot be parsed confidently, it fails closed with a stable validation error instead of falling back to substring matching.

### Result classification

Each normalized result receives one of two classifications:

- `in_scope`: its IP is inside an authorized CIDR, or its domain/host is the authorized root domain or one of its subdomains.
- `candidate_only`: it is associated through an authorized query but does not independently satisfy Scope, or its identity cannot be classified reliably.

Examples:

- A subdomain of an authorized `example.com` is `in_scope`.
- A different domain hosted on an authorized IP is `candidate_only` unless that domain is separately authorized.
- Certificate, ICP, organization, or shared-infrastructure associations outside Scope are `candidate_only`.
- Missing or ambiguous identity fields default to `candidate_only`.

Candidate records carry `active_testing_allowed: false`. Projector may retain them as low-confidence Evidence or Hypothesis, but it must not promote them into Scope or an actively operable target. Existing Bash, browser, connectivity, and network Scope enforcement remains authoritative for active operations.

## Results and Artifacts

The MCP server returns a normalized full payload to the trusted bridge. The bridge writes the complete result as a JSON Artifact associated with the current Task, then constructs a bounded model response.

The model response includes:

- normalized query summary and selected fields;
- returned count and provider-reported total when present;
- consumed-point metadata when present;
- separate `in_scope` and bounded `candidate_only` previews;
- classification counts;
- opaque next cursor when available;
- `artifactRef` for the complete result;
- explicit warnings that candidates cannot be actively tested.

Artifacts contain public FOFA result data, query expression, field selection, paging metadata, classifications, and point-consumption metadata. They never contain the API key, raw authenticated URL, environment dump, or unredacted provider error.

## Credentials and Configuration

Required host environment:

- `FOFA_API_KEY`

Optional host environment:

- `FOFA_EMAIL`
- `FOFA_API_BASE_URL`, defaulting to the official FOFA API origin and restricted to HTTPS except in tests.
- `FOFA_MAX_RESULTS_PER_CALL`, default `100`.
- `FOFA_MAX_RESULTS_PER_TASK`, default `1000`.
- `FOFA_MAX_AGGREGATIONS_PER_TASK`, default `20`.
- `FOFA_REQUEST_TIMEOUT_MS`, default `15000`.

The child receives a minimal allowlisted environment rather than inheriting the entire host environment. The API key is never injected into an Executor sandbox or Pi prompt.

When `FOFA_API_KEY` is absent, LuaN1aoAgent continues to start normally and simply does not register FOFA tools. Runtime records one non-sensitive capability-disabled event. A malformed FOFA configuration fails FOFA initialization without disabling unrelated Executor tools.

## Quotas and Concurrency

- Each call may return at most 100 records by default.
- Each Task may receive at most 1,000 search records across initial and next-page calls.
- Each Task may issue at most 20 statistics/host-aggregation calls by default.
- Host configuration can lower or raise these values; the model cannot.
- Runtime reserves quota atomically before making a provider request, preventing concurrent Task calls from oversubscribing a Task allowance.
- A failure known to occur before FOFA accepts a request releases the reservation.
- Authentication, authorization, account-plan, and provider responses that may have consumed points do not release it.
- If consumption cannot be established safely, the reservation remains consumed.

The limits are Runtime policy, independent of and no larger than the provider's own account restrictions.

Per-Task consumed search records and aggregation calls are persisted in `RuntimeStore` in the shared session SQLite database. Quota updates use a transaction and survive `--resume`. Cursor mappings remain memory-only because provider next tokens are short-lived and should not be persisted unnecessarily.

## Error Handling

Stable error categories include:

- `fofa_not_configured`
- `fofa_scope_rejected`
- `fofa_query_invalid`
- `fofa_quota_exhausted`
- `fofa_auth_failed`
- `fofa_points_insufficient`
- `fofa_plan_unsupported`
- `fofa_rate_limited`
- `fofa_timeout`
- `fofa_provider_error`
- `fofa_response_invalid`
- `fofa_mcp_unavailable`

Authentication failures, insufficient points, unsupported account features, and policy rejections are not retried. Rate limits, timeouts, and transient 5xx responses use bounded exponential backoff with at most two retries and honor Run cancellation. Provider errors are normalized and redacted before they cross MCP or enter ExecutionLog.

Malformed provider responses fail closed. A sanitized structural diagnostic may be logged, but unknown raw content is not passed directly to the model.

If the MCP child exits unexpectedly, the current call fails with `fofa_mcp_unavailable`. Runtime may restart the child once for future calls. It preserves quota reservations, cursor ownership, and Scope state outside the child. Run shutdown closes the MCP client, sends graceful termination, applies a bounded grace period, and then kills only the resolved child PID if necessary.

## Observability

FOFA calls use the existing Pi tool event path so `tool_started` and `tool_finished` remain visible. Additional Runtime metadata records the stable operation name, Task, duration, result counts, classifications, quota state, Artifact reference, and stable error code.

Logs must not include:

- API key or authenticated URL;
- full process environment;
- raw provider request headers;
- unbounded result bodies;
- cursor provider tokens.

MCP process start, readiness, restart, and shutdown events are recorded without credentials.

## Lifecycle Integration

1. Controller initialization creates no FOFA child process.
2. After `runUntilDone` receives or infers Scope, it configures `FofaMcpRuntime` with an immutable normalized Scope snapshot and lazily starts the server if credentials exist.
3. Executor session creation receives Task-bound FOFA bridge tools.
4. Task completion retains quota and cursor audit state until Run shutdown; cursors for terminal Tasks become unusable.
5. `requestStop` cancels outstanding FOFA requests.
6. Controller `close` drains bridge work, closes the MCP client, and terminates the child before stores close.

Resume creates a new MCP child and rebuilds only safe Runtime state. Old opaque cursors are invalid after process restart; the Executor must issue a new bounded search. Persisted quota usage is restored from Runtime state so resume cannot reset the per-Task allowance.

## Testing

### FOFA client unit tests

Use an injectable local mock HTTP server to verify parameter encoding, all five supported operations, response validation, redaction, timeout, rate-limit handling, retry boundaries, and cancellation. Default tests never contact FOFA or consume points.

### Scope policy tests

Cover root domains, subdomains, authorized IPs and CIDRs, co-hosted domains, certificate associations, IPv4, IPv6, mixed boolean expressions, negation, escaping, invalid syntax, ambiguous results, cursor ownership, and broad unanchored queries.

### MCP protocol tests

Start the actual stdio server and exercise initialization, `tools/list`, every `tools/call`, protocol shutdown, stderr diagnostics, unexpected child exit, and one bounded restart. Assert that stdout contains only valid MCP frames.

### LuaN1ao integration tests

Verify that:

- tools are registered only for Executor sessions;
- missing credentials leave unrelated tools operational;
- trusted Task/Scope fields cannot be model-supplied;
- Task quotas are isolated and remain correct under concurrent calls;
- pagination cannot change query, fields, Task, Run, or Scope;
- full results become Task Artifacts while the model response stays bounded;
- candidate records cannot enable active testing;
- stop and close terminate requests and the child process;
- resume restores quota usage but invalidates old cursors.

### Secret-leak regression tests

Tests use a unique sentinel API key and scan MCP content, stdout, stderr, thrown errors, ExecutionLog, serialized events, and Artifact files. The sentinel must occur only in the mock server's received authenticated request and nowhere else.

### Optional live smoke test

A live test runs only when both `FOFA_LIVE_TEST=1` and real credentials are present. It requests at most one result. It is excluded from normal CI and `npm test` by default.

## Acceptance Criteria

- Executor can invoke all five FOFA MCP tools.
- Planner, Supervisor, and Projector cannot invoke them.
- Host credentials never enter Executor context, logs, events, Artifacts, or errors.
- Every search and aggregation is anchored to authorized Scope or a trusted derived reference.
- Subdomains may become `in_scope`; co-hosted or associated third-party assets remain `candidate_only`.
- Candidate results cannot authorize active testing.
- Model results are bounded and complete results are saved as Task Artifacts.
- Per-call, per-Task result, and aggregation quotas cannot be bypassed through concurrency or pagination.
- MCP child failure and Run shutdown leave no orphan process.
- Mock-backed unit and integration suites pass without making live FOFA requests.
