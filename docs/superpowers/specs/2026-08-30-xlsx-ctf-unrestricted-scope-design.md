# XLSX Scope Files and Optional CTF Scope

## Goal

Extend authorization-document parsing to XLSX workbooks and allow CTF runs to omit an authorization scope. Web pentest runs continue to require an explicit domain, IPv4 address, IPv4 CIDR, or confirmed scope document; CLI pentest runs retain their existing goal-based IPv4/CIDR inference fallback.

## XLSX Parsing

- Accept files with the `.xlsx` extension through the shared scope-document parser.
- Reuse the existing `fflate` dependency to read the OOXML ZIP package. Do not add an Excel library or invoke an external office application.
- Read every worksheet referenced by `xl/workbook.xml` and its relationships.
- Extract non-empty cell values from shared strings, inline strings, ordinary values, and cached formula results.
- Preserve the worksheet name and cell address on each extracted fragment so candidate evidence identifies its source.
- Ignore unrelated ZIP entries, macros, drawings, comments, and external links.
- Apply the existing 5 MiB input, 20 MiB expanded-data, 10,000-fragment, and 2 MiB extracted-text limits.
- Reject malformed workbooks with a stable `invalid_xlsx` diagnostic.

The candidate extractor remains unchanged and therefore still accepts only literal domains, IPv4 addresses, and IPv4 CIDRs found in extracted cell text. AI selection remains evidence-grounded and cannot widen scope.

## CTF Without Scope

- The Web start-run form permits an empty scope only when `taskType` is `ctf`.
- The Web API independently enforces the same rule; clients cannot bypass it by omitting the UI validation.
- The CLI maps an omitted `--scope` and no `--scope-file` directly to the universal scope only for `--task-type ctf`. Pentest continues through the existing goal-based scope inference path.
- An omitted CTF scope is normalized internally to `0.0.0.0/0`. This reuses the existing Controller, network sandbox, graph, prompt, and tool boundaries without introducing a second scope mode.
- An explicit CTF scope remains restricted exactly as supplied.
- Pentest behavior is unchanged: Web requires an explicit scope or confirmed scope document, while CLI may infer literal IPv4/CIDR entries from the goal as before.
- Existing FOFA policy remains in force. The universal IPv4 CIDR authorizes IPv4-anchored searches but does not create a universal domain anchor.
- Transparent proxy setup may use the normalized universal CIDR in CTF mode through the existing path.

## Interfaces and Documentation

- Add `.xlsx` to the Web file input accept list.
- Extend `ScopeTextFragment` with optional `sheet` and `cell` evidence fields and propagate them to candidate evidence.
- Document XLSX alongside TXT, Markdown, CSV, JSON, DOCX, and text-layer PDF.
- Keep the current upload API and CLI flags unchanged.

## Error Handling

- Invalid ZIP signatures, missing workbook metadata, invalid relationships, missing referenced worksheets, or malformed required XML produce `invalid_xlsx`.
- Existing size and complexity errors retain their current codes.
- XLSX parsing errors do not expose workbook contents or local filesystem paths.
- A Web pentest request without scope returns the existing invalid-request class of error. A CLI pentest request without explicit scope retains its existing inference behavior and error messages.

## Verification

- Parser tests cover multiple worksheets, shared strings, inline strings, ordinary values, cached formula values, evidence locations, unrelated ZIP entries, and malformed XLSX input.
- Web component and API tests cover `.xlsx` acceptance, empty CTF scope, and rejected empty pentest scope.
- CLI tests cover empty CTF scope and the existing pentest scope inference or validation path.
- Run the full server and Web test suites after focused red-green verification.
