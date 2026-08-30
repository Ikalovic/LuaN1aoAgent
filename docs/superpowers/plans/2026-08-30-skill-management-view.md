# Skill Management View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level Web workbench view that lists project Skills and lets administrators enable or disable valid Skills.

**Architecture:** Keep registry loading and mutation inside a focused `SkillsView` component. Extend the existing typed API client with the two already-supported backend routes, then integrate the component through `ViewKey`, the sidebar, `App`, localization, and the existing stylesheet.

**Tech Stack:** React 19, TypeScript, Ant Design 6, Lucide React, Vitest, Testing Library

---

## File Map

- Create `web/src/components/SkillsView.tsx`: registry loading, filtering, rendering, and mutation state.
- Create `web/src/components/SkillsView.test.tsx`: list, filters, permissions, and errors.
- Modify `web/src/types.ts`: registry snapshot types and the new view key.
- Modify `web/src/api.ts` and `web/src/api.test.ts`: typed list and mutation calls.
- Modify `web/src/components/Sidebar.tsx` and its test: navigation entry.
- Modify `web/src/App.tsx`: view routing and inspector copy.
- Modify `web/src/language.tsx`: Chinese and English labels.
- Modify `web/src/styles.css`: stable desktop and mobile layout.

### Task 1: Typed Skills API Client

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Test: `web/src/api.test.ts`

- [ ] **Step 1: Write the failing API test**

Import the wished-for helpers and verify the GET path plus encoded, CSRF-protected mutation:

```ts
it("lists skills and posts encoded state changes with CSRF", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ skills: [], diagnostics: [], scannedAt: "2026-08-30T00:00:00.000Z" }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ csrfToken: "skills-csrf" }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: "ctf/web", enabled: false }) });
  vi.stubGlobal("fetch", fetchMock);
  await fetchSkills();
  await setSkillEnabled("ctf/web", false);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/skills");
  const [url, options] = fetchMock.mock.calls[2] as [string, RequestInit];
  expect(url).toBe("/api/skills/ctf%2Fweb/state");
  expect(new Headers(options.headers).get("X-CSRF-Token")).toBe("skills-csrf");
  expect(JSON.parse(String(options.body))).toEqual({ enabled: false });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run `npx vitest run --config web/vite.config.ts web/src/api.test.ts`.

Expected: fail because `fetchSkills` and `setSkillEnabled` are not exported.

- [ ] **Step 3: Add minimal response types**

Add to `web/src/types.ts`:

```ts
export interface RegisteredSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  valid: boolean;
  enabled: boolean;
  modelInvocable: boolean;
}

