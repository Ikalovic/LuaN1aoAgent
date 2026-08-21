import assert from "node:assert/strict";
import test from "node:test";
import { FofaClient } from "../src/fofa/fofa-client.js";
import type { FofaConfig } from "../src/fofa/fofa-config.js";
import { FofaError } from "../src/fofa/fofa-types.js";

const config: FofaConfig = {
  provider: "official",
  allowInsecureHttp: false,
  apiKey: "sentinel-secret",
  email: "agent@example.com",
  baseUrl: "https://fofa.example",
  maxResultsPerCall: 100,
  maxResultsPerTask: 1_000,
  maxAggregationsPerTask: 20,
  requestTimeoutMs: 50
};

test("FOFA client routes Shenxd searches directly through the PHP adapter", async () => {
  let seen: URL | undefined;
  const client = new FofaClient({
    ...config,
    provider: "shenxd",
    allowInsecureHttp: true,
    baseUrl: "http://map.example/fofa/test_fofa/fofa1_api.php"
  }, {
    fetch: async (input) => {
      seen = new URL(String(input));
      return json({ error: false, size: 1, total: 1, results: [["192.0.2.1", 443]] });
    }
  });

  await client.search({ query: 'domain="example.com"', fields: ["ip", "port"], size: 1, full: false });
  assert.ok(seen);
  assert.equal(seen.pathname, "/fofa/test_fofa/fofa1_api.php");
  assert.equal(Buffer.from(seen.searchParams.get("qbase64")!, "base64").toString("utf8"), 'domain="example.com"');
  assert.equal(seen.searchParams.get("key"), "sentinel-secret");
  assert.equal(seen.searchParams.get("email"), "agent@example.com");
  assert.equal(seen.searchParams.get("fields"), "ip,port");
  assert.equal(seen.searchParams.get("size"), "1");
  assert.equal(seen.searchParams.get("full"), "false");
});

test("FOFA client normalizes Shenxd expired-card errors without leaking credentials", async () => {
  const client = new FofaClient({
    ...config,
    provider: "shenxd",
    allowInsecureHttp: true,
    baseUrl: "http://map.example/fofa/test_fofa/fofa1_api.php"
  }, {
    fetch: async () => json({ error: true, message: "API密钥 sentinel-secret 无效或已过期" })
  });

  await assert.rejects(
    client.search({ query: 'domain="example.com"', fields: ["host"], size: 1, full: false }),
    (error: unknown) => {
      assert.ok(isFofaError(error, "fofa_auth_failed"));
      assert.doesNotMatch(String(error), /sentinel-secret|agent@example\.com/);
      return true;
    }
  );
});

test("FOFA client calls all official endpoints with encoded bounded parameters", async () => {
  const seen: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.pathname === "/api/v1/info/my") {
      return json({
        error: false,
        email: "agent@example.com",
        key: "sentinel-secret",
        username: "profile-name",
        fofa_point: 88,
        isvip: true
      });
    }
    if (url.pathname === "/api/v1/search/all") {
      return json({ error: false, size: 1, total: 9, results: [["192.0.2.1", 443]], next: "page-2" });
    }
    if (url.pathname === "/api/v1/search/next") {
      return json({ error: false, size: 1, results: [["192.0.2.2", 8443]], consumed_fpoint: 1 });
    }
    if (url.pathname === "/api/v1/search/stats") {
      return json({ error: false, distinct: { country: 3 } });
    }
    return json({ error: false, host: "a.example.com", ports: [443] });
  };
  const client = new FofaClient(config, { fetch: fetchImpl });

  const account = await client.accountInfo();
  assert.deepEqual(account, { fofa_point: 88, isvip: true });
  assert.deepEqual(
    await client.search({ query: 'title="中文"', fields: ["ip", "port"], size: 10, full: false }),
    { results: [["192.0.2.1", 443]], size: 1, total: 9, next: "page-2", consumedFpoints: undefined }
  );
  await client.searchNext({
    query: 'title="中文"', fields: ["ip", "port"], size: 10, full: true, next: "page-2"
  });
  await client.stats({ query: 'title="中文"', fields: ["country"], size: 10 });
  await client.hostAggregate({ host: "a.example.com", detail: true });

  assert.deepEqual(seen.map((url) => url.pathname), [
    "/api/v1/info/my",
    "/api/v1/search/all",
    "/api/v1/search/next",
    "/api/v1/search/stats",
    "/api/v1/host/a.example.com"
  ]);
  assert.ok(seen.every((url) => url.searchParams.get("key") === "sentinel-secret"));
  assert.equal(
    Buffer.from(seen[1].searchParams.get("qbase64")!, "base64").toString("utf8"),
    'title="中文"'
  );
  assert.equal(seen[1].searchParams.get("fields"), "ip,port");
  assert.equal(seen[1].searchParams.get("size"), "10");
  assert.equal(seen[2].searchParams.get("next"), "page-2");
  assert.equal(seen[4].searchParams.get("detail"), "true");
});

