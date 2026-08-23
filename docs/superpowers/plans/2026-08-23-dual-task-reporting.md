# Dual CTF and Pentest Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit CTF and pentest run modes, Markdown-based user-configurable pentest templates, and mode-specific final report artifacts.

**Architecture:** Normalize the run mode at the Web/CLI boundary, load pentest Markdown templates once per run, and carry a small immutable reporting context through controller prompts. Keep ArtifactStore and TaskOutcome as the source of truth; only the finalization prompt and Web presentation vary by mode.

**Tech Stack:** TypeScript/Node.js, existing controller and ArtifactStore, React/Ant Design Web UI, Node test runner, Vitest.

---

### Task 1: Add Markdown template assets and loader

**Files:**
- Create: `templates/pentest/default-scoring-standard.md`
- Create: `templates/pentest/default-report-template.md`
- Create: `src/reporting/task-reporting.ts`
- Test: `test/task-reporting.test.ts`

- [ ] **Step 1: Write the failing loader tests**

Add tests for `normalizeTaskType`, `loadPentestTemplates`, and `reportFilename`:

```ts
test("missing task type defaults to pentest", () => {
  assert.equal(normalizeTaskType(undefined), "pentest");
  assert.equal(normalizeTaskType("ctf"), "ctf");
});

test("invalid task type is rejected", () => {
  assert.throws(() => normalizeTaskType("unknown"), /taskType/);
});

test("pentest templates load from explicit paths", async () => {
  const result = await loadPentestTemplates({
    scoringPath: scoringFixture,
    reportPath: reportFixture,
    allowedRoots: [fixtureRoot]
  });
  assert.match(result.scoringText, /评分/);
  assert.match(result.reportText, /攻击路径/);
  assert.match(result.templateDigest, /^[a-f0-9]{64}$/);
});

test("empty or outside-root template fails closed", async () => {
  await assert.rejects(loadPentestTemplates({ scoringPath: emptyFixture, reportPath: reportFixture, allowedRoots: [fixtureRoot] }), /template_unavailable/);
  await assert.rejects(loadPentestTemplates({ scoringPath: outsideFixture, reportPath: reportFixture, allowedRoots: [fixtureRoot] }), /template_unavailable/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/task-reporting.test.ts`

Expected: FAIL because the reporting module and Markdown fixtures do not exist.

- [ ] **Step 3: Create the normalized default Markdown templates**

Write the scoring file with the PDF-derived rules: submission ordering and 50% reuse rule, per-result and per-unit caps, supply-chain bonus, authorization requirements, required credential source/code/path details, AI traceability, and the scoring/penalty categories for devices, accounts, servers, Web/FTP, databases, virtualization, identity platforms, network/security devices, AI applications, and data access.

Write the report file with these required sections: project information, self-score detail, attack path, result/evidence entries, exploit code, credential source, trace-cleanup table, other notes, AI-use statement, and appendices/limitations.

- [ ] **Step 4: Implement the loader and immutable reporting context**

Export:

```ts
export type TaskType = "ctf" | "pentest";
export type ReportingContext = {
  taskType: TaskType;
  scoringTemplatePath?: string;
  reportTemplatePath?: string;
  scoringText?: string;
  reportText?: string;
  templateDigest?: string;
};
export function normalizeTaskType(value: unknown): TaskType;
export async function loadPentestTemplates(input: { scoringPath?: string; reportPath?: string; allowedRoots: string[] }): Promise<ReportingContext>;
export function reportFilename(taskType: TaskType): string;
```

Use `readFile`, `resolve`, `relative`, and SHA-256 hashing. Reject missing, empty, oversized, or outside-allowlist files with an error whose `code` is `template_unavailable`.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `node --test test/task-reporting.test.ts`

Expected: PASS for normalization, default fixture loading, digest generation, and fail-closed path checks.

### Task 2: Carry task type and reporting context through controller execution

**Files:**
- Modify: `src/types.ts`
- Modify: `src/controller.ts`
- Modify: `src/cli.ts`
- Modify: `src/agent-runtime-bootstrap.ts` only if bootstrap metadata is required
- Test: `test/controller-reporting-mode.test.ts`

- [ ] **Step 1: Add type-level failing tests**

Assert that `runUntilDone` accepts `{ taskType, reportingContext }`, and that the finalization tool instructions use `writeup.md` for CTF and `pentest-report.md` plus template text for pentest.

- [ ] **Step 2: Extend public runtime types**

Add `TaskType` and optional `reportingContext` references without changing existing TaskEnvelope or TaskOutcome wire compatibility. Keep historical sessions readable by treating absent mode as `pentest`.

- [ ] **Step 3: Extend controller input and prompt rendering**

Add optional fields to `SecurityAgentController.runUntilDone`:

```ts
type RunReportingInput = {
  taskType?: TaskType;
  reportingContext?: ReportingContext;
};
```

Normalize mode at entry. Add a bounded `<reporting_context>` block to Planner/Executor prompts. The CTF block requires a concise reproducible WP and Flag; the pentest block requires evidence-backed findings, score details, credential source, attack path, AI disclosure, and the configured template sections. Never let template text override authorization or system instructions.

