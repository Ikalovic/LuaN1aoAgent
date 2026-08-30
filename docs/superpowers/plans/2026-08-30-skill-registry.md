# Skill Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover, validate, select and expose project Agent Skills while guaranteeing that missing or broken Skills never prevent normal runs.

**Architecture:** A synchronous registry wraps Pi SDK Skill discovery and converts only validated project-local Skills into exact load paths. A short Planner-model selection session chooses eligible Skills for each Task; the controller logs selection and read events and falls back to an empty list on every registry/selection failure. Web APIs and a management drawer expose global enablement plus per-run allow/deny configuration without downloading or executing third-party content.

**Tech Stack:** TypeScript, Pi SDK Agent Skills, TypeBox structured tools, Node test runner, React 19, Ant Design, Vitest.

---

### Task 1: Build the project-local Skill Registry

**Files:**
- Create: `src/skills/skill-registry.ts`
- Test: `test/skill-registry.test.ts`

- [ ] **Step 1: Write failing discovery and containment tests**

```ts
const registry = new SkillRegistry(join(root, ".agents/skills"));
assert.deepEqual(registry.scan().skills.map((x) => x.name), ["recon-subdomain"]);
assert.equal(registry.scan().skills[0].valid, true);
assert.equal(registry.scan().diagnostics.some((x) => x.code === "skill_name_collision"), true);
assert.equal(registry.scan().diagnostics.some((x) => x.code === "skill_path_outside_root"), true);
```

Also test a missing root returns `{ skills: [], diagnostics: [] }`, missing description is invalid, illegal names are invalid, duplicate names have one deterministic winner, and a symlink escaping the root is rejected.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run build:server && node --test dist/test/skill-registry.test.js`  
Expected: compilation fails because `SkillRegistry` does not exist.

- [ ] **Step 3: Implement immutable registry snapshots**

```ts
export type RegisteredSkill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  valid: boolean;
  enabled: boolean;
  modelInvocable: boolean;
};

export type SkillRegistrySnapshot = {
  scannedAt: string;
  skills: RegisteredSkill[];
  diagnostics: Array<{ code: string; message: string; path?: string; skillName?: string }>;
};
```

Use Pi SDK `loadSkillsFromDir` for Agent Skills parsing, then add canonical-path containment, collision normalization and stable sorting. Persist enable/disable state in `.agents/skills-state.json` using atomic rename; a missing/unreadable state file means all valid Skills are enabled. Expose `scan()`, `snapshot()`, `setEnabled(name, enabled)`, and `resolveSelection(names, allowlist?, denylist?)`.

- [ ] **Step 4: Run the registry test**

Run: `npm run build:server && node --test dist/test/skill-registry.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit the registry**

```bash
git add src/skills/skill-registry.ts test/skill-registry.test.ts
git commit -m "feat: add validated project skill registry"
```

### Task 2: Add a bounded AI Skill selector

**Files:**
- Create: `src/skills/skill-selector.ts`
- Modify: `src/tools/pi-tools.ts`
- Modify: `src/agents.ts`
- Test: `test/skill-selector.test.ts`

- [ ] **Step 1: Write failing selector validation tests**

```ts
const result = validateSkillSelection(snapshot, {
  selections: [
    { name: "recon-subdomain", reason: "Task requests subdomain enumeration" },
    { name: "unknown", reason: "not installed" }
  ]
});
assert.deepEqual(result.selected.map((x) => x.name), ["recon-subdomain"]);
assert.deepEqual(result.rejected, [{ name: "unknown", code: "unknown_skill" }]);
```

Test disabled, invalid, denylisted, allowlisted and `disable-model-invocation` Skills, plus an empty snapshot returning immediately without an LLM call.

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run build:server && node --test dist/test/skill-selector.test.js`  
Expected: FAIL because selector functions are missing.

- [ ] **Step 3: Add the terminating selection tool and session**

Add `createSkillSelectionSubmitTool()` with a closed array schema containing `{ name, reason }`, capped at 16 entries and 500 characters per reason. Add `createSkillSelectorAgentSession` using the Planner model, no built-in tools, and a system prompt that chooses only Skills materially useful to the exact Task and permits an empty selection.

Implement:

```ts
export async function selectSkillsForTask(input: {
  taskGoal: string;
  snapshot: SkillRegistrySnapshot;
  llmRuntime: LlmRuntime;
  allowlist?: string[];
  denylist?: string[];
  providerAdmission?: ProviderAdmissionOptions;
}): Promise<{ selected: RegisteredSkill[]; reasons: Record<string, string>; diagnostics: SkillSelectionDiagnostic[] }>;
```

Catch provider, timeout and malformed-output errors and return an empty selection with `skill_selection_failed` rather than throwing.

- [ ] **Step 4: Run selector and agent tests**

Run: `npm run build:server && node --test dist/test/skill-selector.test.js dist/test/agents.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit selection support**

