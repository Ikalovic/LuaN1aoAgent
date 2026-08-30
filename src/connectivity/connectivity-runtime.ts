import type { ArtifactStore } from "../stores/artifact-store.js";
import type { ConnectivityStore } from "../stores/connectivity-store.js";
import type { ExecutionLog } from "../stores/execution-log.js";
import type { MitmFlowClient } from "./mitm-flow-client.js";
import {
  NetworkSandboxManager,
  type GatewayEpochDrainAck,
  type IcmpEchoResult,
  type TaskNetworkHealth,
  type TaskGateway
} from "./network-sandbox-manager.js";
import {
  ReplayGatewayRuntime,
  type GatewayReplayInput
} from "./replay-gateway-runtime.js";
import {
  RouteManager,
  type RouteOpenInput,
  type RouteProjectionContext,
  type RouteStatus
} from "./route-manager.js";
import {
  ConnectivityRuntimeOwnershipError,
  ConnectivityRuntimeOwnerLease
} from "./runtime-owner-lease.js";
import type { TrafficReplayResult } from "./traffic-proxy-client.js";

export { ConnectivityRuntimeOwnershipError };

export class ConnectivityRuntime {
  readonly network: NetworkSandboxManager;
  readonly routes: RouteManager;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private readerDrainPromise?: Promise<void>;
  private closePreserveDesiredRoutes?: boolean;
  private routeCleanupComplete = false;
  private networkCleanupComplete = false;
  private ownerReleaseComplete = false;
  private closing = false;
  private ownershipLost = false;
  private routeQueue: Promise<void> = Promise.resolve();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly recoverDesiredRoutesOnStart: boolean;
  private readonly maintainDesiredRoutes: boolean;
  private readonly lazyRoutes: boolean;
  private routesInitialized = false;
  private routeStartPromise?: Promise<void>;
  private readonly routeHealthIntervalMs: number;
  private readonly routeReconnectBaseDelayMs: number;
  private readonly routeReconnectMaxDelayMs: number;
  private readonly routeRetries = new Map<string, { failures: number; nextAttemptAt: number }>();
  private routeMaintenanceTimer?: ReturnType<typeof setTimeout>;
  private readonly ownerLease: ConnectivityRuntimeOwnerLease;
  private readonly runtimeDir: string;
  private readonly executionLog: ExecutionLog;
  private readonly replayGatewayFactory: () => ReplayGatewayRuntime;
  private replayGateway?: ReplayGatewayRuntime;

  constructor(input: {
    runtimeDir: string;
    runRef: string;
    artifactStore: ArtifactStore;
    executionLog: ExecutionLog;
    connectivityStore?: ConnectivityStore;
    network?: NetworkSandboxManager;
    routes?: RouteManager;
    recoverDesiredRoutesOnStart?: boolean;
    maintainDesiredRoutes?: boolean;
    lazyRoutes?: boolean;
    manageFlowIndex?: boolean;
    routeHealthIntervalMs?: number;
    routeReconnectBaseDelayMs?: number;
    routeReconnectMaxDelayMs?: number;
    replayGatewayFactory?: () => ReplayGatewayRuntime;
    knownTaskIds?: string[];
  }) {
    this.runtimeDir = input.runtimeDir;
    this.recoverDesiredRoutesOnStart = input.recoverDesiredRoutesOnStart ?? true;
    this.maintainDesiredRoutes = input.maintainDesiredRoutes ?? this.recoverDesiredRoutesOnStart;
    this.lazyRoutes = input.lazyRoutes ?? false;
    this.routeHealthIntervalMs = positiveDuration(input.routeHealthIntervalMs, 15_000);
    this.routeReconnectBaseDelayMs = positiveDuration(input.routeReconnectBaseDelayMs, 2_000);
    this.routeReconnectMaxDelayMs = Math.max(
      this.routeReconnectBaseDelayMs,
      positiveDuration(input.routeReconnectMaxDelayMs, 60_000)
    );
    this.ownerLease = new ConnectivityRuntimeOwnerLease(input.runtimeDir);
    this.executionLog = input.executionLog;
    this.network = input.network ?? new NetworkSandboxManager({
      runtimeDir: input.runtimeDir,
      runRef: input.runRef,
      manageFlowIndex: input.manageFlowIndex,
      knownTaskIds: input.knownTaskIds
    });
    this.routes = input.routes ?? new RouteManager(
      this.network,
      input.artifactStore,
      input.executionLog,
      input.connectivityStore
    );
    this.replayGatewayFactory = input.replayGatewayFactory ?? (() => new ReplayGatewayRuntime({
      runtimeDir: this.network.runtimeDir,
      networkName: this.network.networkName,
      image: this.network.image,
      hostEgress: () => this.network.hostEgress()
    }));
  }

