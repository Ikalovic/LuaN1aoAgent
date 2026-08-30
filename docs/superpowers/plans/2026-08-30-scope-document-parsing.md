# Scope Document Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Web and CLI users derive a confirmed domain/IPv4/CIDR authorization boundary from TXT, Markdown, CSV, JSON, DOCX, or text-layer PDF files without changing existing text-only runs.

**Architecture:** A format-neutral parser produces bounded text fragments with source positions, deterministic extraction creates grounded candidates, and an optional Planner-model resolver may add only candidates whose literal normalized value is present in a fragment. A filesystem store keeps pre-run documents under the configured runtime root; Web and CLI merge confirmed file scope with manual scope before passing the same normalized string into the existing controller guards.

**Tech Stack:** TypeScript, Node.js 25, `fflate`, `pdfjs-dist`, Pi SDK structured tools, Node test runner, React 19, Ant Design, Vitest.

---

### Task 1: Add document contracts and deterministic extraction

**Files:**
- Create: `src/scope-documents/scope-document-types.ts`
- Create: `src/scope-documents/scope-candidate-extractor.ts`
- Modify: `src/scope.ts`
- Test: `test/scope-document-extractor.test.ts`

- [ ] **Step 1: Write failing tests for grounded domains, IPv4 and CIDRs**

```ts
test("extracts normalized candidates with line evidence", () => {
  assert.deepEqual(extractScopeCandidates([{ text: "允许 api.Example.com 和 10.0.0.7、10.1.0.0/16", line: 4 }]), {
    domains: [{ value: "api.example.com", source: "rule", evidence: { line: 4, excerpt: "允许 api.Example.com 和 10.0.0.7、10.1.0.0/16" } }],
    ipv4Cidrs: [
      { value: "10.0.0.7/32", source: "rule", evidence: { line: 4, excerpt: "允许 api.Example.com 和 10.0.0.7、10.1.0.0/16" } },
      { value: "10.1.0.0/16", source: "rule", evidence: { line: 4, excerpt: "允许 api.Example.com 和 10.0.0.7、10.1.0.0/16" } }
    ]
  });
});

test("does not accept URL paths, IPv6, email domains or invalid IPv4", () => {
  const result = extractScopeCandidates([{ text: "https://x.example/a user@example.com 2001:db8::1 999.1.1.1" }]);
  assert.deepEqual(result, { domains: [], ipv4Cidrs: [] });
});
```

- [ ] **Step 2: Run the focused test and verify that imports fail**

Run: `npm run build:server && node --test dist/test/scope-document-extractor.test.js`  
Expected: compilation fails because `scope-document-types.ts` and `scope-candidate-extractor.ts` do not exist.

- [ ] **Step 3: Export a reusable single-entry normalizer and implement the contracts**

```ts
export type ScopeTextFragment = { text: string; page?: number; paragraph?: number; line?: number };
export type ScopeCandidate = {
  value: string;
  source: "rule" | "ai";
  evidence: { page?: number; paragraph?: number; line?: number; excerpt: string };
};
export type ParsedScopeDocument = {
  documentId: string;
  fileName: string;
  domains: ScopeCandidate[];
  ipv4Cidrs: ScopeCandidate[];
  normalizedScope: string;
  diagnostics: Array<{ code: string; message: string }>;
};
```

Add `normalizeScopeEntry(value: string): { kind: "domain" | "cidr"; value: string }` to `src/scope.ts`, implemented by the same private IPv4/domain normalization functions used by `parseAuthorizedScope`. Implement `extractScopeCandidates(fragments)` with bounded regexes, rejection of URL/email contexts, `normalizeScopeEntry`, stable de-duplication, and a 240-character evidence excerpt.

- [ ] **Step 4: Run scope tests**

Run: `npm run build:server && node --test dist/test/scope.test.js dist/test/scope-document-extractor.test.js`  
Expected: both files pass.

- [ ] **Step 5: Commit the extraction unit**

```bash
git add src/scope.ts src/scope-documents/scope-document-types.ts src/scope-documents/scope-candidate-extractor.ts test/scope-document-extractor.test.ts
git commit -m "feat: extract grounded scope document candidates"
```

