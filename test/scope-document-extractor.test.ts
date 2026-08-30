import assert from "node:assert/strict";
import test from "node:test";
import { extractScopeCandidates } from "../src/scope-documents/scope-candidate-extractor.js";
import { normalizeScopeEntry } from "../src/scope.js";

test("normalizes one domain, IPv4 address, or CIDR entry", () => {
  assert.deepEqual(normalizeScopeEntry("API.Example.COM."), { kind: "domain", value: "api.example.com" });
  assert.deepEqual(normalizeScopeEntry("10.0.0.7"), { kind: "cidr", value: "10.0.0.7/32" });
  assert.deepEqual(normalizeScopeEntry("10.1.9.4/16"), { kind: "cidr", value: "10.1.0.0/16" });
});

test("extracts normalized candidates with source evidence", () => {
  assert.deepEqual(extractScopeCandidates([{
    text: "允许 api.Example.com 和 10.0.0.7、10.1.0.0/16",
    line: 4
  }]), {
    domains: [{
      value: "api.example.com",
      source: "rule",
      evidence: { line: 4, excerpt: "允许 api.Example.com 和 10.0.0.7、10.1.0.0/16" }
    }],
    ipv4Cidrs: [{
      value: "10.0.0.7/32",
      source: "rule",
      evidence: { line: 4, excerpt: "允许 api.Example.com 和 10.0.0.7、10.1.0.0/16" }
    }, {
      value: "10.1.0.0/16",
      source: "rule",
      evidence: { line: 4, excerpt: "允许 api.Example.com 和 10.0.0.7、10.1.0.0/16" }
    }]
  });
});

test("rejects URL paths, email domains, IPv6 and invalid IPv4", () => {
  const result = extractScopeCandidates([{
    text: "https://web.example/a user@mail.example 2001:db8::1 999.1.1.1"
  }]);
  assert.deepEqual(result, { domains: [], ipv4Cidrs: [] });
});

test("deduplicates candidates while retaining the first evidence location", () => {
  const result = extractScopeCandidates([
    { text: "a.example", line: 2 },
    { text: "A.EXAMPLE", line: 9 }
  ]);
  assert.deepEqual(result.domains, [{
    value: "a.example",
    source: "rule",
    evidence: { line: 2, excerpt: "a.example" }
  }]);
});
