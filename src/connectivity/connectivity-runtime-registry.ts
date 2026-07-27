import { resolve, join } from "node:path";
import { readdir } from "node:fs/promises";
import { ArtifactStore } from "../stores/artifact-store.js";
import { ConnectivityStore } from "../stores/connectivity-store.js";
import { ExecutionLog } from "../stores/execution-log.js";
import { getOrCreateRuntimeRunRef } from "../stores/runtime-store.js";
import { ConnectivityRuntime } from "./connectivity-runtime.js";
import { closeHistoricalMitmIndexes } from "./mitm-flow-client.js";

export type HistoricalConnectivityRuntime = Pick<
  ConnectivityRuntime,
  "routeStatus" | "stopRoute" | "reconnectRoute" | "forgetRoute" | "replayTraffic"
>;

type RuntimeResources = {
  runtime: HistoricalConnectivityRuntime;
  close: () => Promise<void>;
};

type RuntimeEntry = {
  runtimeDir: string;
  resources: Promise<RuntimeResources>;
  facade: HistoricalConnectivityRuntime;
  inFlight: Set<Promise<unknown>>;
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
};

export type HistoricalConnectivityRuntimeFactory = (input: {
  runtimeDir: string;
  runRef: string;
}) => Promise<RuntimeResources>;

export class HistoricalConnectivityRuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>();
  private closeAllPromise?: Promise<void>;

  constructor(
    private readonly factory: HistoricalConnectivityRuntimeFactory = createRuntimeResources,
    private readonly idleMs = 120_000
  ) {}

  has(runtimeDir: string): boolean {
    return this.entries.has(resolve(runtimeDir));
  }

  async get(runtimeDir: string): Promise<HistoricalConnectivityRuntime> {
    if (this.closeAllPromise) throw new Error("Historical connectivity runtime registry is closing");
    const canonicalRuntimeDir = resolve(runtimeDir);
    let entry = this.entries.get(canonicalRuntimeDir);
    if (!entry) {
      entry = this.createEntry(canonicalRuntimeDir);
      this.entries.set(canonicalRuntimeDir, entry);
      void entry.resources.catch(() => {
        if (this.entries.get(canonicalRuntimeDir) === entry) this.entries.delete(canonicalRuntimeDir);
      });
    }
    await entry.resources;
    this.scheduleIdleClose(entry);
    return entry.facade;
  }

  async getExisting(runtimeDir: string): Promise<HistoricalConnectivityRuntime | undefined> {
    if (this.closeAllPromise) return undefined;
    const entry = this.entries.get(resolve(runtimeDir));
    if (!entry || entry.closing) return undefined;
    await entry.resources;
    this.scheduleIdleClose(entry);
    return entry.facade;
  }

  async close(runtimeDir: string): Promise<void> {
    const canonicalRuntimeDir = resolve(runtimeDir);
    const entry = this.entries.get(canonicalRuntimeDir);
    if (!entry) return;
    this.entries.delete(canonicalRuntimeDir);
    await this.closeEntry(entry);
  }

  async closeAll(): Promise<void> {
    this.closeAllPromise ??= this.closeAllEntries();
    return this.closeAllPromise;
  }

  private async closeAllEntries(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => this.closeEntry(entry)));
  }

  private createEntry(runtimeDir: string): RuntimeEntry {
    const entry = {} as RuntimeEntry;
    entry.runtimeDir = runtimeDir;
    entry.resources = this.factory({
      runtimeDir,
      runRef: getOrCreateRuntimeRunRef(join(runtimeDir, "state.sqlite"))
    });
    entry.inFlight = new Set();
    entry.closing = false;
    entry.facade = {
      routeStatus: (...args) => this.use(entry, (runtime) => runtime.routeStatus(...args)),
      stopRoute: (...args) => this.use(entry, (runtime) => runtime.stopRoute(...args)),
      reconnectRoute: (...args) => this.use(entry, (runtime) => runtime.reconnectRoute(...args)),
      forgetRoute: (...args) => this.use(entry, (runtime) => runtime.forgetRoute(...args)),
      replayTraffic: (...args) => this.use(entry, (runtime) => runtime.replayTraffic(...args))
    };
    return entry;
  }

  private async use<T>(
    entry: RuntimeEntry,
    operation: (runtime: HistoricalConnectivityRuntime) => Promise<T>
  ): Promise<T> {
    if (entry.closing || this.entries.get(entry.runtimeDir) !== entry) {
      throw new Error("Historical connectivity runtime is closing");
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    const pending = entry.resources.then(({ runtime }) => operation(runtime));
    entry.inFlight.add(pending);
    try {
      return await pending;
    } finally {
      entry.inFlight.delete(pending);
      this.scheduleIdleClose(entry);
    }
  }

  private scheduleIdleClose(entry: RuntimeEntry): void {
    if (entry.closing || entry.inFlight.size > 0 || this.entries.get(entry.runtimeDir) !== entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.closing || entry.inFlight.size > 0 || this.entries.get(entry.runtimeDir) !== entry) return;
      this.entries.delete(entry.runtimeDir);
      void this.closeEntry(entry).catch(() => undefined);
    }, Math.max(1, this.idleMs));
    entry.idleTimer.unref?.();
  }

  private async closeEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.closing) return;
    entry.closing = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    await Promise.allSettled([...entry.inFlight]);
    const resources = await entry.resources.catch(() => undefined);
    await resources?.close();
  }
}

async function createRuntimeResources(input: { runtimeDir: string; runRef: string }): Promise<RuntimeResources> {
  const databasePath = join(input.runtimeDir, "state.sqlite");
  let artifactStore: ArtifactStore | undefined;
  let executionLog: ExecutionLog | undefined;
  let connectivityStore: ConnectivityStore | undefined;
  let runtime: ConnectivityRuntime | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    await runtime?.close({ preserveDesiredRoutes: true }).catch((error: unknown) => failures.push(error));
    await executionLog?.drain().catch((error: unknown) => failures.push(error));
    for (const closeStore of [
      () => connectivityStore?.close(),
      () => executionLog?.close(),
      () => artifactStore?.close()
    ]) {
      try {
        closeStore();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Historical connectivity runtime cleanup failed");
  };
  try {
    const manageFlowIndex = await hasPersistedMitmFlows(input.runtimeDir);
    await closeHistoricalMitmIndexes(input.runtimeDir);
    artifactStore = new ArtifactStore(join(input.runtimeDir, "artifacts"), databasePath);
    executionLog = new ExecutionLog(join(input.runtimeDir, "execution.jsonl"), databasePath);
    connectivityStore = new ConnectivityStore(databasePath);
    runtime = new ConnectivityRuntime({
      runtimeDir: input.runtimeDir,
      runRef: input.runRef,
      artifactStore,
      executionLog,
      connectivityStore,
      recoverDesiredRoutesOnStart: false,
      lazyRoutes: true,
      manageFlowIndex
    });
    await runtime.start();
    return { runtime, close };
  } catch (error) {
    await executionLog?.append({
      role: "runtime",
      eventType: "connectivity_runtime_restore_failed",
      summary: "Historical connectivity runtime restore failed",
      payload: {
        runRef: input.runRef,
        errorType: error instanceof Error ? error.name : "UnknownError"
      }
    }).catch(() => undefined);
    await close().catch(() => undefined);
    throw error;
  }
}

async function hasPersistedMitmFlows(runtimeDir: string): Promise<boolean> {
  try {
    const entries = await readdir(join(runtimeDir, "traffic", "flows"), {
      recursive: true,
      withFileTypes: true
    });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith(".mitm"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
