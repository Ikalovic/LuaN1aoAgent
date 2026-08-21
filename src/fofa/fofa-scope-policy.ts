import { createHash } from "node:crypto";
import {
  authorizedScopeContainsDomain,
  authorizedScopeContainsIp,
  type AuthorizedScope
} from "../scope.js";
import { disjunctiveBranches, parseFofaQuery, type FofaQueryNode } from "./fofa-query.js";
import { FofaError, type FofaRecord } from "./fofa-types.js";

const ANCHOR_FIELDS = new Set([
  "ip",
  "host",
  "domain",
  "cert",
  "certs_subject_cn",
  "cname_domain"
]);

export class FofaScopePolicy {
  constructor(readonly scope: AuthorizedScope) {}

  fingerprint(): string {
    const stableScope = {
      cidrs: [...this.scope.cidrs].sort(),
      domains: [...this.scope.domains].sort()
    };
    return createHash("sha256").update(JSON.stringify(stableScope)).digest("hex");
  }

  validateQuery(query: string, derivedRefs: ReadonlySet<string> = new Set()): void {
    const branches = disjunctiveBranches(parseFofaQuery(query));
    if (branches.some((branch) => !branch.some((node) => this.isAuthorizedAnchor(node, derivedRefs)))) {
      throw scopeRejected();
    }
  }

  validateHost(host: string, derivedRefs: ReadonlySet<string> = new Set()): void {
    if (derivedRefs.has(host) || this.identityIsAuthorized(host)) {
      return;
    }
    throw scopeRejected();
  }

  classify(identity: { host?: string; domain?: string; ip?: string }):
    Pick<FofaRecord, "classification" | "active_testing_allowed"> {
    const namedIdentity = identity.host?.trim() || identity.domain?.trim();
    if (namedIdentity) {
      const normalized = parseIdentity(namedIdentity);
      const allowed = normalized?.kind === "domain"
        ? authorizedScopeContainsDomain(this.scope, normalized.value)
        : normalized?.kind === "ip"
          ? authorizedScopeContainsIp(this.scope, normalized.value)
          : false;
      return classification(allowed);
    }
    return classification(Boolean(identity.ip && authorizedScopeContainsIp(this.scope, identity.ip)));
  }

  private isAuthorizedAnchor(node: FofaQueryNode, derivedRefs: ReadonlySet<string>): boolean {
    if (node.kind !== "comparison" || !ANCHOR_FIELDS.has(node.field) || !isPositiveEquality(node)) {
      return false;
    }
    return derivedRefs.has(node.value) || this.identityIsAuthorized(node.value);
  }

  private identityIsAuthorized(value: string): boolean {
    const identity = parseIdentity(value);
    if (identity?.kind === "ip") {
      return authorizedScopeContainsIp(this.scope, identity.value);
    }
    if (identity?.kind === "domain") {
      return authorizedScopeContainsDomain(this.scope, identity.value);
    }
    return false;
  }
}

function isPositiveEquality(node: Extract<FofaQueryNode, { kind: "comparison" }>): boolean {
  return node.operator === "=" ? !node.negated : node.negated;
}

function parseIdentity(value: string): { kind: "domain" | "ip"; value: string } | undefined {
  let candidate = value.trim();
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return undefined;
      }
      candidate = url.hostname;
    } catch {
      return undefined;
    }
  }
  candidate = candidate.replace(/\.+$/, "");
  if (isIpv4(candidate)) {
    return { kind: "ip", value: candidate };
  }
  if (candidate.includes(":") || candidate.includes("/") || candidate.includes("@")) {
    return undefined;
  }
  return { kind: "domain", value: candidate };
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function classification(inScope: boolean): Pick<FofaRecord, "classification" | "active_testing_allowed"> {
  return inScope
    ? { classification: "in_scope", active_testing_allowed: true }
    : { classification: "candidate_only", active_testing_allowed: false };
}

function scopeRejected(): FofaError {
  return new FofaError(
    "fofa_scope_rejected",
    "FOFA request requires a positive authorized asset anchor in every OR branch"
  );
}
