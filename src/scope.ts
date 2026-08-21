import { domainToASCII } from "node:url";

const IPV4_CIDR_PATTERN = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?(?![\d.])/g;

export type ScopeResolution = {
  cidrs: string[];
};

export type AuthorizedScope = {
  cidrs: string[];
  domains: string[];
};

export function authorizedScopeContainsDomain(scope: AuthorizedScope, input: string): boolean {
  const candidate = normalizeDomainCandidate(input);
  if (!candidate) {
    return false;
  }
  return scope.domains.some((pattern) => {
    if (pattern.startsWith("*.")) {
      return candidate.endsWith(`.${pattern.slice(2)}`);
    }
    return candidate === pattern || candidate.endsWith(`.${pattern}`);
  });
}

export function authorizedScopeContainsIp(scope: AuthorizedScope, input: string): boolean {
  const candidate = parseIpv4Number(input);
  if (candidate === undefined) {
    return false;
  }
  return scope.cidrs.some((cidr) => {
    const [networkInput, prefixInput] = cidr.split("/");
    const network = parseIpv4Number(networkInput);
    const prefixLength = Number(prefixInput);
    if (network === undefined || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
      return false;
    }
    const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    return ((candidate & mask) >>> 0) === ((network & mask) >>> 0);
  });
}

export function normalizeScope(values: string | string[]): string {
  const scope = parseAuthorizedScope(values);
  return [...scope.cidrs, ...scope.domains].join(",");
}

export function parseAuthorizedScope(values: string | string[]): AuthorizedScope {
  const parts = Array.isArray(values) ? values : values.split(/[\s,，;；]+/u);
  const cidrs: string[] = [];
  const domains: string[] = [];
  for (const raw of parts.map((value) => value.trim()).filter(Boolean)) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(raw)) {
      cidrs.push(normalizeIpv4Cidr(raw));
    } else {
      domains.push(normalizeDomainPattern(raw));
    }
  }
  const normalized = {
    cidrs: [...new Set(cidrs)].sort(compareCidrs),
    domains: [...new Set(domains)].sort()
  };
  if (normalized.cidrs.length === 0 && normalized.domains.length === 0) {
    throw new Error("Authorized scope must contain at least one IPv4 address, CIDR, or domain");
  }
  return normalized;
}

export function normalizeScopeCidrs(values: string | string[]): string {
  const parts = Array.isArray(values) ? values : values.split(/[\s,，;；]+/u);
  const normalized = [...new Set(parts
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeIpv4Cidr))]
    .sort(compareCidrs);
  if (normalized.length === 0) {
    throw new Error("Authorized scope must contain at least one IPv4 address or CIDR");
  }
  return normalized.join(",");
}

function normalizeDomainPattern(value: string): string {
  const wildcard = value.startsWith("*.");
  const rawDomain = (wildcard ? value.slice(2) : value).replace(/\.$/, "").toLowerCase();
  if (!rawDomain || rawDomain.includes("*") || rawDomain.includes(":") || rawDomain.includes("/")) {
    throw new Error(`Invalid domain scope entry: ${value}`);
  }
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (!domain || domain.length > 253 || !domain.includes(".")) {
    throw new Error(`Invalid domain scope entry: ${value}`);
  }
  const labels = domain.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels.at(-1)!)) {
    throw new Error(`Invalid domain scope entry: ${value}`);
  }
  return wildcard ? `*.${domain}` : domain;
}

function normalizeDomainCandidate(value: string): string | undefined {
  const rawDomain = value.trim().replace(/\.+$/, "").toLowerCase();
  if (!rawDomain || rawDomain.includes("*") || rawDomain.includes(":") || rawDomain.includes("/") || /\s/.test(rawDomain)) {
    return undefined;
  }
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (!domain || domain.length > 253 || !domain.includes(".")) {
    return undefined;
  }
  const labels = domain.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels.at(-1)!)) {
    return undefined;
  }
  return domain;
}

export function normalizeInferredScopeCidrs(goal: string, values: string[]): string {
  const authorized = new Set(extractLiteralGoalCidrs(goal));
  if (authorized.size === 0) {
    throw new Error(
      "Unable to infer authorized scope: --goal contains no explicit IPv4 address or CIDR; pass --scope"
    );
  }
  const normalized = normalizeScopeCidrs(values).split(",");
  for (const cidr of normalized) {
    if (!authorized.has(cidr)) {
      throw new Error(`AI-inferred scope ${cidr} is not explicitly present in --goal`);
    }
  }
  return normalized.join(",");
}

export function extractLiteralGoalCidrs(goal: string): string[] {
  const values: string[] = [];
  for (const match of goal.matchAll(IPV4_CIDR_PATTERN)) {
    values.push(normalizeIpv4Cidr(`${match[1]}/${match[2] ?? "32"}`));
  }
  return [...new Set(values)].sort(compareCidrs);
}

function normalizeIpv4Cidr(value: string): string {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid IPv4 scope entry: ${value}`);
  }
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) {
    throw new Error(`Invalid IPv4 scope entry: ${value}`);
  }
  const prefixLength = Number(match[5] ?? "32");
  if (prefixLength < 0 || prefixLength > 32) {
    throw new Error(`Invalid IPv4 prefix length: ${value}`);
  }
  const address = (
    (octets[0] << 24) |
    (octets[1] << 16) |
    (octets[2] << 8) |
    octets[3]
  ) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (address & mask) >>> 0;
  return `${network >>> 24}.${(network >>> 16) & 255}.${(network >>> 8) & 255}.${network & 255}/${prefixLength}`;
}

function compareCidrs(left: string, right: string): number {
  const [leftAddress, leftPrefix] = left.split("/");
  const [rightAddress, rightPrefix] = right.split("/");
  const addressOrder = ipv4Number(leftAddress) - ipv4Number(rightAddress);
  return addressOrder || Number(leftPrefix) - Number(rightPrefix);
}

function ipv4Number(value: string): number {
  return value.split(".").reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function parseIpv4Number(value: string): number | undefined {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return undefined;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return undefined;
  }
  return octets.reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
}
