import assert from "node:assert/strict";
import test from "node:test";
import { SecurityAgentController } from "../src/controller.js";
import type { RouteStatus } from "../src/connectivity/route-manager.js";

const route: RouteStatus = {
  routeRef: "route:test",
  connectorRef: "connector:test",
  connector: "ssh",
  pivotHostRef: "host:dmz",
  dialAddress: "10.0.0.5",
  targetCidrs: ["172.31.0.0/24"],
  desiredState: "running",
  status: "live",
  lastHeartbeat: "2026-07-26T00:00:00.000Z",
  connectionRef: "connection:test"
};

test("Controller exposes the active ConnectivityRuntime without creating another owner", async () => {
  const calls: string[] = [];
  const runtime = {
    routeStatus: async (routeRef?: string) => {
      calls.push(`status:${routeRef ?? "all"}`);
      return [route];
    },
    stopRoute: async (routeRef: string) => {
      calls.push(`stop:${routeRef}`);
      return { ...route, desiredState: "stopped" as const, status: "stale" as const };
    },
    reconnectRoute: async (routeRef: string) => {
      calls.push(`reconnect:${routeRef}`);
      return route;
    },
    forgetRoute: async (routeRef: string) => {
      calls.push(`forget:${routeRef}`);
      return { ...route, desiredState: "closed" as const, status: "closed" as const };
    },
    replayTraffic: async () => {
      calls.push("replay");
      return { exchange_id: "flow:replayed", replay_of: "flow:source", status: 200 };
    }
  };
  const controller = Object.create(SecurityAgentController.prototype) as SecurityAgentController;
  (controller as unknown as { connectivityRuntime?: typeof runtime }).connectivityRuntime = runtime;

  assert.equal(controller.hasConnectivityRuntime(), true);
  assert.deepEqual(await controller.routeStatus(), [route]);
  assert.equal((await controller.routeStop(route.routeRef)).desiredState, "stopped");
  assert.equal((await controller.routeReconnect(route.routeRef)).status, "live");
  assert.equal((await controller.routeForget(route.routeRef)).status, "closed");
  assert.equal((await controller.replayTraffic({} as never, {
    flowRef: "flow:source",
    method: "GET",
    url: "http://172.31.0.20/",
    headers: [],
    routeRef: route.routeRef,
    context: {
      runtime_ref: "run:test",
      task_ref: "task:test",
      run_ref: "run:test",
      attribution: "web-user:test",
      route_ref: route.routeRef,
      session_ref: "connection:test"
    }
  })).exchange_id, "flow:replayed");
  assert.deepEqual(calls, [
    "status:all",
    "stop:route:test",
    "reconnect:route:test",
    "forget:route:test",
    "replay"
  ]);

  delete (controller as unknown as { connectivityRuntime?: typeof runtime }).connectivityRuntime;
  assert.equal(controller.hasConnectivityRuntime(), false);
  assert.throws(() => controller.routeStatus(), /Connectivity runtime is unavailable/);
});

test("route_open does not wait for asynchronous Host projection", async () => {
  const calls: Array<{ pivotHostRef: string; ownerTaskId: string }> = [];
  const runtime = {
    openRoute: async (input: { pivotHostRef: string }, ownerTaskId: string) => {
      calls.push({ pivotHostRef: input.pivotHostRef, ownerTaskId });
      return route;
    },
    routeStatus: async () => [route],
    stopRoute: async () => route,
    reconnectRoute: async () => route
  };
  const controller = Object.create(SecurityAgentController.prototype) as SecurityAgentController;
  (controller as unknown as { connectivityRuntime?: typeof runtime }).connectivityRuntime = runtime;
  const tools = (controller as unknown as {
    createTaskConnectivityTools(taskId: string): Array<{
      name: string;
      execute(toolCallId: string, params: Record<string, unknown>): Promise<{ details: RouteStatus }>;
    }>;
  }).createTaskConnectivityTools("task:pivot");
  const open = tools.find((tool) => tool.name === "route_open");
  assert.ok(open);

  const result = await open.execute("call:route", {
    connector: "ssh",
    pivotHostRef: "192.0.2.10",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:key",
    options: { user: "ops" }
  });

  assert.equal(result.details.routeRef, route.routeRef);
  assert.deepEqual(calls, [{ pivotHostRef: "192.0.2.10", ownerTaskId: "task:pivot" }]);
});

