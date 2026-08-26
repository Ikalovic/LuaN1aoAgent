import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFofaTopology } from "../src/fofa/fofa-topology.js";

test("normalizes FOFA candidate side-site topology with evidence", () => {
  const delta = normalizeFofaTopology({
    evidenceRef: "artifact:fofa-1",
    authorizedAnchors: ["example.com"],
    records: [{
      fields: { host: "sub.example.net", domain: "example.net", ip: "203.0.113.10", port: 443, protocol: "https", product: "nginx", link: "https://sub.example.net/", cname_domain: "cdn.example.net" },
      classification: "candidate_only",
      active_testing_allowed: false
    }]
  });
  assert.ok(delta.nodes.some((node) => node.type === "Host" && node.label === "sub.example.net" && node.properties.validationStatus === "pending"));
  assert.ok(delta.nodes.some((node) => node.type === "WebEndpoint"));
  assert.ok(delta.edges.some((edge) => edge.type === "candidate_for"));
  assert.ok(delta.edges.some((edge) => edge.type === "resolves_to"));
  assert.ok(delta.edges.some((edge) => edge.type === "has_alias"));
  assert.ok(delta.edges.some((edge) => edge.type === "exposes_endpoint"));
  assert.ok(delta.nodes.every((node) => node.evidenceRefs?.includes("artifact:fofa-1")));
});