  start(): Promise<void> {
    if (this.ownershipLost) throw new ConnectivityRuntimeOwnershipError(this.runtimeDir);
    if (this.closing) throw new Error("Connectivity runtime is closing");
    this.startPromise ??= this.startOwnedResources();
    return this.startPromise;
  }

  configureAuthorizedScope(cidrs: string): Promise<void> {
    if (this.closing) throw new Error("Connectivity runtime is closing");
    return this.network.configureAuthorizedScope(cidrs);
  }

  beginTaskEpoch(input: { taskId: string; epochId: string }): Promise<TaskGateway> {
    return this.withTask(input.taskId, async () => {
      await this.start();
      await this.assertOwner();
      return this.network.createGateway(input);
    });
  }

  endTaskEpoch(input: { taskId: string; epochId: string }): Promise<GatewayEpochDrainAck> {
    return this.withTask(input.taskId, async () => {
      await this.startPromise?.catch(() => undefined);
      if (!this.startPromise) {
        return {
          epochRef: input.epochId,
          gatewayPresent: false,
          activeFlowCount: 0,
          activeTcpCount: 0,
          activeNetworkCount: 0,
          persistedFlowSequence: 0,
          persistedNetworkSequence: 0,
          flowBytes: 0,
          netBytes: 0,
          flushed: true
        };
      }
      await this.assertOwner();
      return this.network.endEpoch(input.taskId, input.epochId);
    });
  }

  disposeTask(taskId: string): Promise<void> {
    return this.withTask(taskId, async () => {
      await this.startPromise?.catch(() => undefined);
      if (!this.startPromise) return;
      await this.assertOwner();
      await this.network.disposeGateway(taskId);
    });
  }

  networkStatus(taskId: string): Promise<TaskNetworkHealth> {
    return this.network.taskNetworkHealth(taskId);
  }

  icmpEcho(taskId: string, target: string, timeoutMs: number): Promise<IcmpEchoResult> {
    return this.network.icmpEcho(taskId, target, timeoutMs);
  }

  openRoute(input: RouteOpenInput, ownerTaskId: string): Promise<RouteStatus> {
    return this.withRoutes(async () => {
      await this.ensureRoutesInitialized();
      const route = await this.routes.open(input, ownerTaskId);
      this.routeRetries.delete(route.routeRef);
      return route;
    });
  }

  replaceTransparentProxy(input: RouteOpenInput): Promise<RouteStatus> {
    return this.withRoutes(async () => {
      await this.ensureRoutesInitialized();
      const route = await this.routes.replaceTransparentProxy(input);
      this.routeRetries.delete(route.routeRef);
      return route;
    });
  }

  routeStatus(routeRef?: string): Promise<RouteStatus[]> {
    return this.withRoutes(async () => {
      await this.ensureRoutesInitialized();
      const routes = await this.routes.status(routeRef);
      for (const route of routes) {
        if (route.status === "live") this.routeRetries.delete(route.routeRef);
      }
      return routes;
    });
  }

  executorRouteStatus(routeRef?: string): Promise<RouteStatus[]> {
    return this.routeStatus(routeRef).then((routes) => routes.filter(
      (route) => !this.routes.isTransparentProxyRoute(route.routeRef)
    ));
  }

  executorStopRoute(routeRef: string): Promise<RouteStatus> {
    return this.withRoutes(async () => {
      await this.ensureRoutesInitialized();
      if (this.routes.isTransparentProxyRoute(routeRef)) {
        throw new Error("The process-wide transparent proxy is operator-managed");
      }
      const route = await this.routes.stop(routeRef);
      this.routeRetries.delete(routeRef);
      return route;
    });
  }

  executorReconnectRoute(routeRef: string): Promise<RouteStatus> {
    return this.withRoutes(async () => {
      await this.ensureRoutesInitialized();
      if (this.routes.isTransparentProxyRoute(routeRef)) {
        throw new Error("The process-wide transparent proxy is operator-managed");
      }
      try {
        const route = await this.routes.reconnect(routeRef);
        this.routeRetries.delete(routeRef);
        return route;
      } catch (error) {
        this.recordRouteRetryFailure(routeRef);
        throw error;
      }
    });
  }