### Task 2: Implement bounded format adapters

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/scope-documents/scope-document-formats.ts`
- Test: `test/scope-document-formats.test.ts`

- [ ] **Step 1: Install server parsing dependencies**

Run: `npm install fflate pdfjs-dist`  
Expected: both packages appear under `dependencies`, and the lockfile changes.

- [ ] **Step 2: Write failing adapter tests**

Create tests that pass `Buffer` values directly and assert these exact outcomes:

```ts
assert.deepEqual((await extractScopeText("scope.txt", Buffer.from("a.example\n10.0.0.1"))).map((x) => x.line), [1, 2]);
assert.deepEqual((await extractScopeText("scope.csv", Buffer.from("kind,value\ndomain,a.example"))).at(-1)?.text, "domain value a.example");
assert.match((await extractScopeText("scope.json", Buffer.from('{"domain":"a.example"}')))[0].text, /a\.example/);
await assert.rejects(() => extractScopeText("scan.pdf", scannedPdf), (error: ScopeDocumentError) => error.code === "scanned_pdf_not_supported");
await assert.rejects(() => extractScopeText("scope.exe", Buffer.from("x")), (error: ScopeDocumentError) => error.code === "unsupported_document_type");
```

Generate DOCX input in the test with `zipSync({ "[Content_Types].xml": ..., "word/document.xml": strToU8(documentXml) })`; generate a minimal text PDF fixture in the test helper with numbered PDF objects and computed xref offsets so no binary fixture is committed.

- [ ] **Step 3: Run the focused test and verify failure**

Run: `npm run build:server && node --test dist/test/scope-document-formats.test.js`  
Expected: FAIL because `extractScopeText` is missing.

- [ ] **Step 4: Implement strict format dispatch and limits**

```ts
export const SCOPE_DOCUMENT_LIMITS = {
  inputBytes: 5 * 1024 * 1024,
  expandedBytes: 20 * 1024 * 1024,
  fragments: 10_000,
  textBytes: 2 * 1024 * 1024
} as const;

