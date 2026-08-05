import { dirname, relative, resolve, sep } from "node:path";
import { ConnectivityRuntimeOwnerLease, ConnectivityRuntimeOwnershipError } from "./connectivity/runtime-owner-lease.js";
import type { DockerRunner } from "./executor-sandbox-docker.js";

type ManagedDockerResource = {
  kind: "container" | "network";
  name: string;
  role: string;
  runRef?: string;
  runtimeDir?: string;
};

export type DockerOrphanReapResult = {
  removed: string[];
  skippedActiveRuntimeDirs: string[];
  failures: string[];
};

const CONTAINER_ROLES = new Set(["executor", "gateway", "connector", "index", "history-index", "replay-gateway"]);
const NETWORK_ROLES = new Set(["run-network", "task-network", "replay-task-network"]);

export async function reapStaleManagedDockerResources(input: {
  roots: string[];
  runner: DockerRunner;
}): Promise<DockerOrphanReapResult> {
  const result: DockerOrphanReapResult = { removed: [], skippedActiveRuntimeDirs: [], failures: [] };
  const roots = [...new Set(input.roots.map((root) => resolve(root)))];
  const resources = await listManagedResources(input.runner, result.failures);
  const runtimeByRunRef = new Map<string, string>();

  for (const resource of resources) {
    if (resource.runtimeDir && isWithinRoots(resource.runtimeDir, roots) && resource.runRef) {
      runtimeByRunRef.set(resource.runRef, resource.runtimeDir);
    }
  }
  for (const resource of resources) {
    if (!resource.runtimeDir && resource.runRef) resource.runtimeDir = runtimeByRunRef.get(resource.runRef);
  }

  const byRuntime = new Map<string, ManagedDockerResource[]>();
  for (const resource of resources) {
    if (!resource.runtimeDir || !isWithinRoots(resource.runtimeDir, roots)) continue;
    const runtimeDir = resolve(resource.runtimeDir);
    const current = byRuntime.get(runtimeDir) ?? [];
    current.push(resource);
    byRuntime.set(runtimeDir, current);
  }

  for (const [runtimeDir, ownedResources] of byRuntime) {
    const lease = new ConnectivityRuntimeOwnerLease(runtimeDir);
    try {
      await lease.acquire();
    } catch (error) {
      if (error instanceof ConnectivityRuntimeOwnershipError) {
        result.skippedActiveRuntimeDirs.push(runtimeDir);
        continue;
      }
      result.failures.push(`${runtimeDir}: ${errorMessage(error)}`);
      continue;
    }
    try {
      for (const resource of ownedResources.filter(({ kind }) => kind === "container")) {
        const removed = await input.runner(["rm", "-f", resource.name], { timeoutMs: 30_000 });
        if (removed.code === 0 || dockerResourceMissing(removed)) result.removed.push(resource.name);
        else result.failures.push(`${resource.name}: ${removed.stderr.toString("utf8").trim()}`);
      }
      for (const resource of ownedResources.filter(({ kind }) => kind === "network")) {
        const removed = await input.runner(["network", "rm", resource.name], { timeoutMs: 30_000 });
        if (removed.code === 0 || dockerResourceMissing(removed)) result.removed.push(resource.name);
        else result.failures.push(`${resource.name}: ${removed.stderr.toString("utf8").trim()}`);
      }
    } finally {
      await lease.release().catch((error: unknown) => {
        result.failures.push(`${runtimeDir}: failed to release cleanup lease: ${errorMessage(error)}`);
      });
    }
  }
  return result;
}

async function listManagedResources(runner: DockerRunner, failures: string[]): Promise<ManagedDockerResource[]> {
  const resources: ManagedDockerResource[] = [];
  const containers = await runner(["ps", "-aq", "--filter", "label=luanniao.managed=true"], { timeoutMs: 30_000 })
    .catch(() => undefined);
  if (!containers || containers.code !== 0) return resources;
  for (const id of lines(containers.stdout)) {
    const inspected = await runner(["inspect", id], { timeoutMs: 30_000 });
    if (inspected.code !== 0) continue;
    try {
      const records = JSON.parse(inspected.stdout.toString("utf8")) as DockerInspect[];
      const record = records[0];
      const labels = record?.Config?.Labels ?? {};
      const role = labels["luanniao.role"] ?? "";
      if (labels["luanniao.managed"] !== "true" || !CONTAINER_ROLES.has(role)) continue;
      resources.push({
        kind: "container",
        name: (record?.Name ?? id).replace(/^\//, ""),
        role,
        runRef: optionalLabel(labels["luanniao.run_ref"]),
        runtimeDir: optionalLabel(labels["luanniao.runtime_dir"]) ?? runtimeDirFromMounts(record?.Mounts ?? [])
      });
    } catch (error) {
      failures.push(`${id}: invalid Docker inspect response: ${errorMessage(error)}`);
    }
  }

  const networks = await runner(["network", "ls", "-q", "--filter", "label=luanniao.managed=true"], { timeoutMs: 30_000 });
  if (networks.code !== 0) return resources;
  for (const id of lines(networks.stdout)) {
    const inspected = await runner(["network", "inspect", id], { timeoutMs: 30_000 });
    if (inspected.code !== 0) continue;
    try {
      const records = JSON.parse(inspected.stdout.toString("utf8")) as DockerInspect[];
      const record = records[0];
      const labels = record?.Labels ?? {};
      const role = labels["luanniao.role"] ?? "";
      if (labels["luanniao.managed"] !== "true" || !NETWORK_ROLES.has(role)) continue;
      resources.push({
        kind: "network",
        name: record?.Name ?? id,
        role,
        runRef: optionalLabel(labels["luanniao.run_ref"]),
        runtimeDir: optionalLabel(labels["luanniao.runtime_dir"])
      });
    } catch (error) {
      failures.push(`${id}: invalid Docker network inspect response: ${errorMessage(error)}`);
    }
  }
  return resources;
}

type DockerInspect = {
  Name?: string;
  Config?: { Labels?: Record<string, string> };
  Labels?: Record<string, string>;
  Mounts?: Array<{ Source?: string; Destination?: string }>;
};

function runtimeDirFromMounts(mounts: Array<{ Source?: string; Destination?: string }>): string | undefined {
  for (const mount of mounts) {
    if (!mount.Source || !mount.Destination) continue;
    const source = resolve(mount.Source);
    if (mount.Destination === "/traffic") return dirname(source);
    if (mount.Destination === "/traffic/ca") return dirname(dirname(source));
    if (mount.Destination.startsWith("/traffic/flows/")) return source.slice(0, source.indexOf(`${sep}traffic${sep}flows${sep}`));
    if (mount.Destination === "/workspace") {
      const marker = `${sep}sandboxes${sep}`;
      const index = source.indexOf(marker);
      if (index > 0) return source.slice(0, index);
    }
  }
  return undefined;
}

function isWithinRoots(path: string, roots: string[]): boolean {
  const canonical = resolve(path);
  return roots.some((root) => {
    const child = relative(root, canonical);
    return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep));
  });
}

function lines(value: Buffer): string[] {
  return value.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function optionalLabel(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function dockerResourceMissing(result: { stdout: Buffer; stderr: Buffer }): boolean {
  return /no such (?:object|container|network)|not found/i.test(
    `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
