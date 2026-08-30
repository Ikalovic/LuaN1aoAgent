import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NetworkSandboxManager } from "../dist/src/connectivity/network-sandbox-manager.js";
import { createDockerTaskSandbox } from "../dist/src/executor-sandbox-docker.js";

if (process.env.LUANNIAO_DOCKER_LIVE_TEST !== "1") {
  console.log("SKIP set LUANNIAO_DOCKER_LIVE_TEST=1 to run the Docker data-plane smoke test");
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const runtimeDir = await mkdtemp(join(tmpdir(), "luanniao-network-live-"));
const targetAddress = Object.values(networkInterfaces()).flat()
  .find((value) => value?.family === "IPv4" && !value.internal)?.address;
if (!targetAddress) throw new Error("live smoke requires one non-loopback IPv4 host interface");

const target = createServer((socket) => socket.end("probe-ok\n"));
await new Promise((resolve, reject) => {
  target.once("error", reject);
  target.listen(0, "0.0.0.0", resolve);
});
const targetPort = target.address().port;
const manager = new NetworkSandboxManager({
  runtimeDir,
  runRef: "network-live-smoke",
  manageFlowIndex: false
});
let sandbox;

try {
  await manager.configureAuthorizedScope(`${targetAddress}/32`);
  const gateway = await manager.createGateway({ taskId: "task:network-live", epochId: "epoch:network-live" });
  sandbox = await createDockerTaskSandbox({
    runtimeDir,
    runRef: "network-live-smoke",
    taskId: "task:network-live",
    network: {
      networkName: gateway.networkName,
      taskNetworkCidr: gateway.taskNetworkCidr,
      gatewayAddress: gateway.gatewayAddress,
      dnsAddress: gateway.dnsAddress
    },
    transparentCaPath: manager.gatewayCaPath(),
    environment: {}
  });
  await sandbox.start();

  const response = await dockerExec(
    sandbox.containerName,
    `exec 3<>/dev/tcp/${targetAddress}/${targetPort}; cat <&3`
  );
  if (!response.includes("probe-ok")) {
    throw new Error(`authorized TCP returned unexpected response: ${JSON.stringify(response)}`);
  }

  const bridgeAddress = `${gateway.gatewayAddress.split(".").slice(0, 3).join(".")}.1`;
  let bypassSucceeded = false;
  try {
    await dockerExec(sandbox.containerName, `exec 3<>/dev/tcp/${bridgeAddress}/${targetPort}`, 3_000);
    bypassSucceeded = true;
  } catch {
    // The Executor OUTPUT guard must reject direct access to the Docker bridge host.
  }
  if (bypassSucceeded) throw new Error("Executor bypassed Gateway through the task bridge host");

  await manager.endEpoch("task:network-live", "epoch:network-live");
  const telemetry = await readFile(gateway.netFile, "utf8");
  const expectedDestination = `\"destination\":{\"host\":\"${targetAddress}\",\"port\":${targetPort}}`;
  if (!telemetry.includes(expectedDestination)) {
    throw new Error(`Gateway telemetry did not contain authorized target ${targetAddress}:${targetPort}`);
  }
  console.log("PASS authorized TCP traversed Gateway and task-bridge bypass was rejected");
} finally {
  await sandbox?.dispose().catch(() => undefined);
  await manager.close().catch(() => undefined);
  await new Promise((resolve) => target.close(() => resolve()));
  await rm(runtimeDir, { recursive: true, force: true });
}

async function dockerExec(containerName, command, timeout = 10_000) {
  const result = await execFileAsync(
    "docker",
    ["exec", containerName, "bash", "--noprofile", "--norc", "-c", `timeout ${Math.ceil(timeout / 1000)} bash -c ${shellQuote(command)}`],
    { timeout: timeout + 5_000 }
  );
  return result.stdout;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
