import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConnectivityRuntime,
  ConnectivityRuntimeOwnershipError
} from "../src/connectivity/connectivity-runtime.js";
import { MitmFlowClient } from "../src/connectivity/mitm-flow-client.js";
import type { NetworkSandboxManager, TaskGateway } from "../src/connectivity/network-sandbox-manager.js";
import type { ReplayGatewayRuntime } from "../src/connectivity/replay-gateway-runtime.js";
import type { RouteManager, RouteStatus } from "../src/connectivity/route-manager.js";
import type { ArtifactStore } from "../src/stores/artifact-store.js";
import type { ExecutionLog } from "../src/stores/execution-log.js";

test("ConnectivityRuntime owns startup, task serialization, and non-destructive shutdown", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let gatewayCalls = 0;
  const network = {
    start: async () => { calls.push("network.start"); },
    createGateway: async ({ taskId, epochId }: { taskId: string; epochId: string }): Promise<TaskGateway> => {
      gatewayCalls += 1;
      calls.push(`gateway.begin:${epochId}`);
      if (gatewayCalls === 1) {
        markFirstStarted();
        await firstPending;
      }
      return {
        taskId,
        epochId,
        containerName: "gateway",
        networkName: "task-network",
        gatewayAddress: "172.30.0.2",
        dnsAddress: "172.30.0.2",
        flowFile: `${epochId}.mitm`,
        netFile: `${epochId}.net.jsonl`
      };
    },
    endEpoch: async () => undefined,
    disposeGateway: async () => undefined,
    close: async () => { calls.push("network.close"); }
  } as unknown as NetworkSandboxManager;
  const routes = {
    restore: async () => { calls.push("routes.restore"); },
    recoverDesired: async () => { calls.push("routes.recoverDesired"); return []; },
    stopAll: async () => { calls.push("routes.stopAll"); },
    snapshotForProjection: () => [],
    capabilityRefsForTask: (taskId: string) => taskId === "task:a" ? ["route:a", "connection:a"] : []
  } as unknown as RouteManager;
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network,
    routes
  });

  const first = runtime.beginTaskEpoch({ taskId: "task:a", epochId: "epoch:1" });
  const second = runtime.beginTaskEpoch({ taskId: "task:a", epochId: "epoch:2" });
  await firstStarted;
  assert.equal(gatewayCalls, 1);
  releaseFirst();
  assert.equal((await first).epochId, "epoch:1");
  assert.equal((await second).epochId, "epoch:2");

  await runtime.close();
  assert.deepEqual(calls.slice(0, 2), ["network.start", "routes.restore"]);
  assert.ok(calls.indexOf("routes.restore") < calls.indexOf("routes.recoverDesired"));
  assert.equal(calls.filter((value) => value === "network.start").length, 1);
  assert.ok(calls.indexOf("routes.stopAll") < calls.indexOf("network.close"));
  assert.deepEqual(runtime.capabilityRefsForTask("task:a"), ["route:a", "connection:a"]);
});

test("historical runtime shutdown suspends connectors without clearing reconnect intent", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const calls: string[] = [];
  const network = {
    start: async () => undefined,
    close: async () => { calls.push("network.close"); }
  } as unknown as NetworkSandboxManager;
  const routes = {
    restore: async () => undefined,
    recoverDesired: async () => [],
    suspendAll: async () => { calls.push("routes.suspendAll"); },
    stopAll: async () => { calls.push("routes.stopAll"); }
  } as unknown as RouteManager;
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network,
    routes
  });

  await runtime.start();
  await runtime.close({ preserveDesiredRoutes: true });

  assert.deepEqual(calls, ["routes.suspendAll", "network.close"]);
});

