import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { RouteManager } from "../src/connectivity/route-manager.js";
import type { NetworkSandboxManager } from "../src/connectivity/network-sandbox-manager.js";
import type { ArtifactStore } from "../src/stores/artifact-store.js";
import { ConnectivityStore, stableConnectivityId } from "../src/stores/connectivity-store.js";
import type { ExecutionLog } from "../src/stores/execution-log.js";

function createChiselLifecycleHarness(): {
  network: NetworkSandboxManager;
  commands: Array<{ command: string; stdin?: string }>;
  setRemoteStopFailure: (value: boolean) => void;
} {
  const commands: Array<{ command: string; stdin?: string }> = [];
  let failRemoteStop = false;
  const network = {
    connectorAddress: "192.168.1.2",
    chiselEndpoint: "https://connect.example.test:19090",
    chiselAuth: "run:test-secret",
    chiselFingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    connectorExec: async (command: string, stdin?: string) => {
      commands.push({ command, stdin });
      if (stdin?.includes("kill -TERM \"$pid\"") && failRemoteStop) {
        return { code: 1, stdout: "", stderr: "remote cleanup unavailable" };
      }
      return { code: 0, stdout: command.includes("uname") ? "x86_64\n" : "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  return {
    network,
    commands,
    setRemoteStopFailure: (value: boolean) => { failRemoteStop = value; }
  };
}

async function openManagedRoutePair(manager: RouteManager) {
  const ssh = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:key",
    options: { port: 22, user: "ops" }
  }, "task:ssh");
  const chisel = await manager.open({
    connector: "chisel",
    pivotHostRef: "host:dmz",
    targetCidrs: ["10.20.0.0/16"],
    bootstrapConnectionRef: ssh.connectionRef
  }, "task:chisel");
  return { ssh, chisel };
}

test("Chisel startup failures retain a degraded route for later recovery", async () => {
  const published: Array<Array<{ routeRef: string; connectionRef?: string }>> = [];
  const network = {
    connectorAddress: "192.168.1.2",
    chiselEndpoint: "https://connect.example.test:19090",
    chiselAuth: "run:test-secret",
    chiselFingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    connectorExec: async () => ({ code: 0, stdout: "", stderr: "" }),
    replaceRoutes: async (routes: Array<{ routeRef: string; connectionRef?: string }>) => { published.push(routes); }
  } as unknown as NetworkSandboxManager;
  const manager = new RouteManager(
    network,
    {} as ArtifactStore,
    { append: async () => ({}) } as unknown as ExecutionLog
  );

  const route = await manager.open({
    connector: "chisel",
    pivotHostRef: "host:dmz",
    targetCidrs: ["172.31.0.0/24"],
    bootstrapConnectionRef: "connection:webshell"
  }, "task:pivot");

  assert.equal(route.desiredState, "running");
  assert.equal(route.status, "degraded");
  assert.match(route.error ?? "", /requires a live RouteManager SSH connection/);
  assert.equal(published.at(-1)?.[0]?.routeRef, route.routeRef);
  assert.equal((await manager.status(route.routeRef))[0]?.routeRef, route.routeRef);
});

