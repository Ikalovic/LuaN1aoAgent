# Editable Scope Document Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace exact file-scope confirmation in the Web modal with an editable preview that appends deduplicated entries to the manual authorization scope field.

**Architecture:** Keep document parsing and the backend confirmation API unchanged. `StartRunModal` owns a temporary normalized-scope draft, promotes it into the existing `scope` form value when Add is clicked, then clears all file-preview state so submission follows the established manual-scope path.

**Tech Stack:** React 19, TypeScript, Ant Design 6, Vitest, Testing Library.

---

### Task 1: Specify Editable Preview Behavior

**Files:**
- Modify: `web/src/components/StartRunModal.test.tsx`

- [ ] **Step 1: Replace the exact-confirmation test with an edit-and-add test**

Use this behavior sequence in the component test:

```tsx
fireEvent.change(screen.getByLabelText("授权范围"), {
  target: { value: "manual.example,api.example" }
});
fireEvent.change(screen.getByLabelText("授权范围文件"), {
  target: { files: [new File(["api.example\n10.0.0.1"], "scope.txt", { type: "text/plain" })] }
});

const preview = await screen.findByLabelText("文件解析范围内容");
expect(preview).toHaveValue(parsed.normalizedScope);
expect(preview).toHaveAttribute("readonly");
fireEvent.click(screen.getByRole("button", { name: "修改" }));
fireEvent.change(preview, {
  target: { value: "api.example,10.0.0.1/32,extra.example" }
});
fireEvent.click(screen.getByRole("button", { name: "添加" }));

expect(screen.getByLabelText("授权范围")).toHaveValue(
  "manual.example,api.example,10.0.0.1/32,extra.example"
);
expect(screen.queryByLabelText("文件解析范围内容")).not.toBeInTheDocument();
```

Complete the test by entering a goal and starting the run. Assert that `startRun` receives the merged `scope` and does not receive `scopeDocumentId` or `confirmedDocumentScope`.

- [ ] **Step 2: Add a Pentest validation test**

Upload a file, wait for `文件解析范围内容`, enter only a goal, click Start, and assert `请输入授权范围` appears with no `startRun` call. This proves an unadded preview is not authorization.

- [ ] **Step 3: Run the focused test and verify RED**

```bash
npm run test:web -- web/src/components/StartRunModal.test.tsx
```

Expected: the new tests fail because the preview textarea and Modify/Add buttons do not exist. Existing CTF and manual-scope tests remain passing.

### Task 2: Implement Preview Promotion

**Files:**
- Modify: `web/src/components/StartRunModal.tsx`
- Modify: `web/src/language.tsx`
- Test: `web/src/components/StartRunModal.test.tsx`

- [ ] **Step 1: Add localized labels**

Replace the unused confirmation label with these keys in both locale maps:

```ts
// zh
"startRun.scopePreviewContent": "文件解析范围内容",
"startRun.modifyScopePreview": "修改",
"startRun.addScopePreview": "添加",

// en
"startRun.scopePreviewContent": "Parsed scope content",
"startRun.modifyScopePreview": "Modify",
"startRun.addScopePreview": "Add",
```

- [ ] **Step 2: Replace confirmation state with draft state**

Import `useRef` and `Button`, remove `Checkbox` and `Tag`, then add:

```tsx
const fileInputRef = useRef<HTMLInputElement>(null);
const [scopeDraft, setScopeDraft] = useState("");
const [editingScopeDraft, setEditingScopeDraft] = useState(false);

const resetDocument = () => {
  setParsedDocument(undefined);
  setScopeDraft("");
  setEditingScopeDraft(false);
  if (fileInputRef.current) fileInputRef.current.value = "";
};
```

After `parseScopeDocument(file)` resolves, store the response and initialize `scopeDraft` from `normalizedScope`.

- [ ] **Step 3: Implement append and deduplication**

```tsx
const addScopeDraft = () => {
  const entries = [String(form.getFieldValue("scope") ?? ""), scopeDraft]
    .flatMap((value) => value.split(/[\s,，;；]+/u))
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const merged = entries.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (merged.length === 0) return;
  form.setFieldValue("scope", merged.join(","));
  void form.validateFields(["scope"]).catch(() => undefined);
  resetDocument();
};
```

- [ ] **Step 4: Render the editable preview**

Attach `ref={fileInputRef}` to the file input. Replace tags, evidence text, and the checkbox with:

```tsx
<Space direction="vertical" size={8} style={{ width: "100%" }}>
  <Input.TextArea
    aria-label={t("startRun.scopePreviewContent")}
    rows={3}
    value={scopeDraft}
    readOnly={!editingScopeDraft}
    onChange={(event) => setScopeDraft(event.target.value)}
  />
  <Space>
    <Button onClick={() => setEditingScopeDraft(true)}>
      {t("startRun.modifyScopePreview")}
    </Button>
    <Button type="primary" disabled={!scopeDraft.trim()} onClick={addScopeDraft}>
      {t("startRun.addScopePreview")}
    </Button>
  </Space>
</Space>
```

- [ ] **Step 5: Restore manual-scope submission semantics**

Set the modal Start button disabled state to only `parsing`. Pentest validation must check only the actual `scope` value, not `parsedDocument`. Remove `documentConfirmed` and the conditional `scopeDocumentId` / `confirmedDocumentScope` fields from the `startRun` payload; retain all existing budget and task-type fields.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm run test:web -- web/src/components/StartRunModal.test.tsx
```

Expected: all `StartRunModal` tests pass with no unhandled promise rejections.

- [ ] **Step 7: Commit the feature**

```bash
git add web/src/components/StartRunModal.tsx web/src/components/StartRunModal.test.tsx web/src/language.tsx
git commit -m "feat: edit and append parsed Web scope"
```

### Task 3: Verify and Restart the Web Panel

**Files:**
- No source changes expected.

- [ ] **Step 1: Run complete Web verification**

```bash
npm run build:web
npm run test:web
git diff --check
```

Expected: the production build exits 0, all Web tests pass, and `git diff --check` prints nothing.

- [ ] **Step 2: Restart the existing panel**

Resolve the process listening on `127.0.0.1:8787`, confirm it is this repository's `dist/src/web-server.js`, terminate only that process, and start the new build with `.agent-runtime`. Preserve any explicit `EXECUTOR_SANDBOX_MODE` selected by the operator.

- [ ] **Step 3: Verify the restarted panel**

```bash
curl --noproxy '*' -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/
```

Expected: `200`.
