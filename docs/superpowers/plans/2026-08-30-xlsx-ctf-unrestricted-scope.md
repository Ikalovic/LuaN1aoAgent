# XLSX Scope Files and Optional CTF Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse all worksheets in XLSX authorization files and let CTF runs omit scope while keeping pentest scope requirements unchanged.

**Architecture:** Extend the existing bounded OOXML parser with XLSX workbook traversal using `fflate`, then propagate worksheet/cell evidence through the current candidate model. Represent an omitted CTF scope with one shared canonical `0.0.0.0/0` default used by Web and CLI entrypoints, so Controller and network enforcement continue through their existing paths.

**Tech Stack:** TypeScript, Node.js, `fflate`, Node test runner, React, Ant Design, Vitest, Testing Library.

---

### Task 1: Parse XLSX Workbooks and Preserve Cell Evidence

**Files:**
- Modify: `src/scope-documents/scope-document-types.ts`
- Modify: `src/scope-documents/scope-document-formats.ts`
- Modify: `src/scope-documents/scope-candidate-extractor.ts`
- Modify: `test/scope-document-formats.test.ts`
- Modify: `test/scope-document-extractor.test.ts`

- [ ] **Step 1: Write failing XLSX parser tests**

Add a `createXlsx()` fixture that ZIPs workbook metadata, relationships, shared strings, two worksheets, and an unrelated XML entry. Assert shared, inline, ordinary, and cached-formula values from both worksheets:

```ts
test("extracts every XLSX worksheet with cell evidence", async () => {
  assert.deepEqual(await extractScopeText("scope.xlsx", createXlsx()), [
    { text: "api.example", sheet: "External", cell: "A1" },
    { text: "10.0.0.0/24", sheet: "External", cell: "B2" },
    { text: "admin.example", sheet: "Internal", cell: "C3" },
    { text: "192.0.2.8", sheet: "Internal", cell: "D4" }
  ]);
});

test("rejects malformed XLSX packages", async () => {
  await assert.rejects(
    () => extractScopeText("scope.xlsx", Buffer.from("not-a-zip")),
    (error: unknown) => error instanceof ScopeDocumentError && error.code === "invalid_xlsx"
  );
});
```

- [ ] **Step 2: Run the parser test and verify red**

Run:

```bash
npm run build:server && node --test --test-concurrency=1 dist/test/scope-document-formats.test.js
```

Expected: FAIL with `unsupported_document_type` for `.xlsx`.

- [ ] **Step 3: Add worksheet and cell evidence fields**

Extend both types in `scope-document-types.ts`:

```ts
export type ScopeTextFragment = {
  text: string;
  page?: number;
  paragraph?: number;
  line?: number;
  sheet?: string;
  cell?: string;
};

export type ScopeCandidateEvidence = {
  page?: number;
  paragraph?: number;
  line?: number;
  sheet?: string;
  cell?: string;
  excerpt: string;
};
```

Copy `sheet` and `cell` in `addCandidate()` using the same conditional pattern as page, paragraph, and line.

- [ ] **Step 4: Implement bounded XLSX traversal**

Add dispatch:

```ts
case ".xlsx":
  fragments = xlsxCells(data);
  break;
```

Implement the parser around this interface:

```ts
function xlsxCells(data: Buffer): ScopeTextFragment[] {
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new ScopeDocumentError("invalid_xlsx", "XLSX 文件签名无效");
  }
  const entries = unzipOfficePackage(data, "invalid_xlsx", "XLSX");
  const workbook = requiredXml(entries, "xl/workbook.xml", "invalid_xlsx");
  const relationships = requiredXml(entries, "xl/_rels/workbook.xml.rels", "invalid_xlsx");
  const sharedStrings = parseSharedStrings(entries["xl/sharedStrings.xml"]);
  return parseWorkbookSheets(workbook, relationships).flatMap(({ name, path }) =>
    parseWorksheet(requiredXml(entries, path, "invalid_xlsx"), name, sharedStrings)
  );
}
```

The helpers must calculate expanded ZIP bytes before XML parsing, resolve relationship targets only inside `xl/`, decode XML entities, join rich shared-string `<t>` nodes, parse cell references and types, and reject missing or invalid workbook relationships as `invalid_xlsx`. Existing final fragment/text limits remain authoritative.

- [ ] **Step 5: Add and run evidence propagation test**

```ts
test("preserves XLSX worksheet and cell evidence", () => {
  const result = extractScopeCandidates([{
    text: "api.example 10.0.0.1",
    sheet: "Targets",
    cell: "B7"
  }]);
  assert.deepEqual(result.domains[0]?.evidence, {
    sheet: "Targets", cell: "B7", excerpt: "api.example 10.0.0.1"
  });
  assert.deepEqual(result.ipv4Cidrs[0]?.evidence, {
    sheet: "Targets", cell: "B7", excerpt: "api.example 10.0.0.1"
  });
});
```

Run:

```bash
npm run build:server && node --test --test-concurrency=1 dist/test/scope-document-formats.test.js dist/test/scope-document-extractor.test.js
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit XLSX parser support**

```bash
git add src/scope-documents/scope-document-types.ts src/scope-documents/scope-document-formats.ts src/scope-documents/scope-candidate-extractor.ts test/scope-document-formats.test.ts test/scope-document-extractor.test.ts
git commit -m "feat: parse XLSX authorization scopes"
```

### Task 2: Expose XLSX and Optional CTF Scope in the Web Form

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/components/StartRunModal.tsx`
- Modify: `web/src/components/StartRunModal.test.tsx`

