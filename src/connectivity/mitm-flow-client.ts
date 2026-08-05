import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TrafficProxyControlError,
  type TrafficExchange,
  type TrafficHistoryBody,
  type TrafficHistoryFilter,
  type TrafficHistoryPage
} from "./traffic-proxy-client.js";
import { networkCaptureDockerEnv } from "./network-sandbox-manager.js";
import {
  ConnectivityRuntimeOwnerLease,
  ConnectivityRuntimeOwnershipError,
  type ConnectivityRuntimeReader
} from "./runtime-owner-lease.js";

type IndexDescriptor = { url: string; token: string; network?: string };
type CommandResult = { code: number | null; stdout: string; stderr: string };
type CommandRunner = (args: string[]) => Promise<CommandResult>;
type OpenOptions = { fetcher?: typeof fetch; runner?: CommandRunner; image?: string };
type IndexContainer = {
  containerName: string;
  runner: CommandRunner;
};
type OwnedIndex = IndexContainer & {
  lease: ConnectivityRuntimeOwnerLease;
};
type RevivedIndex = IndexContainer & { descriptor: IndexDescriptor };

const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const HISTORY_INDEX_IDLE_MS = 120_000;

class HistoricalMitmIndexOwner {
  private readonly revivals = new Map<string, Promise<RevivedIndex>>();
  private readonly entries = new Map<string, OwnedIndex & { idleTimer: NodeJS.Timeout }>();

  async revive(runtimeDir: string, options: OpenOptions): Promise<IndexDescriptor> {
    const existing = this.revivals.get(runtimeDir);
    if (existing) return (await existing).descriptor;
    const revival = this.startOwnedRevival(runtimeDir, options);
    this.revivals.set(runtimeDir, revival);
    try {
      const revived = await revival;
      return revived.descriptor;
    } finally {
      this.revivals.delete(runtimeDir);
    }
  }

  async cleanupAfterFailure(runtimeDir: string, failure: unknown): Promise<never> {
    try {
      await this.close(runtimeDir);
    } catch (cleanupError) {
      throw combineFailures(
        failure,
        cleanupError,
        `Historical mitm index startup failed and cleanup was not confirmed for ${runtimeDir}`
      );
    }
    throw failure;
  }

  touch(runtimeDir: string): void {
    const entry = this.entries.get(runtimeDir);
    if (entry) this.remember(runtimeDir, entry);
  }

