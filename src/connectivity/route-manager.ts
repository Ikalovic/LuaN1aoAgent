import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { NetworkRoute, NetworkSandboxManager } from "./network-sandbox-manager.js";
import type { ArtifactStore } from "../stores/artifact-store.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import { stableConnectivityId, type ConnectivityDefinition, type ConnectivityDesiredState, type ConnectivityStore } from "../stores/connectivity-store.js";

const CHISEL_VERSION = "1.10.1";
const TRANSPARENT_PROXY_OWNER = "runtime:transparent-proxy";
const CHISEL_ASSETS = {
  amd64: "0525aa3c5d457f2a4075e66221d5125d434bedf15006d3271c213f5cd6ff2230",
  arm64: "f55beb68fb99b69903df1adcff4197fbfdb82cb0ee596848c0f055dc219da983"
} as const;

export type RouteConnector = "ssh" | "chisel" | "socks5";

export type RouteOpenInput = {
  connector: RouteConnector;
  pivotHostRef: string;
  dialAddress?: string;
  targetCidrs: string[];
  credentialRef?: string;
  bootstrapConnectionRef?: string;
  options?: { host?: string; port?: number; user?: string };
};

export type ManagedRoute = {
  routeRef: string;
  connectorRef: string;
  connector: RouteConnector;
  pivotHostRef: string;
  dialAddress?: string;
  targetCidrs: string[];
  desiredState: ConnectivityDesiredState;
  status: "live" | "degraded" | "stale" | "closed";
  lastHeartbeat: string;
  error?: string;
  connectorCleanupPending: boolean;
  socksPort: number;
  ownerTaskId: string;
  connectionRef?: string;
  bootstrapConnectionRef?: string;
  credentialRef?: string;
  options: NonNullable<RouteOpenInput["options"]>;
};

export type RouteProjectionContext = Pick<ManagedRoute,
  "routeRef" | "connector" | "pivotHostRef" | "dialAddress" | "targetCidrs" | "status" | "lastHeartbeat" | "connectionRef"
>;

export type RouteStatus = Pick<ManagedRoute,
  "routeRef" | "connectorRef" | "connector" | "pivotHostRef" | "dialAddress" | "targetCidrs" | "desiredState" | "status" | "lastHeartbeat" | "error" | "connectionRef"
>;

export class RouteManager {
  private readonly routes = new Map<string, ManagedRoute>();
  private readonly pendingConnectorCleanups = new Map<string, ManagedRoute>();

  constructor(
    private readonly network: NetworkSandboxManager,
    private readonly artifactStore: ArtifactStore,
    private readonly executionLog: ExecutionLog,
    private readonly connectivityStore?: ConnectivityStore
  ) {}

  async restore(): Promise<void> {
    if (!this.connectivityStore) return;
    for (const definition of this.connectivityStore.listDefinitions("route")) {
      const route = managedRouteFromDefinition(definition);
      if (route) this.routes.set(route.routeRef, route);
    }
    await this.publishRoutes();
  }

  async open(input: RouteOpenInput, ownerTaskId: string): Promise<RouteStatus> {
    validateRouteInput(input);
    const connectorCredential = input.connector === "ssh" || input.connector === "socks5"
      ? await this.readConnectorCredential(input.credentialRef, input.connector)
      : undefined;
    if (input.connector === "chisel") {
      this.requireOwnedSshConnection(input.bootstrapConnectionRef!);
      if (!this.network.chiselEndpoint || !this.network.chiselAuth || !this.network.chiselFingerprint) {
        throw new Error("Chisel routes require LUANNIAO_CHISEL_PUBLIC_HOST to be reachable from the pivot");
      }
    }
    const routeRef = `route:${randomUUID()}`;
    const connectorRef = `connector:${randomUUID()}`;
    const socksPort = connectorPort(connectorRef);
    const dialAddress = routeDialAddress(input);
    const connectionRef = input.connector === "ssh"
      ? routeConnectionRef(routeRef)
      : input.bootstrapConnectionRef;
    let route: ManagedRoute = {
      routeRef,
      connectorRef,
      connector: input.connector,
      pivotHostRef: input.pivotHostRef,
      ...(dialAddress ? { dialAddress } : {}),
      targetCidrs: [...new Set(input.targetCidrs)].sort(),
      desiredState: "running",
      status: "stale",
      lastHeartbeat: new Date().toISOString(),
      connectorCleanupPending: false,
      socksPort,
      ownerTaskId,
      ...(connectionRef ? { connectionRef } : {}),
      ...(input.bootstrapConnectionRef ? { bootstrapConnectionRef: input.bootstrapConnectionRef } : {}),
      credentialRef: input.credentialRef,
      options: { port: input.options?.port, user: input.options?.user }
    };
    try {
      if (input.connector === "ssh") {
        await this.startSsh(route, input, connectorCredential);
      } else if (input.connector === "socks5") {
        await this.startSocks5(route, input, connectorCredential);
      } else {
        await this.startChisel(route, input);
      }
    } catch (startError) {
      let failure: unknown = startError;
      try {
        await this.stopRouteConnector(route);
      } catch (cleanupError) {
        failure = combineFailures(
          startError,
          cleanupError,
          `Route ${routeRef} startup failed and connector cleanup was not confirmed`
        );
        const cleanupPending: ManagedRoute = {
          ...route,
          desiredState: "stopped",
          status: "stale",
          error: failureMessage(failure),
          connectorCleanupPending: true,
          lastHeartbeat: new Date().toISOString()
        };
        this.pendingConnectorCleanups.set(routeRef, cleanupPending);
      }
      throw failure;
    }
    route = { ...route, status: "live", connectorCleanupPending: false, lastHeartbeat: new Date().toISOString() };
    this.routes.set(routeRef, route);
    try {
      await this.publishRoutes();
    } catch (publishError) {
      this.routes.delete(routeRef);
      let failure: unknown = publishError;
      try {
        await this.publishRoutes();
      } catch (rollbackError) {
        failure = combineFailures(
          failure,
          rollbackError,
          `Route ${routeRef} publication failed and the previous route table could not be restored`
        );
      }
      try {
        await this.stopRouteConnector(route);
      } catch (cleanupError) {
        failure = combineFailures(
          failure,
          cleanupError,
          `Route ${routeRef} publication failed and connector cleanup was not confirmed`
        );
        const cleanupPending = {
          ...route,
          desiredState: "stopped" as const,
          status: "stale" as const,
          error: failureMessage(failure),
          connectorCleanupPending: true,
          lastHeartbeat: new Date().toISOString()
        };
        this.pendingConnectorCleanups.set(routeRef, cleanupPending);
      }
      throw failure;
    }
    this.persistRoute(route, "running");
    this.persistOwnedSession(route, "running");
    await this.recordOwnedSession("opened", route);
    await this.record("opened", route);
    return publicRoute(route);
  }

