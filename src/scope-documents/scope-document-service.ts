import { randomUUID } from "node:crypto";
import { normalizeScope } from "../scope.js";
import { extractScopeCandidates } from "./scope-candidate-extractor.js";
import { extractScopeText } from "./scope-document-formats.js";
import type { ValidatedAiScopeCandidates } from "./scope-document-resolver.js";
import { ScopeDocumentStore } from "./scope-document-store.js";
import type { ParsedScopeDocument, ScopeCandidate, ScopeTextFragment } from "./scope-document-types.js";

export class ScopeDocumentServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ScopeDocumentServiceError";
  }
}

export class ScopeDocumentService {
  constructor(private readonly input: {
    store: ScopeDocumentStore;
    aiResolver?: (fragments: ScopeTextFragment[]) => Promise<ValidatedAiScopeCandidates>;
  }) {}

  async parse(input: { fileName: string; data: Buffer }): Promise<ParsedScopeDocument> {
    const fragments = await extractScopeText(input.fileName, input.data);
    const deterministic = extractScopeCandidates(fragments);
    const ai = this.input.aiResolver
      ? await this.input.aiResolver(fragments).catch(() => ({
        accepted: [],
        diagnostics: [{
          code: "ai_scope_resolution_failed",
          message: "AI 辅助范围解析失败，已保留规则解析结果"
        }]
      }))
      : { accepted: [], diagnostics: [] };
    const domains = mergeCandidates(
      deterministic.domains,
      ai.accepted.filter((candidate) => !candidate.value.includes("/"))
    );
    const ipv4Cidrs = mergeCandidates(
      deterministic.ipv4Cidrs,
      ai.accepted.filter((candidate) => candidate.value.includes("/"))
    );
    if (domains.length === 0 && ipv4Cidrs.length === 0) {
      throw new ScopeDocumentServiceError("no_scope_candidates", "授权文件中没有可确认的域名、IPv4 或 CIDR");
    }
    const parsed: ParsedScopeDocument = {
      documentId: randomUUID(),
      fileName: input.fileName,
      domains,
      ipv4Cidrs,
      normalizedScope: normalizeScope([...ipv4Cidrs, ...domains].map((candidate) => candidate.value)),
      diagnostics: ai.diagnostics
    };
    await this.input.store.put({ parsed, fragments, data: input.data });
    return parsed;
  }

  async confirm(input: {
    documentId: string;
    confirmedScope: string;
    manualScope?: string;
  }): Promise<string> {
    const stored = await this.input.store.get(input.documentId).catch(() => undefined);
    if (!stored) {
      throw new ScopeDocumentServiceError("scope_document_not_found", "授权文件解析结果不存在或已失效");
    }
    if (input.confirmedScope !== stored.parsed.normalizedScope) {
      throw new ScopeDocumentServiceError("scope_confirmation_mismatch", "确认范围与文件解析结果不一致");
    }
    const confirmed = stored.parsed.normalizedScope;
    return input.manualScope?.trim()
      ? normalizeScope(`${confirmed},${input.manualScope}`)
      : confirmed;
  }
}

function mergeCandidates(primary: ScopeCandidate[], secondary: ScopeCandidate[]): ScopeCandidate[] {
  const merged = new Map(primary.map((candidate) => [candidate.value, candidate]));
  for (const candidate of secondary) {
    if (!merged.has(candidate.value)) merged.set(candidate.value, candidate);
  }
  return [...merged.values()].sort((left, right) => left.value.localeCompare(right.value));
}