- [ ] **Step 4: Update finalization guidance**

Change the existing finalization guidance so the report artifact filename and minimum sections are mode-specific, while retaining the existing requirement that `artifactRefs` reference a real `artifact_write(kind="report")` result.

- [ ] **Step 5: Pass mode from CLI**

Add a CLI option with default `pentest`, load Markdown templates for pentest, and pass the resulting context to `runUntilDone`. Preserve existing CLI behavior when the option is omitted.

- [ ] **Step 6: Run focused controller and prompt tests**

Run: `node --test test/controller-reporting-mode.test.ts test/prompts.test.ts`

Expected: PASS, with legacy prompt assertions unchanged except for additive mode-specific rules.

### Task 3: Add Web API and UI task-type selection

**Files:**
- Modify: `src/web-server.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/components/StartRunModal.tsx`
- Modify: `web/src/api.ts` only if request types require changes
- Modify: `web/src/language.tsx`
- Test: `test/web-server-reporting-mode.test.ts`
- Test: `web/src/components/StartRunModal.test.tsx`

- [ ] **Step 1: Add failing API/UI tests**

Verify `POST /api/runs` defaults missing `taskType` to `pentest`, accepts `ctf`, rejects other values, and returns `taskType` and template digest metadata. Verify the modal renders a selector defaulted to pentest and sends the selected value.

- [ ] **Step 2: Extend Web request/response types**

Add:

```ts
export interface StartRunInput {
  goal: string;
  scope: string;
  taskType?: "ctf" | "pentest";
  maxRunTimeMs?: number;
  maxParallelTasks?: number;
  maxPlannerCycles?: number;
}
```

Add `taskType` to active-run and start-run response views.

- [ ] **Step 3: Normalize and load mode in `handleStartRun`**

Read `body.taskType`, call `normalizeTaskType`, resolve configured template paths for pentest, and return `{ code: "template_unavailable" }` before bootstrapping when templates cannot be read. Pass `taskType` and `reportingContext` to `runUntilDone` and expose the normalized mode in active-run responses.

- [ ] **Step 4: Update the modal**

Add an Ant Design `Select` with `pentest` first and selected by default, `ctf` second. Include a short description that pentest uses configured Markdown templates and CTF produces a WP. Include the field in `startRun` payload.

- [ ] **Step 5: Add translations and run Web tests**

Add Chinese/English labels for task type and both modes. Run: `npm run test:web -- --run web/src/components/StartRunModal.test.tsx`.

Expected: PASS with the selector, default value, submission payload, and validation behavior.

### Task 4: Persist and display reporting metadata

**Files:**
- Modify: `src/web-server.ts`
- Modify: `src/run-report.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/components/ArtifactsView.tsx` or the existing report view component
- Test: `test/run-report.test.ts`
- Test: `web/src/components/ArtifactsView.test.tsx`

- [ ] **Step 1: Add failing metadata tests**

Assert that final-report derivation returns `taskType` and that report artifacts expose the expected filename (`writeup.md` or `pentest-report.md`). Assert that the Web report view labels the mode.

- [ ] **Step 2: Extend final report and session views**

Add optional `taskType`, `templateDigest`, and `templatePaths` fields to the Web-only report view. Derive them from persisted run metadata/events; do not change ArtifactStore identity or hash semantics.

- [ ] **Step 3: Render mode and artifact labels**

Display `CTF WP` or `渗透测试报告` beside the final artifact, retain Markdown preview/download behavior, and show the template digest for pentest runs when available.

- [ ] **Step 4: Run focused report/UI tests**

Run: `node --test test/run-report.test.ts && npm run test:web -- --run web/src/components/ArtifactsView.test.tsx`.

Expected: PASS with legacy report derivation tests preserved.

### Task 5: Documentation, build, and regression verification

**Files:**
- Modify: `说明.md`
- Modify: `README_CN.md` if the user-facing startup flow is documented there
- Test: existing server and Web suites

- [ ] **Step 1: Document configuration and examples**

Document `taskType`, default `pentest`, the two Markdown template environment variables, the two default template files, the generated filenames, and the fact that the original PDF is not required at runtime.

- [ ] **Step 2: Run TypeScript builds**

Run: `npm run build:server && npm run build:web`.

Expected: both commands exit 0.

- [ ] **Step 3: Run focused regression suites**

Run: `node --test test/task-reporting.test.ts test/controller-reporting-mode.test.ts test/web-server-reporting-mode.test.ts test/run-report.test.ts && npm run test:web`.

Expected: all new tests pass and the existing Web suite remains green.

- [ ] **Step 4: Run repository checks and record baseline failures**

Run: `git diff --check` and the project test command. If pre-existing unrelated failures remain, record their exact test names and output in the handoff; do not mask them as feature failures.

- [ ] **Step 5: Commit when Git metadata is writable**

Use separate commits for template/loader, runtime mode, Web mode, metadata/UI, and documentation. The current managed environment mounts `.git` read-only, so commit commands must be run from an external writable checkout.

