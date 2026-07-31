import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReplayGatewayRuntime } from "../src/connectivity/replay-gateway-runtime.js";
import type { MitmFlowClient } from "../src/connectivity/mitm-flow-client.js";
import type { TrafficExchange } from "../src/connectivity/traffic-proxy-client.js";

const hostEgress = async () => ({
  host: "host.docker.internal" as const,
  port: 32123,
  token: "00".repeat(32)
});

function replayNetworkCommand(args: string[]): { code: number; stdout: string; stderr: string } | undefined {
  if (args[0] !== "network") return undefined;
  if (args[1] === "inspect") {
    const subnet = args.at(-1)?.includes("replay-task") ? "172.31.0.0/24" : "172.30.0.0/24";
    return {
      code: 0,
      stdout: args[3]?.includes("luanniao.managed")
        ? `true|replay-task-network|${subnet}|true\n`
        : `${subnet}\n`,
      stderr: ""
    };
  }
  return { code: 0, stdout: "", stderr: "" };
}

test("replay gateway sends HTTP through uid 1000 and captures replay metadata in one epoch", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-replay-gateway-"));
  const routeSnapshot = [{
    routeRef: "route:test",
    cidr: "172.31.0.0/24",
    prefixLength: 24,
    socksHost: "172.30.0.2",
    socksPort: 22000,
    connectionRef: "connection:test"
  }, {
    routeRef: "route:other",
    cidr: "172.32.0.0/24",
    prefixLength: 24,
    socksHost: "172.30.0.3",
    socksPort: 22001
  }];
  const commands: Array<{ args: string[]; stdin?: string }> = [];
  let epochRef = "";
  const runner = async (args: string[], stdin?: string) => {
    commands.push({ args, stdin });
    const network = replayNetworkCommand(args);
    if (network) return network;
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "exec" && args.includes("gatewayctl")) {
      if (args.includes("epoch.begin")) epochRef = JSON.parse(args.at(-1) ?? "{}").epochRef;
      return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
    }
    if (args[0] === "exec" && args.includes("/opt/luanniao/replay_client.py")) {
      return { code: 0, stdout: '{"ok":true,"status":201}\n', stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const client = {
    historyList: async () => ({ items: [flow(epochRef)], has_more: false })
  } as unknown as MitmFlowClient;
  const runtime = new ReplayGatewayRuntime({
    runtimeDir,
    networkName: "luanniao-net-0123456789abcdef",
    runner,
    hostEgress
  });

  const result = await runtime.replay(client, {
    flowRef: "task:source:flow",
    method: "POST",
    url: "http://172.31.0.20/test",
    headers: [{ name: "Content-Type", value: "text/plain", ordinal: 0 }],
    body: { encoding: "base64", data: "dGVzdA==" },
    routeRef: "route:test",
    context: {
      runtime_ref: "run:test",
      task_ref: "task:source",
      run_ref: "run:test",
      attribution: "web-user:test",
      route_ref: "route:test",
      session_ref: "connection:test",
      connection_ref: "connection:test"
    }
  }, routeSnapshot);

  assert.deepEqual(result, { exchange_id: "task:source:captured", replay_of: "task:source:flow", status: 201 });
  const replay = commands.find((entry) => entry.args.includes("/opt/luanniao/replay_client.py"));
  assert(replay);
  assert.deepEqual(replay.args.slice(0, 6), ["exec", "-i", "--user", "1000:1000", runtime.containerName, "python3"]);
  const replayInput = JSON.parse(replay.stdin ?? "{}");
  assert.equal(replayInput.context.replayOf, "task:source:flow");
  assert.equal(replayInput.context.connectionRef, "connection:test");
  assert.deepEqual(replayInput.targetCidrs, ["172.31.0.0/24"]);
  const routes = commands.find((entry) => entry.args.includes("routes.replace"));
  assert(routes);
  const routePayload = JSON.parse(routes.args.at(-1) ?? "{}");
  assert.deepEqual(routePayload.routes.map((route: { routeRef: string }) => route.routeRef), ["route:test"]);
  const epoch = commands.find((entry) => entry.args.includes("epoch.begin"));
  assert(epoch);
  const epochPayload = JSON.parse(epoch.args.at(-1) ?? "{}");
  assert.match(epochPayload.flowFile, /\.mitm$/);
  assert.match(epochPayload.netFile, /\.net\.jsonl$/);
  assert.ok(commands.some((entry) => entry.args.includes("epoch.end")));
  const gatewayRun = commands.find((entry) => entry.args[0] === "run" && entry.args.includes("--name"))?.args ?? [];
  assert.ok(gatewayRun.includes("/dev/net/tun:/dev/net/tun"));
  assert.ok(gatewayRun.includes("net.netfilter.nf_conntrack_acct=1"));
  for (const capability of ["NET_ADMIN", "SETUID", "SETGID", "CHOWN", "FOWNER", "SETPCAP"]) {
    const capabilityIndex = gatewayRun.indexOf(capability);
    assert.ok(capabilityIndex > 0);
    assert.equal(gatewayRun[capabilityIndex - 1], "--cap-add");
  }
  assert.ok(gatewayRun.includes(`type=bind,src=${join(runtimeDir, "traffic", "flows", "web-replay")},dst=/traffic/flows/web-replay`));
  assert.ok(gatewayRun.includes(`type=bind,src=${join(runtimeDir, "traffic", "ca")},dst=/traffic/ca`));
  assert.equal(gatewayRun.includes(`type=bind,src=${join(runtimeDir, "traffic")},dst=/traffic`), false);
  assert.ok(commands.some((entry) => entry.args.slice(0, 2).join(" ") === "network connect"));
});

test("routed replay fails closed before Docker when its route is absent from the owner snapshot", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-replay-gateway-"));
  const commands: string[][] = [];
  const runtime = new ReplayGatewayRuntime({
    runtimeDir,
    networkName: "luanniao-net-0123456789abcdef",
    hostEgress,
    runner: async (args) => {
      commands.push(args);
      return { code: 1, stdout: "", stderr: "unexpected" };
    }
  });

  await assert.rejects(() => runtime.replay({} as MitmFlowClient, {
    flowRef: "task:source:flow",
    method: "GET",
    url: "http://172.31.0.20/",
    headers: [],
    routeRef: "route:test",
    context: {
      runtime_ref: "run:test",
      task_ref: "task:source",
      run_ref: "run:test",
      attribution: "web-user:test",
      route_ref: "route:test",
      session_ref: "connection:test"
    }
  }, []), (error: unknown) => {
    assert.equal((error as { errorCode?: string }).errorCode, "route_unavailable");
    return true;
  });
  assert.deepEqual(commands, []);
});