test("Executor route controls cannot observe or mutate the operator transparent proxy", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const proxy = {
    routeRef: "route:proxy", connectorRef: "connector:proxy", connector: "socks5",
    pivotHostRef: "proxy.example", targetCidrs: ["0.0.0.0/0"], desiredState: "running",
    status: "live", lastHeartbeat: "2026-07-30T00:00:00.000Z"
  } satisfies RouteStatus;
  const ssh = {
    routeRef: "route:ssh", connectorRef: "connector:ssh", connector: "ssh",
    pivotHostRef: "host:pivot", targetCidrs: ["10.0.0.0/24"], desiredState: "running",
    status: "live", lastHeartbeat: "2026-07-30T00:00:00.000Z"
  } satisfies RouteStatus;
  const calls: string[] = [];
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network: {
      start: async () => undefined,
      close: async () => undefined
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => undefined,
      recoverDesired: async () => [],
      status: async (routeRef?: string) => routeRef === proxy.routeRef ? [proxy] : routeRef === ssh.routeRef ? [ssh] : [proxy, ssh],
      isTransparentProxyRoute: (routeRef: string) => routeRef === proxy.routeRef,
      stop: async (routeRef: string) => { calls.push(`stop:${routeRef}`); return ssh; },
      reconnect: async (routeRef: string) => { calls.push(`reconnect:${routeRef}`); return ssh; },
      stopAll: async () => undefined
    } as unknown as RouteManager
  });

  assert.deepEqual((await runtime.executorRouteStatus()).map((route) => route.routeRef), [ssh.routeRef]);
  assert.deepEqual(await runtime.executorRouteStatus(proxy.routeRef), []);
  await assert.rejects(() => runtime.executorStopRoute(proxy.routeRef), /operator-managed/);
  await assert.rejects(() => runtime.executorReconnectRoute(proxy.routeRef), /operator-managed/);
  assert.equal((await runtime.executorStopRoute(ssh.routeRef)).routeRef, ssh.routeRef);
  assert.equal((await runtime.executorReconnectRoute(ssh.routeRef)).routeRef, ssh.routeRef);
  assert.deepEqual(calls, ["stop:route:ssh", "reconnect:route:ssh"]);
  await runtime.close();
});

test("runtime shutdown drains active flow-index readers before network cleanup", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const trafficRoot = join(runtimeDir, "traffic");
  const token = "b".repeat(64);
  await mkdir(trafficRoot, { recursive: true });
  await writeFile(join(trafficRoot, "index.json"), JSON.stringify({
    url: "http://127.0.0.1:45678",
    token
  }));
  const calls: string[] = [];
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network: {
      start: async () => { calls.push("network.start"); },
      close: async () => { calls.push("network.close"); }
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => undefined,
      recoverDesired: async () => [],
      stopAll: async () => { calls.push("routes.stopAll"); }
    } as unknown as RouteManager
  });
  let markReadStarted: (() => void) | undefined;
  let releaseRead: (() => void) | undefined;
  const readStarted = new Promise<void>((resolveStarted) => { markReadStarted = resolveStarted; });
  const readGate = new Promise<void>((resolveRead) => { releaseRead = resolveRead; });
  let historyRequests = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/health")) return Response.json({ status: "ok" });
    historyRequests += 1;
    markReadStarted?.();
    await readGate;
    return Response.json({ records: [{ id: "flow:active" }], has_more: false });
  }) as typeof fetch;

  await runtime.start();
  const client = await MitmFlowClient.open(runtimeDir, { fetcher });
  const reading = client.historyList();
  await readStarted;
  const closing = runtime.close();
  await Promise.resolve();
  assert.equal(calls.includes("network.close"), false);
  await assert.rejects(
    client.historyGet("flow:late"),
    (error: unknown) => error instanceof ConnectivityRuntimeOwnershipError
  );
  assert.equal(historyRequests, 1);
  releaseRead?.();
  assert.equal((await reading).items[0]?.id, "flow:active");
  await closing;
  assert.ok(calls.indexOf("routes.stopAll") < calls.indexOf("network.close"));
});

