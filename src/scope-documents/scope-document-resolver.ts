import { extractScopeCandidates } from "./scope-candidate-extractor.js";
import type {
  ScopeCandidate,
  ScopeDocumentDiagnostic,
  ScopeTextFragment
} from "./scope-document-types.js";
import { normalizeScopeEntry } from "../scope.js";
import { createScopeDocumentResolverAgentSession } from "../agents.js";
import type { LlmRuntime } from "../llm-config.js";
import { invokeStructured, type ProviderAdmissionOptions } from "../pi-runner.js";

export type AiScopeCandidateSubmission = {
  candidates: Array<{ value: string; fragmentIndex: number }>;
};

export type ValidatedAiScopeCandidates = {
  accepted: ScopeCandidate[];
  diagnostics: ScopeDocumentDiagnostic[];
};

export async function resolveDocumentScopeWithAi(input: {
  fragments: ScopeTextFragment[];
  invoke: () => Promise<AiScopeCandidateSubmission>;
}): Promise<ValidatedAiScopeCandidates> {
  try {
    return validateAiScopeCandidates(input.fragments, await input.invoke());
  } catch {
    return {
      accepted: [],
      diagnostics: [{
        code: "ai_scope_resolution_failed",
        message: "AI 辅助范围解析失败，已保留规则解析结果"
      }]
    };
  }
}

export function renderScopeDocumentFragments(fragments: ScopeTextFragment[]): string {
  const maximumBytes = 64 * 1024;
  const lines: string[] = [];
  let bytes = 0;
  for (let index = 0; index < Math.min(fragments.length, 256); index += 1) {
    const line = `[${index}] ${fragments[index].text.replace(/\s+/g, " ").trim()}\n`;
    const encoded = Buffer.from(line);
    if (bytes + encoded.byteLength > maximumBytes) {
      const remaining = maximumBytes - bytes;
      if (remaining > 0) lines.push(encoded.subarray(0, remaining).toString("utf8"));
      break;
    }
    lines.push(line);
    bytes += encoded.byteLength;
  }
  return lines.join("");
}

export async function resolveDocumentScopeWithLlm(input: {
  cwd: string;
  fragments: ScopeTextFragment[];
  llmRuntime: LlmRuntime;
  providerAdmission?: ProviderAdmissionOptions;
}): Promise<ValidatedAiScopeCandidates> {
  return resolveDocumentScopeWithAi({
    fragments: input.fragments,
    invoke: async () => {
      const sessionResult = await createScopeDocumentResolverAgentSession({
        cwd: input.cwd,
        llmRuntime: input.llmRuntime,
        providerAdmission: input.providerAdmission
      });
      try {
        return await invokeStructured<AiScopeCandidateSubmission>(
          sessionResult.session,
          `<document_fragments>\n${renderScopeDocumentFragments(input.fragments)}</document_fragments>\n` +
            "选择文件中明确写出的授权资产，并提交其原始片段索引。",
          {
            toolName: "scope_document_submit",
            idleTimeoutMs: 60_000,
            hardTimeoutMs: 120_000,
            terminateOnToolError: true,
            admission: input.providerAdmission,
            validate: validateSubmission
          }
        );
      } finally {
        sessionResult.session.dispose();
      }
    }
  });
}

function validateSubmission(value: unknown): AiScopeCandidateSubmission {
  if (!value || typeof value !== "object" || !Array.isArray((value as { candidates?: unknown }).candidates)) {
    throw new Error("scope_document_submit must contain candidates");
  }
  return {
    candidates: (value as { candidates: unknown[] }).candidates.map((candidate) => {
      if (!candidate || typeof candidate !== "object") throw new Error("scope document candidate must be an object");
      const raw = candidate as { value?: unknown; fragmentIndex?: unknown };
      if (typeof raw.value !== "string" || !Number.isInteger(raw.fragmentIndex)) {
        throw new Error("scope document candidate must contain value and fragmentIndex");
      }
      return { value: raw.value, fragmentIndex: Number(raw.fragmentIndex) };
    })
  };
}

export function validateAiScopeCandidates(
  fragments: ScopeTextFragment[],
  submission: AiScopeCandidateSubmission
): ValidatedAiScopeCandidates {
  const accepted = new Map<string, ScopeCandidate>();
  const diagnostics: ScopeDocumentDiagnostic[] = [];
  for (const submitted of submission.candidates) {
    const fragment = fragments[submitted.fragmentIndex];
    if (!fragment) {
      diagnostics.push({
        code: "ai_fragment_not_found",
        message: `AI 返回了不存在的片段索引 ${submitted.fragmentIndex}`
      });
      continue;
    }
    let normalized: ReturnType<typeof normalizeScopeEntry>;
    try {
      normalized = normalizeScopeEntry(submitted.value);
    } catch {
      diagnostics.push({ code: "ai_candidate_invalid", message: `AI 返回了无效范围：${submitted.value}` });
      continue;
    }
    const grounded = extractScopeCandidates([fragment]);
    const values = normalized.kind === "domain" ? grounded.domains : grounded.ipv4Cidrs;
    if (!values.some((candidate) => candidate.value === normalized.value)) {
      diagnostics.push({
        code: "ai_candidate_not_grounded",
        message: `AI 范围没有对应原文证据：${normalized.value}`
      });
      continue;
    }
    if (!accepted.has(normalized.value)) {
      accepted.set(normalized.value, {
        value: normalized.value,
        source: "ai",
        evidence: {
          ...(fragment.page !== undefined ? { page: fragment.page } : {}),
          ...(fragment.paragraph !== undefined ? { paragraph: fragment.paragraph } : {}),
          ...(fragment.line !== undefined ? { line: fragment.line } : {}),
          excerpt: boundedExcerpt(fragment.text)
        }
      });
    }
  }
  return { accepted: [...accepted.values()], diagnostics };
}

function boundedExcerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
