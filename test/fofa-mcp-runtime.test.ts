import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FofaConfig } from "../src/fofa/fofa-config.js";
import {
  FofaMcpRuntime,
  type FofaMcpClientConnection,
  type FofaMcpClientFactory
} from "../src/mcp/fofa-runtime.js";
import { parseAuthorizedScope } from "../src/scope.js";
import { ExecutionLog } from "../src/stores/execution-log.js";
import { RuntimeStore } from "../src/stores/runtime-store.js";

const config: FofaConfig = {
  provider: "official",
  allowInsecureHttp: false,
  apiKey: "sentinel-secret",
  baseUrl: "https://fofa.example",
  maxResultsPerCall: 100,
  maxResultsPerTask: 100,
  maxAggregationsPerTask: 3,
  requestTimeoutMs: 1_000
};

test("FOFA Runtime rejects unsupported Shenxd tools before startup and quota", async () => {
  const fixture = runtimeFixture();
  let factoryCalls = 0;
  const runtime = new FofaMcpRuntime({
    runRef: "run:1",
    scope: parseAuthorizedScope("example.com"),
    config: { ...config, provider: "shenxd", allowInsecureHttp: true },
    runtimeStore: fixture.store,
    executionLog: fixture.log,
    clientFactory: async () => {
      factoryCalls += 1;
      return fakeConnection(async () => assert.fail("unsupported tool must not be dispatched"));
    }
  });

  for (const [tool, args] of [
    ["fofa_account_info", {}],
    ["fofa_search_next", { cursor: "cursor:any", limit: 1 }],
    ["fofa_stats", { query: 'domain="example.com"', fields: ["host"], limit: 1 }],
    ["fofa_host_aggregate", { host: "example.com", detail: false }]
  ] as const) {
    await assert.rejects(
      () => runtime.call("task:a", tool, args),
      (error: unknown) => error instanceof Error && "code" in error
        && error.code === "fofa_plan_unsupported"
    );
  }
  assert.equal(factoryCalls, 0);
  assert.deepEqual(fixture.store.getFofaQuota("task:a"), {
    resultsConsumed: 0,
    aggregationsConsumed: 0
  });
  await runtime.close();
  await fixture.closeStores();
});

test("FOFA Runtime injects trusted Task context and owns opaque cursors", async () => {
  const fixture = runtimeFixture();
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const connection = fakeConnection(async (input) => {
    calls.push(input);
    return success({
      operation: input.name === "fofa_search_next" ? "search_next" : "search",
      query: 'domain="example.com"',
      fields: ["host"],
      records: [{ fields: { host: "a.example.com" }, classification: "in_scope", active_testing_allowed: true }],
      returned: 1,
      nextProviderToken: "provider-secret-page"
    });
  });
  const runtime = fixture.create(async () => connection);
  const first = await runtime.call("task:a", "fofa_search", {
    query: 'domain="example.com"', fields: ["host"], limit: 10, full: true
  });
  assert.match(first.cursor ?? "", /^cursor:/);
  assert.equal((calls[0].arguments._runtime as { taskRef: string }).taskRef, "task:a");
  assert.equal(calls[0].arguments.size, 10);
  assert.equal(first.quota.resultsConsumed, 1);
  assert.doesNotMatch(JSON.stringify(first), /provider-secret-page/);

  await assert.rejects(
    () => runtime.call("task:b", "fofa_search_next", { cursor: first.cursor, limit: 10 }),
    /cursor.*Task/i
  );
  await runtime.call("task:a", "fofa_search_next", { cursor: first.cursor, limit: 10 });
  assert.equal(calls[1].arguments.next, "provider-secret-page");
  assert.equal(calls[1].arguments.query, 'domain="example.com"');
  assert.equal(calls[1].arguments.full, true);
  assert.equal(calls[1].arguments.cursor, undefined);
  await fixture.close(runtime);
});

