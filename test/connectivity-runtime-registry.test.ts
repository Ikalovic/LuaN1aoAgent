import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  HistoricalConnectivityRuntimeRegistry,
  type HistoricalConnectivityRuntime
} from "../src/connectivity/connectivity-runtime-registry.js";

function fakeRuntime(): HistoricalConnectivityRuntime {
  return {
    routeStatus: async () => [],
    stopRoute: async () => { throw new Error("unused"); },
    reconnectRoute: async () => { throw new Error("unused"); },
    forgetRoute: async () => { throw new Error("unused"); },
    replayTraffic: async () => { throw new Error("unused"); }
  };
}

test("historical connectivity runtime registry creates one runtime per canonical directory", async () => {
  const root = await mkdtemp("/tmp/ln-history-runtime-");
  let creates = 0;
  let closes = 0;
  const runRefs: string[] = [];
  let releaseCreate: (() => void) | undefined;
  const createGate = new Promise<void>((resolveCreate) => { releaseCreate = resolveCreate; });
  const runtime = fakeRuntime();
  const registry = new HistoricalConnectivityRuntimeRegistry(async ({ runtimeDir, runRef }) => {
    creates += 1;
    assert.equal(runtimeDir, root);
    assert.match(runRef, /^[0-9a-f-]{36}$/);
    runRefs.push(runRef);
    await createGate;
    return { runtime, close: async () => { closes += 1; } };
  });
  try {
    const first = registry.get(root);
    const second = registry.get(join(root, "."));
    assert.equal(creates, 1);
    assert.equal(registry.has(root), true);
    releaseCreate?.();
    const firstFacade = await first;
    assert.equal(await second, firstFacade);
    assert.equal(await registry.getExisting(root), firstFacade);
    assert.deepEqual(await firstFacade.routeStatus(), []);
    await registry.close(root);
    assert.equal(closes, 1);
    assert.equal(registry.has(root), false);
    assert.deepEqual(await (await registry.get(root)).routeStatus(), []);
    assert.equal(creates, 2);
    assert.equal(new Set(runRefs).size, 1);
    await registry.close(root);
    assert.equal(closes, 2);
  } finally {
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed historical runtime creation is evicted and partially created resources are closed by the factory", async () => {
  const root = await mkdtemp("/tmp/ln-history-runtime-failure-");
  let attempts = 0;
  const runtime = fakeRuntime();
  const registry = new HistoricalConnectivityRuntimeRegistry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("startup failed");
    return { runtime, close: async () => undefined };
  });
  try {
    await assert.rejects(registry.get(root), /startup failed/);
    assert.equal(registry.has(root), false);
    assert.deepEqual(await (await registry.get(root)).routeStatus(), []);
    assert.equal(attempts, 2);
  } finally {
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing an in-flight historical runtime prevents it from escaping registry ownership", async () => {
  const root = await mkdtemp("/tmp/ln-history-runtime-close-");
  let releaseCreate: (() => void) | undefined;
  const createGate = new Promise<void>((resolveCreate) => { releaseCreate = resolveCreate; });
  let closes = 0;
  const registry = new HistoricalConnectivityRuntimeRegistry(async () => {
    await createGate;
    return { runtime: fakeRuntime(), close: async () => { closes += 1; } };
  });
  try {
    const loading = registry.get(root);
    const closing = registry.close(root);
    releaseCreate?.();
    await loading;
    await closing;
    assert.equal(closes, 1);
    assert.equal(registry.has(root), false);
  } finally {
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry shutdown rejects runtimes created after the shutdown snapshot", async () => {
  const root = await mkdtemp("/tmp/ln-history-runtime-shutdown-");
  const registry = new HistoricalConnectivityRuntimeRegistry(async () => ({
    runtime: fakeRuntime(),
    close: async () => undefined
  }));
  try {
    await registry.closeAll();
    await assert.rejects(registry.get(root), /registry is closing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical runtimes close after idle without interrupting active operations", async () => {
  const root = await mkdtemp("/tmp/ln-history-runtime-idle-");
  let releaseStatus: (() => void) | undefined;
  const statusGate = new Promise<void>((resolveStatus) => { releaseStatus = resolveStatus; });
  let closes = 0;
  const registry = new HistoricalConnectivityRuntimeRegistry(async () => ({
    runtime: {
      ...fakeRuntime(),
      routeStatus: async () => {
        await statusGate;
        return [];
      }
    },
    close: async () => { closes += 1; }
  }), 20);
  try {
    const runtime = await registry.get(root);
    const status = runtime.routeStatus();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.equal(registry.has(root), true);
    assert.equal(closes, 0);
    releaseStatus?.();
    await status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.equal(registry.has(root), false);
    assert.equal(closes, 1);
  } finally {
    releaseStatus?.();
    await registry.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
