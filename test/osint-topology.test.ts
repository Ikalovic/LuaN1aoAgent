import assert from "node:assert/strict";
import test from "node:test";
import {
  maskPersonalValue,
  normalizeOsintTopology,
  personalIdentityValue,
  type OsintFinding
} from "../src/osint/osint-topology.js";
import { stableOperationIdentityId } from "../src/operation-identity.js";

const EVIDENCE = "event:test-1";

function project(findings: OsintFinding[], overrides: Partial<Parameters<typeof normalizeOsintTopology>[0]> = {}) {
  return normalizeOsintTopology({ findings, evidenceRef: EVIDENCE, ...overrides });
}

function nodesOfType(result: ReturnType<typeof project>, type: string) {
  return result.nodes.filter((node) => node.type === type);
}

function edgesOfType(result: ReturnType<typeof project>, type: string) {
  return result.edges.filter((edge) => edge.type === type);
}

test("each finding kind projects to its own node type", () => {
  const result = project([
    { kind: "org", value: "某某科技有限公司" },
    { kind: "person", value: "张三", organization: "某某科技有限公司" },
    { kind: "email", value: "zhangsan@example.com" },
    { kind: "account", value: "zhangsan", organization: "某某科技有限公司" },
    { kind: "phone", value: "13800000000" },
    { kind: "host", value: "example.com" },
    { kind: "ip", value: "203.0.113.10" },
    { kind: "document", value: "https://example.com/a.pdf" }
  ]);

  assert.equal(nodesOfType(result, "Organization").length, 1);
  assert.equal(nodesOfType(result, "Person").length, 1);
  assert.equal(nodesOfType(result, "Identity").length, 2);
  assert.equal(nodesOfType(result, "Contact").length, 1);
  assert.equal(nodesOfType(result, "Host").length, 2, "domains and IPs are both Hosts");
  assert.equal(nodesOfType(result, "File").length, 1);
  assert.equal(result.stats.skipped, 0);
});

test("a domain is a Host, never a new node type", () => {
  const result = project([{ kind: "host", value: "example.com" }]);
  const host = nodesOfType(result, "Host")[0]!;
  assert.equal(host.graphKind, "operation");
  assert.equal(host.id, stableOperationIdentityId("host:example.com"));
});

test("cross-runtime projection of the same finding yields the same node ids", () => {
  // This is the property the whole transfer feature rests on. `upsertDelta` does
  // no identity rebase, so if these diverged an import would duplicate forever.
  const findings: OsintFinding[] = [
    { kind: "org", value: "某某科技有限公司" },
    { kind: "person", value: "张三", organization: "某某科技有限公司" },
    { kind: "email", value: "zhangsan@example.com" },
    { kind: "host", value: "example.com" }
  ];
  const runtimeA = project(findings, { evidenceRef: "event:a" });
  const runtimeB = project(findings, { evidenceRef: "event:b" });

  assert.deepEqual(
    runtimeA.nodes.map((node) => node.id).sort(),
    runtimeB.nodes.map((node) => node.id).sort()
  );
  assert.deepEqual(
    runtimeA.edges.map((edge) => `${edge.from}|${edge.type}|${edge.to}`).sort(),
    runtimeB.edges.map((edge) => `${edge.from}|${edge.type}|${edge.to}`).sort()
  );
});

test("hosts outside the authorized scope become unactionable leads", () => {
  const findings: OsintFinding[] = [
    { kind: "host", value: "in-scope.example" },
    { kind: "host", value: "elsewhere.example" }
  ];
  const result = project(findings, { isHostInScope: (host) => host === "in-scope.example" });

  const inScope = nodesOfType(result, "Host").find((node) => node.label === "in-scope.example")!;
  const outOfScope = nodesOfType(result, "Host").find((node) => node.label === "elsewhere.example")!;

  assert.equal(inScope.properties.classification, "in_scope");
  assert.equal(inScope.properties.active_testing_allowed, undefined);
  assert.equal(outOfScope.properties.classification, "candidate_only");
  assert.equal(outOfScope.properties.active_testing_allowed, false);
  assert.equal(outOfScope.properties.validationStatus, "pending");
  assert.equal(result.stats.outOfScope, 1);
});

test("collected hosts are never marked validated", () => {
  const result = project([{ kind: "host", value: "in-scope.example" }], {
    isHostInScope: () => true
  });
  assert.equal(nodesOfType(result, "Host")[0]!.properties.validationStatus, "pending");
});

test("without a scope test every host fails closed", () => {
  const result = project([{ kind: "host", value: "example.com" }]);
  const host = nodesOfType(result, "Host")[0]!;
  assert.equal(host.properties.classification, "candidate_only");
  assert.equal(host.properties.active_testing_allowed, false);
  assert.equal(result.stats.outOfScope, 1);
});