  async replaceTransparentProxy(input: RouteOpenInput): Promise<RouteStatus> {
    if (input.connector !== "socks5") throw new Error("Transparent proxy requires a SOCKS5 connector");
    for (const route of [...this.routes.values()]) {
      if (route.ownerTaskId === TRANSPARENT_PROXY_OWNER && route.status !== "closed") {
        await this.forget(route.routeRef);
      }
    }
    return this.open(input, TRANSPARENT_PROXY_OWNER);
  }

  async status(routeRef?: string): Promise<RouteStatus[]> {
    const selected = routeRef ? [this.requireRoute(routeRef)] : [...this.routes.values()];
    const output: ManagedRoute[] = [];
    for (const route of selected) {
      if (route.desiredState !== "running"
        || route.status === "closed"
        || route.status === "stale"
        || route.connectorCleanupPending) {
        output.push(route);
        continue;
      }
      const probe = await this.probeRoute(route);
      const status = probe.live ? "live" : "degraded";
      const updated: ManagedRoute = {
        ...route,
        status,
        lastHeartbeat: new Date().toISOString(),
        ...(status === "live" ? { error: undefined } : { error: probe.error })
      };
      this.routes.set(route.routeRef, updated);
      this.persistOwnedSession(updated);
      this.persistRoute(updated);
      if (updated.status !== route.status) {
        await this.recordOwnedSession("health_changed", updated);
        await this.record("health_changed", updated);
      }
      output.push(updated);
    }
    return output.map(publicRoute);
  }

  capabilityRefsForTask(taskId: string): string[] {
    const refs = new Set<string>();
    for (const route of this.routes.values()) {
      if (route.ownerTaskId !== taskId) continue;
      refs.add(route.routeRef);
      if (route.connectionRef) refs.add(route.connectionRef);
    }
    return [...refs];
  }

  isTransparentProxyRoute(routeRef: string): boolean {
    return this.routes.get(routeRef)?.ownerTaskId === TRANSPARENT_PROXY_OWNER;
  }

  async forget(routeRef: string): Promise<RouteStatus> {
    const route = this.requireRoute(routeRef);
    const dependentRoute = this.dependentChiselRoute(route, true);
    if (dependentRoute) {
      throw new Error(`Route ${routeRef} backs ${dependentRoute.routeRef}; forget the dependent route first`);
    }
    if (route.desiredState !== "stopped" || route.error || route.connectorCleanupPending) {
      await this.stopRouteConnector(route);
    }
    const closed: ManagedRoute = { ...route, desiredState: "closed", status: "closed", lastHeartbeat: new Date().toISOString() };
    this.routes.delete(routeRef);
    this.connectivityStore?.deleteDefinition(stableConnectivityId("route", route.routeRef));
    if (route.connector === "ssh" && route.connectionRef) {
      this.connectivityStore?.deleteDefinition(stableConnectivityId("session", route.connectionRef));
    }
    await this.publishRoutes();
    await this.recordOwnedSession("forgotten", closed);
    await this.record("forgotten", closed);
    return publicRoute(closed);
  }

  async close(routeRef: string): Promise<RouteStatus> {
    return this.forget(routeRef);
  }

  async reconnect(routeRef: string): Promise<RouteStatus> {
    let route = this.routes.get(routeRef);
    if (!route) {
      await this.restore();
      route = this.routes.get(routeRef);
    }
    if (!route) throw new Error(`Route not found: ${routeRef}`);
    if (route.status === "live") {
      const [current] = await this.status(routeRef);
      if (current?.status === "live") return current;
      route = this.requireRoute(routeRef);
    }
    if (route.status === "closed") throw new Error(`Route was permanently closed: ${routeRef}`);
    route = { ...route, desiredState: "running", status: "stale", error: undefined, lastHeartbeat: new Date().toISOString() };
    this.routes.set(routeRef, route);
    this.persistOwnedSession(route, "running");
    this.persistRoute(route, "running");
    try {
      await this.publishRoutes();
    } catch (publishError) {
      return this.failReconnect(route, publishError, route.connectorCleanupPending);
    }
    try {
      await this.stopRouteConnector(route);
      route = { ...route, connectorCleanupPending: false };
      this.routes.set(routeRef, route);
    } catch (cleanupError) {
      return this.failReconnect(route, cleanupError, true);
    }
    try {
      const input = routeInput(route);
      if (route.connector === "ssh") await this.startSsh(route, input);
      else if (route.connector === "socks5") await this.startSocks5(route, input);
      else await this.startChisel(route, input);
      route = {
        ...route,
        desiredState: "running",
        status: "live",
        error: undefined,
        connectorCleanupPending: false,
        lastHeartbeat: new Date().toISOString()
      };
      this.routes.set(routeRef, route);
      this.persistOwnedSession(route, "running");
      this.persistRoute(route, "running");
      await this.publishRoutes();
    } catch (startError) {
      let failure: unknown = startError;
      let connectorCleanupPending = false;
      try {
        await this.stopRouteConnector(route);
      } catch (cleanupError) {
        connectorCleanupPending = true;
        failure = combineFailures(
          startError,
          cleanupError,
          `Route ${routeRef} reconnect failed and connector cleanup was not confirmed`
        );
      }
      return this.failReconnect(route, failure, connectorCleanupPending);
    }
    await this.recordOwnedSession("reconnected", route);
    await this.record("reconnected", route);
    return publicRoute(route);
  }

