# Qingxuan Backend UI Sync

## Design

Merge origin/main through f5ddac4 without replacing Qingxuan's workbench, homepage, login, wallboard, coverage semantics, or environment editor. Preserve the user's unstaged lockfile edit through a scoped stash and restore it after the merge.

| Backend capability | Frontend integration |
| --- | --- |
| GET /api/agents | Manage / Agents; search, status, diagnostics, read-only analyst access |
| POST /api/agents/:id/state | Administrator enable/disable controls |
| PUT /api/agents/:id/options | Typed option editor with server-supplied authority/bounds |
| POST /api/agents/:id/options-mode | Planner/user ownership and restore author mode |
| OSINT/imported graph nodes in /api/state | Assets / Graph memory; graph/table, confidence/type filters, existing inspector |
| POST /api/attachments and DELETE /api/attachments/:id | New/continue task attachments; 12 files, 32 MiB each |
| POST /api/runs attachmentIds | Submit uploaded identities with the task, retain accepted uploads after partial failure |

The upstream capabilities links map to existing flat management tabs: skills, mcp, agents. No nested duplicate navigation. Reuse upstream components and API clients; adapt their colors and responsive layouts to existing theme tokens. No generated assets or new runtime-transfer API: transfer functionality remains design-only upstream.

## Execution

- Resolve App/types conflicts by combining existing Qingxuan navigation with new backend models and panels.
- Add focused failing route tests, then connect Agents and Memory; keep legacy URLs compatible.
- Validate attachments, partial failure, cancellation, and existing task form flows. Preserve backend permission boundaries.
- Build both server and frontend, run relevant tests, and inspect desktop/mobile browser fixtures. Never modify real configuration or launch a real task during checks.
- Commit the merge and integration, restore only the saved local lockfile change, and report preview URL. Do not push without request.

## Verification

- 66 focused frontend tests passed (routes, login destinations, Agents, option authority, memory, attachments, environment editor).
- 11 backend integration/coverage tests passed in isolated temporary runtimes. The attachment test now waits for asynchronous run initialization before reading `run_started`.
- Server and frontend builds passed. Existing bundle-size warnings remain.
- Browser fixtures passed at 1920x1080 and 390x844: Agent toggles/options/mode, memory graph/list/inspector, upload/discard, dark/light themes, horizontal overflow checks. Screenshots are in `/tmp/qingxuan-sync`.
- Added integration fixes for partial upload retention, staged-file cleanup on cancellation, option-mode refresh in an open drawer, and accessible mobile task launch.
- Development services: frontend `http://localhost:5173`, backend `http://127.0.0.1:8787`. No production configuration edits or real-task launches were used to verify the UI.