export interface SkillRegistryDiagnostic {
  code: string;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillRegistrySnapshot {
  scannedAt: string;
  skills: RegisteredSkill[];
  diagnostics: SkillRegistryDiagnostic[];
}
```

- [ ] **Step 4: Add minimal API helpers**

```ts
export function fetchSkills(signal?: AbortSignal): Promise<SkillRegistrySnapshot> {
  return requestJson("/api/skills", { signal });
}

export function setSkillEnabled(name: string, enabled: boolean): Promise<RegisteredSkill> {
  return requestJson(`/api/skills/${encodeURIComponent(name)}/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run the focused API test; expect all tests to pass. Then commit:

```bash
git add web/src/types.ts web/src/api.ts web/src/api.test.ts
git commit -m "feat: add typed skills web API"
```

### Task 2: Skills View Behavior

**Files:**
- Create: `web/src/components/SkillsView.tsx`
- Create: `web/src/components/SkillsView.test.tsx`

- [ ] **Step 1: Write failing rendering and filtering tests**

Mock `fetchSkills` and `setSkillEnabled`. Use a snapshot containing one enabled valid Skill, one disabled valid Skill, and one diagnostic. Assert summary counts and local search:

```tsx
it("loads registry summary and filters skills", async () => {
  mockedFetch.mockResolvedValue(snapshot);
  render(<SkillsView user={admin} />);
  await screen.findByText("recon-subdomain");
  expect(screen.getByText("2 个 Skill")).toBeInTheDocument();
  expect(screen.getByText("1 个已启用")).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("搜索名称或描述"), { target: { value: "ctf" } });
  expect(screen.getByText("ctf-web")).toBeInTheDocument();
  expect(screen.queryByText("recon-subdomain")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run `npx vitest run --config web/vite.config.ts web/src/components/SkillsView.test.tsx`.

Expected: fail because `SkillsView.tsx` does not exist.

- [ ] **Step 3: Implement loading, summary, table, and filters**

Create a component with `snapshot`, `query`, `status`, `loading`, `error`, and `mutating` state. Load once with an abortable effect. Derive the visible rows with:

```ts
const visible = useMemo(() => (snapshot?.skills ?? []).filter((skill) => {
  const matchesQuery = `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase());
  const matchesStatus = status === "all"
    || (status === "enabled" && skill.enabled)
    || (status === "disabled" && !skill.enabled)
    || (status === "invalid" && !skill.valid);
  return matchesQuery && matchesStatus;
}), [query, snapshot, status]);
```

Render `Statistic` summary cells, an `Input` search, a status `Select`, diagnostics, `Empty`, and `Table<RegisteredSkill>` with horizontal scrolling.

- [ ] **Step 4: Verify the rendering test is GREEN**

Run the focused test and require the rendering/filtering case to pass.

- [ ] **Step 5: Write failing permission, mutation, and failure tests**

```tsx
it("lets administrators toggle one valid skill", async () => {
  mockedFetch.mockResolvedValue(snapshot);
  mockedSetEnabled.mockResolvedValue({ ...snapshot.skills[0], enabled: false });
  render(<SkillsView user={admin} />);
  fireEvent.click(await screen.findByRole("switch", { name: "recon-subdomain" }));
  await waitFor(() => expect(mockedSetEnabled).toHaveBeenCalledWith("recon-subdomain", false));
});

it("keeps analyst switches read-only", async () => {
  mockedFetch.mockResolvedValue(snapshot);
  render(<SkillsView user={analyst} />);
  expect(await screen.findByRole("switch", { name: "recon-subdomain" })).toBeDisabled();
});
```

Add separate assertions that a load failure shows retry controls and a mutation failure keeps the old switch state.

- [ ] **Step 6: Run and verify RED for mutation behavior**

Expected: the administrator mutation assertion fails because no handler exists.

- [ ] **Step 7: Implement guarded state mutation**

Call `setSkillEnabled`, replace only the returned row, then refresh the authoritative snapshot. On failure keep the prior row state and show the error. Disable the switch for analysts, invalid Skills, non-model-invocable Skills, and the row currently mutating.

- [ ] **Step 8: Verify GREEN and commit**

```bash
npx vitest run --config web/vite.config.ts web/src/components/SkillsView.test.tsx
git add web/src/components/SkillsView.tsx web/src/components/SkillsView.test.tsx
git commit -m "feat: add skill registry management view"
```

### Task 3: Workbench Navigation And Presentation

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/components/Sidebar.tsx`
- Modify: `web/src/components/Sidebar.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/language.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write the failing navigation test**

```tsx
it("opens the Skills management view", () => {
  const onViewChange = vi.fn();
  render(<Sidebar activeView="trace" runtimeDir="runtime/a" sessions={[]} agents={{}} onViewChange={onViewChange} onRuntimeChange={vi.fn()} />);
  fireEvent.click(screen.getByText("Skills"));
  expect(onViewChange).toHaveBeenCalledWith("skills");
});
```

- [ ] **Step 2: Run and verify RED**

Run the focused Sidebar test. Expected: `Skills` is absent.

- [ ] **Step 3: Add the view key and navigation copy**

Extend `ViewKey` with `"skills"`. Add a Lucide `Wrench` item to the sidebar. Add Chinese and English keys for the navigation title, description, search, filters, statuses, summaries, empty/error states, permission tooltip, inspector, and stage heading.

- [ ] **Step 4: Integrate the independent view in App**

Handle `skills` in URL parsing, title helpers, the top eyebrow, selection cleanup, and inspector selection. Render it before runtime-dependent branches:

```tsx
{activeView === "skills" ? (
  <SkillsView user={user} />
) : activeView === "connections" ? (
  // existing view branches
```

Do not pass runtime data to `SkillsView`.

- [ ] **Step 5: Add restrained responsive styles**

Add `.skills-view`, `.skills-toolbar`, `.skills-summary`, `.skills-diagnostics`, `.skills-table`, and `.skills-inspector`. Use stable summary tracks, wrapped descriptions, and horizontal table overflow. At the compact breakpoint stack toolbar controls and use two summary columns.

- [ ] **Step 6: Verify focused tests and build**

```bash
npx vitest run --config web/vite.config.ts web/src/components/Sidebar.test.tsx web/src/components/SkillsView.test.tsx web/src/api.test.ts
npm run build:web
git diff --check
```

Expected: all focused tests and the Web build pass.

- [ ] **Step 7: Commit integration**

```bash
git add web/src/App.tsx web/src/types.ts web/src/components/Sidebar.tsx web/src/components/Sidebar.test.tsx web/src/language.tsx web/src/styles.css
git commit -m "feat: expose skills in workbench navigation"
```

### Task 4: End-To-End Verification And Restart

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the complete frontend suite**

Run `npm run test:web`. Expected: all Vitest files and tests pass.

- [ ] **Step 2: Verify full build and backend contract**

```bash
npm run build
node --test dist/test/web-server-skills.test.js
git diff --check
```

Expected: build and backend Skills contract pass.

- [ ] **Step 3: Restart the persistent panel**

Restart the `luaniao-web` tmux session from the repository root with `node dist/src/web-server.js --runtime-dir .agent-runtime --port 8787`. Verify `curl --noproxy '*' http://127.0.0.1:8787/` returns HTTP 200 and the process remains alive.

- [ ] **Step 4: Verify registry and Git state**

Run a direct `SkillRegistry` scan and require 28 usable Skills with zero diagnostics. Confirm only the known unrelated untracked Beekeeper plan remains.

- [ ] **Step 5: Report the visible entry**

Report that the left navigation now contains `Skills`, explain administrator versus analyst behavior, include test/build evidence, and provide the panel URL.