test("ConnectivityRuntime lazily owns replay, serializes it with routes, and closes it before network", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const calls: string[] = [];
  let releaseReplay!: () => void;
  const replayGate = new Promise<void>((resolveReplay) => { releaseReplay = resolveReplay; });
  let replayFactories = 0;
  const routeSnapshot = [{
    routeRef: "route:test",
    cidr: "172.31.0.0/24",
    prefixLength: 24,
    socksHost: "172.30.0.2",
    socksPort: 22000
  }];
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network: {
      runtimeDir,
      networkName: "luanniao-net-test",
      image: "luanniao-network:test",
      start: async () => { calls.push("network.start"); },
      routeSnapshot: () => routeSnapshot,
      close: async () => { calls.push("network.close"); }
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => { calls.push("routes.restore"); },
      recoverDesired: async () => [],
      stop: async () => { calls.push("routes.stop"); return {} as never; },
      stopAll: async () => { calls.push("routes.stopAll"); }
    } as unknown as RouteManager,
    replayGatewayFactory: () => {
      replayFactories += 1;
      return {
        replay: async (_client, _input, routes) => {
          calls.push(`replay:${routes.map((route) => route.routeRef).join(",")}`);
          await replayGate;
          return { exchange_id: "flow:replayed", replay_of: "flow:source", status: 200 };
        },
        close: async () => { calls.push("replay.close"); }
      } as ReplayGatewayRuntime;
    }
  });

  await runtime.start();
  assert.equal(replayFactories, 0);
  const replay = runtime.replayTraffic({} as MitmFlowClient, {
    flowRef: "flow:source",
    method: "GET",
    url: "http://172.31.0.20/",
    headers: [],
    routeRef: "route:test",
    context: {
      runtime_ref: "run:test",
      task_ref: "task:test",
      run_ref: "run:test",
      attribution: "web-user:test",
      route_ref: "route:test",
      session_ref: "connection:test"
    }
  });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const stopped = runtime.stopRoute("route:test");
  assert.equal(calls.includes("routes.stop"), false);
  releaseReplay();
  assert.equal((await replay).exchange_id, "flow:replayed");
  await stopped;
  assert.equal(replayFactories, 1);

  await runtime.close();
  assert.ok(calls.indexOf("replay.close") < calls.indexOf("routes.stopAll"));
  assert.ok(calls.indexOf("replay.close") < calls.indexOf("network.close"));
  assert.deepEqual(calls.filter((call) => call.startsWith("replay:")), ["replay:route:test"]);
});

test("historical runtime defers connector and route restore until a route operation", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const calls: string[] = [];
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    recoverDesiredRoutesOnStart: false,
    lazyRoutes: true,
    network: {
      start: async (options?: { connector?: boolean }) => {
        calls.push(options?.connector === false ? "network.start:base" : "network.start:connector");
      },
      close: async () => { calls.push("network.close"); }
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => { calls.push("routes.restore"); },
      recoverDesired: async () => { calls.push("routes.recoverDesired"); return []; },
      status: async () => { calls.push("routes.status"); return []; },
      suspendAll: async () => { calls.push("routes.suspendAll"); }
    } as unknown as RouteManager
  });

  await runtime.start();
  assert.deepEqual(calls, ["network.start:base"]);
  assert.deepEqual(await runtime.routeStatus(), []);
  assert.deepEqual(await runtime.routeStatus(), []);
  await runtime.close({ preserveDesiredRoutes: true });

  assert.deepEqual(calls, [
    "network.start:base",
    "network.start:connector",
    "routes.restore",
    "routes.status",
    "routes.status",
    "routes.suspendAll",
    "network.close"
  ]);
});

test("historical direct replay never initializes connector or routes", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const calls: string[] = [];
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:history-direct",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    recoverDesiredRoutesOnStart: false,
    lazyRoutes: true,
    network: {
      runtimeDir,
      networkName: "luanniao-net-history",
      image: "luanniao-network:test",
      start: async (options?: { connector?: boolean }) => {
        calls.push(options?.connector === false ? "network.start:base" : "network.start:connector");
      },
      routeSnapshot: () => { throw new Error("direct replay must not read routes"); },
      close: async () => { calls.push("network.close"); }
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => { calls.push("routes.restore"); },
      suspendAll: async () => { calls.push("routes.suspendAll"); }
    } as unknown as RouteManager,
    replayGatewayFactory: () => ({
      replay: async (_client, _input, routes) => {
        assert.deepEqual(routes, []);
        calls.push("replay");
        return { exchange_id: "flow:direct", replay_of: "flow:source", status: 200 };
      },
      close: async () => { calls.push("replay.close"); }
    }) as ReplayGatewayRuntime
  });

  await runtime.start();
  const result = await runtime.replayTraffic({} as MitmFlowClient, {
    flowRef: "flow:source",
    method: "GET",
    url: "https://example.test/",
    headers: [],
    context: {
      runtime_ref: "run:history-direct",
      task_ref: "task:history",
      run_ref: "run:history-direct",
      attribution: "web-user:test",
      route_ref: "",
      session_ref: ""
    }
  });
  assert.equal(result.exchange_id, "flow:direct");
  await runtime.close({ preserveDesiredRoutes: true });

  assert.deepEqual(calls, ["network.start:base", "replay", "replay.close", "network.close"]);
});