  stopRoute(routeRef: string): Promise<RouteStatus> {
    return this.withRoutes(async () => {
      await this.ensureRoutesInitialized();
      const route = await this.routes.stop(routeRef);
      this.routeRetries.delete(routeRef);
      return route;
    });
  }

  reconnectRoute(routeRef: string): Promise<RouteStatus> {
    return this.withRoutes(async () => {
      await this.ensureRoutesInitialized();
      try {
        const route = await this.routes.reconnect(routeRef);
        this.routeRetries.delete(routeRef);
        return route;
      } catch (error) {
        this.recordRouteRetryFailure(routeRef);
        throw error;
      }
    });
  }

  forgetRoute(routeRef: string): Promise<RouteStatus> {
    return this.withRoutes(async () => {
      await this.ensureRoutesInitialized();
      const route = await this.routes.forget(routeRef);
      this.routeRetries.delete(routeRef);
      return route;
    });
  }

  replayTraffic(client: MitmFlowClient, input: GatewayReplayInput): Promise<TrafficReplayResult> {
    return this.withRoutes(async () => {
      if (this.closing) throw new Error("Connectivity runtime is closing");
      if (input.routeRef) await this.ensureRoutesInitialized();
      this.replayGateway ??= this.replayGatewayFactory();
      return this.replayGateway.replay(
        client,
        input,
        input.routeRef ? this.network.routeSnapshot() : []
      );
    });
  }

  routeProjectionSnapshot(): RouteProjectionContext[] {
    return this.routes.snapshotForProjection();
  }

  capabilityRefsForTask(taskId: string): string[] {
    return this.routes.capabilityRefsForTask(taskId);
  }

