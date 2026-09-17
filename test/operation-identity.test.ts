import assert from "node:assert/strict";
import test from "node:test";
import { operationIdentityKeys, stableOperationIdentityId } from "../src/operation-identity.js";
import type { GraphEdge, GraphNode } from "../src/types.js";

test("operation identities agree between explicit properties and graph topology", () => {
  const explicitNodes: GraphNode[] = [
    { id: "port:explicit", graphKind: "operation", type: "Port", label: "8000/TCP", properties: { host: "60.205.226.234", port: 8000, protocol: "tcp" } },
    { id: "service:explicit", graphKind: "operation", type: "Service", label: "HTTP", properties: { host: "60.205.226.234", port: 8000, protocol: "http" } },
    { id: "endpoint:explicit", graphKind: "operation", type: "WebEndpoint", label: "GET /flag", properties: { url: "http://60.205.226.234:8000/flag", method: "GET" } },
    { id: "parameter:explicit", graphKind: "operation", type: "Parameter", label: "query id", properties: { endpoint: "http://60.205.226.234:8000/flag", location: "query", name: "id" } }
  ];
  const topologyNodes: GraphNode[] = [
    { id: "host:topology", graphKind: "operation", type: "Host", label: "60.205.226.234", properties: {} },
    { id: "port:topology", graphKind: "operation", type: "Port", label: "8000/TCP", properties: {} },
    { id: "service:topology", graphKind: "operation", type: "Service", label: "HTTP on 8000", properties: {} },
    { id: "endpoint:topology", graphKind: "operation", type: "WebEndpoint", label: "GET /flag", properties: {} },
    { id: "parameter:topology", graphKind: "operation", type: "Parameter", label: "id", properties: { location: "query" } }
  ];
  const topologyEdges: GraphEdge[] = [
    { from: "host:topology", to: "port:topology", type: "has_port" },
    { from: "port:topology", to: "service:topology", type: "runs_service" },
    { from: "service:topology", to: "endpoint:topology", type: "exposes_endpoint" },
    { from: "endpoint:topology", to: "parameter:topology", type: "has_parameter" }
  ];
  const explicit = operationIdentityKeys(explicitNodes, []);
  const topology = operationIdentityKeys(topologyNodes, topologyEdges);

  assert.equal(topology.get("port:topology"), explicit.get("port:explicit"));
  assert.equal(topology.get("service:topology"), explicit.get("service:explicit"));
  assert.equal(topology.get("endpoint:topology"), explicit.get("endpoint:explicit"));
  assert.equal(topology.get("parameter:topology"), explicit.get("parameter:explicit"));
});

test("host identities reject descriptive labels but accept real address labels", () => {
  const identities = operationIdentityKeys([
    { id: "host:description", graphKind: "operation", type: "Host", label: "DMZ Host", properties: {} },
    { id: "host:hostname", graphKind: "operation", type: "Host", label: "dmz-web.internal", properties: {} },
    { id: "host:ipv6", graphKind: "operation", type: "Host", label: "2001:db8::10", properties: {} }
  ], []);

  assert.equal(identities.has("host:description"), false);
  assert.equal(identities.get("host:hostname"), "host:dmz-web.internal");
  assert.equal(identities.get("host:ipv6"), "host:2001:db8::10");
});

test("public-intelligence entity identities are content addressed", () => {
  const identities = operationIdentityKeys([
    { id: "a", graphKind: "operation", type: "Organization", label: "某某科技有限公司", properties: {} },
    { id: "b", graphKind: "operation", type: "Person", label: "张三", properties: { organization: "某某科技有限公司" } },
    { id: "c", graphKind: "operation", type: "Identity", label: "zhangsan@example.com", properties: {} },
    { id: "d", graphKind: "operation", type: "Identity", label: "zhangsan", properties: { organization: "某某科技有限公司" } },
    { id: "e", graphKind: "operation", type: "Contact", label: "+86 138-0000-0000", properties: {} }
  ], []);

  assert.equal(identities.get("a"), "organization:某某科技有限公司");
  assert.equal(identities.get("b"), "person:张三@某某科技有限公司");
  assert.equal(identities.get("c"), "identity:email:zhangsan@example.com");
  assert.equal(identities.get("d"), "identity:account:某某科技有限公司:zhangsan");
  assert.equal(identities.get("e"), "contact:phone:13800000000");
});

