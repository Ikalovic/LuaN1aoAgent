# Qingxuan Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the approved Qingxuan workbench and independent read-only situation wallboard using the delivered artwork and real runtime data.

**Architecture:** Keep existing API permissions and business components. Introduce shared theme, navigation and situation projections, then compose an overview and independent lazy-loaded Three.js presentation. Unknown or truncated data must remain explicit rather than becoming synthetic telemetry.

**Tech Stack:** React 19, TypeScript, Ant Design 6, Cytoscape/ELK, Three.js, Vite, Vitest, Playwright.

## Execution Context

- Branch: `feat/qingxuan-frontend`, created in the user's existing workspace as requested.
- Preserve all previously delivered artwork and pending design documents; do not stage unrelated documentation.
- Approved requirements: `docs/superpowers/specs/2026-09-15-qingxuan-frontend-design.md` and `docs/superpowers/specs/2026-09-15-qingxuan-wallboard-design.md`.
- Baseline: `npm run test:web`, 23 files / 107 tests passing.
- Each task uses a failing behavioral test, implementation, passing test, spec review, then quality review. Do not merge or push without user direction.
- Updated user direction during implementation: "不需要太详细的测试和审查". Remaining work uses build checks, focused functional checks and essential desktop/mobile visual verification only. Stop exhaustive review loops and omit the 30-minute soak; fix already-confirmed functional issues, then prioritize implementation. Earlier completed test results remain recorded below.

## Task 1: Brand and Theme

Files: create `web/src/theme.ts`, `web/src/ThemeProvider.tsx`, `web/src/components/Brand.tsx`, `web/src/styles/theme.css`, `web/src/ThemeProvider.test.tsx`; modify `web/src/main.tsx`, `web/src/language.tsx`, `web/src/components/AuthScreen.tsx`, `web/src/components/Sidebar.tsx`, `web/index.html`.

- [x] Add tests for dark default, stored light preference, toggle persistence, brand accessible name and dark/light symbol selection. Assert `document.documentElement.dataset.theme === "dark"` before toggling and `localStorage.getItem("qingxuan-theme") === "light"` afterward.
- [x] Run `npx vitest run --config web/vite.config.ts src/ThemeProvider.test.tsx`; observe missing-module failure.
- [x] Implement `ThemeMode = "dark" | "light"`, `useTheme(): {mode, toggleTheme}`, nested AntD provider with dark/default algorithms, semantic CSS variables. Remove the fixed light theme from the language provider while retaining locale behavior and old locale storage key.
- [x] Render DOM brand name `青玄` with subtitle `自动渗透agent`, use delivered PNG symbols, favicon and login bitmap. Keep login/register validation and submission unchanged. Replace visible legacy brand translations, not backend identifiers.
- [x] Run theme, language, auth and sidebar tests; build web. Review spec compliance and code quality before task completion.

## Task 2: Shared Situation Data and Coverage

Files: create `web/src/situation.ts`, `web/src/situation.test.ts`; modify `web/src/types.ts`, `src/web-server.ts` and associated server snapshot tests.

- [x] Test ID deduplication, Host/Service/WebEndpoint separation, evidence-qualified Vulnerability, successful evidence-qualified Exploit, candidate-only status, missing task status, zero/unknown denominator and missing coverage.
- [x] Run the focused failing tests before implementing `buildSituation(state?: RuntimeState)` as the only shared statistical projection. No approval risk converted into vulnerability severity.
- [x] Add optional per-source coverage entries with state `complete | partial | unknown | unavailable`, returned count, limit, truncated, skippedRecords, time range and reason. Bounded reads inspect one extra record; malformed JSONL records degrade completeness. Fallback reconstruction never claims complete graph coverage.
- [x] Run focused frontend and backend tests plus `npm run build`; review the additive API contract and implementation quality.

## Task 3: Workbench Composition and Navigation

Files: create `web/src/components/WorkbenchShell.tsx`, `RunSwitcher.tsx`, `OverviewView.tsx`, `FindingsView.tsx`, `web/src/navigation.ts`, associated tests, `web/src/styles/workbench.css`; modify `web/src/App.tsx`, `types.ts`, existing graph styling.

