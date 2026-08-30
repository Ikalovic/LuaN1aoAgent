import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeScope } from "./scope.js";
import { ScopeDocumentService } from "./scope-documents/scope-document-service.js";
import { ScopeDocumentStore } from "./scope-documents/scope-document-store.js";
import type { ParsedScopeDocument, ScopeTextFragment } from "./scope-documents/scope-document-types.js";
import type { ValidatedAiScopeCandidates } from "./scope-documents/scope-document-resolver.js";

export async function resolveCliScopeDocuments(input: {
  cwd: string;
  runtimeDir: string;
  files: string[];
  manualScope?: string;
  aiResolver?: (fragments: ScopeTextFragment[]) => Promise<ValidatedAiScopeCandidates>;
}): Promise<{ normalizedScope: string; documents: ParsedScopeDocument[] }> {
  const service = new ScopeDocumentService({
    store: new ScopeDocumentStore(join(input.runtimeDir, "scope-documents")),
    aiResolver: input.aiResolver
  });
  const documents: ParsedScopeDocument[] = [];
  for (const fileName of input.files) {
    const filePath = isAbsolute(fileName) ? fileName : resolve(input.cwd, fileName);
    documents.push(await service.parse({ fileName, data: await readFile(filePath) }));
  }
  return {
    normalizedScope: normalizeScope([
      ...documents.map((document) => document.normalizedScope),
      ...(input.manualScope?.trim() ? [input.manualScope] : [])
    ]),
    documents
  };
}
