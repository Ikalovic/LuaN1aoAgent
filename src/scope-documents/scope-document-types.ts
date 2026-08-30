export type ScopeTextFragment = {
  text: string;
  page?: number;
  paragraph?: number;
  line?: number;
};

export type ScopeCandidateEvidence = {
  page?: number;
  paragraph?: number;
  line?: number;
  excerpt: string;
};

export type ScopeCandidate = {
  value: string;
  source: "rule" | "ai";
  evidence: ScopeCandidateEvidence;
};

export type ScopeDocumentDiagnostic = {
  code: string;
  message: string;
};

export type ParsedScopeDocument = {
  documentId: string;
  fileName: string;
  domains: ScopeCandidate[];
  ipv4Cidrs: ScopeCandidate[];
  normalizedScope: string;
  diagnostics: ScopeDocumentDiagnostic[];
};
