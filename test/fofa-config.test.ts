import assert from "node:assert/strict";
import test from "node:test";
import {
  fofaChildEnvironment,
  loadFofaConfig,
  redactFofaSecret
} from "../src/fofa/fofa-config.js";

test("FOFA stays disabled without a key", () => {
  assert.equal(loadFofaConfig({}), undefined);
});

test("FOFA config clamps per-call results to the Task limit", () => {
  const config = loadFofaConfig({
    FOFA_API_KEY: "sentinel-secret",
    FOFA_MAX_RESULTS_PER_CALL: "500",
    FOFA_MAX_RESULTS_PER_TASK: "10"
  })!;
  assert.equal(config.maxResultsPerCall, 10);
  assert.equal(config.maxResultsPerTask, 10);
  assert.equal(config.provider, "official");
  assert.equal(config.allowInsecureHttp, false);
});

test("FOFA config requires an explicit opt-in for the Shenxd HTTP endpoint", () => {
  const endpoint = "http://map.example/fofa/test_fofa/fofa1_api.php";
  assert.throws(
    () => loadFofaConfig({
      FOFA_API_KEY: "sentinel-secret",
      FOFA_PROVIDER: "shenxd",
      FOFA_API_BASE_URL: endpoint
    }),
    /FOFA_ALLOW_INSECURE_HTTP/
  );

  const config = loadFofaConfig({
    FOFA_API_KEY: "sentinel-secret",
    FOFA_PROVIDER: "shenxd",
    FOFA_ALLOW_INSECURE_HTTP: "1",
    FOFA_API_BASE_URL: endpoint
  })!;
  assert.equal(config.provider, "shenxd");
  assert.equal(config.allowInsecureHttp, true);
  assert.equal(config.baseUrl, endpoint);

  assert.throws(
    () => loadFofaConfig({ FOFA_API_KEY: "sentinel-secret", FOFA_PROVIDER: "unknown" }),
    /FOFA_PROVIDER/
  );
});

test("FOFA config uses bounded defaults for invalid positive integers", () => {
  const config = loadFofaConfig({
    FOFA_API_KEY: "sentinel-secret",
    FOFA_MAX_RESULTS_PER_CALL: "0",
    FOFA_MAX_RESULTS_PER_TASK: "not-a-number",
    FOFA_MAX_AGGREGATIONS_PER_TASK: "-2",
    FOFA_REQUEST_TIMEOUT_MS: "1.5"
  })!;
  assert.equal(config.maxResultsPerCall, 100);
  assert.equal(config.maxResultsPerTask, 1000);
  assert.equal(config.maxAggregationsPerTask, 20);
  assert.equal(config.requestTimeoutMs, 15_000);
});

test("FOFA rejects insecure remote base URLs but permits test loopback", () => {
  assert.throws(
    () => loadFofaConfig({ FOFA_API_KEY: "sentinel-secret", FOFA_BASE_URL: "http://fofa.example" }),
    /HTTPS/
  );
  assert.equal(
    loadFofaConfig({
      FOFA_API_KEY: "sentinel-secret",
      FOFA_BASE_URL: "http://127.0.0.1:8080/",
      NODE_ENV: "test"
    })!.baseUrl,
    "http://127.0.0.1:8080"
  );
  assert.equal(
    loadFofaConfig({
      FOFA_API_KEY: "sentinel-secret",
      FOFA_API_BASE_URL: "http://localhost:9090/",
      FOFA_BASE_URL: "http://127.0.0.1:8080/",
      NODE_ENV: "test"
    })!.baseUrl,
    "http://localhost:9090"
  );
});

test("the child environment and redacted text do not expose host secrets", () => {
  const config = loadFofaConfig({
    FOFA_API_KEY: "sentinel-secret",
    FOFA_EMAIL: "agent+fofa@example.com"
  })!;
  const child = fofaChildEnvironment(config, {
    PATH: "/bin",
    HOME: "/secret",
    NODE_OPTIONS: "--inspect"
  });
  assert.equal(child.HOME, undefined);
  assert.equal(child.NODE_OPTIONS, undefined);
  assert.equal(child.PATH, "/bin");
  assert.equal(child.FOFA_API_KEY, "sentinel-secret");
  assert.equal(child.FOFA_EMAIL, "agent+fofa@example.com");
  assert.equal(child.FOFA_PROVIDER, "official");
  assert.equal(child.FOFA_ALLOW_INSECURE_HTTP, undefined);

  const redacted = redactFofaSecret(
    "?key=sentinel-secret sentinel-secret email=agent%2Bfofa%40example.com agent+fofa@example.com",
    config
  );
  assert.doesNotMatch(redacted, /sentinel-secret/);
  assert.doesNotMatch(redacted, /agent(?:%2B|\+)fofa(?:%40|@)example\.com/i);
});