  async close(runtimeDir?: string): Promise<void> {
    const selected = runtimeDir === undefined
      ? [...this.entries.entries()]
      : [...this.entries.entries()].filter(([key]) => key === runtimeDir);
    const failures: unknown[] = [];
    for (const [key, entry] of selected) {
      clearTimeout(entry.idleTimer);
      try {
        await entry.lease.quiesceReaders();
        await removeHistoryIndex(entry);
        await entry.lease.release();
      } catch (error) {
        failures.push(error);
        if (this.entries.get(key) === entry) this.remember(key, entry);
        continue;
      }
      if (this.entries.get(key) === entry) this.entries.delete(key);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Historical mitm index cleanup failed: ${failures.map(failureSummary).join("; ")}`
      );
    }
  }

  private async startOwnedRevival(runtimeDir: string, options: OpenOptions): Promise<RevivedIndex> {
    const leaseStatus = await ConnectivityRuntimeOwnerLease.inspect(runtimeDir);
    if (leaseStatus.state === "active") {
      throw new ConnectivityRuntimeOwnershipError(runtimeDir, leaseStatus.ownerPid);
    }
    if (leaseStatus.state === "initializing") {
      throw new ConnectivityRuntimeOwnershipError(runtimeDir);
    }
    const lease = new ConnectivityRuntimeOwnerLease(runtimeDir);
    await lease.acquire();
    let claimed = false;
    try {
      return await startIndex(runtimeDir, options, (owned) => {
        claimed = true;
        this.remember(runtimeDir, { ...owned, lease });
      });
    } catch (error) {
      if (claimed) return this.cleanupAfterFailure(runtimeDir, error);
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  private remember(runtimeDir: string, revived: OwnedIndex): void {
    const current = this.entries.get(runtimeDir);
    if (current) clearTimeout(current.idleTimer);
    const idleTimer = setTimeout(() => {
      void this.close(runtimeDir).catch(() => undefined);
    }, HISTORY_INDEX_IDLE_MS);
    idleTimer.unref();
    this.entries.set(runtimeDir, { ...revived, idleTimer });
  }
}

const historicalIndexOwner = new HistoricalMitmIndexOwner();

export class MitmFlowClient {
  private constructor(
    private readonly descriptor: IndexDescriptor,
    private readonly fetcher: typeof fetch,
    private readonly reader?: ConnectivityRuntimeReader
  ) {}

  static async open(runtimeDir: string, options: OpenOptions = {}): Promise<MitmFlowClient> {
    const canonicalRuntimeDir = resolve(runtimeDir);
    const fetcher = options.fetcher ?? fetch;
    let descriptor: IndexDescriptor | undefined;
    try {
      descriptor = await readDescriptor(canonicalRuntimeDir);
    } catch {
      descriptor = undefined;
    }
    const currentClient = descriptor
      ? new MitmFlowClient(descriptor, fetcher, ConnectivityRuntimeOwnerLease.bindReader(canonicalRuntimeDir))
      : undefined;
    const currentHealthy = currentClient ? await currentClient.healthy() : false;
    const leaseStatus = await ConnectivityRuntimeOwnerLease.inspect(canonicalRuntimeDir);
    if (currentClient && currentHealthy && leaseStatus.state === "active") {
      historicalIndexOwner.touch(canonicalRuntimeDir);
      return currentClient;
    }
    if (leaseStatus.state === "active") {
      throw new ConnectivityRuntimeOwnershipError(canonicalRuntimeDir, leaseStatus.ownerPid);
    }
    if (leaseStatus.state === "initializing") {
      throw new ConnectivityRuntimeOwnershipError(canonicalRuntimeDir);
    }
    descriptor = await reviveIndex(canonicalRuntimeDir, options);
    const client = new MitmFlowClient(
      descriptor,
      fetcher,
      ConnectivityRuntimeOwnerLease.bindReader(canonicalRuntimeDir)
    );
    if (!await waitForHealthy(() => client.healthy())) {
      return historicalIndexOwner.cleanupAfterFailure(
        canonicalRuntimeDir,
        new Error("Mitm flow index did not become healthy")
      );
    }
    historicalIndexOwner.touch(canonicalRuntimeDir);
    return client;
  }

  async historyList(options: { cursor?: string; limit?: number; filter?: TrafficHistoryFilter } = {}): Promise<TrafficHistoryPage> {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    for (const [key, value] of Object.entries(options.filter ?? {})) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const result = await this.request<{ records: TrafficExchange[]; has_more: boolean; next_cursor?: string }>(`/history?${query}`);
    return { items: result.records, has_more: result.has_more, next_cursor: result.next_cursor };
  }

  async historyGet(flowRef: string): Promise<TrafficExchange> {
    const result = await this.request<{ record: TrafficExchange }>(`/history/${encodeURIComponent(flowRef)}`);
    return result.record;
  }

  historyBody(flowRef: string, side: "request" | "response", byteLimit?: number): Promise<TrafficHistoryBody> {
    const query = new URLSearchParams({ side });
    if (byteLimit !== undefined) query.set("byte_limit", String(byteLimit));
    return this.request(`/history/${encodeURIComponent(flowRef)}/body?${query}`);
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<T> {
    if (this.reader) return this.reader.run(() => this.requestDirect<T>(path, init, timeoutMs));
    return this.requestDirect<T>(path, init, timeoutMs);
  }

  private async requestDirect<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const response = await this.fetcher(`${this.descriptor.url}${path}`, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${this.descriptor.token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
      const errorCode = payload.error ?? "traffic_proxy_control_error";
      throw new TrafficProxyControlError(payload.message ?? `Mitm flow index request failed: ${response.status}`, errorCode);
    }
    return await response.json() as T;
  }

  private async healthy(): Promise<boolean> {
    try {
      return (await this.request<{ status: string }>("/health")).status === "ok";
    } catch {
      return false;
    }
  }
}

async function waitForHealthy(probe: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await probe()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function readDescriptor(runtimeDir: string): Promise<IndexDescriptor> {
  const descriptor = JSON.parse(await readFile(join(runtimeDir, "traffic", "index.json"), "utf8")) as IndexDescriptor;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.url) || !/^[a-f0-9]{64}$/.test(descriptor.token)) {
    throw new Error("Invalid mitm flow index descriptor");
  }
  if (descriptor.network !== undefined && !/^luanniao-net-[a-f0-9]{16}$/.test(descriptor.network)) {
    throw new Error("Invalid mitm flow index network");
  }
  return descriptor;
}

async function reviveIndex(runtimeDir: string, options: OpenOptions): Promise<IndexDescriptor> {
  return historicalIndexOwner.revive(runtimeDir, options);
}

async function startIndex(
  runtimeDir: string,
  options: OpenOptions,
  claim: (owned: IndexContainer) => void
): Promise<RevivedIndex> {
  const runner = options.runner ?? dockerCommand;
  const trafficRoot = join(runtimeDir, "traffic");
  const token = await ensureIndexToken(trafficRoot);
  const runtimeHash = createHash("sha256").update(runtimeDir).digest("hex").slice(0, 16);
  const containerName = `luanniao-history-index-${runtimeHash}`;
  const image = options.image ?? (process.env.LUANNIAO_NETWORK_IMAGE?.trim() || "luanniao-network:latest");
  const captureEnvironment = networkCaptureDockerEnv();
  const configDigest = createHash("sha256").update(JSON.stringify({ trafficRoot, image, captureEnvironment })).digest("hex");
  const inspected = await runner(["inspect", "--format", "{{.State.Running}}|{{index .Config.Labels \"luanniao.managed\"}}|{{index .Config.Labels \"luanniao.role\"}}|{{index .Config.Labels \"luanniao.config\"}}", containerName]);
  const [running, managed, role, actualDigest] = inspected.stdout.trim().split("|");
  if (inspected.code === 0 && (managed !== "true" || role !== "history-index")) {
    throw new Error(`Refusing to replace unmanaged container ${containerName}`);
  }
  if (inspected.code !== 0 || running !== "true" || actualDigest !== configDigest) {
    if (inspected.code === 0) {
      claim({ containerName, runner });
      const removed = await runner(["rm", "-f", containerName]);
      if (removed.code !== 0) {
        throw new Error(`Failed to replace historical mitm flow index ${containerName}: ${removed.stderr || removed.stdout}`);
      }
    }
    const started = await runner([
      "run", "-d", "--name", containerName,
      "--label", "luanniao.managed=true", "--label", "luanniao.role=history-index", "--label", `luanniao.config=${configDigest}`,
      "--label", `luanniao.runtime_dir=${resolve(runtimeDir)}`,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "128", "--memory", "512m",
      "--publish", "127.0.0.1::8788",
      "--mount", `type=bind,src=${trafficRoot},dst=/traffic,readonly`,
      "--env", "LUANNIAO_FLOW_ROOT=/traffic/flows", "--env", `LUANNIAO_INDEX_TOKEN=${token}`,
      ...captureEnvironment,
      image,
      "index", "--listen", "0.0.0.0:8788"
    ]);
    if (started.code !== 0) throw new Error(`Failed to revive mitm flow index: ${started.stderr}`);
    claim({ containerName, runner });
  } else {
    claim({ containerName, runner });
  }
  const portResult = await runner(["port", containerName, "8788/tcp"]);
  const port = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/.exec(portResult.stdout)?.[1];
  if (portResult.code !== 0 || !port) throw new Error(`Failed to resolve mitm flow index port: ${portResult.stderr || portResult.stdout}`);
  const descriptor: IndexDescriptor = { url: `http://127.0.0.1:${port}`, token };
  const descriptorPath = join(trafficRoot, "index.json");
  const temporaryPath = `${descriptorPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(descriptor), { mode: 0o600 });
    await rename(temporaryPath, descriptorPath);
    await chmod(descriptorPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { descriptor, containerName, runner };
}

async function ensureIndexToken(trafficRoot: string): Promise<string> {
  const tokenPath = join(trafficRoot, "index.token");
  await mkdir(trafficRoot, { recursive: true, mode: 0o700 });
  try {
    await writeFile(tokenPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid mitm flow index token");
  await chmod(tokenPath, 0o600);
  return token;
}

async function removeHistoryIndex(entry: IndexContainer): Promise<void> {
  const inspected = await entry.runner([
    "inspect", "--format",
    "{{index .Config.Labels \"luanniao.managed\"}}|{{index .Config.Labels \"luanniao.role\"}}",
    entry.containerName
  ]);
  if (inspected.code !== 0) {
    if (/no such (?:object|container)|not found/i.test(inspected.stderr || inspected.stdout)) return;
    throw new Error(`Failed to inspect ${entry.containerName}: ${inspected.stderr || inspected.stdout || `exit ${inspected.code}`}`);
  }
  const [managed, role] = inspected.stdout.trim().split("|");
  if (managed !== "true" || role !== "history-index") {
    throw new Error(`Refusing to remove unmanaged container ${entry.containerName}`);
  }
  const removed = await entry.runner(["rm", "-f", entry.containerName]);
  if (removed.code !== 0) throw new Error(`Failed to remove ${entry.containerName}: ${removed.stderr || removed.stdout}`);
}

export function closeHistoricalMitmIndexes(runtimeDir?: string): Promise<void> {
  return historicalIndexOwner.close(runtimeDir === undefined ? undefined : resolve(runtimeDir));
}

function failureSummary(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(failureSummary)].filter(Boolean).join(": ");
  }
  return error instanceof Error ? error.message : String(error);
}

function combineFailures(primary: unknown, secondary: unknown, message: string): AggregateError {
  return new AggregateError(
    [primary, secondary],
    `${message}: ${failureSummary(primary)}; ${failureSummary(secondary)}`
  );
}

export function runMitmIndexDockerCommand(
  args: string[],
  timeoutMs = DOCKER_COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish({
        code: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}docker command timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

const dockerCommand = runMitmIndexDockerCommand;