- [ ] **Step 1: Write failing Web tests**

```ts
it("accepts XLSX authorization files", () => {
  render(<StartRunModal open onClose={() => undefined} onStarted={() => undefined} />);
  expect(screen.getByLabelText("授权范围文件"))
    .toHaveAttribute("accept", expect.stringContaining(".xlsx"));
});
```

Add one test that selects `ctf`, enters only a goal, submits, and expects `startRun` with `{ scope: "", taskType: "ctf" }`. Add another that enters only a pentest goal and expects the scope-required validation with no `startRun` call.

- [ ] **Step 2: Run Web tests and verify red**

```bash
npm run test:web -- web/src/components/StartRunModal.test.tsx
```

Expected: `.xlsx` is absent and CTF empty-scope submission is rejected.

- [ ] **Step 3: Update Web types and form behavior**

Add `sheet?: string` and `cell?: string` to `ScopeDocumentCandidate.evidence`. In the modal use:

```tsx
const taskType = Form.useWatch("taskType", form) ?? "pentest";
```

Add `dependencies={["taskType"]}` to the scope item, allow empty input when `taskType === "ctf"`, and set:

```tsx
accept=".txt,.md,.csv,.json,.docx,.xlsx,.pdf"
```

- [ ] **Step 4: Verify and commit the Web form**

```bash
npm run test:web -- web/src/components/StartRunModal.test.tsx
git add web/src/types.ts web/src/components/StartRunModal.tsx web/src/components/StartRunModal.test.tsx
git commit -m "feat: accept XLSX scope files in Web"
```

Expected: all StartRunModal tests pass before commit.

### Task 3: Normalize Empty CTF Scope in Web and CLI

**Files:**
- Modify: `src/scope.ts`
- Modify: `src/cli.ts`
- Modify: `src/web-server.ts`
- Modify: `test/scope.test.ts`
- Modify: `test/web-server-scope-documents.test.ts`

- [ ] **Step 1: Write the shared default-scope test**

```ts
test("defaults only an omitted CTF scope to unrestricted IPv4", () => {
  assert.equal(defaultScopeForTask("ctf"), "0.0.0.0/0");
  assert.equal(defaultScopeForTask("pentest"), undefined);
});
```

- [ ] **Step 2: Verify red**

```bash
npm run build:server
```

Expected: compilation fails because `defaultScopeForTask` is not exported.

- [ ] **Step 3: Implement one canonical CTF default**

Add to `scope.ts`:

```ts
export const UNRESTRICTED_CTF_SCOPE = "0.0.0.0/0";

export function defaultScopeForTask(taskType: "ctf" | "pentest"): string | undefined {
  return taskType === "ctf" ? UNRESTRICTED_CTF_SCOPE : undefined;
}
```

Use this only in the CLI's final no-scope branch:

```ts
: defaultScopeForTask(options.taskType)
  ?? await controller.inferScopeFromGoal(runContext.userGoal);
```

In `handleStartRun()`, validate the goal separately, reject absent scope only for pentest, and choose:

```ts
scope = scopeDocumentId
  ? await new ScopeDocumentService({ store: scopeDocumentStore }).confirm({
      documentId: scopeDocumentId,
      confirmedScope: confirmedDocumentScope,
      manualScope: rawScope
    })
  : rawScope
    ? normalizeScope(rawScope)
    : defaultScopeForTask(taskType)!;
```

- [ ] **Step 4: Add Web API regression coverage**

POST a pentest run with empty scope and assert `400`. POST a CTF run with empty scope and assert:

```ts
assert.equal(response.status, 201);
assert.equal((await response.json() as { scope: string }).scope, "0.0.0.0/0");
```

Stop the returned runtime through `/api/runs/stop` so test cleanup does not outlive the fixture.

- [ ] **Step 5: Verify and commit CTF behavior**

```bash
npm run build:server && node --test --test-concurrency=1 dist/test/scope.test.js dist/test/web-server-scope-documents.test.js dist/test/cli-options.test.js
git add src/scope.ts src/cli.ts src/web-server.ts test/scope.test.ts test/web-server-scope-documents.test.ts
git commit -m "feat: allow CTF runs without explicit scope"
```

Expected: all focused tests pass; CLI pentest continues through its existing inference path.

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update user documentation**

Use this supported-format sentence:

```md
Scope may also be extracted from TXT, Markdown, CSV, JSON, DOCX, XLSX, or text-layer PDF files.
```

State that XLSX reads all worksheets and that CTF may omit scope, which produces an unrestricted IPv4 boundary. State that pentest behavior is unchanged.

- [ ] **Step 2: Run complete verification**

```bash
npm run build
node --test --test-concurrency=1 --test-force-exit "dist/**/*.test.js"
npm run test:web
git diff --check
```

Expected: build exits 0; server has 0 failures with only the existing platform skip; Web has 0 failures; `git diff --check` prints nothing.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: describe XLSX and optional CTF scope"
```

- [ ] **Step 4: Review final state**

```bash
git status --short --branch
git log --oneline -6
```

Expected: only pre-existing unrelated untracked files remain; feature commits stay local until explicitly pushed.