test("FOFA client rejects rows that do not match the requested fields", async () => {
  const client = new FofaClient(config, {
    fetch: async () => json({ error: false, size: 1, results: [["192.0.2.1"]] })
  });
  await assert.rejects(
    client.search({ query: 'domain="example.com"', fields: ["ip", "port"], size: 1, full: false }),
    (error: unknown) => isFofaError(error, "fofa_response_invalid")
  );
});

test("FOFA client maps non-retryable provider and HTTP errors without leaking secrets", async () => {
  const cases: Array<{ response: Response; code: FofaError["code"] }> = [
    { response: json({ error: true, errmsg: "email or key sentinel-secret is invalid" }), code: "fofa_auth_failed" },
    { response: json({ error: true, errmsg: "F-point is not enough for sentinel-secret" }), code: "fofa_points_insufficient" },
    { response: json({ error: true, errmsg: "VIP privilege unsupported for sentinel-secret" }), code: "fofa_plan_unsupported" },
    { response: json({ error: true, errmsg: "provider rejected sentinel-secret" }), code: "fofa_provider_error" },
    { response: json({}, 401), code: "fofa_auth_failed" },
    { response: json({}, 403), code: "fofa_auth_failed" }
  ];
  for (const item of cases) {
    let calls = 0;
    const client = new FofaClient(config, { fetch: async () => { calls += 1; return item.response.clone(); } });
    await assert.rejects(client.accountInfo(), (error: unknown) => {
      assert.ok(isFofaError(error, item.code));
      assert.doesNotMatch(String(error), /sentinel-secret|agent@example\.com/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("FOFA client retries 429 and 5xx twice with bounded backoff", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = new FofaClient(config, {
    fetch: async () => {
      calls += 1;
      if (calls === 1) return json({}, 429);
      if (calls === 2) return json({}, 503);
      return json({ error: false, size: 0, results: [] });
    },
    sleep: async (milliseconds: number) => { sleeps.push(milliseconds); }
  });
  await client.search({ query: 'domain="example.com"', fields: ["ip"], size: 1, full: false });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 500]);
});

test("FOFA client retries timeouts but not caller cancellation", async () => {
  const timeoutSleeps: number[] = [];
  let timeoutCalls = 0;
  const timeoutClient = new FofaClient({ ...config, requestTimeoutMs: 5 }, {
    fetch: async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      timeoutCalls += 1;
      return await rejectWhenAborted(init?.signal);
    },
    sleep: async (milliseconds: number) => { timeoutSleeps.push(milliseconds); }
  });
  await assert.rejects(timeoutClient.accountInfo(), (error: unknown) => isFofaError(error, "fofa_timeout"));
  assert.equal(timeoutCalls, 3);
  assert.deepEqual(timeoutSleeps, [250, 500]);

  const controller = new AbortController();
  let cancelledCalls = 0;
  const cancelledClient = new FofaClient(config, {
    fetch: async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      cancelledCalls += 1;
      setImmediate(() => controller.abort(new DOMException("cancelled", "AbortError")));
      return await rejectWhenAborted(init?.signal);
    },
    sleep: async () => assert.fail("caller cancellation must not retry")
  });
  await assert.rejects(cancelledClient.accountInfo(controller.signal), { name: "AbortError" });
  assert.equal(cancelledCalls, 1);

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort(new DOMException("cancelled sentinel-secret", "AbortError"));
  await assert.rejects(cancelledClient.accountInfo(alreadyCancelled.signal), (error: unknown) => {
    assert.equal(error instanceof Error && error.name, "AbortError");
    assert.doesNotMatch(String(error), /sentinel-secret/);
    return true;
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function isFofaError(error: unknown, code: FofaError["code"]): boolean {
  return error instanceof FofaError && error.code === code;
}

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error("missing abort signal"));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