```bash
git add src/skills/skill-selector.ts src/tools/pi-tools.ts src/agents.ts test/skill-selector.test.ts
git commit -m "feat: select task skills with bounded AI output"
```

### Task 3: Integrate per-task selection with controller sessions

**Files:**
- Modify: `src/controller.ts`
- Modify: `src/agents.ts`
- Modify: `src/prompts.ts`
- Modify: `src/stores/runtime-store.ts`
- Modify: `src/web-trace-presentation.ts`
- Test: `test/controller-skills.test.ts`
- Modify: `test/agents.test.ts`
- Modify: `test/prompts.test.ts`
- Modify: `test/runtime-store.test.ts`
- Modify: `test/web-trace-presentation.test.ts`

- [ ] **Step 1: Write failing controller fallback tests**

Inject a registry and selector into a controller fixture. Assert a matched Task passes only selected `SKILL.md` paths to `createExecutorAgentSession`; no Skills passes `[]`; selector rejection still creates the Executor; a resumed Task reuses its persisted selected names; and registry exceptions append `skill_registry_failed` without rejecting the run.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm run build:server && node --test dist/test/controller-skills.test.js dist/test/agents.test.js`  
Expected: FAIL because the controller has no Skill dependencies or events.

- [ ] **Step 3: Replace whole-directory loading with exact validated paths**

Change Executor session creation to receive `skillsDirs` containing selected Skill directories only. The shared bootstrap Executor always receives `[]`; when a Task selects at least one Skill, force that Task through the existing dynamic/isolated Executor path so Skill bodies never leak into unrelated Tasks. At controller initialization scan once and append `skill_registry_scanned`. Before a new Task session, call `selectSkillsForTask`, append `skill_selected` per accepted Skill and `skill_skipped` for diagnostics, then construct the Executor. Add a nullable `selected_skills_json` column to `executor_sessions` through `ensureColumn`, and store the selected names so resume is deterministic. If state is absent for old sessions, select again; on any failure use `[]`.

Provide Planner with a compact `<available_skill_metadata>` block of valid enabled names/descriptions through `renderPlannerInput`, never Skill bodies. Keep Observer loaders unchanged.

- [ ] **Step 4: Record actual Skill reads**

Extend execution logging presentation so a successful Executor `read` whose canonical path ends with `/SKILL.md` under a selected base directory emits/presents `skill_instruction_read` with the Skill name. Do not treat selection alone as usage.

- [ ] **Step 5: Run controller and trace tests**

Run: `npm run build:server && node --test dist/test/controller-skills.test.js dist/test/agents.test.js dist/test/web-trace-presentation.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit runtime integration**

```bash
git add src/controller.ts src/agents.ts src/prompts.ts src/stores/runtime-store.ts src/web-trace-presentation.ts test/controller-skills.test.ts test/agents.test.ts test/prompts.test.ts test/runtime-store.test.ts test/web-trace-presentation.test.ts
git commit -m "feat: load selected skills per executor task"
```

### Task 4: Add Skill status and mutation APIs

**Files:**
- Modify: `src/web-server.ts`
- Test: `test/web-server-skills.test.ts`

- [ ] **Step 1: Write failing authorization and API tests**

Assert authenticated viewers can `GET /api/skills`; unauthenticated users receive 401; operators can `POST /api/skills/:name/state` with exactly `{ enabled: boolean }`; invalid names/extra fields return 400; analysts lacking mutation capability receive 403; and a missing `.agents/skills` returns a successful empty list.

- [ ] **Step 2: Run the API test and verify route failure**