test("direct replay applies an empty route snapshot and never inherits managed routes", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-replay-gateway-"));
  const commands: Array<{ args: string[]; stdin?: string }> = [];
  let epochRef = "";
  const runner = async (args: string[], stdin?: string) => {
    commands.push({ args, stdin });
    const network = replayNetworkCommand(args);
    if (network) return network;
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "exec" && args.includes("gatewayctl")) {
      if (args.includes("epoch.begin")) epochRef = JSON.parse(args.at(-1) ?? "{}").epochRef;
      return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
    }
    if (args[0] === "exec" && args.includes("/opt/luanniao/replay_client.py")) {
      return { code: 0, stdout: '{"ok":true,"status":200}\n', stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = new ReplayGatewayRuntime({
    runtimeDir,
    networkName: "luanniao-net-0123456789abcdef",
    runner,
    hostEgress
  });

  await runtime.replay({
    historyList: async () => ({ items: [flow(epochRef)], has_more: false })
  } as unknown as MitmFlowClient, {
    flowRef: "task:source:flow",
    method: "GET",
    url: "http://198.51.100.20/",
    headers: [],
    context: {
      runtime_ref: "run:test",
      task_ref: "task:source",
      run_ref: "run:test",
      attribution: "web-user:test",
      route_ref: "",
      session_ref: ""
    }
  }, [{
    routeRef: "route:other",
    cidr: "172.31.0.0/24",
    prefixLength: 24,
    socksHost: "172.30.0.2",
    socksPort: 22000
  }]);

  const routeCommand = commands.find((entry) => entry.args.includes("routes.replace"));
  assert(routeCommand);
  assert.deepEqual(JSON.parse(routeCommand.args.at(-1) ?? "{}").routes, []);
  assert.ok(commands.some((entry) => entry.args.slice(0, 2).join(" ") === "network connect"));
});

test("replay gateway replaces an owned container created from a stale image ID", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-replay-gateway-"));
  let configDigest = "";
  let epochRef = "";
  const firstCommands: string[][] = [];
  const first = new ReplayGatewayRuntime({
    runtimeDir,
    networkName: "luanniao-net-0123456789abcdef",
    hostEgress,
    runner: async (args) => {
      firstCommands.push(args);
      const network = replayNetworkCommand(args);
      if (network) return network;
      if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      if (args[0] === "run") {
        configDigest = args.find((value) => value.startsWith("luanniao.config="))?.split("=", 2)[1] ?? "";
      }
      if (args[0] === "exec" && args.includes("gatewayctl")) {
        if (args.includes("epoch.begin")) epochRef = JSON.parse(args.at(-1) ?? "{}").epochRef;
        return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
      }
      if (args[0] === "exec" && args.includes("/opt/luanniao/replay_client.py")) {
        return { code: 0, stdout: '{"ok":true,"status":200}\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  const client = {
    historyList: async () => ({ items: [flow(epochRef)], has_more: false })
  } as unknown as MitmFlowClient;
  const input = {
    flowRef: "task:source:flow",
    method: "GET",
    url: "http://198.51.100.20/",
    headers: [],
    context: {
      runtime_ref: "run:test",
      task_ref: "task:source",
      run_ref: "run:test",
      attribution: "web-user:test",
      route_ref: "",
      session_ref: ""
    }
  };
  await first.replay(client, input, []);
  assert.ok(configDigest);

  const secondCommands: string[][] = [];
  const second = new ReplayGatewayRuntime({
    runtimeDir,
    networkName: "luanniao-net-0123456789abcdef",
    hostEgress,
    runner: async (args) => {
      secondCommands.push(args);
      const network = replayNetworkCommand(args);
      if (network) return network;
      if (args[0] === "image") return { code: 0, stdout: "sha256:current\n", stderr: "" };
      if (args[0] === "inspect" && args[2]?.includes(".State.Running")) {
        return { code: 0, stdout: `true|true|replay-gateway|${configDigest}|sha256:stale\n`, stderr: "" };
      }
      if (args[0] === "inspect") return { code: 0, stdout: "true|replay-gateway\n", stderr: "" };
      if (args[0] === "exec" && args.includes("gatewayctl")) {
        if (args.includes("epoch.begin")) epochRef = JSON.parse(args.at(-1) ?? "{}").epochRef;
        return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
      }
      if (args[0] === "exec" && args.includes("/opt/luanniao/replay_client.py")) {
        return { code: 0, stdout: '{"ok":true,"status":200}\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  await second.replay(client, input, []);

  assert.ok(secondCommands.some((args) => args[0] === "image" && args[1] === "inspect"));
  assert.ok(secondCommands.some((args) => args[0] === "rm" && args[1] === "-f"));
  assert.ok(secondCommands.some((args) => args[0] === "run"));
});

function flow(epochRef: string): TrafficExchange {
  return {
    id: "task:source:captured",
    kind: "http",
    started_at: "2026-07-26T00:00:00Z",
    completed_at: "2026-07-26T00:00:01Z",
    duration_ms: 1000,
    method: "POST",
    url: "http://172.31.0.20/test",
    host: "172.31.0.20",
    scheme: "http",
    protocol: "HTTP/1.1",
    mode: "replay",
    status: 201,
    request_observed_bytes: 4,
    response_observed_bytes: 0,
    request_captured_bytes: 4,
    response_captured_bytes: 0,
    request_capture_state: "captured",
    response_capture_state: "none",
    request_truncated: false,
    response_truncated: false,
    headers_truncated: false,
    quota_pressure: false,
    evicted_exchanges: 0,
    epoch_ref: epochRef,
    replay_of: "task:source:flow"
  };
}
