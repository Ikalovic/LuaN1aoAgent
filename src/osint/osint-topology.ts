import { createHash } from "node:crypto";
import { stableOperationIdentityId } from "../operation-identity.js";
import type { GraphDelta, GraphEdge, GraphNode } from "../types.js";

/**
 * Deterministic projection of public-internet findings into the operation graph.
 *
 * This is a pure function on purpose. The findings it consumes are already
 * structured (kind, value, provenance, confidence), so routing them through the
 * LLM Projector would lose fields, vary between runs, and be untestable. The
 * sibling `fofa/fofa-topology.ts` established the same approach for FOFA data.
 *
 * Node ids are content addressed via `stableOperationIdentityId`, which is what
 * makes cross-runtime transfer merge instead of duplicate. That matters more here
 * than it looks: `SQLiteGraphStore.upsertDelta` performs no identity rebase —
 * only `commitProjection` does — so an id that is not already canonical when it
 * reaches the store stays a duplicate forever.
 */

export type OsintEntityKind =
  | "org"
  | "person"
  | "email"
  | "account"
  | "phone"
  | "host"
  | "ip"
  | "service"
  | "document";

export type OsintConfidence = "observed" | "inferred" | "unconfirmed";

export type OsintProvenance = {
  url?: string;
  title?: string;
  source?: string;
  observedAt?: string;
};

export type OsintFinding = {
  kind: OsintEntityKind;
  value: string;
  confidence?: OsintConfidence;
  /** Affiliation, for person / account / email findings. */
  organization?: string;
  /** Owning or operating organization, for host findings. */
  owner?: string;
  /** Container host, for service findings. */
  host?: string;
  port?: number | string;
  /** Person this identity or contact belongs to. */
  person?: string;
  provenance?: OsintProvenance[];
};

export type OsintTopologyInput = {
  findings: OsintFinding[];
  evidenceRef: string;
  /**
   * Authorized-scope test for target-side entities, injected so this module
   * stays free of runtime and scope plumbing. Absent means every host is
   * treated as out of scope, which is the fail-closed direction: an unproven
   * host becomes a lead rather than an actionable asset.
   */
  isHostInScope?: (host: string) => boolean;
  /** Hard cap on projected nodes. Findings past it are counted, not stored. */
  maxNodes?: number;
  /**
   * When true (the default), personal-data values are stored as a display mask
   * plus a stable pseudonym that preserves identity. See `personalIdentityValue`.
   */
  maskPersonalData?: boolean;
};

export type OsintTopologyResult = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    findings: number;
    projectedNodes: number;
    /** Findings that produced no node (unusable value or missing container). */
    skipped: number;
    /** Findings whose new node was refused because `maxNodes` was reached. */
    capped: number;
    /** Target-side nodes projected as unconfirmed leads instead of in-scope assets. */
    outOfScope: number;
    /** Nodes whose label was masked under the personal-data policy. */
    masked: number;
  };
};

/**
 * Safety valve, not a routine limiter. The graph has no retention controls at
 * all, so something has to stop a single Task from writing an unbounded number
 * of nodes; but the cap is set high enough that a realistic haul (a large
 * organization's domains, services, mailboxes and contacts) fits well inside it.
 * The Planner's bounded read is protected by local traversal and by the low
 * decision weight of intelligence nodes, not by shrinking the memory.
 */
export const DEFAULT_OSINT_MAX_NODES = 2_000;

/**
 * Eviction order when the safety valve is reached. Target-side entities are
 * actionable and merge heavily through content-addressed ids; contact data is
 * the weakest evidence per node and grows fastest, so it is sacrificed first.
 * Without this ordering the cap would be first-come and could discard every
 * domain while keeping phone numbers.
 */
const KIND_PRIORITY: Record<OsintEntityKind, number> = {
  host: 7,
  ip: 7,
  service: 6,
  org: 5,
  email: 4,
  account: 4,
  document: 3,
  person: 2,
  phone: 1
};

/**
 * Domain separation for the personal-data pseudonym. Bumping the version
 * deliberately invalidates every previously projected identity rather than
 * silently re-keying them, so a rotation is a visible migration.
 */
