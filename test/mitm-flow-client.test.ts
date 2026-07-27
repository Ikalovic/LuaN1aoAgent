import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeHistoricalMitmIndexes, MitmFlowClient, runMitmIndexDockerCommand } from "../src/connectivity/mitm-flow-client.js";
import {
  ConnectivityRuntimeOwnerLease,
  ConnectivityRuntimeOwnershipError
} from "../src/connectivity/runtime-owner-lease.js";

const token = "a".repeat(64);

function createOwnedIndexRunner(options: { failPort?: boolean; failRemove?: boolean } = {}) {
  const commands: string[][] = [];
  let exists = false;
  let configDigest = "";
  let failPort = options.failPort ?? false;
  let failRemove = options.failRemove ?? false;
  const runner = async (args: string[]) => {
    commands.push(args);
    if (args[0] === "inspect" && args[2]?.includes(".State.Running")) {
      return exists
        ? { code: 0, stdout: `true|true|history-index|${configDigest}`, stderr: "" }
        : { code: 1, stdout: "", stderr: "not found" };
    }
    if (args[0] === "inspect") {
      return exists
        ? { code: 0, stdout: "true|history-index", stderr: "" }
        : { code: 1, stdout: "", stderr: "not found" };
    }
    if (args[0] === "run") {
      exists = true;
      configDigest = args.find((value) => value.startsWith("luanniao.config="))?.slice("luanniao.config=".length) ?? "";
      return { code: 0, stdout: "container", stderr: "" };
    }
    if (args[0] === "port") {
      return failPort
        ? { code: 1, stdout: "", stderr: "port unavailable" }
        : { code: 0, stdout: "127.0.0.1:37890\n", stderr: "" };
    }
    if (args[0] === "rm") {
      if (failRemove) return { code: 1, stdout: "", stderr: "cleanup denied" };
      exists = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return {
    commands,
    runner,
    setFailPort: (value: boolean) => { failPort = value; },
    setFailRemove: (value: boolean) => { failRemove = value; }
  };
}

test("revives a stale historical mitm index and rewrites its descriptor", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  const leaseDir = join(runtimeDir, ".connectivity-runtime-owner");
  await mkdir(leaseDir, { mode: 0o700 });
  await writeFile(join(leaseDir, "owner.json"), JSON.stringify({
    version: 2,
    token: "stale-owner",
    pid: 2_147_483_647,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z"
  }));
  const network = "luanniao-net-0123456789abcdef";
  await writeFile(join(trafficRoot, "index.json"), JSON.stringify({ url: "http://127.0.0.1:1", token, network }));
  const commands: string[][] = [];
  const runner = async (args: string[]) => {
    commands.push(args);
    if (args[0] === "inspect") {
      if (args[2]?.includes(".State.Running")) return { code: 1, stdout: "", stderr: "not found" };
      return { code: 0, stdout: "true|history-index", stderr: "" };
    }
    if (args[0] === "run") return { code: 0, stdout: "container", stderr: "" };
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:34567\n", stderr: "" };
    if (args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:1/")) throw new Error("stale");
    if (url.endsWith("/health")) return Response.json({ status: "ok" });
    return Response.json({ records: [{ id: "flow:1" }], has_more: false });
  }) as typeof fetch;

  const client = await MitmFlowClient.open(runtimeDir, { runner, fetcher, image: "test-network-image" });
  const history = await client.historyList({ limit: 5 });

  assert.equal(history.items.length, 1);
  assert.ok(commands.some((args) => args[0] === "run" && args.includes("luanniao.role=history-index")));
  assert.equal(commands.some((args) => args[0] === "network" || args.includes("--network")), false);
  assert.ok(commands.some((args) => args.includes("--cap-drop") && args.includes("no-new-privileges")));
  assert.ok(commands.some((args) => args.includes(`type=bind,src=${trafficRoot},dst=/traffic,readonly`)));
  assert.deepEqual(JSON.parse(await readFile(join(trafficRoot, "index.json"), "utf8")), {
    url: "http://127.0.0.1:34567",
    token
  });
  await closeHistoricalMitmIndexes(runtimeDir);
  assert.ok(commands.some((args) => args[0] === "rm" && args.includes("-f")));
});

test("rebuilds a missing historical descriptor from the persisted token", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  const runner = async (args: string[]) => {
    if (args[0] === "inspect") {
      if (args[2]?.includes(".State.Running")) return { code: 1, stdout: "", stderr: "not found" };
      return { code: 0, stdout: "true|history-index", stderr: "" };
    }
    if (args[0] === "run") return { code: 0, stdout: "container", stderr: "" };
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:35678\n", stderr: "" };
    if (args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const fetcher = (async () => Response.json({ status: "ok" })) as typeof fetch;

  await MitmFlowClient.open(runtimeDir, { runner, fetcher });

  assert.deepEqual(JSON.parse(await readFile(join(trafficRoot, "index.json"), "utf8")), {
    url: "http://127.0.0.1:35678",
    token
  });
  await closeHistoricalMitmIndexes(runtimeDir);
});

test("rebuilds a historical index when the disposable token was lost", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  const commands: string[][] = [];
  const runner = async (args: string[]) => {
    commands.push(args);
    if (args[0] === "inspect") {
      if (args[2]?.includes(".State.Running")) return { code: 1, stdout: "", stderr: "not found" };
      return { code: 0, stdout: "true|history-index", stderr: "" };
    }
    if (args[0] === "run") return { code: 0, stdout: "container", stderr: "" };
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:36789\n", stderr: "" };
    if (args[0] === "rm") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const fetcher = (async () => Response.json({ status: "ok" })) as typeof fetch;

  await MitmFlowClient.open(runtimeDir, { runner, fetcher });

  const recoveredToken = (await readFile(join(trafficRoot, "index.token"), "utf8")).trim();
  assert.match(recoveredToken, /^[a-f0-9]{64}$/);
  assert.ok(commands.some((args) => args[0] === "run" && args.includes(`LUANNIAO_INDEX_TOKEN=${recoveredToken}`)));
  await closeHistoricalMitmIndexes(runtimeDir);
});

test("preserves opaque flow references across detail and body", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(trafficRoot, { recursive: true });
  await writeFile(join(trafficRoot, "index.json"), JSON.stringify({ url: "http://127.0.0.1:45678", token }));
  const requests: Array<{ url: string; method: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/health")) return Response.json({ status: "ok" });
    if (url.endsWith("/body?side=request")) return Response.json({ exchange_id: "task:1:flow/http", side: "request" });
    return Response.json({ record: { id: "task:1:flow/http", kind: "http" } });
  }) as typeof fetch;
  const runtimeLease = new ConnectivityRuntimeOwnerLease(runtimeDir);
  await runtimeLease.acquire();
  const client = await MitmFlowClient.open(runtimeDir, { fetcher });

  await client.historyGet("task:1:flow/http");
  await client.historyBody("task:1:flow/http", "request");

  assert.ok(requests.some((request) => request.url.includes("task%3A1%3Aflow%2Fhttp") && request.method === "GET"));
  assert.ok(requests.every((request) => request.method === "GET"));
  await runtimeLease.release();
});

