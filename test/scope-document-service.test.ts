import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScopeDocumentService } from "../src/scope-documents/scope-document-service.js";
import { ScopeDocumentStore } from "../src/scope-documents/scope-document-store.js";

test("parses, persists, confirms, and copies an authorization document", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-document-service-"));
  try {
    const store = new ScopeDocumentStore(join(root, "documents"));
    const service = new ScopeDocumentService({ store });
    const parsed = await service.parse({
      fileName: "authorization.txt",
      data: Buffer.from("api.example\n10.0.0.1")
    });
    assert.equal(parsed.normalizedScope, "10.0.0.1/32,api.example");
    assert.equal((await store.get(parsed.documentId))?.parsed.fileName, "authorization.txt");
    assert.equal(await service.confirm({
      documentId: parsed.documentId,
      confirmedScope: parsed.normalizedScope,
      manualScope: "*.extra.example"
    }), "10.0.0.1/32,*.extra.example,api.example");

    const runtimeDir = join(root, "runtime");
    await store.copyToRuntime(parsed.documentId, runtimeDir);
    assert.equal(await readFile(join(runtimeDir, "scope-document", "source.bin"), "utf8"), "api.example\n10.0.0.1");
    assert.equal(JSON.parse(await readFile(join(runtimeDir, "scope-document", "result.json"), "utf8")).documentId, parsed.documentId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects changed confirmation, missing documents, and empty extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-document-confirm-"));
  try {
    const service = new ScopeDocumentService({ store: new ScopeDocumentStore(root) });
    const parsed = await service.parse({ fileName: "scope.txt", data: Buffer.from("api.example") });
    await assert.rejects(() => service.confirm({
      documentId: parsed.documentId,
      confirmedScope: "0.0.0.0/0"
    }), (error: unknown) => hasCode(error, "scope_confirmation_mismatch"));
    await assert.rejects(() => service.confirm({
      documentId: "00000000-0000-4000-8000-000000000000",
      confirmedScope: "api.example"
    }), (error: unknown) => hasCode(error, "scope_document_not_found"));
    await assert.rejects(
      () => service.parse({ fileName: "empty.txt", data: Buffer.from("no authorized assets here") }),
      (error: unknown) => hasCode(error, "no_scope_candidates")
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merges grounded AI candidates and preserves AI failure diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "scope-document-ai-"));
  try {
    const store = new ScopeDocumentStore(root);
    const service = new ScopeDocumentService({
      store,
      aiResolver: async () => ({
        accepted: [{ value: "ai.example", source: "ai", evidence: { line: 1, excerpt: "ai.example" } }],
        diagnostics: [{ code: "ai_notice", message: "resolved" }]
      })
    });
    const parsed = await service.parse({ fileName: "scope.txt", data: Buffer.from("rule.example ai.example") });
    assert.equal(parsed.normalizedScope, "ai.example,rule.example");
    assert.equal(parsed.domains.find((candidate) => candidate.value === "ai.example")?.source, "rule");
    assert.deepEqual(parsed.diagnostics, [{ code: "ai_notice", message: "resolved" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