const PSEUDONYM_SALT = "luanniao-osint-identity-v1:";

/** Kinds that carry personal data and are therefore subject to masking. */
const PERSONAL_KINDS = new Set<OsintEntityKind>(["person", "email", "account", "phone"]);

export function normalizeOsintTopology(input: OsintTopologyInput): OsintTopologyResult {
  const maxNodes = input.maxNodes ?? DEFAULT_OSINT_MAX_NODES;
  const maskPersonalData = input.maskPersonalData ?? true;
  const isHostInScope = input.isHostInScope;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  /** Eviction priority per node id, so truncation can drop the weakest first. */
  const priority = new Map<string, number>();
  const stats = {
    findings: input.findings.length,
    projectedNodes: 0,
    skipped: 0,
    capped: 0,
    outOfScope: 0,
    masked: 0
  };

  // The cap is applied after the whole batch is built, never during it. Applying
  // it inline would make array order decide what survives; see `evictToCap`.
  const addNode = (node: GraphNode, kindPriority: number): "added" | "merged" => {
    const previous = nodes.get(node.id);
    if (previous) {
      // Same entity seen twice in one batch: merge rather than overwrite, so a
      // later thinner finding cannot erase what an earlier one established.
      // `provenance` needs an explicit union — a plain spread would keep only the
      // last source and quietly discard the corroborating one.
      nodes.set(node.id, {
        ...previous,
        properties: {
          ...previous.properties,
          ...node.properties,
          provenance: mergeProvenance(previous.properties.provenance, node.properties.provenance)
        },
        evidenceRefs: mergeRefs(previous.evidenceRefs, node.evidenceRefs)
      });
      return "merged";
    }
    nodes.set(node.id, node);
    priority.set(node.id, kindPriority);
    stats.projectedNodes += 1;
    return "added";
  };

  const addEdge = (from: string, to: string, type: string): void => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) {
      return;
    }
    const key = `${from}|${type}|${to}`;
    if (!edges.has(key)) {
      edges.set(key, { from, to, type, evidenceRefs: [input.evidenceRef] });
    }
  };

  const ensureOrganization = (name: string): string | undefined => {
    const id = stableOperationIdentityId(`organization:${normalizeKeyPart(name)}`);
    if (nodes.has(id)) {
      return id;
    }
    addNode({
      id,
      graphKind: "operation",
      type: "Organization",
      label: name,
      properties: { source: "osint", origin: "osint" },
      evidenceRefs: [input.evidenceRef]
    }, KIND_PRIORITY.org);
    return id;
  };

  /**
   * One definition of a person's identity, shared by the person branch and by
   * `linkPerson`. They must agree exactly: when masking is on the node is keyed
   * on the pseudonym, so a link computed from the raw name would silently point
   * at an id that does not exist and the relation would vanish.
   */
  const personIdentityKey = (name: string, organization: string | undefined): string => {
    const nameKey = maskPersonalData ? personalIdentityValue("person", name) : normalizeKeyPart(name);
    const orgKey = organization ? normalizeKeyPart(organization) : undefined;
    return orgKey ? `person:${nameKey}@${orgKey}` : `person:${nameKey}`;
  };

  /** Links an entity to the person named by the same finding, if any. */
  const linkPerson = (finding: OsintFinding, entityId: string, edgeType: string): void => {
    const personName = text(finding.person);
    if (!personName) {
      // Only an explicit `person` field creates the link. Two findings sharing a
      // batch is not evidence that they concern the same human.
      return;
    }
    const personId = stableOperationIdentityId(personIdentityKey(personName, text(finding.organization)));
    if (nodes.has(personId)) {
      addEdge(personId, entityId, edgeType);
    }
  };

  for (const finding of input.findings) {
    const value = typeof finding.value === "string" ? finding.value.trim() : "";
    if (!value) {
      stats.skipped += 1;
      continue;
    }

    const personal = PERSONAL_KINDS.has(finding.kind);
    const masked = personal && maskPersonalData;
    if (masked) {
      stats.masked += 1;
    }
    // Identity is keyed on the unmasked-or-pseudonymised value, never on the
    // display label: a mask like "张*" would collide for 张三 and 张四. Personal
    // values are canonicalised in both modes so turning masking off cannot change
    // which entities merge.
    const identityValue = masked
      ? personalIdentityValue(finding.kind, value)
      : personal
        ? normalizePersonalValue(finding.kind, value)
        : value;
    const label = masked ? maskPersonalValue(finding.kind, value) : value;
    const base = findingProperties(finding, masked, identityValue);

    switch (finding.kind) {
      case "org": {
        addNode({
          id: stableOperationIdentityId(`organization:${normalizeKeyPart(value)}`),
          graphKind: "operation",
          type: "Organization",
          label: value,
          properties: base,
          evidenceRefs: [input.evidenceRef]
        }, KIND_PRIORITY.org);
        continue;
      }

      case "person": {
        const organization = text(finding.organization);
        const id = stableOperationIdentityId(personIdentityKey(value, organization));
        addNode({
          id,
          graphKind: "operation",
          type: "Person",
          label,
          properties: { ...base, ...(organization ? { organization } : {}) },
          evidenceRefs: [input.evidenceRef]
        }, KIND_PRIORITY.person);
        if (organization) {
          const orgId = ensureOrganization(organization);
          if (orgId) {
            addEdge(id, orgId, "member_of");
          }
        }
        continue;
      }

      case "email":
      case "account": {
        const isEmail = finding.kind === "email";
        const organization = isEmail ? undefined : text(finding.organization);
        const identityKey = isEmail
          ? `identity:email:${normalizeKeyPart(identityValue)}`
          : `identity:account:${normalizeKeyPart(organization ?? "unknown")}:${normalizeKeyPart(identityValue)}`;
        const id = stableOperationIdentityId(identityKey);
        addNode({
          id,
          graphKind: "operation",
          type: "Identity",
          label,
          properties: {
            ...base,
            kind: isEmail ? "email" : "account",
            ...(isEmail ? { email: identityValue } : { account: identityValue }),
            ...(organization ? { organization } : {})
          },
          evidenceRefs: [input.evidenceRef]
        }, isEmail ? KIND_PRIORITY.email : KIND_PRIORITY.account);
        linkPerson(finding, id, "uses_identity");
        continue;
      }

      case "phone": {
        const id = stableOperationIdentityId(`contact:phone:${normalizeKeyPart(identityValue)}`);
        addNode({
          id,
          graphKind: "operation",
          type: "Contact",
          label,
          properties: { ...base, kind: "phone", phone: identityValue },
          evidenceRefs: [input.evidenceRef]
        }, KIND_PRIORITY.phone);
        linkPerson(finding, id, "reachable_at");
        continue;
      }

      case "host":
      case "ip": {
        const { node, outOfScope } = hostNode(value, base, input.evidenceRef, isHostInScope);
        if (outOfScope) {
          stats.outOfScope += 1;
        }
        addNode(node, KIND_PRIORITY.host);
        const owner = text(finding.owner);
        if (owner) {
          const orgId = ensureOrganization(owner);
          if (orgId) {
            addEdge(orgId, node.id, "owns");
          }
        }
        continue;
      }

      case "service": {
        const host = text(finding.host);
        if (!host) {
          // A service without its container host has no identity that could ever
          // merge with the real service later, so it is skipped rather than
          // invented under a placeholder host.
          stats.skipped += 1;
          continue;
        }
        const { node: hostGraphNode, outOfScope } = hostNode(host, {}, input.evidenceRef, isHostInScope);
        if (outOfScope) {
          stats.outOfScope += 1;
        }
        addNode(hostGraphNode, KIND_PRIORITY.host);
        const port = finding.port === undefined ? undefined : String(finding.port).trim();
        const serviceId = stableOperationIdentityId(
          port
            ? `service:host:${normalizeKeyPart(host)}:${port}/${normalizeKeyPart(value)}`
            : `service:host:${normalizeKeyPart(host)}:${normalizeKeyPart(value)}`
        );
        addNode({
          id: serviceId,
          graphKind: "operation",
          type: "Service",
          label: value,
          properties: { ...base, service: value, host, ...(port ? { port } : {}) },
          evidenceRefs: [input.evidenceRef]
        }, KIND_PRIORITY.service);
        if (port) {
          const portId = stableOperationIdentityId(`port:host:${normalizeKeyPart(host)}:${port}/tcp`);
          addNode({
            id: portId,
            graphKind: "operation",
            type: "Port",
            label: `${port}/tcp`,
            properties: { source: "osint", origin: "osint", host, port, protocol: "tcp" },
            evidenceRefs: [input.evidenceRef]
          }, KIND_PRIORITY.service);
          addEdge(hostGraphNode.id, portId, "has_port");
          addEdge(portId, serviceId, "runs_service");
        } else {
          addEdge(hostGraphNode.id, serviceId, "runs_service");
        }
        continue;
      }

      case "document": {
        addNode({
          id: stableOperationIdentityId(`document:${normalizeKeyPart(value)}`),
          graphKind: "operation",
          type: "File",
          label: value,
          properties: base,
          evidenceRefs: [input.evidenceRef]
        }, KIND_PRIORITY.document);
        continue;
      }

      default: {
        stats.skipped += 1;
      }
    }
  }

  return finishProjection(nodes, edges, priority, maxNodes, stats);
}