test("route publication failure atomically restores the previous route table", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-publish-failure-");
  const published: Array<Array<{ routeRef: string }>> = [];
  let connectorCalls = 0;
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async () => {
      connectorCalls += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async (routes: Array<{ routeRef: string }>) => {
      published.push(routes);
      if (published.length === 1) throw new Error("route publication unavailable");
    }
  } as unknown as NetworkSandboxManager;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(
    network,
    {
      get: async () => ({ taskId: "task:pivot" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    { append: async () => ({}) } as unknown as ExecutionLog,
    store
  );

  await assert.rejects(() => manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:key",
    options: { port: 22, user: "ops" }
  }, "task:pivot"), /route publication unavailable/);

  assert.equal(published[0]?.length, 1);
  assert.deepEqual(published[1], []);
  assert.equal(connectorCalls, 0);
  assert.deepEqual(await manager.status(), []);
  assert.equal(store.listDefinitions("route").length, 0);
  assert.equal(store.listDefinitions("session").length, 0);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("Chisel reuses a RouteManager-owned SSH command connection", async () => {
  const commands: Array<{ command: string; stdin?: string }> = [];
  let remoteChiselAlive = true;
  let failRemoteStop = false;
  const network = {
    connectorAddress: "192.168.1.2",
    chiselEndpoint: "https://connect.example.test:19090",
    chiselAuth: "run:test-secret",
    chiselFingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    connectorExec: async (command: string, stdin?: string) => {
      commands.push({ command, stdin });
      const invocation = `${command}\n${stdin ?? ""}`;
      if (invocation.includes("readlink /proc/$pid/exe") && !invocation.includes("kill -TERM") && !remoteChiselAlive) {
        return { code: 1, stdout: "", stderr: "remote process missing" };
      }
      if (stdin?.includes("kill -TERM \"$pid\"") && failRemoteStop) {
        return { code: 1, stdout: "", stderr: "remote cleanup unavailable" };
      }
      return { code: 0, stdout: command.includes("uname") ? "x86_64\n" : "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const manager = new RouteManager(
    network,
    {
      get: async () => ({ taskId: "task:credential" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    { append: async () => ({}) } as unknown as ExecutionLog
  );
  const ssh = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:key",
    options: { port: 22, user: "ops" }
  }, "task:ssh");

  const chisel = await manager.open({
    connector: "chisel",
    pivotHostRef: "host:dmz",
    targetCidrs: ["10.20.0.0/16"],
    bootstrapConnectionRef: ssh.connectionRef
  }, "task:chisel");

  const bootstrap = commands.find((entry) => entry.stdin?.includes("luanniao-chisel-1.10.1"));
  assert.equal(chisel.connectionRef, ssh.connectionRef);
  assert.match(bootstrap?.command ?? "", /ssh -T -S/);
  assert.match(bootstrap?.command ?? "", /ops@192\.0\.2\.10/);
  assert.match(bootstrap?.stdin ?? "", /R:0\.0\.0\.0:[0-9]+:socks/);
  assert.doesNotMatch(bootstrap?.stdin ?? "", /&;/);
  assert.match(bootstrap?.stdin ?? "", /&\necho \$!/);
  const deployment = commands.find((entry) => entry.command.includes("/opt/luanniao/chisel/chisel_1.10.1_linux_amd64.gz"));
  assert.match(deployment?.command ?? "", /0525aa3c5d457f2a4075e66221d5125d434bedf15006d3271c213f5cd6ff2230/);
  assert.doesNotMatch(commands.map((entry) => `${entry.command}\n${entry.stdin ?? ""}`).join("\n"), /curl|github\.com/i);
  await assert.rejects(() => manager.stop(ssh.routeRef), new RegExp(`backs ${chisel.routeRef}`));
  assert.deepEqual((await manager.status()).map((route) => route.status), ["live", "live"]);
  remoteChiselAlive = false;
  const [degraded] = await manager.status(chisel.routeRef);
  assert.equal(degraded?.status, "degraded");
  assert.match(degraded?.error ?? "", /remote process missing/);
  remoteChiselAlive = true;
  await assert.rejects(() => manager.forget(ssh.routeRef), new RegExp(`backs ${chisel.routeRef}`));
  failRemoteStop = true;
  await assert.rejects(() => manager.stop(chisel.routeRef), /remote cleanup unavailable/);
  await assert.rejects(() => manager.stop(ssh.routeRef), new RegExp(`backs ${chisel.routeRef}`));
  failRemoteStop = false;
  await manager.stop(chisel.routeRef);
  assert.equal((await manager.stop(ssh.routeRef)).status, "stale");
  await manager.forget(chisel.routeRef);
  const processScripts = commands.filter((entry) => entry.stdin?.includes("/proc/$pid/exe"));
  assert.equal(processScripts.length, 4);
  assert.ok(processScripts.every((entry) => /ssh -T -S/.test(entry.command)));
  assert.ok(processScripts.every((entry) => /-- 'sh' '-s'$/.test(entry.command)));
  assert.ok(processScripts.every((entry) => !entry.command.includes("/proc/$pid/exe")));
  assert.ok(processScripts.some((entry) => entry.stdin?.includes("kill -0")));
  assert.ok(processScripts.some((entry) => entry.stdin?.includes("kill -TERM")));
  assert.ok(processScripts.some((entry) => entry.stdin?.includes("kill -KILL")));
  assert.ok(processScripts.some((entry) => entry.stdin?.includes("managed_chisel")));
  await manager.forget(ssh.routeRef);
});

test("RouteManager emits typed connectivity facts for Projector without a graph writer", async () => {
  const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async () => ({ code: 0, stdout: "", stderr: "" }),
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const manager = new RouteManager(
    network,
    {
      get: async () => ({ taskId: "task:credential" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    {
      append: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        events.push(event);
        return {};
      }
    } as unknown as ExecutionLog
  );

  const route = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:key",
    options: { user: "ops" }
  }, "task:pivot");

  assert.deepEqual(events.map((event) => event.eventType), ["connectivity_observation", "connectivity_observation"]);
  assert.deepEqual(events.map((event) => event.payload?.observationKind), ["session", "route"]);
  assert.equal(events[0]?.payload?.hostRef, "host:dmz");
  assert.equal(events[0]?.payload?.connectionRef, route.connectionRef);
  assert.equal(events[0]?.payload?.sessionRef, undefined);
  assert.equal(events[1]?.payload?.sessionRef, undefined);
  assert.equal(events[1]?.payload?.pivotHostRef, "host:dmz");
  assert.deepEqual(events[1]?.payload?.targetCidrs, ["172.31.0.0/24"]);
});

test("SSH routes accept matching user:password artifacts", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-store-");
  const staged: string[] = [];
  const commands: string[] = [];
  const published: Array<Array<{ connectionRef?: string }>> = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string, stdin?: string) => {
      commands.push(command);
      if (stdin !== undefined) staged.push(stdin);
      if (command.startsWith("nc -z")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async (routes: Array<{ connectionRef?: string }>) => { published.push(routes); }
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:test" }),
    read: async () => "ops:Lan1ao-Ops!23\n"
  } as unknown as ArtifactStore;
  const log = { append: async () => ({}) } as unknown as ExecutionLog;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(network, artifacts, log, store);

  const route = await manager.open({
    connector: "ssh",
    pivotHostRef: "dmz-web",
    dialAddress: "192.0.2.23",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:test",
    options: { port: 18023, user: "ops" }
  }, "task:test");

  assert.equal(route.status, "live");
  assert.deepEqual(staged, ["Lan1ao-Ops!23"]);
  assert.ok(commands.some((command) => command.includes("-D 0.0.0.0:")));
  assert.equal(published.at(-1)?.[0]?.connectionRef, route.connectionRef);
  assert.equal("sessionRef" in (published.at(-1)?.[0] ?? {}), false);
  const persisted = store.listDefinitions("route")[0];
  assert.equal(persisted?.externalId, route.routeRef);
  assert.equal(persisted?.status, "live");
  assert.equal(persisted?.definition.transport, "ssh");
  assert.equal(persisted?.definition.connectionRef, route.connectionRef);
  assert.equal(persisted?.definition.dialAddress, "192.0.2.23");
  assert.equal(persisted?.definition.dialPort, 18023);
  assert.equal(persisted?.credentialRef, "artifact:test");
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("SSH routes accept credential artifacts produced by predecessor tasks", async () => {
  const staged: string[] = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string, stdin?: string) => {
      if (stdin !== undefined) staged.push(stdin);
      if (command.startsWith("nc -z")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:predecessor" }),
    read: async () => "ops:shared-password\n"
  } as unknown as ArtifactStore;
  const log = { append: async () => ({}) } as unknown as ExecutionLog;
  const manager = new RouteManager(network, artifacts, log);

  const route = await manager.open({
    connector: "ssh",
    pivotHostRef: "dmz-web",
    dialAddress: "192.0.2.23",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:predecessor",
    options: { port: 18023, user: "ops" }
  }, "task:successor");

  assert.equal(route.status, "live");
  assert.deepEqual(staged, ["shared-password"]);
});

test("SSH routes extract passwords from structured credential artifacts", async () => {
  const staged: string[] = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string, stdin?: string) => {
      if (stdin !== undefined) staged.push(stdin);
      if (command.startsWith("nc -z")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:predecessor" }),
    read: async () => JSON.stringify({ username: "ops", password: "json-password", host: "dmz-web" })
  } as unknown as ArtifactStore;
  const log = { append: async () => ({}) } as unknown as ExecutionLog;
  const manager = new RouteManager(network, artifacts, log);

  const route = await manager.open({
    connector: "ssh",
    pivotHostRef: "dmz-web",
    dialAddress: "192.0.2.23",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:structured",
    options: { port: 18023, user: "ops" }
  }, "task:successor");

  assert.equal(route.status, "live");
  assert.deepEqual(staged, ["json-password"]);
});

test("SSH route failures surface connector authentication logs", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-failure-");
  const publishedRoutes: Array<Array<{ routeRef: string; cidr: string }>> = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      if (command.startsWith("nc -z")) return { code: 1, stdout: "", stderr: "" };
      if (command.includes("kill -0")) return { code: 1, stdout: "", stderr: "" };
      if (command.startsWith("tail -c")) return { code: 0, stdout: "Permission denied, please try again.\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async (routes: Array<{ routeRef: string; cidr: string }>) => {
      publishedRoutes.push(routes);
    }
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:test" }),
    read: async () => "wrong-password"
  } as unknown as ArtifactStore;
  const log = { append: async () => ({}) } as unknown as ExecutionLog;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(network, artifacts, log, store);

  const route = await manager.open({
    connector: "ssh",
    pivotHostRef: "dmz-web",
    dialAddress: "192.0.2.23",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:test",
    options: { port: 18023, user: "ops" }
  }, "task:test");
  assert.equal(route.desiredState, "running");
  assert.equal(route.status, "degraded");
  assert.match(route.error ?? "", /SSH connector failed: Permission denied/);
  assert.equal(publishedRoutes[0]?.[0]?.cidr, "172.31.0.0/24");
  assert.equal(publishedRoutes.at(-1)?.[0]?.routeRef, route.routeRef);
  const persisted = store.listDefinitions("route")[0];
  assert.equal(persisted?.externalId, route.routeRef);
  assert.equal(persisted?.desiredState, "running");
  assert.equal(persisted?.status, "degraded");
  assert.match(String(persisted?.definition.lastFailureReason), /Permission denied/);
  assert.equal((await manager.status(route.routeRef))[0]?.routeRef, route.routeRef);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("stopped routes restore and reconnect with the same route identity", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-reconnect-");
  const published: Array<Array<{ routeRef: string; cidr: string }>> = [];
  const commands: string[] = [];
  const events: string[] = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      commands.push(command);
      events.push(`connector:${command}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async (routes: Array<{ routeRef: string; cidr: string }>) => {
      published.push(routes);
      events.push(`publish:${routes.map((item) => item.cidr).join(",")}`);
    }
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:pivot" }),
    read: async () => "route-password"
  } as unknown as ArtifactStore;
  const log = { append: async () => ({}) } as unknown as ExecutionLog;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  store.upsertDefinition({
    kind: "route",
    externalId: "route:recoverable",
    desiredState: "stopped",
    status: "stale",
    hostRef: "host:dmz",
    processRef: "connector:recoverable",
    credentialRef: "artifact:route-password",
    definition: {
      transport: "ssh",
      pivotHostRef: "host:dmz",
      targetCidrs: ["172.31.0.0/24"],
      connectorRef: "connector:recoverable",
      sessionRef: "connection:dmz",
      dialAddress: "192.0.2.10",
      dialPort: 22,
      dialUser: "ops",
      ownerTaskId: "task:pivot",
      lastFailureReason: ""
    }
  });
  const manager = new RouteManager(network, artifacts, log, store);

  await manager.restore();
  assert.equal(published.at(-1)?.[0]?.routeRef, "route:recoverable");
  assert.equal(published.at(-1)?.[0]?.cidr, "172.31.0.0/24");
  events.length = 0;
  const route = await manager.reconnect("route:recoverable");

  assert.equal(route.routeRef, "route:recoverable");
  assert.equal(route.connectorRef, "connector:recoverable");
  assert.equal(route.status, "live");
  assert.equal(route.connectionRef, "connection:dmz");
  assert.equal("sessionRef" in route, false);
  assert.ok(commands.some((command) => command.includes("ops@192.0.2.10")));
  const failClosedPublish = events.findIndex((event) => event === "publish:172.31.0.0/24");
  const connectorStart = events.findIndex((event) => event.startsWith("connector:setsid "));
  assert.ok(failClosedPublish >= 0 && connectorStart > failClosedPublish);
  assert.equal(published[1]?.[0]?.cidr, "172.31.0.0/24");
  assert.equal(published.at(-1)?.[0]?.routeRef, "route:recoverable");
  const persisted = store.listDefinitions("route")[0];
  assert.equal(persisted?.desiredState, "running");
  assert.equal(persisted?.status, "live");
  assert.equal(persisted?.definition.connectionRef, "connection:dmz");
  assert.equal(persisted?.definition.sessionRef, undefined);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("failed reconnects preserve the running intent for later recovery", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-reconnect-failure-");
  const artifacts = {
    get: async () => ({ taskId: "task:pivot" }),
    read: async () => "route-password"
  } as unknown as ArtifactStore;
  const log = { append: async () => ({}) } as unknown as ExecutionLog;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  store.upsertDefinition({
    kind: "route",
    externalId: "route:recoverable",
    desiredState: "stopped",
    status: "stale",
    hostRef: "host:dmz",
    processRef: "connector:recoverable",
    credentialRef: "artifact:route-password",
    definition: {
      transport: "ssh",
      pivotHostRef: "host:dmz",
      targetCidrs: ["172.31.0.0/24"],
      connectorRef: "connector:recoverable",
      connectionRef: "connection:dmz",
      dialAddress: "192.0.2.10",
      dialPort: 22,
      dialUser: "ops",
      ownerTaskId: "task:pivot"
    }
  });
  const failingNetwork = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      if (command.startsWith("setsid sh -c")) return { code: 1, stdout: "", stderr: "transient connector failure" };
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const firstManager = new RouteManager(failingNetwork, artifacts, log, store);
  await firstManager.restore();

  await assert.rejects(
    () => firstManager.reconnect("route:recoverable"),
    /Failed to start SSH connector: transient connector failure/
  );
  assert.equal(store.listDefinitions("route")[0]?.desiredState, "running");

  const recoveringNetwork = {
    connectorAddress: "192.168.1.2",
    connectorExec: async () => ({ code: 0, stdout: "", stderr: "" }),
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const secondManager = new RouteManager(recoveringNetwork, artifacts, log, store);
  await secondManager.restore();
  const [recovered] = await secondManager.recoverDesired();

  assert.equal(recovered?.routeRef, "route:recoverable");
  assert.equal(recovered?.status, "live");
  assert.equal(store.listDefinitions("route")[0]?.desiredState, "running");
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("recoverDesired probes persisted live routes before trusting their process state", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-recover-live-");
  let probes = 0;
  const commands: string[] = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      commands.push(command);
      if (command.startsWith("nc -z")) {
        probes += 1;
        return { code: probes === 1 ? 1 : 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:pivot" }),
    read: async () => "route-password"
  } as unknown as ArtifactStore;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  store.upsertDefinition({
    kind: "route",
    externalId: "route:claimed-live",
    desiredState: "running",
    status: "live",
    hostRef: "host:dmz",
    processRef: "connector:claimed-live",
    credentialRef: "artifact:route-password",
    definition: {
      transport: "ssh",
      pivotHostRef: "host:dmz",
      targetCidrs: ["172.31.0.0/24"],
      connectorRef: "connector:claimed-live",
      connectionRef: "connection:dmz",
      dialAddress: "192.0.2.10",
      dialPort: 22,
      dialUser: "ops",
      ownerTaskId: "task:pivot"
    }
  });
  const manager = new RouteManager(network, artifacts, { append: async () => ({}) } as unknown as ExecutionLog, store);

  await manager.restore();
  const [recovered] = await manager.recoverDesired();

  assert.equal(recovered?.routeRef, "route:claimed-live");
  assert.equal(recovered?.status, "live");
  assert.ok(probes >= 2);
  assert.ok(commands.some((command) => command.includes("setsid sh -c")));
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("running routes retain their CIDRs while the connector is stale", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-fail-closed-");
  const published: Array<Array<{ routeRef: string; cidr: string }>> = [];
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  store.upsertDefinition({
    kind: "route",
    externalId: "route:degraded",
    desiredState: "running",
    status: "degraded",
    hostRef: "host:dmz",
    processRef: "connector:degraded",
    credentialRef: "artifact:route-password",
    definition: {
      transport: "ssh",
      pivotHostRef: "host:dmz",
      targetCidrs: ["172.31.0.0/24"],
      connectorRef: "connector:degraded",
      connectionRef: "connection:dmz",
      dialAddress: "192.0.2.10",
      dialPort: 22,
      dialUser: "ops",
      ownerTaskId: "task:pivot"
    }
  });
  const manager = new RouteManager({
    connectorAddress: "192.168.1.2",
    replaceRoutes: async (routes: Array<{ routeRef: string; cidr: string }>) => { published.push(routes); }
  } as unknown as NetworkSandboxManager, {} as ArtifactStore, { append: async () => ({}) } as unknown as ExecutionLog, store);

  await manager.restore();

  assert.equal(published.at(-1)?.length, 1);
  assert.equal(published.at(-1)?.[0]?.routeRef, "route:degraded");
  assert.equal(published.at(-1)?.[0]?.cidr, "172.31.0.0/24");
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("recoverDesired restores a persisted SSH connection before its Chisel route", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-recover-chisel-");
  const commands: Array<{ command: string; stdin?: string }> = [];
  const network = {
    connectorAddress: "192.168.1.2",
    chiselEndpoint: "https://connect.example.test:19090",
    chiselAuth: "run:test-secret",
    chiselFingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    connectorExec: async (command: string, stdin?: string) => {
      commands.push({ command, stdin });
      return { code: 0, stdout: command.includes("uname") ? "x86_64\n" : "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:pivot" }),
    read: async () => "route-password"
  } as unknown as ArtifactStore;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  store.upsertDefinition({
    kind: "route",
    externalId: "route:ssh",
    desiredState: "running",
    status: "stale",
    hostRef: "host:dmz",
    processRef: "connector:ssh",
    credentialRef: "artifact:route-password",
    definition: {
      transport: "ssh",
      pivotHostRef: "host:dmz",
      targetCidrs: ["172.31.0.0/24"],
      connectorRef: "connector:ssh",
      connectionRef: "connection:dmz",
      dialAddress: "192.0.2.10",
      dialPort: 22,
      dialUser: "ops",
      ownerTaskId: "task:ssh"
    }
  });
  store.upsertDefinition({
    kind: "route",
    externalId: "route:chisel",
    desiredState: "running",
    status: "stale",
    hostRef: "host:dmz",
    processRef: "connector:chisel",
    definition: {
      transport: "chisel",
      pivotHostRef: "host:dmz",
      targetCidrs: ["10.20.0.0/16"],
      connectorRef: "connector:chisel",
      pivotSessionRef: "connection:dmz",
      ownerTaskId: "task:chisel"
    }
  });
  const manager = new RouteManager(network, artifacts, { append: async () => ({}) } as unknown as ExecutionLog, store);

  await manager.restore();
  const recovered = await manager.recoverDesired();

  assert.deepEqual(recovered.map((route) => route.routeRef), ["route:ssh", "route:chisel"]);
  assert.deepEqual(recovered.map((route) => route.status), ["live", "live"]);
  const chiselBootstrap = commands.find((entry) => entry.stdin?.includes("R:0.0.0.0:"));
  assert.match(chiselBootstrap?.command ?? "", /ssh -T -S/);
  assert.match(chiselBootstrap?.stdin ?? "", /R:0\.0\.0\.0:[0-9]+:socks/);
  const migratedChisel = store.getDefinition(stableConnectivityId("route", "route:chisel"));
  assert.equal(migratedChisel?.definition.connectionRef, "connection:dmz");
  assert.equal(migratedChisel?.definition.bootstrapConnectionRef, "connection:dmz");
  assert.equal(migratedChisel?.definition.pivotSessionRef, undefined);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("forgotten routes are permanently removed and cannot reconnect", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-forget-");
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async () => ({ code: 0, stdout: "", stderr: "" }),
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:pivot" }),
    read: async () => "route-password"
  } as unknown as ArtifactStore;
  const log = { append: async () => ({}) } as unknown as ExecutionLog;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(network, artifacts, log, store);
  const opened = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:route-password",
    options: { port: 22, user: "ops" }
  }, "task:pivot");

  const forgotten = await manager.forget(opened.routeRef);

  assert.equal(forgotten.status, "closed");
  assert.equal(store.listDefinitions("route").length, 0);
  assert.equal(store.listDefinitions("session").length, 0);
  await assert.rejects(() => manager.status(opened.routeRef), /Route not found/);
  await assert.rejects(() => manager.reconnect(opened.routeRef), /Route not found/);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("stopAll preserves routes for a later reconnect", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-stop-all-");
  const published: Array<Array<{ routeRef: string }>> = [];
  const commands: string[] = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      commands.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async (routes: Array<{ routeRef: string }>) => { published.push(routes); }
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:pivot" }),
    read: async () => "route-password"
  } as unknown as ArtifactStore;
  const log = { append: async () => ({}) } as unknown as ExecutionLog;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(network, artifacts, log, store);
  const opened = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:route-password",
    options: { port: 22, user: "ops" }
  }, "task:pivot");

  await manager.stopAll();

  const stopped = store.listDefinitions("route")[0];
  assert.equal(stopped?.externalId, opened.routeRef);
  assert.equal(stopped?.desiredState, "stopped");
  assert.equal(stopped?.status, "stale");
  assert.equal(published.at(-1)?.[0]?.routeRef, opened.routeRef);
  const credentialPath = `/run/luanniao/credentials/${opened.connectorRef.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  assert.ok(commands.some((command) => command.includes('kill -TERM -"$pid"') && command.includes(credentialPath)));
  assert.equal(commands.filter((command) => command.startsWith("umask 077; cat >") && command.includes(credentialPath)).length, 1);

  const reconnected = await manager.reconnect(opened.routeRef);
  assert.equal(reconnected.status, "live");
  assert.equal(commands.filter((command) => command.startsWith("umask 077; cat >") && command.includes(credentialPath)).length, 2);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("stopAll retains a backing SSH connection when Chisel cleanup fails", async () => {
  const harness = createChiselLifecycleHarness();
  const manager = new RouteManager(
    harness.network,
    {
      get: async () => ({ taskId: "task:credential" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    { append: async () => ({}) } as unknown as ExecutionLog
  );
  const { ssh, chisel } = await openManagedRoutePair(manager);
  const sshPidFile = `/run/luanniao/connectors/${ssh.connectorRef.replace(/[^A-Za-z0-9._-]+/g, "-")}.pid`;
  harness.commands.length = 0;
  harness.setRemoteStopFailure(true);

  await assert.rejects(() => manager.stopAll(), /One or more routes could not be stopped/);

  const failedStatuses = new Map((await manager.status()).map((route) => [route.routeRef, route]));
  assert.equal(failedStatuses.get(chisel.routeRef)?.desiredState, "stopped");
  assert.match(failedStatuses.get(chisel.routeRef)?.error ?? "", /remote cleanup unavailable/);
  assert.equal(failedStatuses.get(ssh.routeRef)?.desiredState, "running");
  assert.equal(failedStatuses.get(ssh.routeRef)?.status, "live");
  assert.equal(harness.commands.some((entry) => entry.command.includes(sshPidFile)), false);

  harness.setRemoteStopFailure(false);
  harness.commands.length = 0;
  await manager.stopAll();
  const stoppedStatuses = new Map((await manager.status()).map((route) => [route.routeRef, route]));
  assert.equal(stoppedStatuses.get(chisel.routeRef)?.desiredState, "stopped");
  assert.equal(stoppedStatuses.get(chisel.routeRef)?.error, undefined);
  assert.equal(stoppedStatuses.get(ssh.routeRef)?.desiredState, "stopped");
  assert.equal(harness.commands.some((entry) => entry.command.includes(sshPidFile)), true);

  harness.commands.length = 0;
  await manager.suspendAll();
  assert.deepEqual(harness.commands, []);
});

test("suspendAll protects only backing connections whose Chisel cleanup failed in this pass", async () => {
  const harness = createChiselLifecycleHarness();
  const manager = new RouteManager(
    harness.network,
    {
      get: async () => ({ taskId: "task:credential" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    { append: async () => ({}) } as unknown as ExecutionLog
  );
  const { ssh, chisel } = await openManagedRoutePair(manager);
  const sshPidFile = `/run/luanniao/connectors/${ssh.connectorRef.replace(/[^A-Za-z0-9._-]+/g, "-")}.pid`;
  harness.commands.length = 0;
  harness.setRemoteStopFailure(true);

  await assert.rejects(() => manager.suspendAll(), /One or more route connectors could not be suspended/);

  let statuses = new Map((await manager.status()).map((route) => [route.routeRef, route]));
  assert.equal(statuses.get(chisel.routeRef)?.desiredState, "running");
  assert.equal(statuses.get(chisel.routeRef)?.status, "stale");
  assert.match(statuses.get(chisel.routeRef)?.error ?? "", /remote cleanup unavailable/);
  assert.equal(statuses.get(ssh.routeRef)?.status, "live");
  assert.equal(harness.commands.some((entry) => entry.command.includes(sshPidFile)), false);

  harness.setRemoteStopFailure(false);
  harness.commands.length = 0;
  await manager.suspendAll();
  statuses = new Map((await manager.status()).map((route) => [route.routeRef, route]));
  assert.equal(statuses.get(chisel.routeRef)?.status, "stale");
  assert.equal(statuses.get(chisel.routeRef)?.error, undefined);
  assert.equal(statuses.get(ssh.routeRef)?.status, "stale");
  assert.equal(harness.commands.some((entry) => entry.command.includes(sshPidFile)), true);
});

test("route stop persists stopped intent when connector cleanup fails and retries idempotently", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-stop-failure-");
  let failCleanup = false;
  const published: Array<Array<{ routeRef: string }>> = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      if (command.startsWith("nc -z")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes('kill -TERM -"$pid"') && failCleanup) {
        failCleanup = false;
        return { code: 1, stdout: "", stderr: "connector unavailable" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async (routes: Array<{ routeRef: string }>) => { published.push(routes); }
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:pivot" }),
    read: async () => "route-password"
  } as unknown as ArtifactStore;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(network, artifacts, { append: async () => ({}) } as unknown as ExecutionLog, store);
  const opened = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:route-password",
    options: { port: 22, user: "ops" }
  }, "task:pivot");
  failCleanup = true;

  await assert.rejects(() => manager.stop(opened.routeRef), /connector unavailable/);
  let persisted = store.listDefinitions("route")[0];
  assert.equal(persisted?.desiredState, "stopped");
  assert.equal(persisted?.status, "stale");
  assert.match(String(persisted?.definition.lastFailureReason), /connector unavailable/);
  assert.equal(published.at(-1)?.[0]?.routeRef, opened.routeRef);

  const stopped = await manager.stop(opened.routeRef);
  persisted = store.listDefinitions("route")[0];
  assert.equal(stopped.desiredState, "stopped");
  assert.equal(stopped.error, undefined);
  assert.equal(persisted?.definition.lastFailureReason, "");
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("suspendAll preserves running desire while releasing live connectors", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-suspend-all-");
  const published: Array<Array<{ routeRef: string }>> = [];
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async () => ({ code: 0, stdout: "", stderr: "" }),
    replaceRoutes: async (routes: Array<{ routeRef: string }>) => { published.push(routes); }
  } as unknown as NetworkSandboxManager;
  const artifacts = {
    get: async () => ({ taskId: "task:pivot" }),
    read: async () => "route-password"
  } as unknown as ArtifactStore;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(network, artifacts, { append: async () => ({}) } as unknown as ExecutionLog, store);
  const opened = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:route-password",
    options: { port: 22, user: "ops" }
  }, "task:pivot");

  await manager.suspendAll();

  const suspended = store.listDefinitions("route")[0];
  assert.equal(suspended?.externalId, opened.routeRef);
  assert.equal(suspended?.desiredState, "running");
  assert.equal(suspended?.status, "stale");
  assert.equal(published.at(-1)?.[0]?.routeRef, opened.routeRef);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("open preserves startup and cleanup failures on the same recoverable route", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-open-compensation-");
  const events: Array<{ payload?: Record<string, unknown> }> = [];
  const commands: string[] = [];
  let failStart = true;
  let failCleanup = true;
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      commands.push(command);
      if (command.startsWith("setsid sh -c") && failStart) {
        return { code: 1, stdout: "", stderr: "startup unavailable" };
      }
      if (command.includes('kill -TERM -"$pid"') && failCleanup) {
        return { code: 1, stdout: "", stderr: "cleanup unavailable" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(
    network,
    {
      get: async () => ({ taskId: "task:pivot" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    {
      append: async (event: { payload?: Record<string, unknown> }) => {
        events.push(event);
        return {};
      }
    } as unknown as ExecutionLog,
    store
  );

  const opened = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:key",
    options: { port: 22, user: "ops" }
  }, "task:pivot");

  assert.equal(opened.status, "degraded");
  assert.match(opened.error ?? "", /startup unavailable/);
  assert.match(opened.error ?? "", /cleanup unavailable/);
  const persisted = store.getDefinition(stableConnectivityId("route", opened.routeRef));
  assert.equal(persisted?.desiredState, "running");
  assert.equal(persisted?.definition.connectorCleanupPending, true);
  assert.match(String(persisted?.definition.lastFailureReason), /startup unavailable/);
  assert.match(String(persisted?.definition.lastFailureReason), /cleanup unavailable/);
  assert.ok(events.some((event) => event.payload?.transition === "open_failed"
    && String(event.payload?.failureReason).includes("cleanup unavailable")));

  const commandsBeforeStatus = commands.length;
  const [stillDegraded] = await manager.status(opened.routeRef);
  assert.equal(stillDegraded?.status, "degraded");
  assert.equal(commands.length, commandsBeforeStatus);

  failStart = false;
  failCleanup = false;
  const recovered = await manager.reconnect(opened.routeRef);
  assert.equal(recovered.routeRef, opened.routeRef);
  assert.equal(recovered.connectorRef, opened.connectorRef);
  assert.equal(recovered.status, "live");
  assert.equal(store.getDefinition(stableConnectivityId("route", opened.routeRef))?.definition.connectorCleanupPending, false);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("reconnect never starts SSH while previous connector cleanup is unconfirmed", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-reconnect-cleanup-");
  const commands: string[] = [];
  let listenerAvailable = true;
  let failCleanup = false;
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      commands.push(command);
      if (command.includes('kill -TERM -"$pid"') && failCleanup) {
        return { code: 1, stdout: "", stderr: "old connector cleanup unavailable" };
      }
      if (command.startsWith("nc -z")) {
        return { code: listenerAvailable ? 0 : 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  const manager = new RouteManager(
    network,
    {
      get: async () => ({ taskId: "task:pivot" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    { append: async () => ({}) } as unknown as ExecutionLog,
    store
  );
  const opened = await manager.open({
    connector: "ssh",
    pivotHostRef: "host:dmz",
    dialAddress: "192.0.2.10",
    targetCidrs: ["172.31.0.0/24"],
    credentialRef: "artifact:key",
    options: { port: 22, user: "ops" }
  }, "task:pivot");
  const startsBeforeReconnect = commands.filter((command) => command.startsWith("setsid sh -c")).length;
  listenerAvailable = false;
  assert.equal((await manager.status(opened.routeRef))[0]?.status, "degraded");
  failCleanup = true;

  await assert.rejects(() => manager.reconnect(opened.routeRef), /old connector cleanup unavailable/);

  assert.equal(commands.filter((command) => command.startsWith("setsid sh -c")).length, startsBeforeReconnect);
  let persisted = store.getDefinition(stableConnectivityId("route", opened.routeRef));
  assert.equal(persisted?.desiredState, "running");
  assert.equal(persisted?.status, "stale");
  assert.equal(persisted?.definition.connectorCleanupPending, true);
  assert.match(String(persisted?.definition.lastFailureReason), /old connector cleanup unavailable/);

  failCleanup = false;
  listenerAvailable = true;
  const recovered = await manager.reconnect(opened.routeRef);
  persisted = store.getDefinition(stableConnectivityId("route", opened.routeRef));
  assert.equal(recovered.routeRef, opened.routeRef);
  assert.equal(recovered.connectorRef, opened.connectorRef);
  assert.equal(recovered.status, "live");
  assert.equal(persisted?.definition.connectorCleanupPending, false);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("reconnect combines startup and compensation cleanup failures before retry", async () => {
  const root = await mkdtemp("/tmp/luanniao-route-reconnect-compensation-");
  const commands: string[] = [];
  let cleanupCalls = 0;
  let failStart = true;
  let failCompensationCleanup = true;
  const network = {
    connectorAddress: "192.168.1.2",
    connectorExec: async (command: string) => {
      commands.push(command);
      if (command.includes('kill -TERM -"$pid"')) {
        cleanupCalls += 1;
        if (cleanupCalls === 2 && failCompensationCleanup) {
          return { code: 1, stdout: "", stderr: "compensation cleanup unavailable" };
        }
      }
      if (command.startsWith("setsid sh -c") && failStart) {
        return { code: 1, stdout: "", stderr: "replacement startup unavailable" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    replaceRoutes: async () => undefined
  } as unknown as NetworkSandboxManager;
  const store = new ConnectivityStore(`${root}/state.sqlite`);
  store.upsertDefinition({
    kind: "route",
    externalId: "route:recoverable",
    desiredState: "stopped",
    status: "stale",
    hostRef: "host:dmz",
    processRef: "connector:recoverable",
    credentialRef: "artifact:key",
    definition: {
      transport: "ssh",
      pivotHostRef: "host:dmz",
      targetCidrs: ["172.31.0.0/24"],
      connectorRef: "connector:recoverable",
      connectionRef: "connection:recoverable",
      dialAddress: "192.0.2.10",
      dialPort: 22,
      dialUser: "ops",
      ownerTaskId: "task:pivot"
    }
  });
  const manager = new RouteManager(
    network,
    {
      get: async () => ({ taskId: "task:pivot" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    { append: async () => ({}) } as unknown as ExecutionLog,
    store
  );
  await manager.restore();

  await assert.rejects(
    () => manager.reconnect("route:recoverable"),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /replacement startup unavailable/);
      assert.match(error.message, /compensation cleanup unavailable/);
      return true;
    }
  );

  assert.equal(commands.filter((command) => command.startsWith("setsid sh -c")).length, 1);
  let persisted = store.getDefinition(stableConnectivityId("route", "route:recoverable"));
  assert.equal(persisted?.desiredState, "running");
  assert.equal(persisted?.status, "stale");
  assert.equal(persisted?.definition.connectorCleanupPending, true);
  assert.match(String(persisted?.definition.lastFailureReason), /replacement startup unavailable/);
  assert.match(String(persisted?.definition.lastFailureReason), /compensation cleanup unavailable/);

  failStart = false;
  failCompensationCleanup = false;
  const recovered = await manager.reconnect("route:recoverable");
  persisted = store.getDefinition(stableConnectivityId("route", "route:recoverable"));
  assert.equal(recovered.routeRef, "route:recoverable");
  assert.equal(recovered.connectorRef, "connector:recoverable");
  assert.equal(recovered.status, "live");
  assert.equal(persisted?.definition.connectorCleanupPending, false);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("reconnect never restarts Chisel while remote cleanup is unconfirmed", async () => {
  const harness = createChiselLifecycleHarness();
  const manager = new RouteManager(
    harness.network,
    {
      get: async () => ({ taskId: "task:credential" }),
      read: async () => "route-password"
    } as unknown as ArtifactStore,
    { append: async () => ({}) } as unknown as ExecutionLog
  );
  const { chisel } = await openManagedRoutePair(manager);
  harness.setRemoteStopFailure(true);
  await assert.rejects(() => manager.stop(chisel.routeRef), /remote cleanup unavailable/);
  harness.commands.length = 0;

  await assert.rejects(() => manager.reconnect(chisel.routeRef), /remote cleanup unavailable/);

  assert.equal(harness.commands.some((entry) => entry.stdin?.includes("R:0.0.0.0:")), false);
  assert.equal(harness.commands.some((entry) => entry.command.includes("uname")), false);
  const failed = (await manager.status(chisel.routeRef))[0];
  assert.equal(failed?.routeRef, chisel.routeRef);
  assert.equal(failed?.desiredState, "running");
  assert.equal(failed?.status, "stale");
  assert.match(failed?.error ?? "", /remote cleanup unavailable/);

  harness.setRemoteStopFailure(false);
  harness.commands.length = 0;
  const recovered = await manager.reconnect(chisel.routeRef);
  assert.equal(recovered.routeRef, chisel.routeRef);
  assert.equal(recovered.connectorRef, chisel.connectorRef);
  assert.equal(recovered.status, "live");
  assert.equal(harness.commands.some((entry) => entry.stdin?.includes("R:0.0.0.0:")), true);
});