- [x] Test default `overview`, recognized legacy routes, opaque entity IDs, URL whitelist, popstate and runtime change clearing selection. Parse via URLSearchParams, never interpolate entity IDs into query text.
- [x] Implement compact navigation, searchable session switcher with manual directory and continue controls, topbar theme/fullscreen-wallboard actions, grouped graph views and contextual inspector. Preserve admin-only approval/MCP/environment controls and analyst workflows. Wallboard entry is completed with Task 5.
- [x] Build overview metrics, asset topology, findings, task summary, event activity from Task 2's shared projection. Missing data displays `--`, loaded empty data `0`, uncertain completeness is labeled. Findings select existing graph entities and evidence; no invented severity.
- [x] Add `overview`, `findings`, `wallboard` to `ViewKey`. Keep old runtime/locale storage keys. Use pushState for navigation and listen to popstate, initialize node/trace/exchange selection from URLs.
- [x] Run existing workflow tests and new navigation/overview tests, then build. Review depth reduced at the user's request; confirmed functional findings fixed without additional review loops.

## Task 4: Snapshot-safe Refresh Lifecycle

Files: modify `web/src/useRuntimeDashboard.ts`, `web/src/api.ts`, `web/src/App.tsx`; add/extend hook tests.

- [x] Test pause while requests pending, runtime switch with late results, hidden tab, manual refresh while paused, immediate resume, request-completion-based retry and 401 clearing.
- [x] Implement request sequence and AbortController guards across state, runs and sessions, pause/visibility cancellation, bounded scheduling after settlement, and stale-data timestamp. Wallboard must not independently fetch approvals or privileged configuration (route composition in Task 5).
- [x] Verify no late response mutates frozen presentation and no prior runtime remains displayed during a switch. Run hook/API tests and review both spec and quality.

## Task 5: Independent 3D Wallboard

Files: create `web/src/components/WallboardView.tsx`, `WallboardControls.tsx`, `WallboardScene.tsx`, `web/src/wallboardScene.ts`, `useWallboardPresentation.ts`, `web/src/styles/wallboard.css`, focused tests; modify package dependencies and lazy route composition.

- [x] Reuse the bounded operation projection and implement baseline/selection/motion lifecycle. Per updated user direction, use lightweight browser selection, pause and fallback checks instead of a new exhaustive test matrix.
- [x] Install Three.js and typings after checking official API documentation. Reuse ELK layout with x/y mapped to world X/Z; height is decorative, not risk. Shared geometry/materials, orthographic camera, capped DPR, disposable renderer and context-loss fallback.
- [x] Render delivered V2 4K/1080 WebP background, header rail and deck texture; compose real metrics, graph stage, findings, tasks, event focus and activity. No fake geography, attacks, heartbeats or scores. Wallboard has no mutation controls.
- [x] Provide manual fullscreen, pause, refresh-once, graph modes, distance mode, optional tour and accessible node selection. DOM labels limited to 12 and collision-checked; explicit small-screen/WebGL fallback. Freeze animations for hidden/paused/delayed/reduced-motion states.
- [x] Verify desktop, 4K, 1366x768 and mobile layout with Playwright screenshots and nonblank canvas pixel checks; exercise controls and context-loss fallback. Build checks replace additional review rounds per user direction.

## Task 6: Integration Verification and Delivery

- [x] Record earlier frontend/backend test results and run a fresh final `npm run build`. Do not repeat the full suite after the user's request for lighter verification.
- [x] Perform focused existing workflow checks and basic browser theme/history/detail and wallboard-control checks. Do not launch actual penetration tasks for visual testing; no exhaustive manual workflow matrix is claimed.
- [x] Browser-check 390px, 1366px, 1920px and 3840px for overflow, asset loading and graph rendering, plus 4K distance layout and WebGL failure fallback. The long-duration soak is omitted per user direction.
- [x] Fix observed rendering/integration issues, document delivery and limitations. Omit final independent review per user direction. Preserve the new branch and unrelated files, leave local servers running and provide URLs.