test("a throwing scope test does not grant scope", () => {
  const result = project([{ kind: "host", value: "example.com" }], {
    isHostInScope: () => {
      throw new Error("scope resolver exploded");
    }
  });
  assert.equal(nodesOfType(result, "Host")[0]!.properties.classification, "candidate_only");
});

test("relations come from explicit fields, not from batch co-occurrence", () => {
  const withPerson = project([
    { kind: "person", value: "张三", organization: "甲公司" },
    { kind: "email", value: "zhangsan@example.com", person: "张三", organization: "甲公司" }
  ]);
  assert.equal(edgesOfType(withPerson, "member_of").length, 1);
  assert.equal(edgesOfType(withPerson, "uses_identity").length, 1);

  // Same two findings minus the explicit link: sharing a batch is not evidence
  // that the mailbox belongs to that person.
  const withoutPerson = project([
    { kind: "person", value: "张三", organization: "甲公司" },
    { kind: "email", value: "zhangsan@example.com" }
  ]);
  assert.equal(edgesOfType(withoutPerson, "uses_identity").length, 0);
});

test("a host owner becomes an owns edge only when the organization exists", () => {
  const result = project([{ kind: "host", value: "example.com", owner: "某某科技有限公司" }]);
  const owns = edgesOfType(result, "owns");
  assert.equal(owns.length, 1);
  assert.equal(owns[0]!.from, stableOperationIdentityId("organization:某某科技有限公司"));
  assert.ok(result.nodes.some((node) => node.type === "Organization"));
});

test("a service projects its host, port and service chain", () => {
  const result = project([{ kind: "service", value: "nginx", host: "example.com", port: 8443 }], {
    isHostInScope: () => true
  });

  assert.equal(nodesOfType(result, "Service").length, 1);
  assert.equal(nodesOfType(result, "Port").length, 1);
  assert.equal(edgesOfType(result, "has_port").length, 1);
  assert.equal(edgesOfType(result, "runs_service").length, 1);
  const hostId = stableOperationIdentityId("host:example.com");
  const portId = stableOperationIdentityId("port:host:example.com:8443/tcp");
  assert.equal(edgesOfType(result, "has_port")[0]!.from, hostId);
  assert.equal(edgesOfType(result, "runs_service")[0]!.from, portId);
});

test("a service without its host is skipped rather than invented", () => {
  const result = project([{ kind: "service", value: "nginx" }]);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.stats.skipped, 1);
});

test("unusable findings are counted, not silently dropped", () => {
  const result = project([
    { kind: "host", value: "   " },
    { kind: "unknown" as never, value: "whatever" }
  ]);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.stats.skipped, 2);
});

test("repeated findings merge into one node and keep every provenance entry", () => {
  const result = project([
    { kind: "org", value: "某某科技有限公司", provenance: [{ url: "https://a.example/1", source: "sogou" }] },
    { kind: "org", value: "某某科技有限公司", provenance: [{ url: "https://b.example/2", source: "so360" }] }
  ]);

  const organizations = nodesOfType(result, "Organization");
  assert.equal(organizations.length, 1);
  const provenance = organizations[0]!.properties.provenance as Array<{ url?: string }>;
  assert.equal(provenance.length, 2, "the second finding must not erase the first source");
  assert.equal(result.stats.projectedNodes, 1);
});

test("the node cap bounds the graph and reports what it refused", () => {
  const findings: OsintFinding[] = Array.from({ length: 10 }, (_, index) => ({
    kind: "host",
    value: `host-${index}.example`
  }));
  const result = project(findings, { maxNodes: 4, isHostInScope: () => true });

  assert.equal(result.nodes.length, 4);
  assert.equal(result.stats.capped, 6);
  assert.equal(result.stats.findings, 10);
});

test("eviction drops the weakest evidence, not whatever came last", () => {
  // The regression this guards: a first-come cap would let array order decide,
  // so a batch listing phone numbers first would discard every domain.
  const phones: OsintFinding[] = Array.from({ length: 20 }, (_, index) => ({
    kind: "phone",
    value: `1380000${String(index).padStart(4, "0")}`
  }));
  const hosts: OsintFinding[] = [
    { kind: "host", value: "a.example" },
    { kind: "host", value: "b.example" }
  ];

  // Phones first in the array, and the cap cannot hold everything.
  const result = project([...phones, ...hosts], { maxNodes: 5, isHostInScope: () => true });

  assert.equal(result.nodes.length, 5);
  assert.equal(nodesOfType(result, "Host").length, 2, "actionable assets outrank contact data");
  assert.equal(nodesOfType(result, "Contact").length, 3);
  assert.equal(result.stats.capped, 17);
});