test("reuses a healthy active Runtime index without invoking Docker", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(trafficRoot, { recursive: true });
  await writeFile(join(trafficRoot, "index.json"), JSON.stringify({ url: "http://127.0.0.1:45678", token }));
  const fetcher = (async () => Response.json({ status: "ok" })) as typeof fetch;
  const runner = async (_args: string[]) => {
    assert.fail("Docker must not be called for a healthy descriptor");
    return { code: 1, stdout: "", stderr: "" };
  };

  const runtimeLease = new ConnectivityRuntimeOwnerLease(runtimeDir);
  await runtimeLease.acquire();
  await MitmFlowClient.open(runtimeDir, { runner, fetcher });
  await runtimeLease.release();
});

test("claims a healthy unowned descriptor before returning a historical client", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-healthy-unowned-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  await writeFile(join(trafficRoot, "index.json"), JSON.stringify({ url: "http://127.0.0.1:45678", token }));
  const harness = createOwnedIndexRunner();
  const fetcher = (async () => Response.json({ status: "ok" })) as typeof fetch;

  await MitmFlowClient.open(runtimeDir, { runner: harness.runner, fetcher });

  assert.equal(harness.commands.filter((args) => args[0] === "run").length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(trafficRoot, "index.json"), "utf8")), {
    url: "http://127.0.0.1:37890",
    token
  });
  const contender = new ConnectivityRuntimeOwnerLease(runtimeDir);
  await assert.rejects(
    contender.acquire(),
    (error: unknown) => error instanceof ConnectivityRuntimeOwnershipError
  );
  await closeHistoricalMitmIndexes(runtimeDir);
  await contender.acquire();
  await contender.release();
});

