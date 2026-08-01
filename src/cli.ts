import { bootstrapAgentRuntime } from "./agent-runtime-bootstrap.js";
import { cliHelp, parseCliOptions, shouldUseTui } from "./cli-options.js";
import { resolveCliRunContext } from "./cli-runtime.js";
import { normalizeScope } from "./scope.js";
import { parseTransparentProxy } from "./proxy-config.js";
import { AgentCliApp } from "./tui/app.js";

try {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(cliHelp());
  } else {
    await run(options);
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}

async function run(options: ReturnType<typeof parseCliOptions>): Promise<void> {
  const transparentProxy = options.proxy ? parseTransparentProxy(options.proxy) : undefined;
  const cwd = process.cwd();
  const runContext = resolveCliRunContext(options, cwd);
  const useTui = shouldUseTui(options, {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY
  });
  let agentRuntime: Awaited<ReturnType<typeof bootstrapAgentRuntime>> | undefined;
  let app: AgentCliApp | undefined;
  let receivedSignal: NodeJS.Signals | undefined;
  let stopRequest: Promise<void> | undefined;
  let unsubscribeJsonl: (() => void) | undefined;
  let jsonlResult: unknown;
  const requestStop = (signal: NodeJS.Signals): Promise<void> => {
    receivedSignal ??= signal;
    process.exitCode = 128 + signalNumber(signal);
    if (!agentRuntime) {
      return Promise.resolve();
    }
    stopRequest ??= agentRuntime.controller.requestStop(`Received ${receivedSignal}`);
    return stopRequest;
  };
  const handleSignal = (signal: NodeJS.Signals): void => {
    void requestStop(signal);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    agentRuntime = await bootstrapAgentRuntime({
      cwd,
      runtimeDir: runContext.runtimeDir,
      routeRef: "cli-run"
    });
    const { controller } = agentRuntime;
    app = useTui
      ? new AgentCliApp({
        executionLog: controller.executionLog,
        artifactStore: controller.artifactStore,
        goal: runContext.userGoal,
        runtimeDir: runContext.runtimeDir,
        resumed: runContext.resumed,
        onInterrupt: () => requestStop("SIGINT"),
        onForceInterrupt: () => requestStop("SIGINT")
      })
      : undefined;
    if (receivedSignal) {
      await requestStop(receivedSignal);
      return;
    }
    const scopeSummary = runContext.resumed
      ? runContext.scopeSummary!
      : runContext.scopeSummary
        ? normalizeScope(runContext.scopeSummary)
        : await controller.inferScopeFromGoal(runContext.userGoal);
    if (transparentProxy) {
      await controller.configureTransparentProxy(transparentProxy, scopeSummary);
    }
    if (options.jsonl) {
      process.stdout.write(`${JSON.stringify({
        type: "run",
        runtimeDir: runContext.runtimeDir,
        resumed: runContext.resumed,
        userGoal: runContext.userGoal,
        scopeSummary
      })}\n`);
      unsubscribeJsonl = controller.executionLog.subscribe((event) => {
        process.stdout.write(`${JSON.stringify({ type: "event", event })}\n`);
      });
    }
    await app?.start();
    const result = await controller.runUntilDone({
      userGoal: runContext.userGoal,
      scopeSummary,
      maxPlannerCycles: options.maxPlannerCycles,
      maxParallelTasks: options.maxParallelTasks,
      maxRunTimeMs: options.maxRunTimeMs
    });
    if (app) {
      app.setStatus(receivedSignal ? "interrupting" : "completed", receivedSignal ? "运行已中断" : "运行结果已生成");
    } else if (options.jsonl) {
      jsonlResult = result;
    } else if (!receivedSignal) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    app?.setStatus("failed", errorMessage(error));
    if (!app) {
      console.error(errorMessage(error));
    }
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    try {
      await stopRequest;
    } finally {
      try {
        await agentRuntime?.close();
      } finally {
        if (options.jsonl && jsonlResult !== undefined) {
          process.stdout.write(`${JSON.stringify({ type: "result", result: jsonlResult })}\n`);
        }
        unsubscribeJsonl?.();
        await app?.stop();
      }
    }
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGTERM" ? 15 : 2;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
