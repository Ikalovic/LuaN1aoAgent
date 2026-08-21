import assert from "node:assert/strict";
import test from "node:test";
import { FofaScopePolicy } from "../src/fofa/fofa-scope-policy.js";
import { FofaError } from "../src/fofa/fofa-types.js";
import { parseAuthorizedScope } from "../src/scope.js";

test("FOFA policy requires an authorized positive anchor in every OR branch", () => {
  const policy = new FofaScopePolicy(parseAuthorizedScope("example.com,192.0.2.0/24"));
  assert.doesNotThrow(() => policy.validateQuery('domain="example.com" && port="443"'));
  assert.doesNotThrow(() => policy.validateQuery('domain="a.example.com" || ip="192.0.2.8"'));
  assert.throws(() => policy.validateQuery('domain="example.com" || country="CN"'), scopeRejected);
  assert.throws(() => policy.validateQuery('domain!="example.com" && product="nginx"'), scopeRejected);
  assert.throws(() => policy.validateQuery('!ip="192.0.2.8" && port="443"'), scopeRejected);
});

test("FOFA policy honors wildcard and IDN domain boundaries", () => {
  const wildcard = new FofaScopePolicy(parseAuthorizedScope("*.example.net"));
  assert.doesNotThrow(() => wildcard.validateQuery('domain="a.example.net"'));
  assert.throws(() => wildcard.validateQuery('domain="example.net"'), scopeRejected);

  const idn = new FofaScopePolicy(parseAuthorizedScope("例子.测试"));
  assert.doesNotThrow(() => idn.validateQuery('host="子.例子.测试"'));
});

test("FOFA policy accepts trusted opaque derived references but not free-form identities", () => {
  const policy = new FofaScopePolicy(parseAuthorizedScope("example.com,192.0.2.0/24"));
  const derived = new Set(["asset-ref:abc123"]);
  assert.doesNotThrow(() => policy.validateQuery('host="asset-ref:abc123"', derived));
  assert.doesNotThrow(() => policy.validateHost("asset-ref:abc123", derived));
  assert.throws(() => policy.validateQuery('host="asset-ref:abc123"'), scopeRejected);
  assert.throws(() => policy.validateHost("other.test"), scopeRejected);
  assert.throws(() => policy.validateQuery('ip="192.0.2.999"'), scopeRejected);
  assert.throws(() => policy.validateQuery('ip="2001:db8::1"'), scopeRejected);
});

test("FOFA policy recognizes URL and certificate anchors but not ICP associations", () => {
  const policy = new FofaScopePolicy(parseAuthorizedScope("example.com"));
  assert.doesNotThrow(() => policy.validateHost("https://a.example.com:443/path"));
  assert.doesNotThrow(() => policy.validateQuery('cert="a.example.com"'));
  assert.doesNotThrow(() => policy.validateQuery('certs_subject_cn="example.com"'));
  assert.throws(() => policy.validateQuery('cert="other.test"'), scopeRejected);
  assert.throws(() => policy.validateQuery('icp="example.com"'), scopeRejected);
});

test("FOFA policy classifies unrelated co-hosts as candidate-only", () => {
  const policy = new FofaScopePolicy(parseAuthorizedScope("example.com,192.0.2.0/24"));
  assert.deepEqual(policy.classify({ host: "a.example.com", ip: "198.51.100.2" }), {
    classification: "in_scope",
    active_testing_allowed: true
  });
  assert.deepEqual(policy.classify({ host: "other.test", ip: "192.0.2.8" }), {
    classification: "candidate_only",
    active_testing_allowed: false
  });
  assert.equal(policy.classify({ host: "https://a.example.com/path" }).classification, "in_scope");
  assert.equal(policy.classify({ ip: "192.0.2.8" }).classification, "in_scope");
  assert.equal(policy.classify({ ip: "2001:db8::1" }).classification, "candidate_only");
  assert.equal(policy.classify({}).classification, "candidate_only");
});

test("FOFA Scope fingerprint is stable for equivalent normalized Scope", () => {
  const first = new FofaScopePolicy(parseAuthorizedScope("example.com,192.0.2.0/24"));
  const second = new FofaScopePolicy(parseAuthorizedScope("192.0.2.9/24,example.com"));
  assert.equal(first.fingerprint(), second.fingerprint());
  assert.match(first.fingerprint(), /^[a-f0-9]{64}$/);
});

function scopeRejected(error: unknown): boolean {
  return error instanceof FofaError && error.code === "fofa_scope_rejected";
}
