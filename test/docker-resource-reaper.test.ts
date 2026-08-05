import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ConnectivityRuntimeOwnerLease } from "../src/connectivity/runtime-owner-lease.js";
import { reapStaleManagedDockerResources } from "../src/docker-resource-reaper.js";
import type { DockerRunner } from "../src/executor-sandbox-docker.js";

test("orphan reaper removes stale managed containers before their networks", async () => {
  const root = await mkdtemp("/tmp/luanniao-reaper-");
  const runtimeDir = join(root, "runtime");
  const calls: string[][] = [];
  try {
    const runner = fakeRunner(runtimeDir, calls);
    const result = await reapStaleManagedDockerResources({ roots: [root], runner });

    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.skippedActiveRuntimeDirs, []);
    assert.deepEqual(result.removed, ["executor-one", "gateway-one", "connector-one", "network-one"]);
    const firstNetworkRemoval = calls.findIndex((args) => args[0] === "network" && args[1] === "rm");
    const lastContainerRemoval = calls.map((args) => args[0]).lastIndexOf("rm");
    assert.ok(firstNetworkRemoval > lastContainerRemoval);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan reaper leaves resources owned by an active runtime untouched", async () => {
  const root = await mkdtemp("/tmp/luanniao-reaper-active-");
  const runtimeDir = join(root, "runtime");
  const lease = new ConnectivityRuntimeOwnerLease(runtimeDir);
  const calls: string[][] = [];
  try {
    await lease.acquire();
    const result = await reapStaleManagedDockerResources({ roots: [root], runner: fakeRunner(runtimeDir, calls) });

    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.skippedActiveRuntimeDirs, [runtimeDir]);
    assert.equal(calls.some((args) => args[0] === "rm" || (args[0] === "network" && args[1] === "rm")), false);
  } finally {
    await lease.release();
    await rm(root, { recursive: true, force: true });
  }
});

function fakeRunner(runtimeDir: string, calls: string[][]): DockerRunner {
  const runRef = "run:stale";
  const containers: Record<string, unknown> = {
    c1: inspectContainer("executor-one", "executor", runRef, runtimeDir),
    c2: inspectContainer("gateway-one", "gateway", runRef, undefined, [{
      Source: join(runtimeDir, "traffic", "ca"),
      Destination: "/traffic/ca"
    }]),
    c3: inspectContainer("connector-one", "connector", runRef)
  };
  return async (args) => {
    calls.push(args);
    if (args[0] === "ps") return dockerResult(0, "c1\nc2\nc3\n");
    if (args[0] === "inspect") return dockerResult(0, JSON.stringify([containers[args[1] ?? ""]]));
    if (args[0] === "network" && args[1] === "ls") return dockerResult(0, "n1\n");
    if (args[0] === "network" && args[1] === "inspect") {
      return dockerResult(0, JSON.stringify([{
        Name: "network-one",
        Labels: {
          "luanniao.managed": "true",
          "luanniao.role": "run-network",
          "luanniao.run_ref": runRef
        }
      }]));
    }
    if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) return dockerResult(0);
    return dockerResult(1, "", `unexpected command: ${args.join(" ")}`);
  };
}

function inspectContainer(
  name: string,
  role: string,
  runRef: string,
  runtimeDir?: string,
  Mounts: Array<{ Source: string; Destination: string }> = []
): unknown {
  return {
    Name: `/${name}`,
    Config: {
      Labels: {
        "luanniao.managed": "true",
        "luanniao.role": role,
        "luanniao.run_ref": runRef,
        ...(runtimeDir ? { "luanniao.runtime_dir": runtimeDir } : {})
      }
    },
    Mounts
  };
}

function dockerResult(code: number, stdout = "", stderr = "") {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}
