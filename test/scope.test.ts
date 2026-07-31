import assert from "node:assert/strict";
import test from "node:test";
import {
  extractLiteralGoalCidrs,
  normalizeInferredScopeCidrs,
  normalizeScope,
  normalizeScopeCidrs,
  parseAuthorizedScope
} from "../src/scope.js";

test("normalizes explicit IPv4 scope into canonical CIDRs", () => {
  assert.equal(normalizeScopeCidrs("11.0.0.9/24,10.0.0.1"), "10.0.0.1/32,11.0.0.0/24");
});

test("normalizes exact and wildcard domain scope entries", () => {
  assert.equal(
    normalizeScope("*.Baidu.COM., baidu.com,例子.测试,10.0.0.1"),
    "10.0.0.1/32,*.baidu.com,baidu.com,xn--fsqu00a.xn--0zwm56d"
  );
  assert.deepEqual(parseAuthorizedScope("baidu.com,*.baidu.com"), {
    cidrs: [],
    domains: ["*.baidu.com", "baidu.com"]
  });
});

test("rejects malformed domain scope entries", () => {
  for (const value of ["*baidu.com", "baidu.*.com", "https://baidu.com", "baidu.com:443", "localhost"]) {
    assert.throws(() => normalizeScope(value), /Invalid domain scope entry/);
  }
});

test("extracts literal IP addresses and CIDRs from a natural-language goal", () => {
  assert.deepEqual(
    extractLiteralGoalCidrs("评估 http://10.0.162.0:80 和 11.2.3.4/24"),
    ["10.0.162.0/32", "11.2.3.0/24"]
  );
});

test("rejects AI scope widening or invention", () => {
  assert.equal(
    normalizeInferredScopeCidrs("评估 10.0.162.0", ["10.0.162.0/32"]),
    "10.0.162.0/32"
  );
  assert.throws(
    () => normalizeInferredScopeCidrs("评估 10.0.162.0", ["10.0.162.0/24"]),
    /not explicitly present/
  );
  assert.throws(
    () => normalizeInferredScopeCidrs("评估授权系统", ["10.0.0.1/32"]),
    /pass --scope/
  );
});