test("a truncated node takes its edges with it", () => {
  const result = project([
    { kind: "host", value: "keep.example", owner: "保留公司" },
    { kind: "phone", value: "13800000001", person: "某人" }
  ], { maxNodes: 1, isHostInScope: () => true });

  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.type, "Host");
  for (const edge of result.edges) {
    assert.ok(result.nodes.some((node) => node.id === edge.from), "edge endpoint was evicted");
    assert.ok(result.nodes.some((node) => node.id === edge.to), "edge endpoint was evicted");
  }
});

test("better-corroborated nodes win a tie on kind priority", () => {
  const sparse: OsintFinding = { kind: "org", value: "甲公司" };
  const corroborated: OsintFinding = {
    kind: "org",
    value: "乙公司",
    provenance: [
      { url: "https://a.example/1", source: "sogou" },
      { url: "https://b.example/2", source: "so360" }
    ]
  };

  const result = project([sparse, corroborated], { maxNodes: 1 });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.label, "乙公司", "two independent sources should outweigh one");
});

test("masking keeps the raw personal value out of the projected node", () => {
  const result = project([
    { kind: "person", value: "张三", organization: "某某科技有限公司" },
    { kind: "email", value: "zhangsan@example.com" },
    { kind: "phone", value: "+86 138-0000-0000" }
  ]);

  const serialized = JSON.stringify(result.nodes);
  assert.doesNotMatch(serialized, /张三/);
  assert.doesNotMatch(serialized, /zhangsan@example\.com/);
  assert.doesNotMatch(serialized, /138-0000-0000/);

  assert.equal(nodesOfType(result, "Person")[0]!.label, "张*");
  assert.equal(nodesOfType(result, "Identity")[0]!.label, "z***@example.com");
  assert.equal(nodesOfType(result, "Contact")[0]!.label, "138****0000");
  assert.equal(result.stats.masked, 3);
  assert.equal(nodesOfType(result, "Person")[0]!.properties.masked, true);
});

test("masked people with the same surname stay distinct identities", () => {
  // The regression this guards: keying identity on the display mask would put
  // 张三 and 张四 on one node and silently conflate two humans.
  const result = project([
    { kind: "person", value: "张三", organization: "甲公司" },
    { kind: "person", value: "张四", organization: "甲公司" }
  ]);

  const people = nodesOfType(result, "Person");
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((node) => node.label), ["张*", "张*"], "both masks are identical");
  assert.notEqual(people[0]!.id, people[1]!.id, "identity must not be derived from the mask");
});

test("masking is stable so the same person merges across runtimes", () => {
  const first = project([{ kind: "email", value: "Ops@Example.com" }]);
  const second = project([{ kind: "email", value: "ops@example.com" }]);
  assert.equal(first.nodes[0]!.id, second.nodes[0]!.id);
});

test("masking can be turned off and then the raw value is the identity", () => {
  const result = project([{ kind: "email", value: "ops@example.com" }], { maskPersonalData: false });
  const identity = nodesOfType(result, "Identity")[0]!;
  assert.equal(identity.label, "ops@example.com");
  assert.equal(identity.properties.email, "ops@example.com");
  assert.equal(identity.properties.masked, undefined);
  assert.equal(result.stats.masked, 0);
});

test("mask helpers degrade predictably on short and malformed values", () => {
  // Too short to be a phone number: falls through to the generic mask rather
  // than pretending the value is a dialable number.
  assert.equal(maskPersonalValue("phone", "123"), "1**");
  assert.equal(maskPersonalValue("person", "张"), "*");
  assert.equal(maskPersonalValue("email", "not-an-email"), "n***");
  assert.equal(maskPersonalValue("email", "a@b.co"), "a*@b.co");
  assert.equal(personalIdentityValue("email", "a@b.co"), personalIdentityValue("email", "a@b.co"));
  assert.notEqual(personalIdentityValue("email", "a@b.co"), personalIdentityValue("account", "a@b.co"));
});

test("personal identity is canonical in both masking modes", () => {
  // Formatting must not create a second entity for the same number, whether or
  // not masking is on.
  const maskedA = project([{ kind: "phone", value: "+86 138-0000-0000" }]);
  const maskedB = project([{ kind: "phone", value: "13800000000" }]);
  assert.equal(maskedA.nodes[0]!.id, maskedB.nodes[0]!.id);

  const plainA = project([{ kind: "phone", value: "+86 138-0000-0000" }], { maskPersonalData: false });
  const plainB = project([{ kind: "phone", value: "13800000000" }], { maskPersonalData: false });
  assert.equal(plainA.nodes[0]!.id, plainB.nodes[0]!.id);
});
