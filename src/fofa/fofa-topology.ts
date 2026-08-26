import { stableOperationIdentityId } from "../operation-identity.js";
import type { GraphDelta, GraphEdge, GraphNode } from "../types.js";
import type { FofaRecord } from "./fofa-types.js";

export type FofaTopologyInput = { records: FofaRecord[]; evidenceRef: string; authorizedAnchors?: string[] };
export type FofaTopologyDelta = Pick<GraphDelta, "nodes" | "edges">;

export function normalizeFofaTopology(input: FofaTopologyInput): FofaTopologyDelta {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const anchors = input.authorizedAnchors ?? [];
  const addNode = (node: GraphNode) => {
    const previous = nodes.get(node.id);
    nodes.set(node.id, previous ? { ...previous, properties: { ...previous.properties, ...node.properties }, evidenceRefs: [...new Set([...(previous.evidenceRefs ?? []), ...(node.evidenceRefs ?? [])])] } : node);
  };
  const addEdge = (from: string, to: string, type: string) => edges.set(`${from}|${type}|${to}`, { from, to, type, evidenceRefs: [input.evidenceRef] });
  for (const record of input.records) {
    const fields = record.fields;
    const host = stringField(fields, "host") ?? stringField(fields, "domain") ?? stringField(fields, "ip");
    const ip = stringField(fields, "ip");
    if (!host && !ip) continue;
    const hostValue = host ?? ip!;
    const hostId = stableOperationIdentityId(`host:${hostValue.toLowerCase()}`);
    const candidate = record.classification === "candidate_only";
    addNode({ id: hostId, graphKind: "operation", type: "Host", label: hostValue, properties: { source: "fofa", classification: record.classification, validationStatus: candidate ? "pending" : "validated", active_testing_allowed: record.active_testing_allowed }, evidenceRefs: [input.evidenceRef] });
    if (candidate && anchors[0]) addEdge(hostId, stableOperationIdentityId(`host:${anchors[0].toLowerCase()}`), "candidate_for");
    if (host && ip) addEdge(hostId, stableOperationIdentityId(`host:${ip}`), "resolves_to");
    const port = stringField(fields, "port");
    if (!port) continue;
    const protocol = stringField(fields, "protocol") ?? "tcp";
    const portId = stableOperationIdentityId(`port:host:${hostValue.toLowerCase()}:${port}/${protocol}`);
    addNode({ id: portId, graphKind: "operation", type: "Port", label: `${port}/${protocol}`, properties: { host: hostValue, port, protocol, source: "fofa", classification: record.classification, active_testing_allowed: record.active_testing_allowed }, evidenceRefs: [input.evidenceRef] });
    addEdge(hostId, portId, "has_port");
    const service = stringField(fields, "product") ?? stringField(fields, "server");
    if (service) {
      const serviceId = stableOperationIdentityId(`service:host:${hostValue.toLowerCase()}:${port}/${protocol}:${service}`);
      addNode({ id: serviceId, graphKind: "operation", type: "Service", label: service, properties: { host: hostValue, port, protocol, service, source: "fofa", classification: record.classification, active_testing_allowed: record.active_testing_allowed }, evidenceRefs: [input.evidenceRef] });
      addEdge(portId, serviceId, "runs_service");
      const link = stringField(fields, "link");
      if (link) {
        const endpointId = stableOperationIdentityId(`endpoint:${link}`);
        addNode({ id: endpointId, graphKind: "operation", type: "WebEndpoint", label: link, properties: { url: link, host: hostValue, source: "fofa", classification: record.classification, validationStatus: candidate ? "pending" : "validated", active_testing_allowed: record.active_testing_allowed }, evidenceRefs: [input.evidenceRef] });
        addEdge(serviceId, endpointId, "exposes_endpoint");
      }
    }
    const cname = stringField(fields, "cname_domain") ?? stringField(fields, "cname");
    if (cname) {
      const aliasId = stableOperationIdentityId(`host:${cname.toLowerCase()}`);
      addNode({ id: aliasId, graphKind: "operation", type: "Host", label: cname, properties: { source: "fofa", classification: "candidate_only", validationStatus: "pending", active_testing_allowed: false }, evidenceRefs: [input.evidenceRef] });
      addEdge(hostId, aliasId, "has_alias");
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function stringField(fields: Record<string, string | number | boolean | null>, key: string): string | undefined {
  const value = fields[key];
  return value === null || value === undefined || value === "" ? undefined : String(value);
}
