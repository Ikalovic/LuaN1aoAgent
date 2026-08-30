import { normalizeScopeEntry } from "../scope.js";
import type { ScopeCandidate, ScopeTextFragment } from "./scope-document-types.js";

const IPV4_CIDR = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?(?![\d.])/g;
const DOMAIN = /(?<![a-z0-9_-])(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?/gi;

export type ExtractedScopeCandidates = {
  domains: ScopeCandidate[];
  ipv4Cidrs: ScopeCandidate[];
};

export function extractScopeCandidates(fragments: ScopeTextFragment[]): ExtractedScopeCandidates {
  const domains = new Map<string, ScopeCandidate>();
  const ipv4Cidrs = new Map<string, ScopeCandidate>();
  for (const fragment of fragments) {
    for (const match of fragment.text.matchAll(IPV4_CIDR)) {
      addCandidate(match[0], fragment, ipv4Cidrs, "cidr");
    }
    for (const match of fragment.text.matchAll(DOMAIN)) {
      if (isUrlOrEmailContext(fragment.text, match.index, match[0].length)) continue;
      addCandidate(match[0], fragment, domains, "domain");
    }
  }
  return {
    domains: [...domains.values()],
    ipv4Cidrs: [...ipv4Cidrs.values()]
  };
}

function addCandidate(
  raw: string,
  fragment: ScopeTextFragment,
  target: Map<string, ScopeCandidate>,
  expectedKind: "domain" | "cidr"
): void {
  try {
    const normalized = normalizeScopeEntry(raw);
    if (normalized.kind !== expectedKind || target.has(normalized.value)) return;
    target.set(normalized.value, {
      value: normalized.value,
      source: "rule",
      evidence: {
        ...(fragment.page !== undefined ? { page: fragment.page } : {}),
        ...(fragment.paragraph !== undefined ? { paragraph: fragment.paragraph } : {}),
        ...(fragment.line !== undefined ? { line: fragment.line } : {}),
        excerpt: boundedExcerpt(fragment.text)
      }
    });
  } catch {
    // A document can contain arbitrary prose. Invalid token-shaped values are
    // ignored here and surfaced only when a user explicitly enters them.
  }
}

function isUrlOrEmailContext(text: string, index: number | undefined, length: number): boolean {
  const start = index ?? 0;
  const before = text.slice(Math.max(0, start - 12), start);
  const after = text.slice(start + length, start + length + 1);
  return before.endsWith("@") || /(?:https?|ftp):\/\/$/i.test(before) || after === "/";
}

function boundedExcerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