test("Controller quiesces the Executor before accepting the gateway drain acknowledgement", async () => {
  const calls: string[] = [];
  const sandbox = {
    quiesce: async () => { calls.push("executor.quiesce"); },
    dispose: async () => { calls.push("executor.dispose"); }
  };
  const controller = Object.create(SecurityAgentController.prototype) as SecurityAgentController;
  const harness = controller as unknown as {
    taskExecutorSandboxes: Map<string, typeof sandbox>;
    connectivityRuntime: {
      endTaskEpoch(input: { taskId: string; epochId: string }): Promise<Record<string, unknown>>;
    };
    executionLog: { append(event: { eventType: string }): Promise<void> };
    endExecutorNetworkEpoch(state: Record<string, unknown>): Promise<void>;
  };
  harness.taskExecutorSandboxes = new Map([["task:drain", sandbox]]);
  harness.connectivityRuntime = {
    endTaskEpoch: async () => {
      calls.push("gateway.epoch.end");
      return gatewayDrainAck("epoch:drain");
    }
  };
  harness.executionLog = {
    append: async (event) => { calls.push(`log:${event.eventType}`); }
  };

  await harness.endExecutorNetworkEpoch({
    epochId: "epoch:drain",
    taskEnvelope: { taskId: "task:drain" }
  });

  assert.deepEqual(calls, [
    "executor.quiesce",
    "gateway.epoch.end",
    "log:network_epoch_flushed"
  ]);
  assert.equal(harness.taskExecutorSandboxes.get("task:drain"), sandbox);
});

test("Controller surfaces a failed gateway drain and retains the stopped Executor for retry", async () => {
  const calls: string[] = [];
  const sandbox = {
    quiesce: async () => { calls.push("executor.quiesce"); },
    dispose: async () => { calls.push("executor.dispose"); }
  };
  const controller = Object.create(SecurityAgentController.prototype) as SecurityAgentController;
  const harness = controller as unknown as {
    taskExecutorSandboxes: Map<string, typeof sandbox>;
    connectivityRuntime: {
      endTaskEpoch(input: { taskId: string; epochId: string }): Promise<Record<string, unknown>>;
    };
    executionLog: { append(event: { eventType: string }): Promise<void> };
    endExecutorNetworkEpoch(state: Record<string, unknown>): Promise<void>;
  };
  harness.taskExecutorSandboxes = new Map([["task:retry-drain", sandbox]]);
  harness.connectivityRuntime = {
    endTaskEpoch: async () => {
      calls.push("gateway.epoch.end");
      throw new Error("capture drain timed out");
    }
  };
  harness.executionLog = {
    append: async (event) => { calls.push(`log:${event.eventType}`); }
  };
  const state = {
    epochId: "epoch:retry-drain",
    taskEnvelope: { taskId: "task:retry-drain" },
    terminationFailure: undefined as string | undefined
  };

  await assert.rejects(
    harness.endExecutorNetworkEpoch(state),
    /capture drain timed out/
  );

  assert.deepEqual(calls, [
    "executor.quiesce",
    "gateway.epoch.end",
    "log:network_epoch_flush_failed"
  ]);
  assert.equal(state.terminationFailure, "capture drain timed out");
  assert.equal(harness.taskExecutorSandboxes.get("task:retry-drain"), sandbox);
  assert.equal(calls.includes("executor.dispose"), false);
});

test("Controller close retains a failed task sandbox handle and retries it", async () => {
  let sandboxDisposeAttempts = 0;
  let runtimeDisposeAttempts = 0;
  let runtimeCloseAttempts = 0;
  const sandbox = {
    dispose: async () => {
      sandboxDisposeAttempts += 1;
      if (sandboxDisposeAttempts === 1) throw new Error("transient executor cleanup failure");
    }
  };
  const runtime = {
    disposeTask: async () => { runtimeDisposeAttempts += 1; },
    close: async () => { runtimeCloseAttempts += 1; }
  };
  const fixture = createControllerCloseFixture({
    taskSandboxes: new Map([["task:retry", sandbox]]),
    connectivityRuntime: runtime
  });

  await assert.rejects(fixture.controller.close(), /Controller executor resource cleanup failed/);
  assert.equal(fixture.taskSandboxes.get("task:retry"), sandbox);
  assert.equal(fixture.connectivityRuntime(), runtime);
  assert.equal(fixture.connectivityStoreCloseCount(), 0);
  assert.equal(fixture.graphStoreCloseCount(), 0);

  await fixture.controller.close();
  assert.equal(fixture.taskSandboxes.has("task:retry"), false);
  assert.equal(fixture.connectivityRuntime(), undefined);
  assert.equal(sandboxDisposeAttempts, 2);
  assert.equal(runtimeDisposeAttempts, 1);
  assert.equal(runtimeCloseAttempts, 1);
  assert.equal(fixture.connectivityStoreCloseCount(), 1);
  assert.equal(fixture.graphStoreCloseCount(), 1);
  assert.ok(fixture.loggedEventTypes().includes("executor_task_cleanup_failed"));
});

