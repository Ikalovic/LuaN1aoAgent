# Beekeeper MCP Integration Design

## Goal

Add a dedicated Beekeeper MCP bridge to LuaN1aoAgent so the executor model can autonomously query and store credentials during an authorized task. Beekeeper remains the owner of its SQLite database and exposes only predefined MCP operations.

## Decisions

- Use a dedicated Beekeeper bridge that follows the existing FOFA runtime pattern.
- Do not apply LuaN1aoAgent task-scope or domain restrictions to Beekeeper operations.
- Return account names and passwords as plaintext MCP tool results. They may therefore appear in model context, task events, artifacts, and the Web UI.
- New credentials default to `is_valid=true`.
- Only an explicit authentication rejection should cause the model to call the invalidation tool. Timeouts, WAF responses, connection errors, and rate limits are not proof that a credential is invalid.
- Do not expose arbitrary SQL, database paths, generated SQLite scripts, deletion, or bulk mutation through LuaN1aoAgent.

## Architecture

The integration has two bounded parts:

1. Beekeeper extends its stdio MCP server with explicit query and mutation tools. Its existing ORM and database session remain the only database access path.
2. LuaN1aoAgent starts Beekeeper as a host-side stdio MCP child process, validates the advertised tools, injects local executor wrappers, and records bounded call metrics.

The Beekeeper database is not mounted into the executor environment. Configuration supplies the Python command, MCP entry point, working directory, timeout, and page-size ceiling.

## MCP Tool Contract

### `query_credentials`

Inputs:

- `domain`: domain filter; it is not checked against the active task scope.
- `cursor`: optional opaque continuation cursor.
- `limit`: optional requested page size, clamped to the configured maximum.
- `include_invalid`: optional boolean, default `false`.

Output:

- `items`: credential records containing stable ID, domain, account, plaintext password, validity, and available source metadata.
- `next_cursor`: opaque cursor for the next page, or `null` when complete.
- `has_more`: whether another page exists.

Pagination is a per-call safety bound, not a total-result limit. Results use stable ID-based keyset pagination. The model may repeatedly pass `next_cursor` until it is `null`, allowing it to retrieve every matching record without a large single response. A cursor is bound to the original query parameters; mismatched or malformed cursors return a validation error.

### `store_credential`

Inputs:

- `domain`
- `account`
- `password`
- optional `source`

The tool normalizes fields, uses Beekeeper's existing duplicate-handling rule, and creates new records with `is_valid=true`. Its result distinguishes `created` from `already_exists` and returns the stable credential ID.

### `mark_credential_invalid`

Inputs:

- `credential_id`
- optional short `reason`

The tool sets `is_valid=false` for one existing record. It is idempotent and does not delete data. Tool instructions explicitly require positive authentication-rejection evidence before use.

### Existing Beekeeper tools

LuaN1aoAgent exposes only the three tools above. Database-info and generated-enumeration-script tools are not bridged into the executor because they bypass the intended interface or reveal unnecessary host details. Beekeeper may retain them for its other clients.

## Runtime and Data Flow

1. LuaN1aoAgent starts the configured Beekeeper stdio MCP server when the feature is enabled.
2. Startup verifies protocol initialization and the required tool names.
3. Executor tool definitions explain when to query, store, and invalidate credentials.
4. The model invokes a tool autonomously.
5. The host bridge applies timeout and input/output bounds, then forwards the MCP call.
6. Beekeeper performs the ORM operation and returns structured JSON.
7. LuaN1aoAgent returns the result to the model and emits a metric containing tool name, duration, and status. Because plaintext mode was selected, normal execution persistence may also contain returned credentials.

## Configuration

Configuration is environment-based and disabled unless explicitly enabled. It contains no embedded credential data:

- enable flag
- Python executable or command
- Beekeeper MCP entry-point path
- Beekeeper working directory
- call timeout
- maximum query page size

Invalid or incomplete configuration fails startup with a clear configuration error rather than silently omitting the tools.

## Error Handling

- Invalid arguments and cursors return stable validation errors.
- Missing credential IDs return a not-found result without mutation.
- MCP startup, timeout, transport, and provider errors are distinguished in runtime metrics.
- A failed write is never reported as successful.
- The child process is stopped during controller shutdown and restarted only through the normal runtime lifecycle.
- Tool output is size-bounded even when Beekeeper returns malformed or unexpectedly large data.

## Testing

Beekeeper tests cover:

- first and subsequent query pages, including complete traversal;
- cursor/query mismatch rejection;
- default exclusion and optional inclusion of invalid records;
- plaintext fields in query results;
- create and duplicate-store behavior;
- default `is_valid=true`;
- idempotent invalidation and missing IDs;
- queries and writes for domains outside the active LuaN1aoAgent scope.

LuaN1aoAgent tests cover:

- configuration parsing and disabled behavior;
- MCP initialization and required-tool validation;
- executor tool schemas and forwarding;
- timeout, malformed response, and provider-error mapping;
- query pagination fields remaining intact;
- controller startup and shutdown;
- metric events for successful and failed calls.

## Acceptance Criteria

- The executor model can autonomously invoke all three Beekeeper tools.
- It can query any domain and follow cursors until all matching credentials are returned.
- It can store plaintext credentials with `is_valid=true` by default.
- It can mark one credential invalid without deleting it.
- No arbitrary SQL or direct SQLite-file access is available through the bridge.
- Existing FOFA MCP behavior remains unchanged.
