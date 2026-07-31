import assert from "node:assert/strict";
import test from "node:test";
import { createExecutorConnectivityTools, type ExecutorConnectivityRuntime } from "../src/tools/connectivity-tools.js";
import type { RouteOpenInput, RouteStatus } from "../src/connectivity/route-manager.js";

const route: RouteStatus = {
  routeRef: "route:test",
  connectorRef: "connector:test",
  connector: "ssh",
  pivotHostRef: "host:dmz",
  dialAddress: "192.0.2.10",
  targetCidrs: ["172.31.0.0/24"],
  desiredState: "running",
  status: "live",
  lastHeartbeat: "2026-07-25T00:00:00.000Z",
  connectionRef: "connection:test"
};

test("executor connectivity tools expose route lifecycle without route_forget", () => {
  const tools = createExecutorConnectivityTools({} as ExecutorConnectivityRuntime, "task:pivot");
  assert.deepEqual(tools.map((tool) => tool.name), [
    "route_open",
    "route_status",
    "route_stop",
    "route_reconnect"
  ]);
});

test("route_open binds the route to the current task and returns stable refs", async () => {
  let received: { input: RouteOpenInput; ownerTaskId: string } | undefined;
  const runtime: ExecutorConnectivityRuntime = {
    openRoute: async (input, ownerTaskId) => {
      received = { input, ownerTaskId };
      return route;
    },
    routeStatus: async () => [route],
    stopRoute: async () => ({ ...route, desiredState: "stopped", status: "stale" }),
    reconnectRoute: async () => route
  };
  const open = createExecutorConnectivityTools(runtime, "task:pivot")[0]!;
  const result = await open.execute("call:open", {
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:key",
    options: { port: 22, user: "ops" }
  }, new AbortController().signal, () => undefined, {} as never);

  assert.equal(received?.ownerTaskId, "task:pivot");
  assert.equal(received?.input.dialAddress, "192.0.2.10");
  assert.equal(result.details, route);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /connection:test/);
});

test("route_open reserves the process-wide SOCKS5 proxy for operator configuration", () => {
  const open = createExecutorConnectivityTools({} as ExecutorConnectivityRuntime, "task:proxy")[0]!;
  assert.doesNotMatch(JSON.stringify(open.parameters), /socks5/);
  assert.match(open.description, /configured by the operator/);
});

test("route lifecycle tools call the Runtime instead of mutating the store", async () => {
  const calls: string[] = [];
  const runtime: ExecutorConnectivityRuntime = {
    openRoute: async () => route,
    routeStatus: async (routeRef) => {
      calls.push(`status:${routeRef ?? "*"}`);
      return [route];
    },
    stopRoute: async (routeRef) => {
      calls.push(`stop:${routeRef}`);
      return { ...route, desiredState: "stopped", status: "stale" };
    },
    reconnectRoute: async (routeRef) => {
      calls.push(`reconnect:${routeRef}`);
      return route;
    }
  };
  const [, status, stop, reconnect] = createExecutorConnectivityTools(runtime, "task:pivot");

  await status!.execute("call:status", { routeRef: route.routeRef }, new AbortController().signal, () => undefined, {} as never);
  await stop!.execute("call:stop", { routeRef: route.routeRef }, new AbortController().signal, () => undefined, {} as never);
  await reconnect!.execute("call:reconnect", { routeRef: route.routeRef }, new AbortController().signal, () => undefined, {} as never);

  assert.deepEqual(calls, ["status:route:test", "stop:route:test", "reconnect:route:test"]);
});