test("runtime shutdown retries only unfinished cleanup stages after a transient failure", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const calls: string[] = [];
  let networkCloseAttempts = 0;
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network: {
      start: async () => undefined,
      close: async () => {
        networkCloseAttempts += 1;
        calls.push(`network.close:${networkCloseAttempts}`);
        if (networkCloseAttempts === 1) throw new Error("transient network cleanup failure");
      }
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => undefined,
      recoverDesired: async () => [],
      suspendAll: async () => { calls.push("routes.suspendAll"); }
    } as unknown as RouteManager
  });

  await runtime.start();
  await assert.rejects(runtime.close({ preserveDesiredRoutes: true }), /Connectivity runtime cleanup failed/);
  assert.deepEqual(calls, ["routes.suspendAll", "network.close:1"]);
  assert.equal((await readLeaseRecord(runtimeDir)).pid, process.pid);

  await runtime.close({ preserveDesiredRoutes: true });
  assert.deepEqual(calls, ["routes.suspendAll", "network.close:1", "network.close:2"]);
  await assert.rejects(stat(join(runtimeDir, ".connectivity-runtime-owner")), { code: "ENOENT" });
});

test("a second runtime fails closed before touching resources and cannot clean up the owner", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const ownerCalls: string[] = [];
  const contenderCalls: string[] = [];
  const owner = runtimeWithCalls(runtimeDir, ownerCalls);
  const contender = runtimeWithCalls(runtimeDir, contenderCalls);

  await owner.start();
  await assert.rejects(contender.start(), (error: unknown) => (
    error instanceof ConnectivityRuntimeOwnershipError
      && error.code === "connectivity_runtime_owned"
      && error.ownerPid === process.pid
  ));
  assert.deepEqual(contenderCalls, []);

  await contender.close();
  assert.deepEqual(contenderCalls, []);
  assert.equal((await readLeaseRecord(runtimeDir)).pid, process.pid);

  await owner.close();
  assert.deepEqual(ownerCalls, ["network.start", "routes.restore", "routes.recoverDesired", "routes.stopAll", "network.close"]);
  await assert.rejects(stat(join(runtimeDir, ".connectivity-runtime-owner")), { code: "ENOENT" });
});

test("a dead process lease is atomically reclaimed", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const leaseDir = join(runtimeDir, ".connectivity-runtime-owner");
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(join(leaseDir, "owner.json"), JSON.stringify({
    version: 1,
    token: "stale-owner",
    pid: 2_147_483_647,
    acquiredAt: "2026-01-01T00:00:00.000Z"
  }));
  const calls: string[] = [];
  const runtime = runtimeWithCalls(runtimeDir, calls);

  await runtime.start();
  const current = await readLeaseRecord(runtimeDir);
  assert.equal(current.pid, process.pid);
  assert.notEqual(current.token, "stale-owner");
  assert.deepEqual(calls, ["network.start", "routes.restore", "routes.recoverDesired"]);
  assert.equal((await readdir(runtimeDir)).some((entry) => entry.startsWith(".connectivity-runtime-owner.stale-")), false);

  await runtime.close();
  await assert.rejects(stat(leaseDir), { code: "ENOENT" });
});

