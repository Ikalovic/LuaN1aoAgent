import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const LEASE_DIRECTORY = ".connectivity-runtime-owner";
const LEASE_RECORD = "owner.json";
const INITIALIZATION_GRACE_MS = 5_000;
const ACQUIRE_ATTEMPTS = 100;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_EXPIRY_MS = 90_000;
const execFileAsync = promisify(execFile);
const CURRENT_PROCESS_START_IDENTITY = `${process.platform}:${process.pid}:node-${Math.floor(performance.timeOrigin)}`;
const localOwners = new Map<string, ConnectivityRuntimeOwnerLease>();

type LegacyLeaseRecord = {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: string;
};

type LeaseRecord = {
  version: 2;
  token: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
  processStartIdentity?: string;
};

type AnyLeaseRecord = LegacyLeaseRecord | LeaseRecord;

type LeaseSnapshot =
  | { state: "missing" }
  | { state: "valid"; record: AnyLeaseRecord }
  | { state: "invalid"; ageMs: number };

export type ConnectivityRuntimeLeaseStatus =
  | { state: "unowned" }
  | { state: "initializing" }
  | { state: "active"; ownerPid: number };

export type ConnectivityRuntimeReader = {
  run<T>(operation: () => Promise<T>): Promise<T>;
};

export class ConnectivityRuntimeOwnershipError extends Error {
  readonly code = "connectivity_runtime_owned";

  constructor(readonly runtimeDir: string, readonly ownerPid?: number) {
    super(ownerPid
      ? `Connectivity runtime is already owned by process ${ownerPid}: ${runtimeDir}`
      : `Connectivity runtime ownership is unavailable: ${runtimeDir}`);
    this.name = "ConnectivityRuntimeOwnershipError";
  }
}

export class ConnectivityRuntimeOwnerLease {
  private readonly runtimeDir: string;
  private readonly leaseDir: string;
  private readonly token = randomUUID();
  private acquired = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private acceptingReaders = false;
  private activeReaders = 0;
  private readonly readerDrainWaiters = new Set<() => void>();

  constructor(runtimeDir: string) {
    this.runtimeDir = resolve(runtimeDir);
    this.leaseDir = join(this.runtimeDir, LEASE_DIRECTORY);
  }

  static async inspect(runtimeDir: string): Promise<ConnectivityRuntimeLeaseStatus> {
    const lease = new ConnectivityRuntimeOwnerLease(runtimeDir);
    const snapshot = await lease.readSnapshot(lease.leaseDir);
    if (snapshot.state === "missing") return { state: "unowned" };
    if (snapshot.state === "invalid") {
      return snapshot.ageMs < INITIALIZATION_GRACE_MS
        ? { state: "initializing" }
        : { state: "unowned" };
    }
    return await leaseIsActive(snapshot.record)
      ? { state: "active", ownerPid: snapshot.record.pid }
      : { state: "unowned" };
  }

  static bindReader(runtimeDir: string): ConnectivityRuntimeReader | undefined {
    const owner = localOwners.get(resolve(runtimeDir));
    if (!owner) return undefined;
    return { run: <T>(operation: () => Promise<T>) => owner.runAsReader(operation) };
  }

  async acquire(): Promise<void> {
    if (this.acquired && await this.isOwner()) return;
    await mkdir(this.runtimeDir, { recursive: true });

    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      if (await this.tryCreateLease()) return;

      const snapshot = await this.readSnapshot(this.leaseDir);
      if (snapshot.state === "valid" && await leaseIsActive(snapshot.record)) {
        throw new ConnectivityRuntimeOwnershipError(this.runtimeDir, snapshot.record.pid);
      }
      if (snapshot.state === "invalid" && snapshot.ageMs < INITIALIZATION_GRACE_MS) {
        throw new ConnectivityRuntimeOwnershipError(this.runtimeDir);
      }
      if (snapshot.state === "missing") {
        await delay(1);
        continue;
      }
      if (await this.tryReclaimAndAcquire()) return;
      await delay(1);
    }