test("refuses to replace an unhealthy descriptor while the Runtime lease is active", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-active-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  const descriptor = { url: "http://127.0.0.1:1", token };
  await writeFile(join(trafficRoot, "index.json"), JSON.stringify(descriptor));
  const runtimeLease = new ConnectivityRuntimeOwnerLease(runtimeDir);
  await runtimeLease.acquire();
  const commands: string[][] = [];

  await assert.rejects(
    MitmFlowClient.open(runtimeDir, {
      runner: async (args) => {
        commands.push(args);
        return { code: 1, stdout: "", stderr: "must not run" };
      },
      fetcher: (async () => { throw new Error("stale"); }) as typeof fetch
    }),
    (error: unknown) => error instanceof ConnectivityRuntimeOwnershipError
      && error.code === "connectivity_runtime_owned"
  );

  assert.deepEqual(commands, []);
  assert.deepEqual(JSON.parse(await readFile(join(trafficRoot, "index.json"), "utf8")), descriptor);
  await runtimeLease.release();
});

test("claims ownership before starting Docker so a Runtime cannot win the revival race", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-race-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  let releaseInspect: (() => void) | undefined;
  let inspectStarted: (() => void) | undefined;
  const inspectGate = new Promise<void>((resolveInspect) => { releaseInspect = resolveInspect; });
  const inspectObserved = new Promise<void>((resolveStarted) => { inspectStarted = resolveStarted; });
  const harness = createOwnedIndexRunner();
  const opening = MitmFlowClient.open(runtimeDir, {
    fetcher: (async () => Response.json({ status: "ok" })) as typeof fetch,
    runner: async (args) => {
      if (args[0] === "inspect" && args[2]?.includes(".State.Running")) {
        inspectStarted?.();
        await inspectGate;
      }
      return harness.runner(args);
    }
  });
  await inspectObserved;

  const contender = new ConnectivityRuntimeOwnerLease(runtimeDir);
  await assert.rejects(
    contender.acquire(),
    (error: unknown) => error instanceof ConnectivityRuntimeOwnershipError
  );

  releaseInspect?.();
  await opening;
  await closeHistoricalMitmIndexes(runtimeDir);
});