test("a reused pid with a different process start identity does not retain ownership", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const leaseDir = join(runtimeDir, ".connectivity-runtime-owner");
  await mkdir(leaseDir, { mode: 0o700 });
  const now = new Date().toISOString();
  await writeFile(join(leaseDir, "owner.json"), JSON.stringify({
    version: 2,
    token: "reused-pid-owner",
    pid: process.pid,
    acquiredAt: now,
    heartbeatAt: now,
    processStartIdentity: "different-process-start"
  }));
  const calls: string[] = [];
  const runtime = runtimeWithCalls(runtimeDir, calls);

  await runtime.start();
  const current = await readLeaseRecord(runtimeDir);
  assert.equal(current.pid, process.pid);
  assert.notEqual(current.token, "reused-pid-owner");
  assert.equal(current.version, 2);
  assert.deepEqual(calls, ["network.start", "routes.restore", "routes.recoverDesired"]);

  await runtime.close();
});

test("an expired heartbeat does not let a live pid retain stale ownership", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const leaseDir = join(runtimeDir, ".connectivity-runtime-owner");
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(join(leaseDir, "owner.json"), JSON.stringify({
    version: 2,
    token: "expired-heartbeat-owner",
    pid: process.pid,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z"
  }));
  const calls: string[] = [];
  const runtime = runtimeWithCalls(runtimeDir, calls);

  await runtime.start();
  assert.notEqual((await readLeaseRecord(runtimeDir)).token, "expired-heartbeat-owner");
  assert.deepEqual(calls, ["network.start", "routes.restore", "routes.recoverDesired"]);

  await runtime.close();
});

test("an interrupted reclaim tombstone never blocks a fresh owner", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const tombstone = join(runtimeDir, ".connectivity-runtime-owner.stale-interrupted");
  await mkdir(tombstone, { mode: 0o700 });
  await writeFile(join(tombstone, "owner.json"), JSON.stringify({
    version: 1,
    token: "interrupted-owner",
    pid: 2_147_483_647,
    acquiredAt: "2026-01-01T00:00:00.000Z"
  }));
  const calls: string[] = [];
  const runtime = runtimeWithCalls(runtimeDir, calls);

  await runtime.start();
  assert.equal((await readLeaseRecord(runtimeDir)).pid, process.pid);
  assert.deepEqual(calls, ["network.start", "routes.restore", "routes.recoverDesired"]);
  await runtime.close();
  assert.equal((await stat(tombstone)).isDirectory(), true);
});

test("startup failure releases only its lease so another runtime can start", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const failedCalls: string[] = [];
  const failed = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:failed",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network: {
      start: async () => { failedCalls.push("network.start"); throw new Error("network failed"); },
      close: async () => { failedCalls.push("network.close"); }
    } as unknown as NetworkSandboxManager,
    routes: {} as RouteManager
  });

  await assert.rejects(failed.start(), /network failed/);
  assert.deepEqual(failedCalls, ["network.start", "network.close"]);
  await assert.rejects(stat(join(runtimeDir, ".connectivity-runtime-owner")), { code: "ENOENT" });
  await failed.disposeTask("task:failed");
  assert.deepEqual(failedCalls, ["network.start", "network.close"]);

  const successorCalls: string[] = [];
  const successor = runtimeWithCalls(runtimeDir, successorCalls);
  await successor.start();
  await failed.close();
  assert.deepEqual(failedCalls, ["network.start", "network.close"]);
  await successor.close();
});

test("runtime whose token was replaced rejects every public resource operation and preserves the new owner", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const calls: string[] = [];
  let replayFactories = 0;
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network: {
      start: async () => { calls.push("network.start"); },
      createGateway: async () => {
        calls.push("network.createGateway");
        return {} as TaskGateway;
      },
      routeSnapshot: () => {
        calls.push("network.routeSnapshot");
        return [];
      },
      close: async () => { calls.push("network.close"); }
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => { calls.push("routes.restore"); },
      recoverDesired: async () => { calls.push("routes.recoverDesired"); return []; },
      status: async () => { calls.push("routes.status"); return []; },
      open: async () => { calls.push("routes.open"); return {} as never; },
      stopAll: async () => { calls.push("routes.stopAll"); }
    } as unknown as RouteManager,
    replayGatewayFactory: () => {
      replayFactories += 1;
      return {} as ReplayGatewayRuntime;
    }
  });
  await runtime.start();
  const startupCalls = [...calls];

  const leasePath = join(runtimeDir, ".connectivity-runtime-owner", "owner.json");
  await writeFile(leasePath, JSON.stringify({
    version: 1,
    token: "replacement-owner",
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  }));

  const rejectsLostOwnership = (operation: Promise<unknown>): Promise<void> => assert.rejects(
    operation,
    (error: unknown) => error instanceof ConnectivityRuntimeOwnershipError
      && error.code === "connectivity_runtime_owned"
  );
  await rejectsLostOwnership(runtime.routeStatus());
  await rejectsLostOwnership(runtime.openRoute({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:credential",
    options: { user: "ops" }
  }, "task:test"));
  await rejectsLostOwnership(runtime.replayTraffic({} as MitmFlowClient, {
    flowRef: "flow:source",
    method: "GET",
    url: "https://example.test/",
    headers: [],
    context: {
      runtime_ref: "run:test",
      task_ref: "task:test",
      run_ref: "run:test",
      attribution: "web-user:test",
      route_ref: "",
      session_ref: ""
    }
  }));
  await rejectsLostOwnership(runtime.beginTaskEpoch({ taskId: "task:test", epochId: "epoch:test" }));
  await runtime.close();

  assert.deepEqual(calls, startupCalls);
  assert.equal(replayFactories, 0);
  assert.equal((await readLeaseRecord(runtimeDir)).token, "replacement-owner");
});

