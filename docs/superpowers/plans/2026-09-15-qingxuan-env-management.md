# Qingxuan Environment Management Implementation Plan

> **For agentic workers:** Execute inline with Superpowers. The user approved adding the management editor and requested lightweight verification.

**Goal:** Add an administrator-only environment variable page under Manage.

**Architecture:** Reuse the existing `/api/env` contract. Extract the existing drawer body into `EnvConfigEditor`, shared by the standalone page and MCP drawer. Keep unsaved values in component state only.

**Tech Stack:** React, TypeScript, Ant Design, Lucide, Vitest, Playwright.

## Task 1: Route And Shared Editor

- [x] Add failing checks to `web/src/navigation.test.ts`, `web/src/App.test.tsx`, and `web/src/components/EnvConfigDrawer.test.tsx`: `?view=env` is preserved; administrators can edit despite runtime failure; analysts cannot mount or fetch the editor; sensitive drafts are masked; discarding clears all inputs.
- [x] Run `npm run test:web -- web/src/navigation.test.ts web/src/App.test.tsx web/src/components/EnvConfigDrawer.test.tsx` and confirm the new behavior is absent.
- [x] Add `env` to `ViewKey`, `VIEWS`, management tabs and titles. Guard the tab and route with administrator access, as for credentials. Treat the route as global.
- [x] Extract `EnvConfigEditor.tsx` from `EnvConfigDrawer.tsx`, keeping `GET /api/env` and `PUT /api/env` unchanged:

```tsx
<EnvConfigEditor onDirtyChange={onEnvDirtyChange} />
```

- [x] Preserve the drawer through the shared editor's `active`, `compact`, and `onSaved` props. Add variable-name filtering, accessible controls, loading/error states and save/discard actions. The save payload remains `{ set: pendingSet, remove: pendingRemove }`.
- [x] Track unsaved input as well as staged changes. Confirm navigation when drafts exist, warn before browser unload, disable editing while saving, and retain drafts on failure. Never echo newly entered sensitive values as plain table text.

## Task 2: Styling And Verification

- [x] Style the full-width editor and responsive toolbar/add/footer rows in `web/src/styles/workbench.css`, using existing theme variables. Keep horizontal scrolling inside the table; use Lucide controls. No image assets required.
- [x] Run focused route/editor/MCP tests and `npm run build:web`.
- [x] Use intercepted API fixtures for desktop and mobile browser checks, including one batch update. Never send a real environment mutation or restart the backend.
- [x] Inspect the scoped diff and provide the existing development server's `?view=env` link. Do not push or stage unrelated documents.

## Results

- 28 focused tests passed across navigation, App, environment editor, and MCP.
- Frontend TypeScript and production build passed; existing large-chunk warnings remain.
- Browser fixtures passed at 1920x1080 and 390x844 in dark/light themes, including failed-save retry, exact batch payloads, administrator-only fetches, and no overflow or footer overlap.
- Screenshots: `/tmp/qingxuan-env`. Temporary browser check: `/tmp/check-qingxuan-env.mjs`.
- Preview: `http://localhost:5173/?view=env`.
- No real `.env` reads/writes, backend restart, or remote push during verification.