Run: `npm run build:server && node --test dist/test/web-server-skills.test.js`  
Expected: new routes return 404.

- [ ] **Step 3: Implement registry routes and per-run input**

Create one project registry at server startup. Add GET refresh via `?refresh=true` and POST state mutation using existing CSRF and role checks. Extend run input with optional `skillAllowlist` and `skillDenylist`, validate each against the current snapshot, cap each at 128 unique names, reject overlap, and pass the filters into controller run options. Legacy run bodies remain valid.

- [ ] **Step 4: Run Web API and security tests**

Run: `npm run build:server && node --test dist/test/web-server-skills.test.js dist/test/web-server-get-api.test.js dist/test/web-security.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit Skill APIs**

```bash
git add src/web-server.ts test/web-server-skills.test.ts
git commit -m "feat: expose skill registry API"
```

### Task 5: Add the Web Skill management drawer and run filters

**Files:**
- Create: `web/src/components/SkillsView.tsx`
- Create: `web/src/components/SkillsView.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/components/StartRunModal.tsx`
- Modify: `web/src/language.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing component tests**

Mock an empty registry, valid Skills and an invalid Skill. Assert the view distinguishes installed/enabled/invalid states, operators can toggle while viewers see disabled controls, refresh reloads diagnostics, and StartRunModal sends selected allow/deny arrays. Assert the empty state explicitly says runs continue without Skills.

- [ ] **Step 2: Run component tests and verify failure**

Run: `npm run test:web -- web/src/components/SkillsView.test.tsx`  
Expected: FAIL because the component and API methods are absent.

- [ ] **Step 3: Implement typed APIs and UI**

Add `SkillItem`, `SkillDiagnostic`, and `SkillsResponse`; implement `fetchSkills(refresh?)` and `setSkillEnabled(name, enabled)`. Add a top-bar “Skills” drawer containing a table/list with source, automatic-invocation status, enabled switch and diagnostics. Add optional allow/deny multi-selects to StartRunModal populated from valid enabled Skills; default to no filters so current behavior is unchanged.

- [ ] **Step 4: Run Web tests**

Run: `npm run test:web -- web/src/components/SkillsView.test.tsx web/src/components/StartRunModal.test.tsx web/src/api.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit the management UI**

```bash
git add web/src/components/SkillsView.tsx web/src/components/SkillsView.test.tsx web/src/App.tsx web/src/api.ts web/src/types.ts web/src/components/StartRunModal.tsx web/src/language.tsx web/src/styles.css
git commit -m "feat: manage and filter skills in Web workbench"
```

### Task 6: Harden installation documentation and verify no-Skill compatibility

**Files:**
- Modify: `install.sh`
- Modify: `README.md`
- Modify: `README_CN.md`
- Test: `test/skill-no-install-regression.test.ts`

- [ ] **Step 1: Write the no-Skill regression test**

Start the runtime fixture with no `.agents` directory and a selector spy that throws if called. Assert initialization succeeds, Executor creation receives an empty Skill path list, normal Planner/Executor tools remain present, and a minimal run reaches its existing outcome path.

- [ ] **Step 2: Run the regression test**

Run: `npm run build:server && node --test dist/test/skill-no-install-regression.test.js`  
Expected before final integration fixes: FAIL if any new code assumes the directory or at least one Skill exists.

- [ ] **Step 3: Make installation updates atomic**

Change `install.sh` to assemble discovered Skills in a temporary staging directory, detect duplicate basenames across the three repositories, and move only the validated staged set into `.agents/skills`. Do not make server startup install or download Skills. Keep npm/build/image behavior unchanged.

- [ ] **Step 4: Document actual Skill semantics**

Explain installation, registry validation, automatic per-Task selection, the distinction between selected and actually read, Web controls, run filters, `.agents/skills` being gitignored, and the guaranteed empty/failed-Skill fallback.

- [ ] **Step 5: Run all verification**

Run: `npm run build && node --test --test-force-exit "dist/**/*.test.js" && npm run test:web && git diff --check`  
Expected: all server and Web tests pass; formatting check exits 0.

- [ ] **Step 6: Commit hardening and docs**

```bash
git add install.sh README.md README_CN.md test/skill-no-install-regression.test.ts
git commit -m "docs: harden and explain optional skill loading"
```
