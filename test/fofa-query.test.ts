import assert from "node:assert/strict";
import test from "node:test";
import { disjunctiveBranches, parseFofaQuery } from "../src/fofa/fofa-query.js";
import { FofaError } from "../src/fofa/fofa-types.js";

test("FOFA parser preserves OR comparisons", () => {
  assert.deepEqual(parseFofaQuery('domain="example.com" || ip="192.0.2.8"'), {
    kind: "or",
    children: [
      { kind: "comparison", field: "domain", operator: "=", value: "example.com", negated: false },
      { kind: "comparison", field: "ip", operator: "=", value: "192.0.2.8", negated: false }
    ]
  });
});

test("FOFA parser applies NOT, AND, OR precedence and escaped strings", () => {
  assert.deepEqual(parseFofaQuery('!domain="bad\\\"name.example" || ip!="192.0.2.8" && port="443"'), {
    kind: "or",
    children: [
      { kind: "comparison", field: "domain", operator: "=", value: 'bad"name.example', negated: true },
      {
        kind: "and",
        children: [
          { kind: "comparison", field: "ip", operator: "!=", value: "192.0.2.8", negated: false },
          { kind: "comparison", field: "port", operator: "=", value: "443", negated: false }
        ]
      }
    ]
  });
});

test("FOFA parser distributes branches and pushes group negation down", () => {
  const root = parseFofaQuery('!(domain="bad.example" || country="CN") && ip="192.0.2.8"');
  assert.deepEqual(disjunctiveBranches(root), [[
    { kind: "comparison", field: "domain", operator: "=", value: "bad.example", negated: true },
    { kind: "comparison", field: "country", operator: "=", value: "CN", negated: true },
    { kind: "comparison", field: "ip", operator: "=", value: "192.0.2.8", negated: false }
  ]]);
});

test("FOFA parser fails closed on unsupported or excessive syntax", () => {
  const invalid = [
    'domain="example.com" &&',
    'port>="443"',
    'domain="unterminated',
    'domain="example.com" trailing',
    'domain="example.com"\n',
    `domain="${"a".repeat(4_096)}"`,
    `${"(".repeat(33)}domain="example.com"${")".repeat(33)}`,
    Array.from({ length: 257 }, () => 'domain="example.com"').join(" && ")
  ];
  for (const query of invalid) {
    assert.throws(
      () => parseFofaQuery(query),
      (error: unknown) => error instanceof FofaError && error.code === "fofa_query_invalid",
      query.slice(0, 80)
    );
  }
});