/**
 * Applies the safety valve after the whole batch is built.
 *
 * Evicting during construction would make the findings array order decide what
 * survives — a batch that happened to list phone numbers first could lose every
 * domain while keeping the weakest evidence. Ranking by kind, then by how well a
 * node is corroborated, and only then by id keeps the outcome deterministic and
 * biased towards the entities the Planner can actually act on.
 */
function finishProjection(
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  priority: Map<string, number>,
  maxNodes: number,
  stats: OsintTopologyResult["stats"]
): OsintTopologyResult {
  let surviving = nodes;
  if (nodes.size > maxNodes) {
    const ranked = [...nodes.entries()].sort((left, right) => {
      const byPriority = (priority.get(right[0]) ?? 0) - (priority.get(left[0]) ?? 0);
      if (byPriority !== 0) {
        return byPriority;
      }
      const byEvidence = provenanceCount(right[1]) - provenanceCount(left[1]);
      if (byEvidence !== 0) {
        return byEvidence;
      }
      return left[0].localeCompare(right[0]);
    });
    const keep = new Set(ranked.slice(0, maxNodes).map(([id]) => id));
    stats.capped += nodes.size - keep.size;
    surviving = new Map(ranked.filter(([id]) => keep.has(id)));
  }

  return {
    nodes: [...surviving.values()],
    // An edge is only meaningful if both endpoints survived eviction.
    edges: [...edges.values()].filter((edge) => surviving.has(edge.from) && surviving.has(edge.to)),
    stats: { ...stats, projectedNodes: surviving.size }
  };
}