export async function extractScopeText(fileName: string, data: Buffer): Promise<ScopeTextFragment[]>;
```

TXT/MD split into numbered lines; CSV uses a quote-aware state machine and flattens each row; JSON recursively emits scalar paths with depth/node limits; DOCX uses `unzipSync` with expanded-size checks and extracts only `word/document.xml`, decoding XML entities and paragraph boundaries; PDF loads with `pdfjs-dist/legacy/build/pdf.mjs`, disables external resources, visits bounded pages, and emits page-numbered text. Reject encrypted, malformed, image-only, over-limit, mismatched-magic, and unsupported files with `ScopeDocumentError(code, message)`.

- [ ] **Step 5: Run adapter and extraction tests**

Run: `npm run build:server && node --test dist/test/scope-document-formats.test.js dist/test/scope-document-extractor.test.js`  
Expected: PASS.

- [ ] **Step 6: Commit format support**

```bash
git add package.json package-lock.json src/scope-documents/scope-document-formats.ts test/scope-document-formats.test.ts
git commit -m "feat: parse bounded scope document formats"
```

### Task 3: Add optional AI-assisted grounded resolution

**Files:**
- Create: `src/scope-documents/scope-document-resolver.ts`
- Modify: `src/agents.ts`
- Modify: `src/tools/pi-tools.ts`
- Test: `test/scope-document-resolver.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
test("accepts AI candidates only when normalized literals occur in evidence", () => {
  const fragments = [{ text: "授权 *.example.com 与 10.2.0.0/16", line: 1 }];
  assert.deepEqual(validateAiScopeCandidates(fragments, {
    candidates: [
      { value: "*.example.com", fragmentIndex: 0 },
      { value: "10.0.0.0/8", fragmentIndex: 0 }
    ]
  }).map((x) => x.value), ["*.example.com"]);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run build:server && node --test dist/test/scope-document-resolver.test.js`  
Expected: FAIL because the validator and resolver session do not exist.

- [ ] **Step 3: Implement a terminating structured tool and resolver session**

Add `createScopeDocumentSubmitTool()` with this closed schema:

```ts
Type.Object({ candidates: Type.Array(Type.Object({
  value: Type.String({ minLength: 3, maxLength: 253 }),
  fragmentIndex: Type.Integer({ minimum: 0 })
}, { additionalProperties: false }), { maxItems: 256 }) }, { additionalProperties: false })
```

Add `createScopeDocumentResolverAgentSession`, using the Planner model and no built-in tools. Its prompt forbids DNS, inferred parent networks, related assets and non-literal values. Implement `resolveDocumentScopeWithAi({ fragments, llmRuntime, providerAdmission })`; send only a bounded numbered fragment set and validate every returned candidate by fragment index, `normalizeScopeEntry`, and literal occurrence after case/IDN normalization. Return `[]` on timeout/provider failure together with an `ai_scope_resolution_failed` diagnostic.

- [ ] **Step 4: Run resolver and existing agent tests**

Run: `npm run build:server && node --test dist/test/scope-document-resolver.test.js dist/test/agents.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit AI assistance**

```bash
git add src/scope-documents/scope-document-resolver.ts src/agents.ts src/tools/pi-tools.ts test/scope-document-resolver.test.ts
git commit -m "feat: ground AI scope extraction in document evidence"
```

### Task 4: Persist pre-run documents and compose confirmed scope

**Files:**
- Create: `src/scope-documents/scope-document-store.ts`
- Create: `src/scope-documents/scope-document-service.ts`
- Test: `test/scope-document-store.test.ts`
- Test: `test/scope-document-service.test.ts`

- [ ] **Step 1: Write failing store and confirmation tests**

```ts
const parsed = await service.parse({ fileName: "scope.txt", data: Buffer.from("a.example\n10.0.0.1") });
assert.equal(parsed.normalizedScope, "10.0.0.1/32,a.example");
assert.equal((await store.get(parsed.documentId))?.fileName, "scope.txt");
assert.equal(await service.confirm({ documentId: parsed.documentId, confirmedScope: parsed.normalizedScope, manualScope: "b.example" }), "10.0.0.1/32,a.example,b.example");
await assert.rejects(() => service.confirm({ documentId: parsed.documentId, confirmedScope: "0.0.0.0/0" }), /does not match parsed scope/);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build:server && node --test dist/test/scope-document-store.test.js dist/test/scope-document-service.test.js`  
Expected: compilation fails for the missing store/service.

- [ ] **Step 3: Implement atomic filesystem persistence and confirmation**

`ScopeDocumentStore(rootDir)` stores each document under `rootDir/<uuid>/` as `source.bin` and `result.json`, writes through a temporary file plus rename, rejects traversal/symlink targets, and exposes `put`, `get`, and `copyToRuntime(documentId, runtimeDir)`. `ScopeDocumentService` coordinates format extraction, rule extraction, optional AI candidates, de-duplication and `normalizeScope`; `confirm` requires byte-for-byte equality with the stored normalized parsed scope before merging optional manual scope.

- [ ] **Step 4: Run the focused tests**

Run: `npm run build:server && node --test dist/test/scope-document-store.test.js dist/test/scope-document-service.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit persistence**

```bash
git add src/scope-documents/scope-document-store.ts src/scope-documents/scope-document-service.ts test/scope-document-store.test.ts test/scope-document-service.test.ts
git commit -m "feat: persist and confirm parsed scope documents"
```

### Task 5: Expose Web parsing and confirmed run start

**Files:**
- Modify: `src/web-server.ts`
- Test: `test/web-server-scope-documents.test.ts`

- [ ] **Step 1: Write failing authenticated API tests**

Cover `POST /api/scope-documents` with `{ fileName, contentBase64 }`, `GET /api/scope-documents/:id`, invalid base64, payload over 5 MiB, unsupported formats, viewer mutation denial, and `POST /api/runs` accepting `{ scopeDocumentId, confirmedDocumentScope, scope: "" }`. Assert mismatched confirmation returns HTTP 409 with `scope_confirmation_mismatch`, while a legacy `{ goal, scope }` request reaches the existing run bootstrap path unchanged.

- [ ] **Step 2: Run the Web test and verify route failure**

Run: `npm run build:server && node --test dist/test/web-server-scope-documents.test.js`  
Expected: new routes return 404 or invalid request.

- [ ] **Step 3: Implement routes with stable errors**

Initialize the store at `join(runtimePathPolicy.rootDir, "scope-documents")`. Read upload JSON with an 8 MiB body cap, strictly validate keys/base64/name, parse with `ScopeDocumentService`, and return 201. Extend `handleStartRun` to accept optional `scopeDocumentId` and `confirmedDocumentScope`; require either non-empty manual scope or a confirmed document; copy the confirmed source/result into the newly created runtime and emit a `scope_document_confirmed` execution event. Map parser codes to 400/413/415/422 and confirmation mismatch to 409.

Construct the optional AI resolver from `createLlmRuntime()` only when parsing reaches the AI phase. If LLM configuration is absent or provider admission fails, return the deterministic extraction plus `ai_scope_resolution_failed`; the upload endpoint must not become a 500 solely because AI assistance is unavailable.

- [ ] **Step 4: Run Web security and API tests**

Run: `npm run build:server && node --test dist/test/web-server-scope-documents.test.js dist/test/web-server-get-api.test.js dist/test/web-security.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit Web API support**

```bash
git add src/web-server.ts test/web-server-scope-documents.test.ts
git commit -m "feat: add scope document Web API"
```

### Task 6: Add Web upload, preview and confirmation UI

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/components/StartRunModal.tsx`
- Modify: `web/src/language.tsx`
- Modify: `web/src/styles.css`
- Create: `web/src/components/StartRunModal.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Mock `parseScopeDocument` and `startRun`; upload `scope.txt`, assert candidate tags/evidence appear, assert Start is disabled until the preview checkbox is checked, and assert the final request includes `scopeDocumentId` plus the exact `confirmedDocumentScope`. Also assert the existing manual-scope-only form still submits without any document fields.

- [ ] **Step 2: Run the UI test and verify failure**

Run: `npm run test:web -- web/src/components/StartRunModal.test.tsx`  
Expected: FAIL because upload and preview controls do not exist.

- [ ] **Step 3: Add typed API methods and the preview state machine**

Add `ScopeDocumentResponse`, `ScopeCandidate`, and optional `scopeDocumentId`/`confirmedDocumentScope` fields to Web types. Implement `parseScopeDocument(file)` by `File.arrayBuffer()`, base64 encoding, and POSTing JSON. In `StartRunModal`, accept `.txt,.md,.csv,.json,.docx,.pdf`, show upload/parse/error states, render domain and CIDR candidates with evidence, clear confirmation whenever the file changes, and allow an empty manual scope only when a confirmed non-empty document preview exists.

- [ ] **Step 4: Run component and Web suites**

Run: `npm run test:web -- web/src/components/StartRunModal.test.tsx web/src/api.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit Web UI support**

```bash
git add web/src/types.ts web/src/api.ts web/src/components/StartRunModal.tsx web/src/components/StartRunModal.test.tsx web/src/language.tsx web/src/styles.css
git commit -m "feat: preview scope documents before Web runs"
```

### Task 7: Add CLI scope files and non-interactive confirmation

**Files:**
- Modify: `src/cli-options.ts`
- Modify: `src/cli.ts`
- Test: `test/cli-options.test.ts`
- Test: `test/cli-runtime.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Assert repeated `--scope-file` values are preserved, `--scope-file` is forbidden with `--resume`, and non-interactive file runs require `--confirm-scope-files`. Assert merging two files and `--scope` produces stable normalized output.

- [ ] **Step 2: Run CLI tests and verify failure**

Run: `npm run build:server && node --test dist/test/cli-options.test.js dist/test/cli-runtime.test.js`  
Expected: FAIL for unknown options.

- [ ] **Step 3: Implement repeatable options and confirmation behavior**

Extend `CliOptions` with `scopeFiles: string[]` and `confirmScopeFiles: boolean`; change argument parsing so only `scope-file` accumulates while other value options retain current semantics. Add help text. Before runtime bootstrap, parse files with `ScopeDocumentService`; TTY mode prints candidates and asks one yes/no question, while JSON/JSONL/no-TUI requires `--confirm-scope-files`. Merge the confirmed file results with `--scope`; preserve Goal inference when neither is provided.

Supply the same lazy optional AI resolver used by Web. Missing LLM configuration during file parsing retains deterministic candidates; normal runtime bootstrap may still report its existing configuration error when an actual Agent run starts.

- [ ] **Step 4: Run CLI and scope tests**

Run: `npm run build:server && node --test dist/test/cli-options.test.js dist/test/cli-runtime.test.js dist/test/scope-document-service.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit CLI support**

```bash
git add src/cli-options.ts src/cli.ts test/cli-options.test.ts test/cli-runtime.test.ts
git commit -m "feat: accept confirmed scope files in CLI"
```

### Task 8: Document and run full regression verification

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`

- [ ] **Step 1: Document formats, limits and examples**

Add Web and CLI examples, including `npm start -- --goal "评估授权资产" --scope-file authorization.docx --confirm-scope-files --no-tui`, the no-OCR limitation, union semantics with `--scope`, and the rule that file evidence cannot broaden scope through DNS/FOFA inference.

- [ ] **Step 2: Run static and focused security checks**

Run: `npm run build && git diff --check`  
Expected: both commands exit 0.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`  
Expected: server and Web tests pass with no failures.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md README_CN.md
git commit -m "docs: explain scope document authorization"
```
