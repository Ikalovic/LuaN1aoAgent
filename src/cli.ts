import { bootstrapAgentRuntime } from "./agent-runtime-bootstrap.js";
import { cliHelp, parseCliOptions, shouldUseTui } from "./cli-options.js";
import { resolveCliRunContext } from "./cli-runtime.js";
import { createLlmRuntime, loadLocalEnvFile } from "./llm-config.js";
import { resolveCliScopeDocuments } from "./cli-scope-documents.js";
import { normalizeScope } from "./scope.js";
import { resolveDocumentScopeWithLlm } from "./scope-documents/scope-document-resolver.js";
import { parseTransparentProxy } from "./proxy-config.js";
import { deriveFinalReport } from "./run-report.js";
import { loadPentestTemplates } from "./reporting/task-reporting.js";
import { dirname, join } from "node:path";
import { AgentCliApp } from "./tui/app.js";
import { createInterface } from "node:readline/promises";

try {
  loadLocalEnvFile(process.env);
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
  if (options.scopeFiles.length > 0 && !useTui && !options.confirmScopeFiles) {
    throw new Error("--scope-file requires --confirm-scope-files in non-interactive mode");
  }
  const fileScope = options.scopeFiles.length > 0
    ? await resolveCliScopeDocuments({
      cwd,
      runtimeDir: runContext.runtimeDir,
      files: options.scopeFiles,
      manualScope: options.scope,
      aiResolver: async (fragments) => resolveDocumentScopeWithLlm({
        cwd,
        fragments,
        llmRuntime: createLlmRuntime()
      })
    })
    : undefined;
  if (fileScope && useTui && !options.confirmScopeFiles) {
    console.log(`解析出的授权范围：${fileScope.normalizedScope}`);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await prompt.question("确认使用以上范围？[y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") throw new Error("已取消：未确认授权范围文件");
    } finally {
      prompt.close();
    }
  }
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
    if (transparentProxy && agentRuntime.executorSandboxMode !== "docker") {
      throw new Error("--proxy requires EXECUTOR_SANDBOX_MODE=docker because transparent SOCKS5 routing is owned by the Docker Gateway");
    }
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
      : fileScope
        ? fileScope.normalizedScope
        : runContext.scopeSummary
        ? normalizeScope(runContext.scopeSummary)
        : await controller.inferScopeFromGoal(runContext.userGoal);
    if (transparentProxy) {
      await controller.configureTransparentProxy(transparentProxy, scopeSummary);
    }
    const reportingContext = options.taskType === "pentest"
      ? await loadPentestTemplates((() => {
        const scoringPath = process.env.PENTEST_SCORING_TEMPLATE?.trim() || join(cwd, "templates/pentest/default-scoring-standard.md");
        const reportPath = process.env.PENTEST_REPORT_TEMPLATE?.trim() || join(cwd, "templates/pentest/default-report-template.md");
        return { scoringPath, reportPath, allowedRoots: [cwd, dirname(scoringPath), dirname(reportPath)] };
      })())
      : { taskType: "ctf" as const };
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
      taskType: options.taskType,
      reportingContext,
      maxPlannerCycles: options.maxPlannerCycles,
      maxParallelTasks: options.maxParallelTasks,
      maxRunTimeMs: options.maxRunTimeMs
    });
    const finalReport = deriveFinalReport(
      controller.runtimeStore.listTaskOutcomes(Number.MAX_SAFE_INTEGER),
      await controller.artifactStore.list()
    );
    const displayedResult = finalReport ? { ...result, finalReport } : result;
    if (app) {
      app.setStatus(
        receivedSignal ? "interrupting" : "completed",
        receivedSignal
          ? "运行已中断"
          : finalReport
            ? `最终报告：${finalReport.artifacts[0]?.path ?? finalReport.artifactRefs[0]}`
            : "运行结果已生成"
      );
    } else if (options.jsonl) {
      jsonlResult = displayedResult;
    } else if (!receivedSignal) {
      console.log(JSON.stringify(displayedResult, null, 2));
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