test("Controller close surfaces ConnectivityRuntime cleanup failure and retries before closing stores", async () => {
  let runtimeCloseAttempts = 0;
  const runtime = {
    disposeTask: async () => undefined,
    close: async () => {
      runtimeCloseAttempts += 1;
      if (runtimeCloseAttempts === 1) throw new Error("transient connectivity cleanup failure");
    }
  };
  const fixture = createControllerCloseFixture({ connectivityRuntime: runtime });

  await assert.rejects(fixture.controller.close(), /Controller executor resource cleanup failed/);
  assert.equal(fixture.connectivityRuntime(), runtime);
  assert.equal(fixture.connectivityStoreCloseCount(), 0);
  assert.equal(fixture.graphStoreCloseCount(), 0);

  await fixture.controller.close();
  assert.equal(runtimeCloseAttempts, 2);
  assert.equal(fixture.connectivityRuntime(), undefined);
  assert.equal(fixture.connectivityStoreCloseCount(), 1);
  assert.equal(fixture.graphStoreCloseCount(), 1);
  assert.ok(fixture.loggedEventTypes().includes("connectivity_runtime_cleanup_failed"));
});

function createControllerCloseFixture(input: {
  taskSandboxes?: Map<string, { dispose(): Promise<void> }>;
  connectivityRuntime?: { disposeTask(taskId: string): Promise<void>; close(): Promise<void> };
}): {
  controller: SecurityAgentController;
  taskSandboxes: Map<string, { dispose(): Promise<void> }>;
  connectivityRuntime: () => unknown;
  connectivityStoreCloseCount: () => number;
  graphStoreCloseCount: () => number;
  loggedEventTypes: () => string[];
} {
  const controller = Object.create(SecurityAgentController.prototype) as SecurityAgentController;
  const taskSandboxes = input.taskSandboxes ?? new Map<string, { dispose(): Promise<void> }>();
  const loggedEventTypes: string[] = [];
  let connectivityStoreCloseCount = 0;
  let graphStoreCloseCount = 0;
  const harness = controller as unknown as {
    graphStoreClosed: boolean;
    invocationAbortController: AbortController;
    activeEpochs: Map<string, unknown>;
    activeTaskRuns: Map<string, unknown>;
    projectionRequestsClosed: boolean;
    pendingSupervisorRequests: Map<string, unknown>;
    activeSupervisorSessions: Set<unknown>;
    activePlannerSessions: Set<unknown>;
    supervisorInFlight: Map<string, Promise<unknown>>;
    projectionCancellationRequested: boolean;
    projectorInvocationAbortController: AbortController;
    projectorCoordinator: {
      close(): Promise<{ drained: boolean; pendingTaskIds: string[] }>;
      waitForSettled(): Promise<boolean>;
    };
    activeProjectionJobCount: number;
    taskExecutorSandboxes: Map<string, { dispose(): Promise<void> }>;
    executorSandbox?: unknown;
    connectivityRuntime?: { disposeTask(taskId: string): Promise<void>; close(): Promise<void> };
    connectivityStore?: { close(): void };
    executionLog: {
      append(event: { eventType: string }): Promise<void>;
      drain(): Promise<void>;
      close(): void;
    };
    graphStore: { close(): void };
    runtimeStore: { close(): void };
    artifactStore: { close(): void };
  };
  Object.assign(harness, {
    graphStoreClosed: false,
    invocationAbortController: new AbortController(),
    activeEpochs: new Map(),
    activeTaskRuns: new Map(),
    projectionRequestsClosed: false,
    pendingSupervisorRequests: new Map(),
    activeSupervisorSessions: new Set(),
    activePlannerSessions: new Set(),
    supervisorInFlight: new Map(),
    projectionCancellationRequested: false,
    projectorInvocationAbortController: new AbortController(),
    projectorCoordinator: {
      close: async () => ({ drained: true, pendingTaskIds: [] }),
      waitForSettled: async () => true
    },
    activeProjectionJobCount: 0,
    taskExecutorSandboxes: taskSandboxes,
    connectivityRuntime: input.connectivityRuntime,
    connectivityStore: { close: () => { connectivityStoreCloseCount += 1; } },
    executionLog: {
      append: async (event: { eventType: string }) => { loggedEventTypes.push(event.eventType); },
      drain: async () => undefined,
      close: () => undefined
    },
    graphStore: { close: () => { graphStoreCloseCount += 1; } },
    runtimeStore: { close: () => undefined },
    artifactStore: { close: () => undefined }
  });
  return {
    controller,
    taskSandboxes,
    connectivityRuntime: () => harness.connectivityRuntime,
    connectivityStoreCloseCount: () => connectivityStoreCloseCount,
    graphStoreCloseCount: () => graphStoreCloseCount,
    loggedEventTypes: () => [...loggedEventTypes]
  };
}

function gatewayDrainAck(epochRef: string): Record<string, unknown> {
  return {
    epochRef,
    gatewayPresent: true,
    activeFlowCount: 0,
    activeTcpCount: 0,
    activeNetworkCount: 0,
    persistedFlowSequence: 2,
    persistedNetworkSequence: 3,
    flowBytes: 128,
    netBytes: 256,
    flushed: true
  };
}