test("FOFA Runtime persists quotas and releases only definite pre-dispatch failures", async () => {
  const definite = runtimeFixture();
  const preDispatch = Object.assign(new Error("not sent"), { preDispatch: true });
  const definiteRuntime = definite.create(async () => fakeConnection(async () => { throw preDispatch; }));
  await assert.rejects(
    () => definiteRuntime.call("task:a", "fofa_search", {
      query: 'domain="example.com"', fields: ["host"], limit: 10, full: false
    }),
    /not sent/
  );
  assert.equal(definite.store.getFofaQuota("task:a").resultsConsumed, 0);
  await definite.close(definiteRuntime);

  const ambiguous = runtimeFixture();
  const ambiguousRuntime = ambiguous.create(async () => fakeConnection(async () => { throw new Error("pipe closed"); }));
  await assert.rejects(
    () => ambiguousRuntime.call("task:a", "fofa_search", {
      query: 'domain="example.com"', fields: ["host"], limit: 10, full: false
    }),
    /fofa_mcp_unavailable/
  );
  assert.equal(ambiguous.store.getFofaQuota("task:a").resultsConsumed, 10);
  await ambiguous.close(ambiguousRuntime);
});

test("FOFA Runtime expires and explicitly invalidates Task cursors", async () => {
  let now = 1_000;
  const fixture = runtimeFixture();
  const runtime = fixture.create(async () => fakeConnection(async () => success({
    operation: "search",
    query: 'domain="example.com"',
    fields: ["host"],
    records: [],
    returned: 0,
    nextProviderToken: "next"
  })), () => now);
  const first = await runtime.call("task:a", "fofa_search", {
    query: 'domain="example.com"', fields: ["host"], limit: 1, full: false
  });
  now += 30 * 60 * 1_000 + 1;
  await assert.rejects(
    () => runtime.call("task:a", "fofa_search_next", { cursor: first.cursor, limit: 1 }),
    /cursor.*expired/i
  );

  now = 2_000;
  const second = await runtime.call("task:a", "fofa_search", {
    query: 'domain="example.com"', fields: ["host"], limit: 1, full: false
  });
  runtime.invalidateTask("task:a");
  await assert.rejects(
    () => runtime.call("task:a", "fofa_search_next", { cursor: second.cursor, limit: 1 }),
    /cursor.*unknown/i
  );
  await fixture.close(runtime);
});

test("FOFA Runtime restarts once for a future call and never replays the failed call", async () => {
  const fixture = runtimeFixture();
  let factoryCalls = 0;
  let firstCalls = 0;
  let secondCalls = 0;
  const factory: FofaMcpClientFactory = async () => {
    factoryCalls += 1;
    if (factoryCalls === 1) {
      return fakeConnection(async () => {
        firstCalls += 1;
        throw new Error("first transport closed");
      });
    }
    return fakeConnection(async () => {
      secondCalls += 1;
      if (secondCalls === 1) {
        return success({ operation: "account_info", data: { fofa_point: 1 }, returned: 0 });
      }
      throw new Error("second transport closed");
    });
  };
  const runtime = fixture.create(factory);
  await assert.rejects(() => runtime.call("task:a", "fofa_account_info", {}), /fofa_mcp_unavailable/);
  assert.equal(firstCalls, 1);
  assert.equal(factoryCalls, 1);

  await runtime.call("task:a", "fofa_account_info", {});
  assert.equal(factoryCalls, 2);
  assert.equal(firstCalls, 1);
  await assert.rejects(() => runtime.call("task:a", "fofa_account_info", {}), /fofa_mcp_unavailable/);
  await assert.rejects(() => runtime.call("task:a", "fofa_account_info", {}), /restart.*exhausted/i);
  assert.equal(factoryCalls, 2);
  await fixture.close(runtime);
});

test("FOFA Runtime propagates cancellation and closes idempotently", async () => {
  const fixture = runtimeFixture();
  let closeCalls = 0;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered; });
  const connection = fakeConnection(async (_input, signal) => {
    assert.ok(signal);
    markEntered();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    assert.fail("unreachable");
  }, () => { closeCalls += 1; });
  const runtime = fixture.create(async () => connection);
  const controller = new AbortController();
  const pending = runtime.call("task:a", "fofa_search", {
    query: 'domain="example.com"', fields: ["host"], limit: 5, full: false
  }, controller.signal);
  await entered;
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(fixture.store.getFofaQuota("task:a").resultsConsumed, 5);
  await Promise.all([runtime.close(), runtime.close("again")]);
  assert.equal(closeCalls, 1);
  await fixture.closeStores();
});