test("drains in-flight readers before handing a historical index to the Runtime owner", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-reader-drain-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  const harness = createOwnedIndexRunner();
  let releaseRead: (() => void) | undefined;
  let markReadStarted: (() => void) | undefined;
  const readGate = new Promise<void>((resolveRead) => { releaseRead = resolveRead; });
  const readStarted = new Promise<void>((resolveStarted) => { markReadStarted = resolveStarted; });
  let historyRequests = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/health")) return Response.json({ status: "ok" });
    historyRequests += 1;
    if (url.includes("/history?")) {
      markReadStarted?.();
      await readGate;
      return Response.json({ records: [{ id: "flow:reader" }], has_more: false });
    }
    return Response.json({ record: { id: "flow:late" } });
  }) as typeof fetch;
  const client = await MitmFlowClient.open(runtimeDir, { runner: harness.runner, fetcher });
  const reading = client.historyList();
  await readStarted;

  const closing = closeHistoricalMitmIndexes(runtimeDir);
  await Promise.resolve();
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 0);
  await assert.rejects(
    client.historyGet("flow:late"),
    (error: unknown) => error instanceof ConnectivityRuntimeOwnershipError
  );
  assert.equal(historyRequests, 1);

  const contender = new ConnectivityRuntimeOwnerLease(runtimeDir);
  await assert.rejects(
    contender.acquire(),
    (error: unknown) => error instanceof ConnectivityRuntimeOwnershipError
  );
  releaseRead?.();
  assert.equal((await reading).items[0]?.id, "flow:reader");
  await closing;
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 1);

  await contender.acquire();
  await assert.rejects(
    client.historyGet("flow:stale"),
    (error: unknown) => error instanceof ConnectivityRuntimeOwnershipError
  );
  await contender.release();
});

test("removes an owned historical index when port discovery fails", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-port-failure-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  const harness = createOwnedIndexRunner({ failPort: true });

  await assert.rejects(
    () => MitmFlowClient.open(runtimeDir, { runner: harness.runner }),
    /Failed to resolve mitm flow index port: port unavailable/
  );

  assert.equal(harness.commands.filter((args) => args[0] === "run").length, 1);
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 1);
  await closeHistoricalMitmIndexes(runtimeDir);
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 1);
});

test("removes an owned historical index when descriptor publication fails", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-descriptor-failure-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await mkdir(join(trafficRoot, "index.json"));
  await writeFile(join(trafficRoot, "index.token"), token);
  const harness = createOwnedIndexRunner();

  await assert.rejects(() => MitmFlowClient.open(runtimeDir, { runner: harness.runner }));

  assert.equal(harness.commands.filter((args) => args[0] === "run").length, 1);
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 1);
  await closeHistoricalMitmIndexes(runtimeDir);
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 1);
});

test("removes an owned historical index when readiness never succeeds", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-readiness-failure-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  const harness = createOwnedIndexRunner();
  const fetcher = (async () => Response.json({ status: "starting" })) as typeof fetch;

  await assert.rejects(
    () => MitmFlowClient.open(runtimeDir, { runner: harness.runner, fetcher }),
    /Mitm flow index did not become healthy/
  );

  assert.equal(harness.commands.filter((args) => args[0] === "run").length, 1);
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 1);
  await closeHistoricalMitmIndexes(runtimeDir);
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 1);
});

test("retains historical index ownership when startup compensation cleanup fails", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-index-cleanup-failure-"));
  const trafficRoot = join(runtimeDir, "traffic");
  await mkdir(join(trafficRoot, "flows"), { recursive: true });
  await writeFile(join(trafficRoot, "index.token"), token);
  const harness = createOwnedIndexRunner({ failPort: true, failRemove: true });

  await assert.rejects(
    () => MitmFlowClient.open(runtimeDir, { runner: harness.runner }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /port unavailable/);
      assert.match(error.message, /cleanup denied/);
      return true;
    }
  );

  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 1);
  harness.setFailPort(false);
  harness.setFailRemove(false);
  await closeHistoricalMitmIndexes(runtimeDir);
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 2);
  await closeHistoricalMitmIndexes(runtimeDir);
  assert.equal(harness.commands.filter((args) => args[0] === "rm").length, 2);
});

test("bounds a stalled historical index Docker command", async () => {
  const binaryDir = await mkdtemp(join(tmpdir(), "luanniao-mitm-docker-"));
  const dockerPath = join(binaryDir, "docker");
  await writeFile(dockerPath, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n");
  await chmod(dockerPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaryDir}:${previousPath ?? ""}`;
  try {
    const result = await runMitmIndexDockerCommand(["info"], 25);
    assert.equal(result.code, null);
    assert.match(result.stderr, /docker command timed out after 25ms/);
  } finally {
    process.env.PATH = previousPath;
  }
});