## Progress and Verification

- 2026-09-15: branch created; frontend baseline 107/107 passing. Implementation not yet started at plan creation.
- Task 1 complete: 18 focused tests and web build pass; full frontend suite 114/114. Spec review found storage-provider composition and English brand-title gaps, fixed with regression tests; re-review and independent quality review approved. Playwright login screenshots at 1440px/390px show no horizontal overflow or broken images. Linux CJK sans fallback corrected after visual inspection.
- Baseline backend verification: GET API and web security tests 12/12; full build passes with existing chunk-size warnings. Vite development server uses port 5173. Task 2 now in progress.
- Task 2 complete: 12 focused frontend tests and 14 backend coverage/GET tests pass, full build passes. Spec review identified malformed SQLite coverage, missing-evidence predicate, selected-edge ordering and missing-endpoint counts; all fixed with observed failing regressions. Spec re-review and independent quality review approved. `CountMetric` uses nullable value plus coverage state; `projectGraph.unloadedEdges` explicitly describes the entire supplied graph.
- Execute Task 4 before Task 3 so new workbench/wallboard composition consumes the final refresh contract. No scope change.
- Browser regression recorded before graph changes: `QINGXUAN_VIEWS=operation QINGXUAN_WIDTH=1920` consistently fails with `Core.headless` / `getPos` after `cy.destroy()`. The cytoscape-elk adapter runs an unguarded promise callback and its `stop()` is a no-op. Task 3 must use a cancellable application-owned ELK result boundary, preserve viewport on data/theme changes, and pass the real-browser regression without disabling StrictMode.
- Task 4 complete: 33 focused lifecycle/API/auth tests, 149 full frontend tests, web build and diff checks pass. Spec review caught visibility-interrupted required baseline while paused; fixed with two RED regressions plus a manual-refresh non-resume regression. Spec re-review and independent code-quality review approved. Additive hook fields: `runsKnown`, `visible`, client `lastSuccessAt`, `delayed`.
- Task 3 in progress. Explicit shared ELK dependency should remain at the installed/proven 0.9.3; root independently checked a two-node direct layout and traced the old adapter's uncancelled callback. New chart dependency may use @ant-design/charts 2.6.7 (compatible React peer range checked).
- Full compiled backend suite: `node --test --test-force-exit --test-concurrency=1 'dist/**/*.test.js'` completed with 854 tests, 853 passed, 1 platform-related skip, 0 failures (approximately 295 seconds).
- Task 3 browser checks: overview and operation at 1920x1080 and 390x844 have nonblank graph pixels, no broken images, horizontal overflow, unexpected API requests or mutations. Theme switching, finding drilldown/selection, inspector closing and back/forward pass at both widths. The first interaction run exposed duplicate history entries from a StrictMode state updater; implementation moved history side effects outside the updater and added a regression test. Visual checks corrected oversized initial graph zoom, low-contrast legends and mobile toolbar layout.
- Task 3 complete: 165 frontend tests passed before the final functional correction batch. That batch passed focused component checks and a fresh web build. It preserves replay drafts across responsive breakpoints, resolves loaded finding references, adds current-run pending work, connects URL traffic/report filters and fixes runtime-event detail, graph selection/list and historical connection context. No final exhaustive re-review, per user direction. Free-text filters currently reset when their view remounts; safe URL filters are restored.
- Task 5 started. Three.js and matching typings pinned to 0.186.0; official renderer/controls APIs checked. Local backend 8787 and Vite 5173 return HTTP 200. Browser WebGL2 initialization is available. No real penetration tasks were launched.
- Task 5 implemented and basic browser checks passed at 1920/1366/390/3840, plus 4K distance. Node selection changes actual scene pixels; pause/manual refresh, fullscreen and context-loss fallback pass. Visual corrections enlarge the scene, brighten real edges and reserve footer space for controls. No synthetic production telemetry was added.
- Delivery details and remaining boundaries: `docs/qingxuan-frontend-delivery.md`. Final verification uses a fresh complete build and basic browser checks, not a claim that every optional design detail or long-duration performance target has been exhaustively verified.