test("runtime health loop restores desired routes with bounded retry backoff", async (context) => {
  const runtimeDir = await temporaryRuntimeDir(context);
  const calls: string[] = [];
  let reconnectAttempts = 0;
  let status: "live" | "stale" = "stale";
  const runtime = new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:health",
    artifactStore: {} as ArtifactStore,
    executionLog: { append: async () => ({}) } as unknown as ExecutionLog,
    recoverDesiredRoutesOnStart: false,
    maintainDesiredRoutes: true,
    routeHealthIntervalMs: 5,
    routeReconnectBaseDelayMs: 10,
    routeReconnectMaxDelayMs: 20,
    network: {
      start: async () => undefined,
      close: async () => undefined
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => undefined,
      status: async () => [{
        routeRef: "route:recover",
        connectorRef: "connector:recover",
        connector: "ssh",
        pivotHostRef: "host:dmz",
        targetCidrs: ["172.31.0.0/24"],
        desiredState: "running",
        status,
        lastHeartbeat: new Date().toISOString()
      }],
      reconnect: async () => {
        reconnectAttempts += 1;
        calls.push(`reconnect:${reconnectAttempts}`);
        if (reconnectAttempts === 1) throw new Error("transient failure");
        status = "live";
        return {
          routeRef: "route:recover",
          connectorRef: "connector:recover",
          connector: "ssh",
          pivotHostRef: "host:dmz",
          targetCidrs: ["172.31.0.0/24"],
          desiredState: "running",
          status,
          lastHeartbeat: new Date().toISOString()
        };
      },
      stopAll: async () => undefined
    } as unknown as RouteManager
  });

  await runtime.start();
  await waitFor(() => reconnectAttempts === 2);
  assert.deepEqual(calls, ["reconnect:1", "reconnect:2"]);
  await runtime.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reconnectAttempts, 2);
});

async function temporaryRuntimeDir(context: { after(callback: () => Promise<void>): void }): Promise<string> {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-connectivity-runtime-"));
  context.after(() => rm(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function runtimeWithCalls(runtimeDir: string, calls: string[]): ConnectivityRuntime {
  return new ConnectivityRuntime({
    runtimeDir,
    runRef: "run:test",
    artifactStore: {} as ArtifactStore,
    executionLog: {} as ExecutionLog,
    network: {
      start: async () => { calls.push("network.start"); },
      close: async () => { calls.push("network.close"); }
    } as unknown as NetworkSandboxManager,
    routes: {
      restore: async () => { calls.push("routes.restore"); },
      recoverDesired: async () => { calls.push("routes.recoverDesired"); return []; },
      stopAll: async () => { calls.push("routes.stopAll"); }
    } as unknown as RouteManager
  });
}

async function readLeaseRecord(runtimeDir: string): Promise<{ token: string; pid: number; version?: number }> {
  return JSON.parse(await readFile(join(runtimeDir, ".connectivity-runtime-owner", "owner.json"), "utf8")) as {
    token: string;
    pid: number;
    version?: number;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