function provenanceCount(node: GraphNode): number {
  return Array.isArray(node.properties.provenance) ? node.properties.provenance.length : 0;
}

/**
 * Target-side entities collected from the open internet are never locally
 * validated, so in-scope hosts are still `validationStatus: "pending"`. Hosts
 * outside the authorized scope keep the FOFA convention (`candidate_only` plus
 * `active_testing_allowed: false`) so the Planner sees the lead without being
 * able to plan action against it.
 */
function hostNode(
  host: string,
  extra: Record<string, unknown>,
  evidenceRef: string,
  isHostInScope: ((host: string) => boolean) | undefined
): { node: GraphNode; outOfScope: boolean } {
  let inScope = false;
  if (isHostInScope) {
    try {
      inScope = isHostInScope(host);
    } catch {
      inScope = false;
    }
  }
  return {
    node: {
      id: stableOperationIdentityId(`host:${normalizeKeyPart(host)}`),
      graphKind: "operation",
      type: "Host",
      label: host,
      properties: {
        source: "osint",
        origin: "osint",
        classification: inScope ? "in_scope" : "candidate_only",
        validationStatus: "pending",
        ...(inScope ? {} : { active_testing_allowed: false }),
        ...extra
      },
      evidenceRefs: [evidenceRef]
    },
    outOfScope: !inScope
  };
}

