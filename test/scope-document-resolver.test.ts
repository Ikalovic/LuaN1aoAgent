import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  resolveDocumentScopeWithAi,
  renderScopeDocumentFragments,
  validateAiScopeCandidates
} from "../src/scope-documents/scope-document-resolver.js";
import { createScopeDocumentSubmitTool } from "../src/tools/pi-tools.js";
import { SCOPE_DOCUMENT_RESOLVER_SYSTEM_PROMPT } from "../src/agents.js";

test("accepts AI candidates only when grounded in the referenced fragment", () => {
  const result = validateAiScopeCandidates(
    [{ text: "授权 *.example.com 与 10.2.9.4/16", line: 1 }],
    { candidates: [
      { value: "*.example.com", fragmentIndex: 0 },
      { value: "10.2.0.0/16", fragmentIndex: 0 },
      { value: "10.0.0.0/8", fragmentIndex: 0 },
      { value: "invented.example", fragmentIndex: 0 }
    ] }
  );
  assert.deepEqual(result.accepted.map((candidate) => candidate.value), ["*.example.com", "10.2.0.0/16"]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
    "ai_candidate_not_grounded",
    "ai_candidate_not_grounded"
  ]);
});

test("rejects missing fragment indexes and deduplicates normalized candidates", () => {
  const result = validateAiScopeCandidates(
    [{ text: "API.Example API.Example", page: 2 }],
    { candidates: [
      { value: "api.example", fragmentIndex: 0 },
      { value: "API.EXAMPLE", fragmentIndex: 0 },
      { value: "api.example", fragmentIndex: 8 }
    ] }
  );
  assert.deepEqual(result.accepted, [{
    value: "api.example",
    source: "ai",
    evidence: { page: 2, excerpt: "API.Example API.Example" }
  }]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["ai_fragment_not_found"]);
});

test("scope document submit schema is closed and bounded", () => {
  const tool = createScopeDocumentSubmitTool();
  assert.equal(Check(tool.parameters, { candidates: [] }), true);
  assert.equal(Check(tool.parameters, { candidates: [{ value: "a.example", fragmentIndex: 0 }] }), true);
  assert.equal(Check(tool.parameters, { candidates: [{ value: "a.example", fragmentIndex: 0, extra: true }] }), false);
  assert.equal(Check(tool.parameters, { candidates: [], extra: true }), false);
});

test("document resolver prompt forbids inferred scope expansion", () => {
  assert.match(SCOPE_DOCUMENT_RESOLVER_SYSTEM_PROMPT, /不得执行 DNS/);
  assert.match(SCOPE_DOCUMENT_RESOLVER_SYSTEM_PROMPT, /不得扩大 CIDR/);
  assert.match(SCOPE_DOCUMENT_RESOLVER_SYSTEM_PROMPT, /片段索引/);
});

test("renders bounded indexed document fragments for the model", () => {
  const rendered = renderScopeDocumentFragments([
    { text: "api.example", line: 1 },
    { text: "x".repeat(70_000), line: 2 }
  ]);
  assert.match(rendered, /^\[0\] api\.example/m);
  assert.ok(Buffer.byteLength(rendered) <= 64 * 1024);
});

test("AI resolution validates structured output and degrades to a diagnostic", async () => {
  const fragments = [{ text: "api.example", line: 1 }];
  const resolved = await resolveDocumentScopeWithAi({
    fragments,
    invoke: async () => ({ candidates: [{ value: "api.example", fragmentIndex: 0 }] })
  });
  assert.deepEqual(resolved.accepted.map((candidate) => candidate.value), ["api.example"]);
  assert.deepEqual(resolved.diagnostics, []);

  const degraded = await resolveDocumentScopeWithAi({
    fragments,
    invoke: async () => { throw new Error("provider unavailable"); }
  });
  assert.deepEqual(degraded.accepted, []);
  assert.deepEqual(degraded.diagnostics, [{
    code: "ai_scope_resolution_failed",
    message: "AI 辅助范围解析失败，已保留规则解析结果"
  }]);
});
