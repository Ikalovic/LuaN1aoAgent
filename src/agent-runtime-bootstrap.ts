import { join } from "node:path";
import { SecurityAgentController } from "./controller.js";
import { TrafficProxyManager } from "./connectivity/traffic-proxy-manager.js";
import { TrafficProxyManagerRegistry } from "./connectivity/traffic-proxy-manager-registry.js";
import {
  defaultDockerRunner,
  shouldUseDockerSandbox,
  type DockerRunner
} from "./executor-sandbox-docker.js";
import { reapStaleManagedDockerResources } from "./docker-resource-reaper.js";
import {
  executorSandboxModeFromEnv,
  type ExecutorSandboxRequestedMode
} from "./executor-sandbox.js";
import { ExecutionLog } from "./stores/execution-log.js";

export type AgentRuntimeLifecycle = {
  controller: SecurityAgentController;
  trafficProxyManager?: TrafficProxyManager;
  executorSandboxMode: ExecutorSandboxRequestedMode;
  close: () => Promise<void>;
};

export type AgentRuntimeBootstrapOptions = {
  cwd: string;
  runtimeDir: string;
  routeRef: string;
  executorSandboxMode?: ExecutorSandboxRequestedMode;
  trafficProxyRegistry?: TrafficProxyManagerRegistry;
  dockerRunner?: DockerRunner;
  controllerFactory?: (input: {
    cwd: string;
    runtimeDir: string;
    environment?: NodeJS.ProcessEnv;
    executorSandboxMode: ExecutorSandboxRequestedMode;
  }) => SecurityAgentController;
};

export function createAgentTrafficProxyRegistry(): TrafficProxyManagerRegistry {
  return new TrafficProxyManagerRegistry({
    logEventForRuntime: async (runtimeDir, event) => {
      const executionLog = new ExecutionLog(join(runtimeDir, "execution.jsonl"), join(runtimeDir, "state.sqlite"));
      try {
        await executionLog.append({ role: "runtime", ...event });
        await executionLog.drain();
      } finally {
        executionLog.close();
      }
    }
  });
}

export async function bootstrapAgentRuntime(input: AgentRuntimeBootstrapOptions): Promise<AgentRuntimeLifecycle> {
  const requestedMode = input.executorSandboxMode ?? executorSandboxModeFromEnv();
  const dockerBackend = await shouldUseDockerSandbox(requestedMode, input.dockerRunner);
  const executorSandboxMode: ExecutorSandboxRequestedMode = dockerBackend ? "docker" : requestedMode;
  if (dockerBackend) {
    await reapStaleManagedDockerResources({
      roots: [input.cwd, input.runtimeDir],
      runner: input.dockerRunner ?? defaultDockerRunner
    });
  }
  const registry = dockerBackend
    ? undefined
    : input.trafficProxyRegistry ?? createAgentTrafficProxyRegistry();
  let controller: SecurityAgentController | undefined;
  try {
    const trafficProxyManager = await registry?.get(input.runtimeDir);
    controller = (input.controllerFactory ?? ((options) => new SecurityAgentController(options)))({
      cwd: input.cwd,
      runtimeDir: input.runtimeDir,
      environment: trafficProxyManager?.managedEnvironment(),
      executorSandboxMode
    });
    await controller.initialize();
    if (trafficProxyManager) {
      await trafficProxyManager.configureManagedHttpScope({
        taskRef: controller.runId,
        runRef: controller.runId,
        sessionRef: controller.runId,
        routeRef: input.routeRef,
        attribution: "security-agent"
      });
    }

    let closePromise: Promise<void> | undefined;
    return {
      controller,
      trafficProxyManager,
      executorSandboxMode,
      close: () => {
        closePromise ??= closeAgentRuntime(controller!, registry, input.runtimeDir);
        return closePromise;
      }
    };
  } catch (error) {
    await closeAgentRuntime(controller, registry, input.runtimeDir);
    throw error;
  }
}

async function closeAgentRuntime(
  controller: SecurityAgentController | undefined,
  registry: TrafficProxyManagerRegistry | undefined,
  runtimeDir: string
): Promise<void> {
  try {
    await controller?.close();
  } finally {
    await registry?.close(runtimeDir);
  }
}