test("FOFA Runtime resume keeps SQLite quota and rejects a prior process cursor", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "fofa-runtime-resume-"));
  const databasePath = join(runtimeDir, "state.sqlite");
  const firstStore = new RuntimeStore(databasePath);
  const firstLog = new ExecutionLog(join(runtimeDir, "first.jsonl"), join(runtimeDir, "first-events.sqlite"));
  const firstRuntime = new FofaMcpRuntime({
    runRef: "run:resume",
    scope: parseAuthorizedScope("example.com"),
    config,
    runtimeStore: firstStore,
    executionLog: firstLog,
    clientFactory: async () => fakeConnection(async () => success({
      operation: "search",
      query: 'domain="example.com"',
      fields: ["host"],
      records: Array.from({ length: 90 }, (_, index) => ({
        fields: { host: `a${index}.example.com` },
        classification: "in_scope",
        active_testing_allowed: true
      })),
      returned: 90,
      nextProviderToken: "provider-token-must-stay-private"
    }))
  });
  const first = await firstRuntime.call("task:a", "fofa_search", {
    query: 'domain="example.com"', fields: ["host"], limit: 90, full: false
  });
  assert.doesNotMatch(first.cursor ?? "", /provider-token/);
  await firstRuntime.close();
  await firstLog.drain();
  firstLog.close();
  firstStore.close();

  const reopenedStore = new RuntimeStore(databasePath);
  const secondLog = new ExecutionLog(join(runtimeDir, "second.jsonl"), join(runtimeDir, "second-events.sqlite"));
  const secondRuntime = new FofaMcpRuntime({
    runRef: "run:resume",
    scope: parseAuthorizedScope("example.com"),
    config,
    runtimeStore: reopenedStore,
    executionLog: secondLog,
    clientFactory: async () => fakeConnection(async () => success({
      operation: "search_next", records: [], returned: 0
    }))
  });
  assert.deepEqual(reopenedStore.getFofaQuota("task:a"), {
    resultsConsumed: 90,
    aggregationsConsumed: 0
  });
  await assert.rejects(
    () => secondRuntime.call("task:a", "fofa_search_next", { cursor: first.cursor, limit: 10 }),
    /cursor.*unknown/i
  );
  assert.deepEqual(
    reopenedStore.reserveFofaQuota({ taskId: "task:a", kind: "results", amount: 10, limit: 100 }),
    { consumed: 100, remaining: 0 }
  );
  assert.throws(
    () => reopenedStore.reserveFofaQuota({ taskId: "task:a", kind: "results", amount: 1, limit: 100 }),
    /quota exhausted/
  );
  await secondRuntime.close();
  await secondLog.drain();
  secondLog.close();
  reopenedStore.close();
});

function runtimeFixture(): {
  store: RuntimeStore;
  log: ExecutionLog;
  create: (factory: FofaMcpClientFactory, now?: () => number) => FofaMcpRuntime;
  close: (runtime: FofaMcpRuntime) => Promise<void>;
  closeStores: () => Promise<void>;
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), "fofa-runtime-"));
  const store = new RuntimeStore(join(runtimeDir, "state.sqlite"));
  const log = new ExecutionLog(join(runtimeDir, "execution.jsonl"), join(runtimeDir, "events.sqlite"));
  const closeStores = async () => {
    await log.drain();
    log.close();
    store.close();
  };
  return {
    store,
    log,
    create: (clientFactory, now) => new FofaMcpRuntime({
      runRef: "run:1",
      scope: parseAuthorizedScope("example.com"),
      config,
      runtimeStore: store,
      executionLog: log,
      clientFactory,
      now
    }),
    close: async (runtime) => {
      await runtime.close();
      await closeStores();
    },
    closeStores
  };
}

function fakeConnection(
  call: (
    input: { name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>,
  onClose: () => void = () => undefined
): FofaMcpClientConnection {
  return {
    listTools: async () => ({ tools: [
      { name: "fofa_account_info" },
      { name: "fofa_host_aggregate" },
      { name: "fofa_search" },
      { name: "fofa_search_next" },
      { name: "fofa_stats" }
    ] }),
    callTool: call,
    close: async () => { onClose(); }
  };
}

function success(payload: Record<string, unknown>): {
  content: Array<{ type: string; text?: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
