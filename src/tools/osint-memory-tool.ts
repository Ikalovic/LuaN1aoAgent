import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeOsintTopology, type OsintEntityKind, type OsintFinding } from "../osint/osint-topology.js";
import {
  authorizedScopeContainsDomain,
  authorizedScopeContainsIp,
  parseAuthorizedScope,
  UNRESTRICTED_CTF_SCOPE,
  type AuthorizedScope
} from "../scope.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import type { SQLiteGraphStore } from "../stores/graph-store.js";

/**
 * Writes collected intelligence into the runtime's graph memory.
 *
 * The projection is deterministic (`normalizeOsintTopology`) rather than an LLM
 * re-reading an artifact, so the same entity always resolves to the same
 * content-addressed node id. That is what lets memory written here merge with
 * locally observed nodes instead of duplicating them, and what will let another
 * runtime import it later without a fuzzy match.
 *
 * Scope is re-validated here, at write time, against the run's *current*
 * authorized scope: a collected host that falls outside it is stored as an
 * unactionable lead (`candidate_only`, `active_testing_allowed: false`) rather
 * than an asset the Planner could plan against. Absent or unparseable scope
 * fails closed.
 */

const ENTITY_KINDS: OsintEntityKind[] = [
  "org", "person", "email", "account", "phone", "host", "ip", "service", "document"
];

const CONFIDENCES = ["observed", "inferred", "unconfirmed"] as const;

export type OsintMemoryScopeResolver = () => string | undefined;

export function createOsintMemoryWriteTool(input: {
  graphStore: SQLiteGraphStore;
  /** Returns the run's current authorized-scope summary, or undefined if unknown. */
  resolveScopeSummary: OsintMemoryScopeResolver;
  executionLog?: ExecutionLog;
  taskId?: string;
}): ToolDefinition<any, any, any> {
  return defineTool({
    name: "osint_memory_write",
    label: "Write OSINT Memory",
    description: [
      "Persist collected intelligence as long-term graph memory so later Tasks and epochs can reuse it without re-collecting.",
      "Call it once, at the end of a collection round, with the entities you actually concluded — not with every search hit.",
      "Target-side entities outside the current authorized scope are stored as unactionable leads automatically; you do not need to filter them yourself.",
      "Provenance is required in spirit: attach the sources you relied on, and never write a personal value you did not observe."
    ].join(" "),
    parameters: Type.Object({
      findings: Type.Array(Type.Object({
        kind: Type.Union(ENTITY_KINDS.map((kind) => Type.Literal(kind))),
        value: Type.String({ minLength: 1, maxLength: 2_048 }),
        confidence: Type.Optional(Type.Union(CONFIDENCES.map((item) => Type.Literal(item)))),
        organization: Type.Optional(Type.String({ maxLength: 512 })),
        owner: Type.Optional(Type.String({ maxLength: 512 })),
        host: Type.Optional(Type.String({ maxLength: 512 })),
        port: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65_535 }), Type.String({ maxLength: 8 })])),
        person: Type.Optional(Type.String({ maxLength: 512 })),
        provenance: Type.Optional(Type.Array(Type.Object({
          url: Type.Optional(Type.String({ maxLength: 2_048 })),
          title: Type.Optional(Type.String({ maxLength: 512 })),
          source: Type.Optional(Type.String({ maxLength: 64 })),
          observedAt: Type.Optional(Type.String({ maxLength: 64 }))
        }, { additionalProperties: false }), { maxItems: 8 }))
      }, { additionalProperties: false }), {
        minItems: 1,
        maxItems: 500,
        description: "Entities concluded in this round. At most 500 per call; a single Task is capped in total."
      })
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const findings = params.findings as OsintFinding[];
      const scope = resolveAuthorizedScope(input.resolveScopeSummary());

      const result = normalizeOsintTopology({
        findings,
        // A placeholder until the audit event exists; every node gets the real
        // event id below so the Planner can resolve the provenance with
        // evidence_read instead of finding a dangling reference.
        evidenceRef: "event:pending",
        isHostInScope: (host) => hostInAuthorizedScope(scope, host)
      });

      if (result.nodes.length === 0) {
        return toolJsonResult({
          written: false,
          reason: "no finding produced a storable entity",
          stats: result.stats
        });
      }

      let evidenceRef = "event:osint-memory";
      if (input.executionLog) {
        const event = await input.executionLog.append({
          taskId: input.taskId,
          role: "executor",
          eventType: "osint_memory_written",
          summary: `Remembered ${result.nodes.length} intelligence node(s)`,
          payload: {
            stats: result.stats,
            nodeTypes: summarizeNodeTypes(result.nodes.map((node) => node.type))
          }
        });
        evidenceRef = event.id;
      }

      const nodes = result.nodes.map((node) => ({ ...node, evidenceRefs: [evidenceRef] }));
      input.graphStore.upsertDelta({
        sourceEventIds: [evidenceRef],
        nodes,
        edges: result.edges.map((edge) => ({ ...edge, evidenceRefs: [evidenceRef] }))
      });

      return toolJsonResult({
        written: true,
        evidenceRef,
        stats: result.stats,
        nodeTypes: summarizeNodeTypes(nodes.map((node) => node.type)),
        note: result.stats.outOfScope > 0
          ? `${result.stats.outOfScope} target-side node(s) were stored as candidate_only leads because they are outside the authorized scope.`
          : undefined
      });
    }
  });
}

/**
 * Rebuilds the scope from its summary at call time. The summary is only known
 * once the run has started, and it can change between Tasks, so this is resolved
 * per write rather than captured at construction. An unparseable summary yields
 * undefined, which `hostInAuthorizedScope` treats as "nothing is in scope".
 */
export function resolveAuthorizedScope(summary: string | undefined): AuthorizedScope | undefined {
  if (!summary) {
    return undefined;
  }
  try {
    return parseAuthorizedScope(summary);
  } catch {
    return undefined;
  }
}

/**
 * Fail-closed scope membership. An unknown or empty scope denies everything, and
 * the unrestricted CTF scope admits every host rather than only those that
 * literally match a domain entry.
 */
export function hostInAuthorizedScope(scope: AuthorizedScope | undefined, host: string): boolean {
  if (!scope) {
    return false;
  }
  if (scope.cidrs.includes(UNRESTRICTED_CTF_SCOPE)) {
    return true;
  }
  return authorizedScopeContainsDomain(scope, host) || authorizedScopeContainsIp(scope, host);
}

function summarizeNodeTypes(types: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of types) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function toolJsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value
  };
}