test("the same person name in different organizations stays a different entity", () => {
  const identities = operationIdentityKeys([
    { id: "a", graphKind: "operation", type: "Person", label: "李四", properties: { organization: "甲公司" } },
    { id: "b", graphKind: "operation", type: "Person", label: "李四", properties: { organization: "乙公司" } },
    { id: "c", graphKind: "operation", type: "Person", label: "李四", properties: {} }
  ], []);

  assert.equal(new Set([identities.get("a"), identities.get("b"), identities.get("c")]).size, 3,
    "collapsing these would silently conflate two humans");
});

test("contact identity folds formatting and the 86 country code", () => {
  const identities = operationIdentityKeys([
    { id: "a", graphKind: "operation", type: "Contact", label: "+86 138-0000-0000", properties: {} },
    { id: "b", graphKind: "operation", type: "Contact", label: "13800000000", properties: {} },
    { id: "c", graphKind: "operation", type: "Contact", label: "8613800000000", properties: {} },
    { id: "d", graphKind: "operation", type: "Contact", label: "(021) 5555 1234", properties: {} },
    { id: "e", graphKind: "operation", type: "Contact", label: "not a phone", properties: {} }
  ], []);

  assert.equal(identities.get("a"), "contact:phone:13800000000");
  assert.equal(identities.get("b"), "contact:phone:13800000000");
  assert.equal(identities.get("c"), "contact:phone:13800000000");
  assert.notEqual(identities.get("d"), identities.get("a"));
  assert.equal(identities.has("e"), false, "a non-numeric label is not a phone identity");
});

test("an identity node only takes an email shape as an email", () => {
  const identities = operationIdentityKeys([
    { id: "email", graphKind: "operation", type: "Identity", label: "ops@example.com", properties: {} },
    { id: "prose", graphKind: "operation", type: "Identity", label: "Contact us", properties: {} },
    { id: "handle", graphKind: "operation", type: "Identity", label: "@ops", properties: {} }
  ], []);

  assert.equal(identities.get("email"), "identity:email:ops@example.com");
  assert.equal(identities.get("prose"), "identity:account:unknown:contact us");
  assert.notEqual(identities.get("prose"), identities.get("handle"));
});

test("entity names normalise width, case and surrounding punctuation", () => {
  const identities = operationIdentityKeys([
    { id: "a", graphKind: "operation", type: "Organization", label: "ＡＣＭＥ  Corp.", properties: {} },
    { id: "b", graphKind: "operation", type: "Organization", label: "acme corp", properties: {} },
    { id: "c", graphKind: "operation", type: "Organization", label: "Acme  Corp", properties: {} }
  ], []);

  assert.equal(new Set([identities.get("a"), identities.get("b"), identities.get("c")]).size, 1,
    "full-width, case and punctuation variants are one organization");
});

test("identities converge across runtimes because they are content addressed", () => {
  // The whole cross-runtime merge rests on this. `upsertDelta` performs no
  // identity rebase (only `commitProjection` does), so the id has to be
  // canonical before it reaches the store; otherwise an import duplicates
  // instead of merging.
  const runtimeA = operationIdentityKeys([
    { id: "op:from-a", graphKind: "operation", type: "Organization", label: "某某科技有限公司", properties: { source: "sogou" } }
  ], []);
  const runtimeB = operationIdentityKeys([
    { id: "op:from-b", graphKind: "operation", type: "Organization", label: "某某科技有限公司", properties: { source: "so360" } }
  ], []);

  assert.equal(runtimeA.get("op:from-a"), runtimeB.get("op:from-b"));
  assert.equal(
    stableOperationIdentityId(runtimeA.get("op:from-a")!),
    stableOperationIdentityId(runtimeB.get("op:from-b")!)
  );
});