  close(options: { preserveDesiredRoutes?: boolean } = {}): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.readerDrainPromise ??= this.ownerLease.quiesceReaders();
      if (this.routeMaintenanceTimer) clearTimeout(this.routeMaintenanceTimer);
      this.routeMaintenanceTimer = undefined;
      this.closePreserveDesiredRoutes ??= options.preserveDesiredRoutes === true;
      this.closePromise = this.closeOwnedResources(this.closePreserveDesiredRoutes).catch((error: unknown) => {
        this.closePromise = undefined;
        throw error;
      });
    }
    return this.closePromise;
  }

  private async startOwnedResources(): Promise<void> {
    let acquired = false;
    try {
      await this.ownerLease.acquire();
      acquired = true;
      await this.network.start({ connector: !this.lazyRoutes });
      for (const pending of this.network.pendingEpochs?.() ?? []) {
        try {
          const drain = await this.network.endEpoch(pending.taskId, pending.epochId);
          await this.executionLog.append({
            epochId: pending.epochId,
            taskId: pending.taskId,
            role: "runtime",
            eventType: "network_capture_finalized",
            summary: `${pending.epochId} network evidence finalized during recovery`,
            payload: { ...drain, recovered: true }
          });
        } catch (error) {
          await this.executionLog.append({
            epochId: pending.epochId,
            taskId: pending.taskId,
            role: "runtime",
            eventType: "network_capture_degraded",
            summary: error instanceof Error ? error.message : String(error),
            payload: { epochId: pending.epochId, recovered: true }
          });
        }
      }
      if (!this.lazyRoutes) await this.ensureRoutesInitialized(true);
    } catch (error) {
      this.startPromise = undefined;
      if (acquired && await this.ownerLease.isOwner()) {
        await this.network.close().catch(() => undefined);
      }
      if (acquired) await this.ownerLease.release().catch(() => undefined);
      throw error;
    }
  }

  private async closeOwnedResources(preserveDesiredRoutes: boolean): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    await this.readerDrainPromise;
    await this.ownerLease.quiesceReaders();
    const ownsLease = await this.ownerLease.isOwner();
    if (!ownsLease && !this.networkCleanupComplete) return;
    await Promise.allSettled([...this.taskQueues.values()]);
    await this.routeQueue.catch(() => undefined);
    const failures: unknown[] = [];
    if (this.replayGateway) {
      try {
        await this.replayGateway.close();
        this.replayGateway = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.routeCleanupComplete) {
      try {
        if (this.routesInitialized) {
          if (preserveDesiredRoutes) await this.routes.suspendAll();
          else await this.routes.stopAll();
        }
        this.routeCleanupComplete = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.replayGateway && this.routeCleanupComplete && !this.networkCleanupComplete) {
      try {
        await this.network.close();
        this.networkCleanupComplete = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.networkCleanupComplete && failures.length === 0 && !this.ownerReleaseComplete) {
      try {
        await this.ownerLease.release();
        this.ownerReleaseComplete = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Connectivity runtime cleanup failed");
  }

  private withRoutes<T>(operation: () => Promise<T>): Promise<T> {
    const guardedOperation = async (): Promise<T> => {
      await this.start();
      await this.assertOwner();
      return operation();
    };
    const result = this.routeQueue.then(guardedOperation, guardedOperation);
    this.routeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async assertOwner(): Promise<void> {
    if (await this.ownerLease.isOwner()) return;
    this.ownershipLost = true;
    this.closing = true;
    if (this.routeMaintenanceTimer) clearTimeout(this.routeMaintenanceTimer);
    this.routeMaintenanceTimer = undefined;
    await this.ownerLease.release().catch(() => undefined);
    throw new ConnectivityRuntimeOwnershipError(this.runtimeDir);
  }

  private ensureRoutesInitialized(connectorReady = false): Promise<void> {
    if (this.routesInitialized) return Promise.resolve();
    this.routeStartPromise ??= this.initializeRoutes(connectorReady).catch((error: unknown) => {
      this.routeStartPromise = undefined;
      throw error;
    });
    return this.routeStartPromise;
  }

  private async initializeRoutes(connectorReady: boolean): Promise<void> {
    if (!connectorReady) await this.network.start();
    await this.routes.restore();
    if (this.recoverDesiredRoutesOnStart) await this.routes.recoverDesired();
    this.routesInitialized = true;
    this.scheduleRouteMaintenance();
  }

  private scheduleRouteMaintenance(): void {
    if (!this.maintainDesiredRoutes || this.closing || this.routeMaintenanceTimer) return;
    this.routeMaintenanceTimer = setTimeout(() => {
      this.routeMaintenanceTimer = undefined;
      void this.withRoutes(() => this.maintainRoutes())
        .catch(async (error: unknown) => {
          await this.executionLog.append({
            role: "runtime",
            eventType: "connectivity_maintenance_failed",
            summary: "Managed route maintenance failed",
            payload: {
              errorType: error instanceof Error ? error.name : "UnknownError"
            }
          }).catch(() => undefined);
        })
        .finally(() => this.scheduleRouteMaintenance());
    }, this.routeHealthIntervalMs);
    this.routeMaintenanceTimer.unref?.();
  }

  private async maintainRoutes(): Promise<void> {
    if (this.closing || !await this.ownerLease.isOwner()) return;
    const routes = (await this.routes.status()).sort(
      (left, right) => Number(left.connector === "chisel") - Number(right.connector === "chisel")
    );
    const activeRefs = new Set(routes.map((route) => route.routeRef));
    for (const routeRef of this.routeRetries.keys()) {
      if (!activeRefs.has(routeRef)) this.routeRetries.delete(routeRef);
    }
    for (const route of routes) {
      if (route.desiredState !== "running" || route.status === "closed") {
        this.routeRetries.delete(route.routeRef);
        continue;
      }
      if (route.status === "live") {
        this.routeRetries.delete(route.routeRef);
        continue;
      }
      const retry = this.routeRetries.get(route.routeRef);
      if (retry && retry.nextAttemptAt > Date.now()) continue;
      try {
        const recovered = await this.routes.reconnect(route.routeRef);
        if (recovered.status === "live") this.routeRetries.delete(route.routeRef);
        else this.recordRouteRetryFailure(route.routeRef);
      } catch {
        this.recordRouteRetryFailure(route.routeRef);
      }
    }
  }

  private recordRouteRetryFailure(routeRef: string): void {
    const failures = (this.routeRetries.get(routeRef)?.failures ?? 0) + 1;
    const delay = Math.min(
      this.routeReconnectMaxDelayMs,
      this.routeReconnectBaseDelayMs * (2 ** Math.min(failures - 1, 10))
    );
    this.routeRetries.set(routeRef, { failures, nextAttemptAt: Date.now() + delay });
  }

  private withTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.taskQueues.set(taskId, settled);
    void settled.finally(() => {
      if (this.taskQueues.get(taskId) === settled) this.taskQueues.delete(taskId);
    });
    return result;
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