  async stop(routeRef: string): Promise<RouteStatus> {
    const route = this.requireRoute(routeRef);
    if (route.status === "closed") return publicRoute(route);
    const dependentRoute = this.dependentChiselRoute(route, false);
    if (dependentRoute) {
      throw new Error(`Route ${routeRef} backs ${dependentRoute.routeRef}; stop the dependent route first`);
    }
    let stopped: ManagedRoute = {
      ...route,
      desiredState: "stopped",
      status: "stale",
      error: undefined,
      connectorCleanupPending: true,
      lastHeartbeat: new Date().toISOString()
    };
    this.routes.set(routeRef, stopped);
    this.persistOwnedSession(stopped, "stopped");
    this.persistRoute(stopped, "stopped");
    await this.publishRoutes();
    try {
      await this.stopRouteConnector(stopped);
    } catch (error) {
      stopped = {
        ...stopped,
        error: error instanceof Error ? error.message : String(error),
        connectorCleanupPending: true,
        lastHeartbeat: new Date().toISOString()
      };
      this.routes.set(routeRef, stopped);
      this.persistOwnedSession(stopped, "stopped");
      this.persistRoute(stopped, "stopped");
      await this.recordOwnedSession("stop_failed", stopped);
      await this.record("stop_failed", stopped);
      throw error;
    }
    stopped = { ...stopped, connectorCleanupPending: false };
    this.routes.set(routeRef, stopped);
    this.persistOwnedSession(stopped, "stopped");
    this.persistRoute(stopped, "stopped");
    await this.recordOwnedSession("stopped", stopped);
    await this.record("stopped", stopped);
    return publicRoute(stopped);
  }