function findingProperties(
  finding: OsintFinding,
  masked: boolean,
  identityValue: string
): Record<string, unknown> {
  const provenance = (finding.provenance ?? [])
    .slice(0, 5)
    .map((item) => ({
      ...(item.url ? { url: item.url } : {}),
      ...(item.title ? { title: item.title.slice(0, 200) } : {}),
      ...(item.source ? { source: item.source } : {}),
      ...(item.observedAt ? { observedAt: item.observedAt } : {})
    }))
    .filter((item) => Object.keys(item).length > 0);

  return {
    source: "osint",
    origin: "osint",
    confidence: finding.confidence ?? "unconfirmed",
    ...(masked ? { personalData: true, masked: true, identityRef: identityValue } : {}),
    ...(provenance.length > 0 ? { provenance } : {})
  };
}

/**
 * Display mask for a personal value. Presentation only — identity is carried
 * separately by `personalIdentityValue`, because deriving identity from a mask
 * would collide ("张*" is both 张三 and 张四) and silently merge two people.
 */
export function maskPersonalValue(kind: OsintEntityKind, value: string): string {
  const normalized = normalizePersonalValue(kind, value);
  if (kind === "email") {
    const at = normalized.lastIndexOf("@");
    if (at > 0) {
      const local = normalized.slice(0, at);
      const stars = "*".repeat(Math.max(1, Math.min(local.length - 1, 3)));
      return `${local.slice(0, 1)}${stars}${normalized.slice(at)}`;
    }
  }
  if (kind === "phone") {
    const digits = normalized;
    if (/^\d{7,}$/.test(digits)) {
      return `${digits.slice(0, 3)}${"*".repeat(digits.length - 7)}${digits.slice(-4)}`;
    }
  }
  const chars = [...normalized];
  if (chars.length <= 1) {
    return "*";
  }
  return `${chars[0]}${"*".repeat(Math.min(chars.length - 1, 3))}`;
}

/**
 * Stable pseudonym for a masked personal value. Cross-runtime merging needs one
 * person to yield one id everywhere, which a display mask cannot provide, so the
 * identity is keyed on a salted digest instead of the raw value. The salt is not
 * a secrecy mechanism — short values such as phone numbers are brute-forceable —
 * it exists so the long-lived graph carries no raw personal value at all.
 */
export function personalIdentityValue(kind: OsintEntityKind, value: string): string {
  const digest = createHash("sha256")
    .update(`${PSEUDONYM_SALT}${kind}:${normalizePersonalValue(kind, value)}`)
    .digest("hex");
  return `pd:${digest.slice(0, 20)}`;
}

function normalizeKeyPart(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function mergeRefs(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

/** Unions two provenance lists, de-duplicating by url+source. */
function mergeProvenance(left: unknown, right: unknown): unknown {
  const lists = [left, right].filter((value): value is unknown[] => Array.isArray(value));
  if (lists.length === 0) {
    return left ?? right;
  }
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const item of lists.flat()) {
    const record = item as Record<string, unknown>;
    const key = `${String(record?.url ?? "")}|${String(record?.source ?? "")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/**
 * Canonical form of a personal value, used by both the display mask and the
 * identity pseudonym. They must agree: masking "+86 138-0000-0000" as
 * "861******0000" while keying identity on "13800000000" would make the same
 * person look like two entities depending on how the number was written.
 */
export function normalizePersonalValue(kind: OsintEntityKind, value: string): string {
  if (kind === "email") {
    return value.normalize("NFKC").trim().toLowerCase();
  }
  if (kind === "phone") {
    const digits = value.replace(/\D/g, "");
    if (digits.length > 11 && digits.startsWith("86")) {
      return digits.slice(2);
    }
    return digits;
  }
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export type OsintTopologyDelta = Pick<GraphDelta, "nodes" | "edges">;