    throw new ConnectivityRuntimeOwnershipError(this.runtimeDir);
  }

  async isOwner(): Promise<boolean> {
    if (!this.acquired) return false;
    const snapshot = await this.readSnapshot(this.leaseDir);
    return snapshot.state === "valid" && snapshot.record.token === this.token;
  }

  async release(): Promise<void> {
    await this.quiesceReaders();
    if (!this.acquired) return;
    this.stopHeartbeat();
    const snapshot = await this.readSnapshot(this.leaseDir);
    if (snapshot.state !== "valid" || snapshot.record.token !== this.token) {
      this.acquired = false;
      return;
    }

    const releaseDir = `${this.leaseDir}.release-${this.token}`;
    try {
      await rename(this.leaseDir, releaseDir);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      this.acquired = false;
      return;
    }

    const releasedSnapshot = await this.readSnapshot(releaseDir);
    if (releasedSnapshot.state !== "valid" || releasedSnapshot.record.token !== this.token) {
      await rename(releaseDir, this.leaseDir).catch(() => undefined);
      this.acquired = false;
      return;
    }
    await rm(releaseDir, { recursive: true, force: true });
    this.acquired = false;
  }

  async quiesceReaders(): Promise<void> {
    this.acceptingReaders = false;
    if (localOwners.get(this.runtimeDir) === this) localOwners.delete(this.runtimeDir);
    if (this.activeReaders === 0) return;
    await new Promise<void>((resolveDrained) => this.readerDrainWaiters.add(resolveDrained));
  }

  private async tryCreateLease(): Promise<boolean> {
    try {
      await mkdir(this.leaseDir, { mode: 0o700 });
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    }

    try {
      const now = new Date().toISOString();
      const processStartIdentity = await readProcessStartIdentity(process.pid);
      const record: LeaseRecord = {
        version: 2,
        token: this.token,
        pid: process.pid,
        acquiredAt: now,
        heartbeatAt: now,
        ...(processStartIdentity ? { processStartIdentity } : {})
      };
      await writeFile(join(this.leaseDir, LEASE_RECORD), JSON.stringify(record), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      this.acquired = true;
      this.acceptingReaders = true;
      localOwners.set(this.runtimeDir, this);
      this.scheduleHeartbeat();
      return true;
    } catch (error) {
      await rm(this.leaseDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async tryReclaimAndAcquire(): Promise<boolean> {
    const staleDir = `${this.leaseDir}.stale-${this.token}`;
    try {
      await rename(this.leaseDir, staleDir);
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) {
        return false;
      }
      throw error;
    }
    try {
      return await this.tryCreateLease();
    } finally {
      await rm(staleDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readSnapshot(directory: string): Promise<LeaseSnapshot> {
    try {
      const raw = await readFile(join(directory, LEASE_RECORD), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if ((parsed.version === 1 || parsed.version === 2)
        && typeof parsed.token === "string" && parsed.token.length > 0
        && Number.isInteger(parsed.pid) && Number(parsed.pid) > 0
        && typeof parsed.acquiredAt === "string" && Number.isFinite(Date.parse(parsed.acquiredAt))
        && (parsed.version === 1 || (
          typeof parsed.heartbeatAt === "string" && Number.isFinite(Date.parse(parsed.heartbeatAt))
          && (parsed.processStartIdentity === undefined || typeof parsed.processStartIdentity === "string")
        ))) {
        return { state: "valid", record: parsed as AnyLeaseRecord };
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        try {
          const info = await stat(directory);
          return { state: "invalid", ageMs: Math.max(0, Date.now() - info.mtimeMs) };
        } catch (statError) {
          if (isNodeError(statError, "ENOENT")) return { state: "missing" };
          throw statError;
        }
      }
      if (!(error instanceof SyntaxError)) throw error;
    }

    const info = await stat(directory);
    return { state: "invalid", ageMs: Math.max(0, Date.now() - info.mtimeMs) };
  }

  private scheduleHeartbeat(): void {
    if (!this.acquired || this.heartbeatTimer) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      void this.refreshHeartbeat().catch(() => undefined).finally(() => this.scheduleHeartbeat());
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async refreshHeartbeat(): Promise<void> {
    if (!this.acquired) return;
    const snapshot = await this.readSnapshot(this.leaseDir).catch(() => undefined);
    if (!snapshot || snapshot.state !== "valid" || snapshot.record.token !== this.token) {
      this.acquired = false;
      this.acceptingReaders = false;
      if (localOwners.get(this.runtimeDir) === this) localOwners.delete(this.runtimeDir);
      return;
    }
    const record: LeaseRecord = snapshot.record.version === 2
      ? { ...snapshot.record, heartbeatAt: new Date().toISOString() }
      : {
          version: 2,
          token: snapshot.record.token,
          pid: snapshot.record.pid,
          acquiredAt: snapshot.record.acquiredAt,
          heartbeatAt: new Date().toISOString(),
          ...(await readProcessStartIdentity(snapshot.record.pid).then((identity) => identity ? { processStartIdentity: identity } : {}))
        };
    const temporaryPath = join(this.leaseDir, `${LEASE_RECORD}.${this.token}.tmp`);
    try {
      await writeFile(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      const current = await this.readSnapshot(this.leaseDir);
      if (current.state !== "valid" || current.record.token !== this.token) return;
      await rename(temporaryPath, join(this.leaseDir, LEASE_RECORD));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async runAsReader<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acquired || !this.acceptingReaders || localOwners.get(this.runtimeDir) !== this) {
      throw new ConnectivityRuntimeOwnershipError(this.runtimeDir);
    }
    this.activeReaders += 1;
    try {
      return await operation();
    } finally {
      this.activeReaders -= 1;
      if (this.activeReaders === 0) {
        for (const resolveDrained of this.readerDrainWaiters) resolveDrained();
        this.readerDrainWaiters.clear();
      }
    }
  }
}

async function leaseIsActive(record: AnyLeaseRecord): Promise<boolean> {
  const heartbeatAt = record.version === 2 ? record.heartbeatAt : record.acquiredAt;
  if (Date.now() - Date.parse(heartbeatAt) >= HEARTBEAT_EXPIRY_MS || !processIsAlive(record.pid)) {
    return false;
  }
  if (record.version !== 2 || !record.processStartIdentity) return true;
  const currentIdentity = await readProcessStartIdentity(record.pid);
  return currentIdentity === undefined || currentIdentity === record.processStartIdentity;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error, "ESRCH") || isNodeError(error, "EINVAL"));
  }
}

async function readProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (pid === process.pid) return CURRENT_PROCESS_START_IDENTITY;
  if (process.platform === "linux") {
    try {
      const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
      const afterCommand = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTicks = afterCommand[19];
      return startTicks ? `linux:${pid}:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2_000 });
    const startedAt = stdout.trim().replace(/\s+/g, " ");
    return startedAt ? `${process.platform}:${pid}:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