  async stopAll(): Promise<void> {
    const failures: unknown[] = [];
    const routes = [...this.routes.values()]
      .filter((route) => route.status !== "closed")
      .sort((left, right) => Number(right.connector === "chisel") - Number(left.connector === "chisel"));
    for (const route of routes) {
      try {
        await this.stop(route.routeRef);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const route of this.pendingConnectorCleanups.values()) {
      try {
        await this.stopRouteConnector(route);
        this.pendingConnectorCleanups.delete(route.routeRef);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "One or more routes could not be stopped");
  }

  async suspendAll(): Promise<void> {
    const failures: unknown[] = [];
    const failedBackingConnections = new Set<string>();
    const routes = [...this.routes.values()]
      .filter((route) => route.status !== "closed")
      .sort((left, right) => Number(right.connector === "chisel") - Number(left.connector === "chisel"));
    for (const route of routes) {
      if (route.desiredState === "stopped" && !route.error && !route.connectorCleanupPending) continue;
      if (route.connector === "ssh" && route.connectionRef && failedBackingConnections.has(route.connectionRef)) {
        continue;
      }
      let failure: string | undefined;
      try {
        await this.stopRouteConnector(route);
      } catch (error) {
        failures.push(error);
        failure = error instanceof Error ? error.message : String(error);
        const backingConnectionRef = route.connector === "chisel"
          ? route.bootstrapConnectionRef ?? route.connectionRef
          : undefined;
        if (backingConnectionRef) failedBackingConnections.add(backingConnectionRef);
      }
      const suspended: ManagedRoute = {
        ...route,
        status: "stale",
        error: failure,
        connectorCleanupPending: Boolean(failure),
        lastHeartbeat: new Date().toISOString()
      };
      this.routes.set(route.routeRef, suspended);
      this.persistOwnedSession(suspended, suspended.desiredState);
      this.persistRoute(suspended, suspended.desiredState);
    }
    for (const route of this.pendingConnectorCleanups.values()) {
      try {
        await this.stopRouteConnector(route);
        this.pendingConnectorCleanups.delete(route.routeRef);
      } catch (error) {
        failures.push(error);
      }
    }
    await this.publishRoutes();
    if (failures.length > 0) throw new AggregateError(failures, "One or more route connectors could not be suspended");
  }

  async recoverDesired(): Promise<RouteStatus[]> {
    const recovered: RouteStatus[] = [];
    const routes = [...this.routes.values()].sort(
      (left, right) => Number(left.connector === "chisel") - Number(right.connector === "chisel")
    );
    for (const route of routes) {
      if (route.desiredState !== "running") continue;
      try {
        recovered.push(await this.reconnect(route.routeRef));
      } catch {
        recovered.push(publicRoute(this.requireRoute(route.routeRef)));
      }
    }
    return recovered;
  }

  async closeAll(): Promise<void> {
    await this.stopAll();
  }

  snapshotForProjection(): RouteProjectionContext[] {
    return [...this.routes.values()]
      .filter((route) => route.status !== "closed")
      .map(({ routeRef, connector, pivotHostRef, dialAddress, targetCidrs, status, lastHeartbeat, connectionRef }) => ({
        routeRef,
        connector,
        pivotHostRef,
        ...(dialAddress ? { dialAddress } : {}),
        targetCidrs: [...targetCidrs],
        status,
        lastHeartbeat,
        ...(connectionRef ? { connectionRef } : {})
      }));
  }

  private async startSsh(route: ManagedRoute, input: RouteOpenInput, credential?: string): Promise<void> {
    const dialAddress = routeDialAddress(input);
    if (!dialAddress || !input.options?.user || !input.credentialRef) {
      throw new Error("SSH route requires dialAddress, options.user, and credentialRef");
    }
    credential ??= await this.readConnectorCredential(input.credentialRef, "ssh");
    const credentialPath = `/run/luanniao/credentials/${safeRef(route.connectorRef)}`;
    const mode = credential.includes("PRIVATE KEY") ? "identity" : "password";
    const stored = await this.network.connectorExec(`umask 077; cat > ${quote(credentialPath)}`, credential);
    if (stored.code !== 0) throw new Error(`Failed to stage SSH credential: ${stored.stderr}`);
    const pidFile = `/run/luanniao/connectors/${safeRef(route.connectorRef)}.pid`;
    const controlPath = `/run/luanniao/connectors/${safeRef(route.connectorRef)}.sock`;
    const target = `${input.options.user}@${dialAddress}`;
    const common = `ssh -N -T -M -S ${quote(controlPath)} -o BatchMode=${mode === "identity" ? "yes" : "no"} -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/run/luanniao/known_hosts -p ${input.options.port ?? 22} -D 0.0.0.0:${route.socksPort}`;
    const command = mode === "identity"
      ? `${common} -i ${quote(credentialPath)} ${quote(target)}`
      : `sshpass -f ${quote(credentialPath)} ${common} ${quote(target)}`;
    const started = await this.network.connectorExec(`setsid sh -c ${quote(command)} >/run/luanniao/connectors/${safeRef(route.connectorRef)}.log 2>&1 & echo $! > ${quote(pidFile)}`);
    if (started.code !== 0) throw new Error(`Failed to start SSH connector: ${started.stderr}`);
    await this.waitForSocks(route.socksPort, pidFile, `/run/luanniao/connectors/${safeRef(route.connectorRef)}.log`);
    const verified = await this.network.connectorExec(`ssh -T -S ${quote(controlPath)} -o BatchMode=yes -p ${input.options.port ?? 22} ${quote(target)} -- true`);
    if (verified.code !== 0) throw new Error(`SSH command channel verification failed: ${verified.stderr || verified.stdout}`);
  }

  private async startSocks5(route: ManagedRoute, input: RouteOpenInput, credential?: string): Promise<void> {
    const dialAddress = routeDialAddress(input);
    if (!dialAddress || !input.options?.user || !input.credentialRef) {
      throw new Error("SOCKS5 route requires dialAddress, options.user, and credentialRef");
    }
    credential ??= await this.readConnectorCredential(input.credentialRef, "socks5");
    if (Buffer.byteLength(input.options.user) > 255 || Buffer.byteLength(credential) > 255) {
      throw new Error("SOCKS5 username and password must contain at most 255 bytes");
    }
    const credentialPath = `/run/luanniao/credentials/${safeRef(route.connectorRef)}`;
    const stored = await this.network.connectorExec(`umask 077; cat > ${quote(credentialPath)}`, credential);
    if (stored.code !== 0) throw new Error(`Failed to stage SOCKS5 credential: ${stored.stderr}`);
    const pidFile = `/run/luanniao/connectors/${safeRef(route.connectorRef)}.pid`;
    const logFile = `/run/luanniao/connectors/${safeRef(route.connectorRef)}.log`;
    const upstream = `${dialAddress}:${input.options.port ?? 1080}`;
    const command = [
      "socks-connector",
      "--listen", `0.0.0.0:${route.socksPort}`,
      "--upstream", upstream,
      "--username", input.options.user,
      "--password-file", credentialPath
    ].map(quote).join(" ");
    const started = await this.network.connectorExec(
      `setsid sh -c ${quote(command)} >${quote(logFile)} 2>&1 & echo $! > ${quote(pidFile)}`
    );
    if (started.code !== 0) throw new Error(`Failed to start SOCKS5 connector: ${started.stderr}`);
    await this.waitForSocks(route.socksPort, pidFile, logFile, "SOCKS5");
  }

  private async startChisel(route: ManagedRoute, input: RouteOpenInput): Promise<void> {
    const bootstrapConnectionRef = input.bootstrapConnectionRef;
    if (!bootstrapConnectionRef) throw new Error("Chisel route requires bootstrapConnectionRef");
    const endpoint = this.network.chiselEndpoint;
    const auth = this.network.chiselAuth;
    const fingerprint = this.network.chiselFingerprint;
    if (!endpoint || !auth || !fingerprint) {
      throw new Error("Chisel routes require LUANNIAO_CHISEL_PUBLIC_HOST to be reachable from the pivot");
    }
    const remoteName = safeRef(route.connectorRef);
    const architecture = await this.runBootstrapCommand({
      connectionRef: bootstrapConnectionRef,
      command: {
        argv: ["uname", "-m"],
        timeoutMs: 15_000
      }
    });
    if (architecture.timedOut) throw new Error("Timed out while detecting the Chisel pivot architecture");
    if (architecture.code !== 0) throw new Error(`Failed to detect the Chisel pivot architecture: ${architecture.stderr}`);
    const asset = chiselAsset(architecture.stdout);
    const binaryPath = await this.uploadChiselAsset(bootstrapConnectionRef, remoteName, asset);
    const start = [
      "set -eu",
      `test -x ${quote(binaryPath)}`,
      `AUTH=${quote(auth)} nohup ${quote(binaryPath)} client --fingerprint ${quote(fingerprint)} ${quote(endpoint)} R:0.0.0.0:${route.socksPort}:socks </dev/null >/tmp/${remoteName}.log 2>&1 &`,
      `echo $! >/tmp/${remoteName}.pid`
    ].join("\n");
    const remote = await this.runBootstrapCommand({
      connectionRef: bootstrapConnectionRef,
      command: {
        argv: ["sh", "-s"],
        stdin: start,
        timeoutMs: 30_000
      }
    });
    if (remote.timedOut) throw new Error("Timed out while starting the remote Chisel client");
    if (remote.code !== 0) throw new Error(`Failed to start remote Chisel client: ${remote.stderr}`);
    await this.waitForSocks(route.socksPort);
  }

  private async uploadChiselAsset(
    connectionRef: string,
    remoteName: string,
    asset: { architecture: keyof typeof CHISEL_ASSETS; sha256: string }
  ): Promise<string> {
    const owned = this.requireOwnedSshConnection(connectionRef);
    const bundlePath = `/opt/luanniao/chisel/chisel_${CHISEL_VERSION}_linux_${asset.architecture}.gz`;
    const binaryPath = `/tmp/luanniao-chisel-${CHISEL_VERSION}-${asset.architecture}`;
    const gzipTemporaryPath = `/tmp/${remoteName}.chisel.gz.tmp`;
    const binaryTemporaryPath = `/tmp/${remoteName}.chisel.bin.tmp`;
    const install = [
      "set -eu",
      "umask 077",
      `cat > ${quote(gzipTemporaryPath)}`,
      `printf '%s  %s\\n' ${quote(asset.sha256)} ${quote(gzipTemporaryPath)} | sha256sum -c -`,
      `gzip -dc ${quote(gzipTemporaryPath)} > ${quote(binaryTemporaryPath)}`,
      `chmod 0700 ${quote(binaryTemporaryPath)}`,
      `mv -f ${quote(binaryTemporaryPath)} ${quote(binaryPath)}`,
      `rm -f ${quote(gzipTemporaryPath)}`
    ].join("\n");
    const timeoutSeconds = 30;
    const remoteCommand = `sh -c ${quote(install)}`;
    const uploaded = await this.network.connectorExec(
      `timeout -k 2s ${timeoutSeconds}s ssh -T -S ${quote(owned.controlPath)} -o BatchMode=yes -p ${owned.port} ${quote(owned.target)} -- ${quote(remoteCommand)} < ${quote(bundlePath)}`
    );
    if (uploaded.code === 124 || uploaded.code === 137) throw new Error("Timed out while deploying the Chisel client");
    if (uploaded.code !== 0) throw new Error(`Failed to deploy the Chisel client: ${uploaded.stderr || uploaded.stdout}`);
    return binaryPath;
  }

  private async runBootstrapCommand(
    input: {
      connectionRef: string;
      command: { argv: string[]; stdin?: string; timeoutMs: number };
    }
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const owned = this.requireOwnedSshConnection(input.connectionRef);
    const remoteCommand = input.command.argv.map(quote).join(" ");
    const timeoutSeconds = Math.max(1, Math.ceil(input.command.timeoutMs / 1_000));
    const result = await this.network.connectorExec(
      `timeout -k 2s ${timeoutSeconds}s ssh -T -S ${quote(owned.controlPath)} -o BatchMode=yes -p ${owned.port} ${quote(owned.target)} -- ${remoteCommand}`,
      input.command.stdin
    );
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.code === 124 || result.code === 137
    };
  }

  private requireOwnedSshConnection(connectionRef: string): { controlPath: string; target: string; port: number } {
    const owned = [...this.routes.values()].find((route) =>
      route.connector === "ssh"
      && route.connectionRef === connectionRef
      && route.status === "live"
    );
    if (!owned) throw new Error(`Managed Chisel requires a live RouteManager SSH connection: ${connectionRef}`);
    if (!owned.dialAddress || !owned.options.user) {
      throw new Error(`Owned SSH connection is incomplete: ${connectionRef}`);
    }
    return {
      controlPath: `/run/luanniao/connectors/${safeRef(owned.connectorRef)}.sock`,
      target: `${owned.options.user}@${owned.dialAddress}`,
      port: owned.options.port ?? 22
    };
  }

  private async waitForSocks(port: number, pidFile?: string, logFile?: string, connectorLabel = "SSH"): Promise<void> {
    let lastError = "SOCKS readiness timed out";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = await this.network.connectorExec(`nc -z 127.0.0.1 ${port}`);
      if (probe.code === 0) return;
      lastError = probe.stderr || lastError;
      if (pidFile) {
        const process = await this.network.connectorExec(`pid=$(cat ${quote(pidFile)} 2>/dev/null || true); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null`);
        if (process.code !== 0) break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (logFile) {
      const log = await this.network.connectorExec(`tail -c 4096 ${quote(logFile)} 2>/dev/null || true`);
      const detail = (log.stdout || log.stderr).trim();
      if (detail) throw new Error(`${connectorLabel} connector failed: ${detail}`);
    }
    throw new Error(lastError);
  }

  private async probeRoute(route: ManagedRoute): Promise<{ live: boolean; error: string }> {
    const listener = await this.network.connectorExec(`nc -z 127.0.0.1 ${route.socksPort}`);
    if (listener.code !== 0) {
      return { live: false, error: listener.stderr || "SOCKS listener is unavailable" };
    }
    if (route.connector !== "chisel") return { live: true, error: "" };
    const bootstrapConnectionRef = route.bootstrapConnectionRef ?? route.connectionRef;
    if (!bootstrapConnectionRef) return { live: false, error: "Chisel bootstrap connection is unavailable" };
    try {
      const remote = await this.runBootstrapCommand({
        connectionRef: bootstrapConnectionRef,
        command: {
          argv: ["sh", "-s"],
          stdin: chiselProcessProbeCommand(route.connectorRef),
          timeoutMs: 5_000
        }
      });
      if (!remote.timedOut && remote.code === 0) return { live: true, error: "" };
      return {
        live: false,
        error: remote.timedOut
          ? "Chisel pivot process health check timed out"
          : remote.stderr || remote.stdout || "Chisel pivot process is unavailable"
      };
    } catch (error) {
      return { live: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async readCredential(credentialRef: string): Promise<string> {
    const record = await this.artifactStore.get(credentialRef);
    if (!record) throw new Error(`Credential artifact is unavailable: ${credentialRef}`);
    const value = await this.artifactStore.read(credentialRef);
    if (!value || value.length > 1 << 20) throw new Error("Credential artifact is empty or too large");
    return value.trimEnd();
  }

  private async readConnectorCredential(
    credentialRef: string | undefined,
    connector: "ssh" | "socks5"
  ): Promise<string> {
    if (!credentialRef) throw new Error(`${connector === "ssh" ? "SSH" : "SOCKS5"} route requires credentialRef`);
    return this.readCredential(credentialRef);
  }

  private async stopConnector(route: ManagedRoute): Promise<void> {
    const pidFile = `/run/luanniao/connectors/${safeRef(route.connectorRef)}.pid`;
    const controlPath = `/run/luanniao/connectors/${safeRef(route.connectorRef)}.sock`;
    const credentialPath = `/run/luanniao/credentials/${safeRef(route.connectorRef)}`;
    const result = await this.network.connectorExec(`pid=$(cat ${quote(pidFile)} 2>/dev/null || true); [ -z "$pid" ] || kill -TERM -"$pid" 2>/dev/null || true; rm -f ${quote(pidFile)} ${quote(controlPath)} ${quote(credentialPath)}`);
    if (result.code !== 0) {
      throw new Error(`Failed to stop connector ${route.connectorRef}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    }
  }

  private async stopRouteConnector(route: ManagedRoute): Promise<void> {
    await this.stopConnector(route);
    const bootstrapConnectionRef = route.bootstrapConnectionRef ?? route.connectionRef;
    if (route.connector === "chisel" && bootstrapConnectionRef) {
      const remoteStop = await this.runBootstrapCommand({
        connectionRef: bootstrapConnectionRef,
        command: {
          argv: ["sh", "-s"],
          stdin: chiselProcessStopCommand(route.connectorRef),
          timeoutMs: 15_000
        }
      });
      if (remoteStop.timedOut) throw new Error(`Timed out while stopping Chisel connector ${route.connectorRef}`);
      if (remoteStop.code !== 0) throw new Error(`Failed to stop Chisel connector ${route.connectorRef}: ${remoteStop.stderr || remoteStop.stdout}`);
      return;
    }
    const closed = await this.network.connectorExec(
      `for _ in $(seq 1 50); do nc -z 127.0.0.1 ${route.socksPort} >/dev/null 2>&1 || exit 0; sleep 0.1; done; exit 1`
    );
    if (closed.code !== 0) throw new Error(`Connector ${route.connectorRef} did not stop listening`);
  }

  private async failReconnect(route: ManagedRoute, error: unknown, connectorCleanupPending: boolean): Promise<never> {
    let failure = error;
    let failed: ManagedRoute = {
      ...route,
      desiredState: "running",
      status: "stale",
      error: failureMessage(failure),
      connectorCleanupPending,
      lastHeartbeat: new Date().toISOString()
    };
    this.routes.set(route.routeRef, failed);
    this.persistOwnedSession(failed, "running");
    this.persistRoute(failed, "running");
    try {
      await this.publishRoutes();
    } catch (publishError) {
      failure = combineFailures(
        failure,
        publishError,
        `Route ${route.routeRef} reconnect failure could not be published`
      );
      failed = { ...failed, error: failureMessage(failure), lastHeartbeat: new Date().toISOString() };
      this.routes.set(route.routeRef, failed);
      this.persistOwnedSession(failed, "running");
      this.persistRoute(failed, "running");
    }
    await this.recordOwnedSession("reconnect_failed", failed);
    await this.record("reconnect_failed", failed);
    throw failure;
  }

  private async publishRoutes(): Promise<void> {
    const socksHost = this.network.connectorAddress;
    if (!socksHost) throw new Error("Connector address is unavailable");
    const routes: NetworkRoute[] = [];
    for (const route of this.routes.values()) {
      if (route.desiredState !== "running" || route.status === "closed") continue;
      for (const cidr of route.targetCidrs) {
        routes.push({
          routeRef: route.routeRef,
          cidr,
          prefixLength: Number(cidr.split("/")[1]),
          socksHost,
          socksPort: route.socksPort,
          ...(route.connectionRef ? { connectionRef: route.connectionRef } : {})
        });
      }
    }
    await this.network.replaceRoutes(routes);
  }

  private requireRoute(routeRef: string): ManagedRoute {
    const route = this.routes.get(routeRef);
    if (!route) throw new Error(`Route not found: ${routeRef}`);
    return route;
  }

  private dependentChiselRoute(route: ManagedRoute, includeStopped: boolean): ManagedRoute | undefined {
    if (route.connector !== "ssh" || !route.connectionRef) return undefined;
    return [...this.routes.values()].find((candidate) => (
      candidate.connector === "chisel"
      && candidate.bootstrapConnectionRef === route.connectionRef
      && candidate.status !== "closed"
      && (includeStopped || candidate.desiredState === "running" || Boolean(candidate.error))
    ));
  }

  private async record(transition: string, route: ManagedRoute): Promise<void> {
    await this.executionLog.append({
      taskId: route.ownerTaskId,
      role: "runtime",
      eventType: "connectivity_observation",
      summary: `${route.connector} route ${route.routeRef} is ${route.status}`,
      payload: {
        observationKind: "route",
        transition,
        routeRef: route.routeRef,
        connector: route.connector,
        pivotHostRef: route.pivotHostRef,
        targetCidrs: route.targetCidrs,
        status: route.status,
        lastHeartbeat: route.lastHeartbeat,
        ...(route.connectionRef ? { connectionRef: route.connectionRef } : {}),
        ...(route.bootstrapConnectionRef ? { bootstrapConnectionRef: route.bootstrapConnectionRef } : {}),
        ...(route.credentialRef ? { credentialRef: route.credentialRef } : {}),
        ...(route.dialAddress ? { dialAddress: route.dialAddress } : {}),
        ...(route.options.port ? { dialPort: route.options.port } : {}),
        ...(route.options.user ? { dialUser: route.options.user } : {}),
        ...(route.error ? { failureReason: route.error } : {})
      }
    });
  }

  private async recordOwnedSession(transition: string, route: ManagedRoute): Promise<void> {
    if (route.connector !== "ssh" || !route.connectionRef) return;
    await this.executionLog.append({
      taskId: route.ownerTaskId,
      role: "runtime",
      eventType: "connectivity_observation",
      summary: `ssh connection ${route.connectionRef} is ${route.status}`,
      payload: {
        observationKind: "session",
        transition,
        connectionRef: route.connectionRef,
        sessionType: "shell",
        hostRef: route.pivotHostRef,
        routeRef: route.routeRef,
        connectorRef: route.connectorRef,
        transport: "ssh",
        status: route.status,
        lastHeartbeat: route.lastHeartbeat,
        ...(route.dialAddress ? { dialAddress: route.dialAddress } : {}),
        ...(route.options.port ? { dialPort: route.options.port } : {}),
        ...(route.options.user ? { dialUser: route.options.user } : {}),
        ...(route.error ? { failureReason: route.error } : {})
      }
    });
  }

  private persistOwnedSession(route: ManagedRoute, desiredState: ConnectivityDesiredState = route.desiredState): void {
    if (!this.connectivityStore || route.connector !== "ssh" || !route.connectionRef) return;
    this.connectivityStore.upsertDefinition({
      kind: "session",
      externalId: route.connectionRef,
      desiredState,
      status: route.status,
      sessionType: "shell",
      hostRef: route.pivotHostRef,
      processRef: route.connectorRef,
      controlRef: `/run/luanniao/connectors/${safeRef(route.connectorRef)}.sock`,
      credentialRef: route.credentialRef,
      definition: {
        runtimeManaged: true,
        transport: "ssh",
        dialAddress: route.dialAddress ?? "",
        port: route.options.port ?? 22,
        user: route.options.user ?? "",
        routeRef: route.routeRef,
        connectorRef: route.connectorRef,
        routeOwned: true,
        commandVerified: route.status === "live",
        connectorCleanupPending: route.connectorCleanupPending,
        ownerTaskId: route.ownerTaskId,
        lastFailureReason: route.error ?? ""
      }
    });
  }

  private persistRoute(route: ManagedRoute, desiredState: ConnectivityDesiredState = route.desiredState): void {
    if (!this.connectivityStore) return;
    this.connectivityStore.upsertDefinition({
      kind: "route",
      externalId: route.routeRef,
      desiredState,
      status: route.status,
      hostRef: route.pivotHostRef,
      processRef: route.connectorRef,
      credentialRef: route.credentialRef,
      definition: {
        runtimeManaged: true,
        transport: route.connector,
        pivotHostRef: route.pivotHostRef,
        dialAddress: route.dialAddress ?? "",
        targetCidrs: route.targetCidrs,
        connectorRef: route.connectorRef,
        connectionRef: route.connectionRef ?? "",
        bootstrapConnectionRef: route.bootstrapConnectionRef ?? "",
        dialPort: route.options.port ?? 0,
        dialUser: route.options.user ?? "",
        connectorCleanupPending: route.connectorCleanupPending,
        ownerTaskId: route.ownerTaskId,
        lastFailureReason: route.error ?? ""
      }
    });
  }
}

function managedRouteFromDefinition(definition: ConnectivityDefinition): ManagedRoute | undefined {
  if (definition.kind !== "route") return undefined;
  const connector = definition.definition.transport;
  const pivotHostRef = definition.definition.pivotHostRef;
  const targetCidrs = definition.definition.targetCidrs;
  const connectorRef = definition.definition.connectorRef ?? definition.processRef;
  const ownerTaskId = definition.definition.ownerTaskId;
  const dialAddress = definition.definition.dialAddress ?? definition.definition.dialHost;
  const connectionRef = definition.definition.connectionRef
    ?? definition.definition.sessionRef
    ?? definition.definition.pivotSessionRef;
  const bootstrapConnectionRef = definition.definition.bootstrapConnectionRef
    ?? (connector === "chisel"
      ? definition.definition.pivotSessionRef ?? definition.definition.sessionRef
      : undefined);
  if ((connector !== "ssh" && connector !== "chisel" && connector !== "socks5")
    || typeof pivotHostRef !== "string" || !pivotHostRef
    || !Array.isArray(targetCidrs) || !targetCidrs.every((value) => typeof value === "string")
    || typeof connectorRef !== "string" || !connectorRef
    || typeof ownerTaskId !== "string" || !ownerTaskId) return undefined;
  const status = definition.status === "closed" ? "closed" : "stale";
  return {
    routeRef: definition.externalId,
    connectorRef,
    connector,
    pivotHostRef,
    ...(typeof dialAddress === "string" && dialAddress ? { dialAddress } : {}),
    targetCidrs: [...targetCidrs],
    desiredState: definition.desiredState,
    status,
    lastHeartbeat: definition.lastHeartbeat ?? definition.updatedAt,
    connectorCleanupPending: definition.definition.connectorCleanupPending === true,
    socksPort: connectorPort(connectorRef),
    ownerTaskId,
    ...((typeof connectionRef === "string" && connectionRef)
      ? { connectionRef }
      : connector === "ssh"
        ? { connectionRef: routeConnectionRef(definition.externalId) }
        : {}),
    ...(typeof bootstrapConnectionRef === "string" && bootstrapConnectionRef ? { bootstrapConnectionRef } : {}),
    ...(definition.credentialRef ? { credentialRef: definition.credentialRef } : {}),
    options: {
      ...(typeof definition.definition.dialPort === "number" && definition.definition.dialPort > 0
        ? { port: definition.definition.dialPort }
        : {}),
      ...(typeof definition.definition.dialUser === "string" && definition.definition.dialUser
        ? { user: definition.definition.dialUser }
        : {})
    },
    ...(typeof definition.definition.lastFailureReason === "string" && definition.definition.lastFailureReason
      ? { error: definition.definition.lastFailureReason }
      : {})
  };
}

function routeInput(route: ManagedRoute): RouteOpenInput {
  return {
    connector: route.connector,
    pivotHostRef: route.pivotHostRef,
    ...(route.dialAddress ? { dialAddress: route.dialAddress } : {}),
    targetCidrs: [...route.targetCidrs],
    ...(route.credentialRef ? { credentialRef: route.credentialRef } : {}),
    ...(route.bootstrapConnectionRef ? { bootstrapConnectionRef: route.bootstrapConnectionRef } : {}),
    options: { ...route.options }
  };
}

function publicRoute(route: ManagedRoute): RouteStatus {
  return {
    routeRef: route.routeRef,
    connectorRef: route.connectorRef,
    connector: route.connector,
    pivotHostRef: route.pivotHostRef,
    ...(route.dialAddress ? { dialAddress: route.dialAddress } : {}),
    targetCidrs: [...route.targetCidrs],
    desiredState: route.desiredState,
    status: route.status,
    lastHeartbeat: route.lastHeartbeat,
    ...(route.connectionRef ? { connectionRef: route.connectionRef } : {}),
    ...(route.error ? { error: route.error } : {})
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineFailures(primary: unknown, secondary: unknown, message: string): AggregateError {
  return new AggregateError(
    [primary, secondary],
    `${message}: ${failureMessage(primary)}; ${failureMessage(secondary)}`
  );
}

function validateRouteInput(input: RouteOpenInput): void {
  if (input.connector !== "ssh" && input.connector !== "chisel" && input.connector !== "socks5") throw new Error("Unsupported route connector");
  if (!input.pivotHostRef.trim()) throw new Error("pivotHostRef is required");
  if (isDockerInfrastructureAlias(input.pivotHostRef)) throw new Error("pivotHostRef must identify the real pivot host");
  const dialAddress = routeDialAddress(input);
  if (dialAddress !== undefined && (!dialAddress || dialAddress.length > 255 || /[\s\0]/.test(dialAddress))) {
    throw new Error("Invalid dialAddress");
  }
  if (!input.targetCidrs.length || input.targetCidrs.length > 1024) throw new Error("targetCidrs must contain 1-1024 CIDRs");
  for (const cidr of input.targetCidrs) {
    const [host, prefixText] = cidr.split("/");
    const prefix = Number(prefixText);
    if (isIP(host) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
  }
  if (input.options?.port !== undefined && (!Number.isInteger(input.options.port) || input.options.port < 1 || input.options.port > 65_535)) throw new Error("Invalid connector port");
  if (input.connector === "ssh") {
    if (!dialAddress || !input.options?.user?.trim() || !input.credentialRef?.trim()) {
      throw new Error("SSH route requires dialAddress, options.user, and credentialRef");
    }
  } else if (input.connector === "socks5") {
    if (!dialAddress || !input.options?.user?.trim() || !input.credentialRef?.trim()) {
      throw new Error("SOCKS5 route requires dialAddress, options.user, and credentialRef");
    }
  } else if (!input.bootstrapConnectionRef?.trim()) {
    throw new Error("Chisel route requires bootstrapConnectionRef");
  }
}

function routeDialAddress(input: RouteOpenInput): string | undefined {
  return input.dialAddress?.trim() || input.options?.host?.trim() || undefined;
}

function routeConnectionRef(routeRef: string): string {
  return `connection:${routeRef.replace(/^route:/, "")}`;
}

function isDockerInfrastructureAlias(value: string): boolean {
  return /^(?:host|gateway)\.docker\.internal$/i.test(value.trim());
}

function connectorPort(connectorRef: string): number {
  return 20_000 + (Number.parseInt(createHash("sha256").update(connectorRef).digest("hex").slice(0, 6), 16) % 20_000);
}

function chiselAsset(architecture: string): { architecture: keyof typeof CHISEL_ASSETS; sha256: string } {
  const normalized = architecture.trim().split(/\s+/)[0]?.toLowerCase();
  const asset = normalized === "x86_64" || normalized === "amd64"
    ? "amd64"
    : normalized === "aarch64" || normalized === "arm64"
      ? "arm64"
      : undefined;
  if (!asset) throw new Error(`Unsupported Chisel pivot architecture: ${normalized || "unknown"}`);
  return { architecture: asset, sha256: CHISEL_ASSETS[asset] };
}

function chiselProcessProbeCommand(connectorRef: string): string {
  const pidPath = `/tmp/${safeRef(connectorRef)}.pid`;
  return `pid=$(cat ${quote(pidPath)} 2>/dev/null || true); [ -n "$pid" ] || exit 1; kill -0 "$pid" 2>/dev/null || exit 1; case "$(readlink /proc/$pid/exe 2>/dev/null || true)" in /tmp/luanniao-chisel-${CHISEL_VERSION}-*) exit 0 ;; *) exit 1 ;; esac`;
}

function chiselProcessStopCommand(connectorRef: string): string {
  const pidPath = `/tmp/${safeRef(connectorRef)}.pid`;
  return [
    "set -eu",
    `pid=$(cat ${quote(pidPath)} 2>/dev/null || true)`,
    `managed_chisel() { case "$(readlink /proc/$pid/exe 2>/dev/null || true)" in /tmp/luanniao-chisel-${CHISEL_VERSION}-*) return 0 ;; *) return 1 ;; esac; }`,
    "if [ -n \"$pid\" ] && managed_chisel; then",
    "  kill -TERM \"$pid\" 2>/dev/null || true",
    "  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do managed_chisel || break; sleep 0.1; done",
    "  if managed_chisel; then",
    "    kill -KILL \"$pid\" 2>/dev/null || true",
    "    for _ in 1 2 3 4 5 6 7 8 9 10; do managed_chisel || break; sleep 0.1; done",
    "  fi",
    "  managed_chisel && exit 1",
    "fi",
    `rm -f ${quote(pidPath)}`
  ].join("\n");
}

function safeRef(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
