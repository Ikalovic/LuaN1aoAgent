# Qingxuan Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. The user approved immediate execution after design and requested lightweight testing and review.

**Goal:** Add the approved B-style public homepage and a consistent, independent login page without changing authorization or existing workbench behavior.

**Architecture:** Keep public entry selection outside workbench `ViewKey`. `AuthRoot` owns entry history and authentication, renders a static homepage immediately, and mounts a lazy business application only after authentication. Reuse existing navigation parsing for safe internal return destinations.

**Tech Stack:** React 19, TypeScript, Ant Design, Lucide, Vite, Vitest, existing Pillow asset export.

**Workspace:** Continue on the existing user-requested `feat/qingxuan-frontend` branch with its uncommitted frontend implementation. Preserve unrelated changes. Do not move or reset this work to a new worktree.

---

## Task 1: Entry Navigation and Authentication

Files: create `web/src/entryNavigation.ts`, `web/src/entryNavigation.test.ts`, `web/src/AuthRoot.test.tsx`; modify `web/src/AuthRoot.tsx` and minimally `web/src/App.tsx`.

- [x] Add focused failing tests: root URL shows public homepage even during session lookup; unauthenticated wallboard deep link shows login without mounting App; successful authentication restores view, runtime and graph parameters; browser back returns to home; external return URLs are ignored.
- [x] Run `npm run test:web -- web/src/entryNavigation.test.ts web/src/AuthRoot.test.tsx` and confirm the missing behavior fails.
- [x] Define the entry contract and implement parsing using `URLSearchParams` and existing `parseNavigation` / `navigationUrl`:

```ts
export type EntryPage = "home" | "login" | "app";
export function parseEntryPage(search: string): EntryPage;
export function appDestination(search: string): string;
export function loginDestination(search: string): string;
```

Explicit `page=home` and `page=login` take precedence. A URL with `view` or `runtimeDir` is a business route; a root URL is home. `appDestination` serializes only existing whitelisted business state; `loginDestination` adds `page=login` to that internal destination. No external redirect parameter is consumed.

- [x] In `AuthRoot`, track the current URL on popstate and local entry navigation. Read live `window.location.search` before redirects because workbench navigation owns its own history updates. When signed out on an app route, replace its URL with a login destination; when signed in on a login route, replace it with the app destination. Never replace history during render.
- [x] Replace eager `App` import with `lazy(() => import("./App"))` and a localized loading state. Homepage renders independently of auth loading. Preserve the single existing `useAuth` instance and all API contracts.
- [x] Rerun the focused tests; check that root renders no business application and that login failure retains the requested view.

## Task 2: B-Style Homepage

Files: create `web/src/components/HomePage.tsx`, `web/src/components/HomePage.test.tsx`, `web/src/styles/homepage.css`.

Component contract:

```ts
interface HomePageProps {
  authenticated: boolean;
  workbenchUrl: string;
  wallboardUrl: string;
  loginUrl: string;
  onNavigate: (href: string) => void;
}
```

- [x] Add a focused component test for the Qingxuan title, upstream credit, entry destinations and product screenshot tabs. Run it before implementation.
- [x] Implement the selected `.superpowers/brainstorm/77554-1789477138/content/homepage-directions.html` B composition in React: full-bleed bitmap, left-aligned brand, introduction, two entry links, three compact capability items, light product band and source credit. Remove all prototype review controls.
- [x] Use real anchors for navigation; intercept only unmodified primary-button clicks. Implement screenshot tabs as keyboard-accessible controls, preserve image dimensions, and show a usable fallback if a product image fails.
- [x] Use local fonts and Lucide icons; responsive explicit breakpoints, zero letter spacing, no new dependency or generated hero. Keep page styling scoped so workbench and wallboard CSS do not change.
- [x] Rerun the component test. Confirm the page receives only entry URLs and session status, with no runtime hook or real data request.

## Task 3: Login and Return Home

Files: modify `web/src/components/AuthScreen.tsx`, `web/src/components/WorkbenchShell.tsx`, `web/src/App.tsx`; create `web/src/styles/entry.css` and focused login coverage in `web/src/AuthRoot.test.tsx`.

- [x] Extend the auth screen with an optional `onHome` callback. Retain actual Ant Design login/register forms, API handlers, validation, theme and language controls.
- [x] Build a single-column login surface matching homepage branding; provide a clearly labeled return-home link and a compact brand title. Use scoped CSS after existing auth styles, avoiding unrelated legacy CSS cleanup.
- [x] Pass an optional `onHome` callback into App and WorkbenchShell. Guard home navigation with App's existing `allowLeave()` before unmounting the workbench; never call `stopRun` for page navigation.
- [x] Verify original auth behavior using `npm run test:web -- web/src/useAuth.test.tsx web/src/AuthRoot.test.tsx web/src/App.test.tsx` and keep form-submission tests limited to changed entry behavior.

## Task 4: Assets and Browser Verification

Files: extend `scripts/prepare-qingxuan-art.py`; update `docs/assets/qingxuan-art-manifest.json`, `docs/qingxuan-art-delivery.md`, `docs/qingxuan-frontend-delivery.md`; add `scripts/check-qingxuan-entry.mjs`.

- [x] Copy existing verified fixture screenshots into ignored asset masters, export `home-workbench.webp` and `home-wallboard.webp` without overwriting user assets, and add dimensions, hashes and fixture provenance to the existing manifest.
- [x] Use a browser-only auth/API fixture for homepage and login screenshots and navigation checks. Cover 1920px, 390px and 3840px, dark/light login, screenshot tab switching, login failure/success and retained wallboard destination. Reject unexpected public-page business requests and any heavy scene module loaded before entry.
- [x] Run `npm run build:web`, the focused tests above, and the entry browser check against the existing Vite server. Verify no horizontal overflow, missing assets or console errors. Do not run the full backend suite or long performance tests.
- [x] Check `git diff --check`, document the actual checks and working URL, and leave implementation changes on the feature branch without merging or pushing unrelated work.

## Completion Evidence

- Design and plan committed as `537c3a9`; implementation remains on `feat/qingxuan-frontend`, without merge or push.
- Final focused run: 7 test files, 30 tests passed, including existing auth, App, theme and language checks.
- `npm run build:web` passed with existing chunk size warnings; `git diff --check` passed.
- Entry browser checks passed at 1920x1080, 390x844 and 3840x2160. English layouts additionally checked at 320px and 390px. Screenshots: `/tmp/qingxuan-entry/`.
- All 33 published asset sizes and SHA-256 values match the manifest. No new image generation request.
- Home: `http://127.0.0.1:5173/`; login: `http://127.0.0.1:5173/?page=login`.
